/**
 * A trigram index, so a content search touches the files that could match
 * instead of every file there is.
 *
 * `grep` and its faster cousins are O(total bytes) per query: they read the
 * whole tree every time you ask. That is fine on a small repo and miserable on
 * a large one, and an agent asks a lot. The alternative is older than any of
 * them — index every overlapping three-byte window once, and at query time
 * intersect the posting lists of the trigrams the pattern must contain. The
 * files that survive are the only ones worth reading. (Design from
 * microsoft/tgrep, which reports up to 52x over ripgrep on very large trees.)
 *
 * The index only ever *narrows*. Every surviving candidate is still matched
 * for real, so a wrong candidate costs time and never correctness.
 *
 * Pure, and no dependencies: a trigram is three bytes packed into a number.
 */

/** `(a << 16) | (b << 8) | c` — injective for three bytes, so no collisions. */
export type Trigram = number;

export function trigramsOf(text: string): Set<Trigram> {
  const out = new Set<Trigram>();
  if (text.length < 3) return out;
  // Latin-1 folding keeps the packing injective for ASCII, which is what
  // source code is; anything above stays distinct enough to narrow with.
  for (let i = 0; i + 2 < text.length; i++) {
    const a = text.charCodeAt(i) & 0xff;
    const b = text.charCodeAt(i + 1) & 0xff;
    const c = text.charCodeAt(i + 2) & 0xff;
    out.add((a << 16) | (b << 8) | c);
  }
  return out;
}

/**
 * What the index can be asked.
 *
 * `all` is the important one: it means the pattern gave nothing indexable, so
 * no candidate set is safe and everything must be read. Getting this wrong is
 * how an index silently starts hiding results.
 */
export type Plan =
  | { kind: "and"; trigrams: Trigram[] }
  | { kind: "or"; branches: Plan[] }
  | { kind: "all" };

/**
 * Literal runs in a regex — the only parts that imply required trigrams.
 *
 * The rule that matters: a run may only contain characters the pattern
 * *requires*, in the order it requires them. Emitting anything else asks the
 * index for trigrams the pattern never promised, and the index then excludes
 * files that genuinely match — a false negative, which is the one failure an
 * index must never produce.
 *
 * That is exactly what an earlier version did. Scanning character by
 * character and merely *breaking* at a delimiter left the delimiter's
 * contents behind as an ordinary run: `x[abcdef]y` yielded `["abcdef"]` and
 * demanded `abc`, `bcd`, `cde`, `def` — none of which a matching `xay`
 * contains. Measured: the file matched under `node`'s own regex and the
 * search returned nothing. `a{2,4}bcdef` had the same shape and required the
 * literal `2,4`.
 *
 * So bracketed and braced spans are skipped over entirely rather than broken
 * at. Losing a run costs narrowing; keeping a wrong one costs the answer.
 *
 * Groups get the same treatment one level up. A quantifier after `)` makes
 * the whole group optional, so nothing pushed since its `(` is required —
 * which needs a stack, because by the time `)?` is seen the group's runs are
 * already in the list. The first fix in this area handled `[...]` and `{...}`
 * and missed exactly this: `(abcd)?xyz` still demanded the trigrams of
 * `abcd`, and a file containing only `xyz` matched the regex while the index
 * excluded it. Lookarounds are dropped the same way, conservatively: a
 * negative `(?!abcd)` must never require what it forbids, and telling the
 * four lookaround forms apart buys too little to be worth the parsing.
 */
export function literalRuns(pattern: string): string[] {
  const runs: string[] = [];
  const groups: Array<{ start: number; discard: boolean }> = [];
  let current = "";
  const breakRun = () => {
    runs.push(current);
    current = "";
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      // An escaped literal character contributes; a class like \d does not,
      // and ends the run.
      if (next && /[^A-Za-z0-9]/.test(next)) {
        current += next;
        i++;
        continue;
      }
      breakRun();
      i++;
      continue;
    }

    // A character class is an alternation: none of what it holds is required.
    if (ch === "[") {
      breakRun();
      i = skipTo(pattern, i, "]");
      continue;
    }
    if (ch === "(") {
      breakRun();
      let discard = false;
      if (pattern[i + 1] === "?") {
        if (pattern[i + 2] === ":") {
          // (?:…) is an ordinary group in disguise; without consuming the
          // marker here, `?` would read as a quantifier and `:` as text.
          i += 2;
        } else {
          // (?=…) (?!…) (?<=…) (?<!…): zero-width. Only the positive forms
          // truly require their contents, and requiring a negative one's
          // contents excludes exactly the files that match.
          discard = true;
          i += 1;
        }
      }
      groups.push({ start: runs.length, discard });
      continue;
    }
    if (ch === ")") {
      const group = groups.pop();
      const next = pattern[i + 1];
      // `+` is deliberately absent: (abc)+ requires at least one abc.
      if (group && (group.discard || next === "?" || next === "*" || next === "{")) {
        runs.length = group.start;
        current = "";
      } else {
        breakRun();
      }
      continue;
    }
    // A quantifier applies to the character before it, which is therefore not
    // required either — and the count inside the braces is not text to match.
    if (ch === "{") {
      runs.push(current.slice(0, -1));
      current = "";
      i = skipTo(pattern, i, "}");
      continue;
    }
    if (ch === "?" || ch === "*" || ch === "+") {
      runs.push(current.slice(0, -1));
      current = "";
      continue;
    }
    if ("}]|.^$".includes(ch)) {
      breakRun();
      continue;
    }
    current += ch;
  }
  runs.push(current);
  return runs.filter((run) => run.length >= 3);
}

