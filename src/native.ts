/**
 * The native core, when there is one.
 *
 * A Rust index built for this package: the same trigram narrowing and the same
 * scoring constants as the TypeScript fallback, compiled. It builds an index
 * of this suite — 417 files — in about 40ms, and a literal search then reads 5
 * of those files instead of all of them.
 *
 * The index is stored between sessions, so a second start on an unchanged tree
 * reloads instead of re-reading it. See `cachePathFor` for where it lives.
 *
 * The binary is an optional dependency per platform, in the napi convention.
 * If none of them installed, this returns null and the caller falls back;
 * nothing here ever throws for a missing binary, because a missing binary is
 * the ordinary case this package is designed to survive.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContentHit, FileHit, GrepOptions, Page, SearchEngine, FindOptions } from "./engine.ts";
import { ignoreMatches, normalizePath, parseIgnore, skipDirectory } from "./walk.ts";

interface NativePage<T> {
  items: T[];
  total: number;
  /** Offset of the next page, or -1 when this was the last. */
  next: number;
  scanned?: number;
}

interface NativeIndex {
  fileCount(): number;
  indexedCount(): number;
  /** Files whose contents came from the stored index instead of from disk. */
  reusedCount(): number;
  /** Files that had to be read because they were new or had changed. */
  rebuiltCount(): number;
  save(): void;
  touch(path: string): void;
  refresh(path: string): void;
  forget(path: string): void;
  /** Re-walk the tree and reconcile against the index: new, changed, gone. */
  reconcile(): void;
  find(query: string, limit: number, offset: number, nowMs: number): NativePage<FileHit>;
  grep(
    pattern: string,
    mode: string,
    limit: number,
    offset: number,
    caseInsensitive: boolean,
  ): NativePage<ContentHit>;
}

interface NativeModule {
  SearchIndex: new (root: string, maxFiles?: number, cachePath?: string) => NativeIndex;
}

/**
 * Where a tree's stored index lives.
 *
 * Not inside the repository: an index is a derived artifact, it is large, and
 * writing one into someone's working tree means it shows up in their `git
 * status` and their diffs. It goes in the platform's cache directory, keyed by
 * the absolute path of the root so two checkouts of the same project keep
 * their own.
 *
 * `PIFY_SEARCH_CACHE_DIR` relocates it and `PIFY_SEARCH_NO_CACHE=1` turns it
 * off, which is how the no-cache path stays tested on a machine that has one.
 */
export function cachePathFor(root: string): string | undefined {
  if (process.env.PIFY_SEARCH_NO_CACHE === "1") return undefined;

  const base =
    process.env.PIFY_SEARCH_CACHE_DIR ??
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? tmpdir(), "pify-search")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches", "pify-search")
        : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pify-search"));

  const absolute = resolve(root);
  // The readable part is for a human looking at the cache directory; the hash
  // is what actually makes the name unique, since two projects can share a
  // basename and paths differ only in case on some platforms.
  const label = (basename(absolute) || "root").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const digest = createHash("sha256").update(absolute.toLowerCase()).digest("hex").slice(0, 16);
  return join(base, `${label}-${digest}.idx`);
}

/** The napi triple for this host, matching how the binaries are published. */
export function tripleOf(platform: string, arch: string): string | null {
  const key = `${platform}-${arch}`;
  const known: Record<string, string> = {
    "win32-x64": "win32-x64",
    "win32-arm64": "win32-arm64",
    "darwin-x64": "darwin-x64",
    "darwin-arm64": "darwin-arm64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
  };
  return known[key] ?? null;
}

function candidatePaths(triple: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  return [
    // A locally built binary, which is how the package is developed.
    join(root, `pify-search.${triple}.node`),
    join(root, "native", "target", "release", `pify-search.${triple}.node`),
  ];
}

/**
 * Load the native core, or null when this platform has no binary.
 * `PIFY_SEARCH_ENGINE=builtin` forces the fallback, which is how both paths
 * get tested on a machine that has the binary.
 */
