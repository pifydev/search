/**
 * How much a file's history is worth now.
 *
 * A file you opened twelve times last week should outrank one you have never
 * touched, but not forever — otherwise last month's task keeps winning today's
 * search. Frecency is the usual answer: every access decays, and the score is
 * what is left of all of them.
 *
 * The half-life is fff's, and so is its reasoning: an agent session is shorter
 * and more concentrated than a human's week, so the default here is the fast
 * decay. Ten-day half-life is for a person browsing; three days is for a tool
 * that touched forty files this afternoon.
 *
 * Pure: the caller supplies now, so the same input always scores the same.
 */

/** ln(2)/3 — a three-day half-life. */
export const DECAY_FAST = 0.231;
/** ln(2)/10 — a ten-day half-life. */
export const DECAY_SLOW = 0.0693;

const DAY_MS = 86_400_000;

/** Older than this contributes nothing, so the store cannot grow forever. */
export const MAX_HISTORY_DAYS = 7;
/** Beyond this, the oldest access is dropped rather than kept and decayed. */
export const MAX_TIMESTAMPS = 128;

export type History = Record<string, number[]>;

export function parseHistory(raw: string | null): History {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: History = {};
    for (const [path, value] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const stamps = value.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
      if (stamps.length > 0) out[path] = stamps.slice(-MAX_TIMESTAMPS);
    }
    return out;
  } catch {
    return {};
  }
}

/** Record an access, dropping what has aged out rather than keeping it. */
export function noteAccess(history: History, path: string, now: number): History {
  const cutoff = now - MAX_HISTORY_DAYS * DAY_MS;
  const kept = (history[path] ?? []).filter((t) => t >= cutoff);
  kept.push(now);
  return { ...history, [path]: kept.slice(-MAX_TIMESTAMPS) };
}

/**
 * The decayed weight of every remaining access. Summed rather than averaged:
 * ten recent touches should beat one, which an average would hide.
 */
export function frecencyOf(history: History, path: string, now: number, decay = DECAY_FAST): number {
  const stamps = history[path];
  if (!stamps || stamps.length === 0) return 0;
  let total = 0;
  for (const at of stamps) {
    const ageDays = (now - at) / DAY_MS;
    if (ageDays < 0 || ageDays > MAX_HISTORY_DAYS) continue;
    total += Math.exp(-decay * ageDays);
  }
  // Scaled into the same range as the other bonuses in fuzzy.ts, and capped so
  // a much-used file cannot outrank an exact filename match on its own.
  return Math.min(200, Math.round(total * 25));
}

/**
 * Union two histories, timestamp by timestamp.
 *
 * The history file is shared by every pi session in a cwd, and each session
 * holds its own in-memory copy. Writing that copy over the file whole made the
 * last writer win and threw away the other session's accesses. Merging on write
 * — fold my new stamps into whatever is on disk now — keeps both. Identical
 * stamps collapse, so re-merging my own history is idempotent.
 */
export function mergeHistories(a: History, b: History): History {
  const out: History = {};
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const path of paths) {
    const stamps = new Set<number>();
    for (const t of a[path] ?? []) stamps.add(t);
    for (const t of b[path] ?? []) stamps.add(t);
    out[path] = [...stamps].sort((x, y) => x - y).slice(-MAX_TIMESTAMPS);
  }
  return out;
}

/** Drop everything that has aged out, so the file on disk stays bounded. */
export function pruneHistory(history: History, now: number): History {
  const cutoff = now - MAX_HISTORY_DAYS * DAY_MS;
  const out: History = {};
  for (const [path, stamps] of Object.entries(history)) {
    const kept = stamps.filter((t) => t >= cutoff);
    if (kept.length > 0) out[path] = kept.slice(-MAX_TIMESTAMPS);
  }
  return out;
}
