/**
 * The two engines, behind one shape.
 *
 * The fast path is the real thing: `@ff-labs/fff-node`, a Rust index with a
 * live watcher, typo-resistant matching, git status and frecency built in. It
 * scans this whole suite in about 80ms and is not something worth
 * reimplementing.
 *
 * The slow path exists because a native binary is a promise you cannot always
 * keep. An unsupported platform, a locked-down install, a postinstall that
 * never ran — any of those and a binary-only search extension is an extension
 * that does nothing. The fallback is pure TypeScript with no dependencies: a
 * trigram index for content, a fuzzy scorer for paths. It is slower, and it
 * works everywhere pi does.
 *
 * Both answer the same questions, so the tools never learn which one they got.
 * `/search` says which is live, because a user comparing timings deserves to
 * know why.
 */

export interface FileHit {
  path: string;
  score?: number;
  git?: string;
  size?: number;
  modifiedMs?: number;
}

export interface ContentHit {
  path: string;
  line: number;
  text: string;
  git?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  cursor: string | null;
}

export type GrepMode = "literal" | "regex" | "fuzzy";

export interface FindOptions {
  limit?: number;
  cursor?: string;
}

export interface GrepOptions extends FindOptions {
  mode?: GrepMode;
  caseInsensitive?: boolean;
  /** Only search paths matching this glob. */
  glob?: string;
}

export interface SearchEngine {
  readonly name: "fff" | "builtin";
  /** Resolve once the first index build has landed. */
  ready(timeoutMs: number): Promise<boolean>;
  find(query: string, options?: FindOptions): Promise<Page<FileHit>>;
  grep(pattern: string, options?: GrepOptions): Promise<Page<ContentHit>>;
  /** Note that a path was used, so frecency can favour it later. */
  touch?(path: string): void;
  dispose(): void;
  /** How many files the index holds, when the engine can say. */
  indexed?(): number;
}

/** fff calls it "plain"; this package calls it what a user would call it. */
const FFF_MODE: Record<GrepMode, string> = { literal: "plain", regex: "regex", fuzzy: "fuzzy" };

interface FffResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

interface FffPage {
  items: Array<Record<string, unknown>>;
  /**
   * For grep this is the size of THIS page, not a grand total — fff searches
   * files lazily and cannot know the total without finishing the job. Reading
   * it as a total is how a result set of twenty looks like the whole answer.
   */
  totalMatched?: number;
  nextCursor?: unknown;
}

interface FffFinder {
  waitForScan(ms: number): Promise<unknown>;
  fileSearch(query: string, options?: Record<string, unknown>): FffResult<FffPage>;
  grep(pattern: string, options?: Record<string, unknown>): FffResult<FffPage>;
  destroy(): void;
}

/**
 * Adapter over fff. Its two searches paginate differently — files by page
 * index, content by an opaque cursor it hands back — so this translates both
 * into the one string cursor the tools see.
 */
export function fffEngine(finder: FffFinder): SearchEngine {
  // fff's grep cursor is an opaque object, and this interface hands back a
  // string. Keeping them here rather than serialising the object's innards
  // avoids depending on a shape its author marked internal.
  const cursors = new Map<string, unknown>();
  let cursorSeq = 0;

  function tokenFor(cursor: unknown): string | null {
    if (cursor === null || cursor === undefined) return null;
    const token = `c${++cursorSeq}`;
    cursors.set(token, cursor);
    // A session asks a lot; only the recent handful can still be in play.
    if (cursors.size > 32) cursors.delete(cursors.keys().next().value as string);
    return token;
  }

  return {
    name: "fff",
    async ready(timeoutMs) {
      try {
        await finder.waitForScan(timeoutMs);
        return true;
      } catch {
        return false;
      }
    },
    async find(query, options = {}) {
      const limit = options.limit ?? 20;
      // fff pages files by index, not by offset.
      const page = Math.max(0, Number.parseInt(options.cursor ?? "0", 10) || 0);
      const result = finder.fileSearch(query, { pageSize: limit, pageIndex: page });
      if (!result.ok || !result.value) return { items: [], total: 0, cursor: null };
      const items = result.value.items.map((raw) => ({
        path: String(raw.relativePath ?? ""),
        git: typeof raw.gitStatus === "string" && raw.gitStatus !== "clean" ? raw.gitStatus : undefined,
        size: typeof raw.size === "number" ? raw.size : undefined,
        modifiedMs: typeof raw.modified === "number" ? raw.modified * 1000 : undefined,
        score: typeof raw.totalFrecencyScore === "number" ? raw.totalFrecencyScore : undefined,
      }));
      const total = result.value.totalMatched ?? items.length;
      // A full page means there may be another; fff reports the match count
      // for the query, so this is a real total rather than a guess.
      const hasMore = items.length === limit && (page + 1) * limit < total;
      return { items, total, cursor: hasMore ? String(page + 1) : null };
    },
    async grep(pattern, options = {}) {
      const limit = options.limit ?? 20;
      const previous = options.cursor ? cursors.get(options.cursor) : undefined;
      const result = finder.grep(pattern, {
        mode: FFF_MODE[options.mode ?? "literal"],
        pageSize: limit,
        smartCase: options.caseInsensitive !== false,
        ...(previous ? { cursor: previous } : {}),
      });
      if (!result.ok || !result.value) return { items: [], total: 0, cursor: null };
      const items = result.value.items.map((raw) => ({
        path: String(raw.relativePath ?? ""),
        line: typeof raw.lineNumber === "number" ? raw.lineNumber : 0,
        text: String(raw.lineContent ?? ""),
        git: typeof raw.gitStatus === "string" && raw.gitStatus !== "clean" ? raw.gitStatus : undefined,
      }));
      // Deliberately items.length: fff searches lazily, so the only honest
      // total is what has actually been found so far.
      return { items, total: items.length, cursor: tokenFor(result.value.nextCursor) };
    },
    dispose() {
      cursors.clear();
      try {
        finder.destroy();
      } catch {
        // already gone
      }
    },
  };
}

/**
 * Load fff if it is installed and its binary is present for this platform.
 * Never throws: a missing engine is the ordinary case this package is built to
 * survive, not an error to report.
 */
export async function loadFff(basePath: string): Promise<SearchEngine | null> {
  if (process.env.PIFY_SEARCH_ENGINE === "builtin") return null;
  for (const specifier of ["@ff-labs/fff-node", "@ff-labs/fff-bun"]) {
    try {
      const mod = (await import(specifier)) as {
        FileFinder?: { create(options: { basePath: string }): FffResult<FffFinder> };
      };
      const created = mod.FileFinder?.create({ basePath });
      if (created?.ok && created.value) return fffEngine(created.value);
    } catch {
      // Not installed, or no binary for this platform — try the next.
    }
  }
  return null;
}