export function loadNative(root: string, maxFiles?: number): SearchEngine | null {
  if (process.env.PIFY_SEARCH_ENGINE === "builtin") return null;
  const triple = tripleOf(process.platform, process.arch);
  if (!triple) return null;

  const require = createRequire(import.meta.url);
  let mod: NativeModule | null = null;
  for (const path of candidatePaths(triple)) {
    if (!existsSync(path)) continue;
    try {
      mod = require(path) as NativeModule;
      break;
    } catch {
      // A binary that will not load is the same as one that is not there.
    }
  }
  if (!mod) {
    try {
      mod = require(`@pify/search-${triple}`) as NativeModule;
    } catch {
      return null;
    }
  }

  let index: NativeIndex;
  try {
    index = new mod.SearchIndex(root, maxFiles, cachePathFor(root));
  } catch {
    return null;
  }

  // The Rust core has no watcher of its own, so without this it only ever
  // learned about files edit/write changed — anything bash, a subagent, or an
  // external editor created, deleted or rewrote stayed invisible, which is the
  // one false negative the index is meant never to produce. The filtering
  // mirrors the builtin walk so the watcher and the walk agree on what belongs.
  const watchers: FSWatcher[] = [];
  const ignorePatterns = (() => {
    try {
      return parseIgnore(readFileSync(join(root, ".gitignore"), "utf8"));
    } catch {
      return [];
    }
  })();
  const ignored = (rel: string, isDir: boolean): boolean => {
    if (ignorePatterns.length === 0 || !rel || rel.startsWith("..")) return false;
    return ignoreMatches(ignorePatterns, isDir ? `${rel}/` : rel);
  };
  const startWatching = (): void => {
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = normalizePath(String(filename));
        if (rel.split("/").some((part) => skipDirectory(part))) return;
        if (ignored(rel, false)) return;
        const absolute = join(root, String(filename));
        // Stat first, so a napi error from refresh() can never be mistaken for
        // "the file is gone" and wrongly forget a file that is still there.
        let stats;
        try {
          stats = statSync(absolute);
        } catch {
          // Gone: a delete, a rename away, or something we may not read.
          try {
            index.forget(rel);
          } catch {
            // A file we cannot forget stays as it was until the next reconcile.
          }
          return;
        }
        if (!stats.isFile()) return;
        try {
          index.refresh(rel);
        } catch {
          // A file we cannot re-read stays as it was.
        }
      });
      watchers.push(watcher);
    } catch {
      // Recursive watching is not available everywhere; reconcile() on a bash
      // result and the fresh walk at every session start still keep it honest.
    }
  };
  startWatching();

  const pageOf = <T>(page: NativePage<T>): Page<T> => ({
    items: page.items,
    total: page.total,
    cursor: page.next >= 0 ? String(page.next) : null,
    // Native scans every candidate it is given, so its counts are always exact.
    exact: true,
  });
  const offsetOf = (cursor?: string) => {
    const n = Number.parseInt(cursor ?? "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  return {
    name: "native",
    async ready() {
      // The index is built in the constructor, so by here it is done.
      return true;
    },
    async find(query: string, options: FindOptions = {}) {
      return pageOf(index.find(query, options.limit ?? 20, offsetOf(options.cursor), Date.now()));
    },
    async grep(pattern: string, options: GrepOptions = {}) {
      return pageOf(
        index.grep(
          pattern,
          options.mode ?? "literal",
          options.limit ?? 20,
          offsetOf(options.cursor),
          options.caseInsensitive !== false,
        ),
      );
    },
    touch(path: string) {
      try {
        index.touch(path);
      } catch {
        // Frecency is a ranking nicety, never a reason to fail a search.
      }
    },
    refresh(path: string) {
      try {
        index.refresh(path);
      } catch {
        // A file we cannot re-read stays as it was.
      }
    },
    forget(path: string) {
      try {
        index.forget(path);
      } catch {
        // ditto
      }
    },
    reconcile() {
      try {
        index.reconcile();
      } catch {
        // A reconcile that fails leaves the index as fresh as its last event.
      }
    },
    indexed() {
      try {
        return index.fileCount();
      } catch {
        return 0;
      }
    },
    stats() {
      try {
        return { reused: index.reusedCount(), rebuilt: index.rebuiltCount() };
      } catch {
        return { reused: 0, rebuilt: 0 };
      }
    },
    dispose() {
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // already closed
        }
      }
      watchers.length = 0;
      // Deliberately not saving here. Anything `refresh` changed during the
      // session has a new mtime on disk, so the next start sees the mismatch
      // and re-reads those files anyway — writing the whole index out at exit
      // would cost a multi-megabyte write to save a handful of file reads.
    },
  };
}
