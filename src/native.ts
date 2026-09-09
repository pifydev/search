/**
 * The native core, when there is one.
 *
 * A Rust index built for this package: the same trigram narrowing and the same
 * scoring constants as the TypeScript fallback, compiled. It builds an index
 * of this suite — 417 files — in about 33ms, and a literal search then reads 5
 * of those files instead of all of them.
 *
 * The binary is an optional dependency per platform, in the napi convention.
 * If none of them installed, this returns null and the caller falls back;
 * nothing here ever throws for a missing binary, because a missing binary is
 * the ordinary case this package is designed to survive.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContentHit, FileHit, GrepOptions, Page, SearchEngine, FindOptions } from "./engine.ts";

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
  touch(path: string): void;
  refresh(path: string): void;
  forget(path: string): void;
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
  SearchIndex: new (root: string, maxFiles?: number) => NativeIndex;
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
  if (process.env.PIFY_SEARCH_ENGINE === "builtin" || process.env.PIFY_SEARCH_ENGINE === "fff") {
    return null;
  }
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
    index = new mod.SearchIndex(root, maxFiles);
  } catch {
    return null;
  }

  const pageOf = <T>(page: NativePage<T>): Page<T> => ({
    items: page.items,
    total: page.total,
    cursor: page.next >= 0 ? String(page.next) : null,
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
    indexed() {
      try {
        return index.fileCount();
      } catch {
        return 0;
      }
    },
    dispose() {
      // The Rust side owns nothing that outlives the object.
    },
  };
}
