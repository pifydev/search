/**
 * Fuzzy path matching, and what makes one result better than another.
 *
 * `find` answers with everything that matches a glob, in whatever order the
 * filesystem handed them over. That is the wrong shape for the question people
 * actually ask, which is "the auth route file — you know the one". Two things
 * fix it: a match that tolerates the way people type, and an order that puts
 * the file you probably meant first.
 *
 * The scoring model is fff's: a base score for match quality, plus a frecency
 * boost, a proximity term, and a bonus for matching the filename rather than
 * some directory halfway up the path. Typo tolerance scales with the query,
 * because one wrong letter in four characters is a different mistake from one
 * wrong letter in twenty.
 *
 * Pure. No index, no clock, no disk — the caller supplies all three.
 */

export interface Candidate {
  /** Path relative to the search root, forward-slashed. */
  path: string;
  /** Frecency, already decayed by the caller: 0 when never touched. */
  frecency?: number;
  /** Git working-tree state, if known. */
  git?: "modified" | "staged" | "untracked" | undefined;
  /** Modified-at, for the recency thresholds. */
  mtimeMs?: number;
}

export interface Scored {
  path: string;
  score: number;
  /** Where the query characters landed, for highlighting. */
  positions: number[];
}

/** How many typos a query of this length may carry: fff's clamp(len/4, 2, 6). */
export function maxTypos(query: string): number {
  return Math.min(6, Math.max(2, Math.floor(query.length / 4)));
}

const BONUS_EXACT_FILENAME = 300;
/** `auth` should find `auth.ts` before `authentication.md`: the stem is the name. */
const BONUS_EXACT_STEM = 200;
const BONUS_FILENAME_PREFIX = 120;
const BONUS_IN_FILENAME = 60;
const BONUS_CONSECUTIVE = 12;
const BONUS_BOUNDARY = 18;
const PENALTY_LEADING = 2;
const PENALTY_TYPO = 40;
const PENALTY_DEPTH = 3;

/** A discrete boost for how recently the file changed — fff's thresholds. */
export function recencyBoost(mtimeMs: number | undefined, now: number): number {
  if (!mtimeMs) return 0;
  const age = (now - mtimeMs) / 1000;
  if (age < 120) return 16;
  if (age < 900) return 8;
  if (age < 3600) return 4;
  if (age < 86_400) return 2;
  if (age < 604_800) return 1;
  return 0;
}

/** Work in progress is what you are most likely to be looking for. */
export function gitBoost(status: Candidate["git"]): number {
  if (status === "modified") return 24;
  if (status === "staged") return 20;
  if (status === "untracked") return 12;
  return 0;
}

/**
 * Subsequence match, preferring later starts so `auth` in `src/auth/x.ts`
 * anchors on the filename rather than the first `a` in the path. Returns null
 * when the query cannot be found even with the typo budget spent.
 */
function matchPositions(haystack: string, needle: string, budget: number): { positions: number[]; typos: number } | null {
  const hay = haystack.toLowerCase();
  const need = needle.toLowerCase();
  const positions: number[] = [];
  let typos = 0;
  let at = 0;

  for (let n = 0; n < need.length; n++) {
    const ch = need[n]!;
    const found = hay.indexOf(ch, at);
    if (found === -1) {
      // Skipping a query character is the typo: a transposition or a slip.
      typos++;
      if (typos > budget) return null;
      continue;
    }
    positions.push(found);
    at = found + 1;
  }
  if (positions.length === 0) return null;
  return { positions, typos };
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1]!;
  return prev === "/" || prev === "_" || prev === "-" || prev === "." || (prev === prev.toLowerCase() && text[index] !== text[index]!.toLowerCase());
}

/** Score one candidate, or null when the query does not match it at all. */
export function scoreCandidate(candidate: Candidate, query: string, now: number): Scored | null {
  const path = candidate.path;
  if (query === "") {
    return { path, score: (candidate.frecency ?? 0) + gitBoost(candidate.git) + recencyBoost(candidate.mtimeMs, now), positions: [] };
  }

  const match = matchPositions(path, query, maxTypos(query));
  if (!match) return null;

  const slash = path.lastIndexOf("/");
  const filename = slash === -1 ? path : path.slice(slash + 1);
  const lowerName = filename.toLowerCase();
  const lowerQuery = query.toLowerCase();

  const dot = lowerName.lastIndexOf(".");
  const stem = dot <= 0 ? lowerName : lowerName.slice(0, dot);

  let score = 0;
  if (lowerName === lowerQuery) score += BONUS_EXACT_FILENAME;
  else if (stem === lowerQuery) score += BONUS_EXACT_STEM;
  else if (lowerName.startsWith(lowerQuery)) score += BONUS_FILENAME_PREFIX;
  else if (lowerName.includes(lowerQuery)) score += BONUS_IN_FILENAME;

  for (let i = 0; i < match.positions.length; i++) {
    const at = match.positions[i]!;
    if (i > 0 && at === match.positions[i - 1]! + 1) score += BONUS_CONSECUTIVE;
    if (isBoundary(path, at)) score += BONUS_BOUNDARY;
    // A match that starts deep in the string is a weaker match.
    if (i === 0) score -= Math.min(at, 40) * PENALTY_LEADING;
  }

  score -= match.typos * PENALTY_TYPO;
  // A shallow path is more likely to be the one meant than a deep one.
  score -= (path.split("/").length - 1) * PENALTY_DEPTH;
  score += candidate.frecency ?? 0;
  score += gitBoost(candidate.git);
  score += recencyBoost(candidate.mtimeMs, now);

  return { path, score, positions: match.positions };
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when this was the last. */
  cursor: string | null;
  total: number;
}

/**
 * Rank and cut. The cursor is an offset rather than a token into stored state:
 * an index that moves under a long-lived cursor would silently skip or repeat
 * results, and an offset at least fails the same way a human would expect.
 */
export function rankAndPage(
  candidates: readonly Candidate[],
  query: string,
  now: number,
  limit: number,
  cursor?: string,
): Page<Scored> {
  const scored: Scored[] = [];
  for (const candidate of candidates) {
    const hit = scoreCandidate(candidate, query, now);
    if (hit) scored.push(hit);
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const offset = Number.parseInt(cursor ?? "0", 10);
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const items = scored.slice(start, start + limit);
  const next = start + items.length;
  return { items, cursor: next < scored.length ? String(next) : null, total: scored.length };
}
