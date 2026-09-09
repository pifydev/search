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

/** Literal runs in a regex — the only parts that imply required trigrams. */
export function literalRuns(pattern: string): string[] {
  const runs: string[] = [];
  let current = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      // An escaped literal character contributes; a character class like \d
      // does not, and ends the run.
      if (next && /[^A-Za-z0-9]/.test(next)) {
        current += next;
        i++;
        continue;
      }
      runs.push(current);
      current = "";
      i++;
      continue;
    }
    // Anything that can match a variable amount, or nothing, ends the run —
    // and a quantifier applies to the character before it, which therefore
    // cannot be required either.
    if ("?*+{".includes(ch)) {
      runs.push(current.slice(0, -1));
      current = "";
      continue;
    }
    if ("[](){}|.^$".includes(ch)) {
      runs.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  runs.push(current);
  return runs.filter((run) => run.length >= 3);
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
