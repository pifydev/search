/**
 * Two engines, behind one shape.
 *
 * **native** — this package's own Rust core, compiled per platform. It indexes
 * this suite in about 40ms, keeps that index between sessions, and a literal
 * search reads the handful of files the trigram index says could match rather
 * than all of them.
 *
 * **builtin** — pure TypeScript, no dependencies, no binary. It exists because
 * a native binary is a promise you cannot always keep: an unsupported
 * platform, a locked-down install, a postinstall that never ran. A
 * binary-only search extension in any of those cases is one that silently does
 * nothing.
 *
 * Both answer the same questions, so the tools never learn which one they got.
 * The scoring constants are shared deliberately, so losing the binary changes
 * how fast a search is and not how it is ordered. `/search` says which engine
 * is live.
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
  /**
   * Whether `total` is the true count or a lower bound. The only path that
   * cannot afford to count everything is builtin's unindexed "all" fallback,
   * which stops one page past the ask; it reports `false` so the formatter can
   * say "at least N" instead of stating a page budget as if it were the answer.
   * Absent means exact.
   */
  exact?: boolean;
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
  readonly name: "native" | "builtin";
  /** Resolve once the first index build has landed. */
  ready(timeoutMs: number): Promise<boolean>;
  find(query: string, options?: FindOptions): Promise<Page<FileHit>>;
  grep(pattern: string, options?: GrepOptions): Promise<Page<ContentHit>>;
  /** Note that a path was used, so frecency can favour it later. */
  touch?(path: string): void;
  /** Re-read one path after a change, when the engine can. */
  refresh?(path: string): void;
  forget?(path: string): void;
  /**
   * Re-walk the tree and reconcile the index with it — pick up whatever bash,
   * a subagent or an external editor changed without a per-file signal. The
   * builtin engine leaves this undefined because its fs.watch already tracks
   * those changes live; the native engine has no watcher of its own.
   */
  reconcile?(): void;
  dispose(): void;
  /** How many files the index holds, when the engine can say. */
  indexed?(): number;
  /**
   * How the last index build was paid for: files whose contents came back from
   * the stored index versus files that had to be read. Only an engine that
   * persists its index can answer, and it is worth surfacing — "reused 0" on a
   * tree that has not changed is the visible symptom of a cache that is
   * silently not working.
   */
  stats?(): { reused: number; rebuilt: number };
}