/**
 * Index of the closing delimiter, or the end of the pattern when there is
 * none. An unterminated `[` is a malformed regex the matcher will reject; the
 * planner's job here is only to avoid inventing requirements from it.
 */
function skipTo(pattern: string, from: number, close: string): number {
  for (let i = from + 1; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] === close) return i;
  }
  return pattern.length;
}

/** A literal pattern: every one of its trigrams must be present. */
export function planForLiteral(literal: string, caseInsensitive: boolean): Plan {
  const text = caseInsensitive ? literal.toLowerCase() : literal;
  const trigrams = [...trigramsOf(text)];
  return trigrams.length === 0 ? { kind: "all" } : { kind: "and", trigrams };
}

/**
 * A regex: take its longest literal run. Using only one run is deliberate —
 * alternation means a run in one branch is not required by the pattern as a
 * whole, and requiring it would hide matches from the other branch.
 */
export function planForRegex(pattern: string, caseInsensitive: boolean): Plan {
  if (pattern.includes("|")) {
    // Each alternative narrows its own branch; the union is safe.
    const branches = pattern.split("|").map((part) => planForRegex(part, caseInsensitive));
    // One unindexable branch can match anywhere, so the union is unbounded.
    if (branches.some((b) => b.kind === "all")) return { kind: "all" };
    return { kind: "or", branches };
  }
  const runs = literalRuns(pattern);
  if (runs.length === 0) return { kind: "all" };
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return planForLiteral(longest, caseInsensitive);
}

/** Several patterns: a file matches if any does, so the plans are unioned. */
export function planForPatterns(plans: readonly Plan[]): Plan {
  if (plans.length === 0) return { kind: "all" };
  if (plans.some((p) => p.kind === "all")) return { kind: "all" };
  return plans.length === 1 ? plans[0]! : { kind: "or", branches: [...plans] };
}

/** Trigram → the files containing it. */
export class TrigramIndex {
  private postings = new Map<Trigram, Set<number>>();
  private indexed = new Set<number>();

  add(fileId: number, content: string, caseInsensitive = true): void {
    this.remove(fileId);
    for (const trigram of trigramsOf(caseInsensitive ? content.toLowerCase() : content)) {
      let list = this.postings.get(trigram);
      if (!list) {
        list = new Set();
        this.postings.set(trigram, list);
      }
      list.add(fileId);
    }
    this.indexed.add(fileId);
  }

  remove(fileId: number): void {
    if (!this.indexed.delete(fileId)) return;
    for (const [trigram, list] of this.postings) {
      if (list.delete(fileId) && list.size === 0) this.postings.delete(trigram);
    }
  }

  get size(): number {
    return this.indexed.size;
  }

  has(fileId: number): boolean {
    return this.indexed.has(fileId);
  }

  /**
   * Candidate file ids, or null meaning "no set is safe — read everything".
   * Null and the empty set are different answers and must not be confused:
   * one means everything, the other means nothing.
   */
  candidates(plan: Plan): Set<number> | null {
    if (plan.kind === "all") return null;

    if (plan.kind === "or") {
      const union = new Set<number>();
      for (const branch of plan.branches) {
        const part = this.candidates(branch);
        if (part === null) return null;
        for (const id of part) union.add(id);
      }
      return union;
    }

    // Intersect, smallest posting list first so the working set only shrinks.
    const lists = plan.trigrams.map((t) => this.postings.get(t) ?? new Set<number>());
    if (lists.length === 0) return null;
    lists.sort((a, b) => a.size - b.size);
    let result = new Set(lists[0]!);
    for (const list of lists.slice(1)) {
      if (result.size === 0) break;
      const next = new Set<number>();
      for (const id of result) if (list.has(id)) next.add(id);
      result = next;
    }
    return result;
  }
}
