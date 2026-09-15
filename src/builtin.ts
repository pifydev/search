/**
 * The engine that needs nothing installed.
 *
 * Everything here is the pure modules wired to a disk: walk the tree once,
 * hold the paths in memory, build a trigram index over the text files, and
 * keep both current from a watcher. It is slower than the Rust one and it runs
 * wherever pi runs, which is the whole point — a search extension that only
 * works when a native binary installed is an extension that sometimes does
 * nothing at all.
 */

import { readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, relative } from "node:path";

import type { ContentHit, FileHit, GrepOptions, Page, SearchEngine, FindOptions } from "./engine.ts";
import { rankAndPage, type Candidate } from "./fuzzy.ts";
import { buildMatcher, looksBinary, matchLines } from "./match.ts";
import { TrigramIndex, planForLiteral, planForPatterns, planForRegex } from "./trigram.ts";
import {
  MAX_SEARCHABLE_BYTES,
  ignoreMatches,
  includeFile,
  parseIgnore,
  indexContent,
  normalizePath,
  skipDirectory,
} from "./walk.ts";
import { frecencyOf, noteAccess, type History } from "./frecency.ts";

interface Entry {
  id: number;
  path: string;
  absolute: string;
  size: number;
  mtimeMs: number;
}

export interface BuiltinOptions {
  /** Frecency history, owned by the caller so it can be persisted. */
  history?: History;
  onHistoryChange?: (history: History) => void;
  /** Hard cap, so a wrong root cannot eat the session. */
  maxFiles?: number;
}

export function builtinEngine(root: string, options: BuiltinOptions = {}): SearchEngine {
  const entries = new Map<number, Entry>();
  const byPath = new Map<string, number>();
  const index = new TrigramIndex();
  const watchers: FSWatcher[] = [];
  const maxFiles = options.maxFiles ?? 50_000;
  let history: History = options.history ?? {};
  let nextId = 1;
  let scanned = false;

  function add(absolute: string, size: number, mtimeMs: number): void {
    const path = normalizePath(relative(root, absolute));
    if (!path || !includeFile(path)) return;
    const existing = byPath.get(path);
    const id = existing ?? nextId++;
    entries.set(id, { id, path, absolute, size, mtimeMs });
    byPath.set(path, id);

    if (!indexContent(path, size)) {
      index.remove(id);
      return;
    }
    try {
      const content = readFileSync(absolute, "utf8");
      // A NUL byte is cheaper and more reliable than trusting an extension.
      if (looksBinary(content)) index.remove(id);
      else index.add(id, content);
    } catch {
      index.remove(id);
    }
  }

  function drop(absolute: string): void {
    const path = normalizePath(relative(root, absolute));
    const id = byPath.get(path);
    if (id === undefined) return;
    byPath.delete(path);
    entries.delete(id);
    index.remove(id);
  }

  /**
   * The repository's own ignore rules, read once at the root.
   *
   * The hard-coded skip list knows about `node_modules` and `target`; it
   * cannot know that this project generates `build-out/` or writes
   * `secrets.env`. Those are exactly the files a repository has already said
   * it does not want carried around — and an index that carries them lets
   * `ffgrep` surface a credential the repo deliberately excluded.
   *
   * Only the root `.gitignore` is read. Nested ones and the full git ignore
   * precedence are not, because a half-implemented ignore hides files
   * silently, and under-ignoring is the safer direction to be wrong in.
   */
  const ignorePatterns = (() => {
    try {
      return parseIgnore(readFileSync(join(root, ".gitignore"), "utf8"));
    } catch {
      return [];
    }
  })();

  function ignored(absolute: string, isDir: boolean): boolean {
    if (ignorePatterns.length === 0) return false;
    const rel = normalizePath(relative(root, absolute));
    if (!rel || rel.startsWith("..")) return false;
    // A directory pattern (`generated/`) has to be matched against the
    // directory's own path, so the whole subtree is skipped rather than every
    // file under it being tested one at a time.
    return ignoreMatches(ignorePatterns, isDir ? `${rel}/` : rel);
  }

  function scan(dir: string, depth = 0): void {
    if (entries.size >= maxFiles || depth > 24) return;
    let listing: string[];
    try {
      listing = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of listing) {
      if (entries.size >= maxFiles) return;
      const absolute = join(dir, name);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (skipDirectory(name) || ignored(absolute, true)) continue;
        scan(absolute, depth + 1);
      } else if (stats.isFile()) {
        if (ignored(absolute, false)) continue;
        add(absolute, stats.size, stats.mtimeMs);
      }
    }
  }

  function startWatching(): void {
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const absolute = join(root, String(filename));
        const parts = normalizePath(String(filename)).split("/");
        if (parts.some((part) => skipDirectory(part))) return;
        // A file created under an ignored path must not sneak in through the
        // watcher after the walk correctly skipped it.
        if (ignored(absolute, false)) return;
        try {
          const stats = statSync(absolute);
          if (stats.isFile()) add(absolute, stats.size, stats.mtimeMs);
        } catch {
          // Gone: a delete, a rename away, or something we may not read.
          drop(absolute);
        }
      });
      watchers.push(watcher);
    } catch {
      // Recursive watching is not available everywhere; the index is then
      // simply as fresh as the last scan, which is still useful.
    }
  }

  function candidates(now: number): Candidate[] {
    return [...entries.values()].map((entry) => ({
      path: entry.path,
      frecency: frecencyOf(history, entry.path, now),
      mtimeMs: entry.mtimeMs,
    }));
  }

  return {
    name: "builtin",
    async ready() {
      if (!scanned) {
        scan(root);
        startWatching();
        scanned = true;
      }
      return true;
    },
    async find(query: string, opts: FindOptions = {}): Promise<Page<FileHit>> {
      const now = Date.now();
      const page = rankAndPage(candidates(now), query, now, opts.limit ?? 20, opts.cursor);
      return {
        items: page.items.map((hit) => {
          const id = byPath.get(hit.path);
          const entry = id === undefined ? undefined : entries.get(id);
          return { path: hit.path, score: hit.score, size: entry?.size, modifiedMs: entry?.mtimeMs };
        }),
        total: page.total,
        cursor: page.cursor,
      };
    },
    async grep(pattern: string, opts: GrepOptions = {}): Promise<Page<ContentHit>> {
      const mode = opts.mode ?? "literal";
      const caseInsensitive = opts.caseInsensitive ?? true;
      // A broken regex is a caller mistake, not an empty tree. Constructing it
      // here lets the failure surface as a clear error; swallowing it and
      // returning "no match" reads as "the pattern is fine and nothing has it",
      // which sends the caller looking in the wrong place. buildMatcher keeps
      // its null-on-broken contract for its other callers, so the check lives
      // here where an empty result and an unusable pattern must be told apart.
      if (mode === "regex") {
        try {
          new RegExp(pattern, caseInsensitive ? "i" : "");
        } catch (err) {
          throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
        }
      }
      const matcher = buildMatcher(pattern, mode, caseInsensitive);
      if (!matcher) return { items: [], total: 0, cursor: null };

      // Fuzzy matching has no required substring, so the index cannot narrow
      // it; saying so honestly beats narrowing wrongly and losing matches.
      //
      // The plan is ALWAYS case-folded, whatever the caller asked, because the
      // index stores only folded trigrams — the plan must speak the index's
      // encoding or it asks for postings that structurally cannot exist.
      // Planning `TODO` case-sensitively looked up `TOD`/`ODO` in a lowercase
      // index and returned "no match" over a tree full of TODOs. Case
      // sensitivity is the MATCHER's job: the index only narrows, and every
      // candidate is still verified against the real pattern below.
      const plan =
        mode === "fuzzy"
          ? { kind: "all" as const }
          : planForPatterns([mode === "regex" ? planForRegex(pattern, true) : planForLiteral(pattern, true)]);
      const narrowed = index.candidates(plan);

      const limit = opts.limit ?? 20;
      const offset = Number.parseInt(opts.cursor ?? "0", 10);
      const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
      // One page beyond what is asked for, so `total` can say whether there is
      // more without reading the entire tree to find out.
      const budget = start + limit + 1;

      // Read candidates in path order, so hits accumulate already sorted and
      // the first `budget` of them are the true sorted prefix. Reading in scan
      // (insertion) order and sorting only afterwards let a file that sorts
      // early but was scanned late fall outside the budget entirely: the page
      // then skipped real matches, and `total` undercounted them.
      const searchIds = (narrowed === null ? [...entries.keys()] : [...narrowed]).sort(
        (a, b) => (entries.get(a)?.path ?? "").localeCompare(entries.get(b)?.path ?? ""),
      );
      // A narrowed plan reads a bounded, index-selected candidate set, so every
      // match can be collected and `total` is exact. Only the "all" fallback
      // could read the whole tree, so it alone stops one page past the ask and
      // reports a lower bound rather than paying for a full scan just to count.
      const exhaustive = narrowed !== null;

      const hits: ContentHit[] = [];
      for (const id of searchIds) {
        if (!exhaustive && hits.length >= budget) break;
        const entry = entries.get(id);
        if (!entry || entry.size > MAX_SEARCHABLE_BYTES) continue;
        if (opts.glob && !entry.path.includes(opts.glob.replace(/\*/g, ""))) continue;
        let content: string;
        try {
          content = readFileSync(entry.absolute, "utf8");
        } catch {
          continue;
        }
        if (looksBinary(content)) continue;
        const room = exhaustive ? Number.POSITIVE_INFINITY : budget - hits.length;
        for (const line of matchLines(content, matcher, room)) {
          hits.push({ path: entry.path, line: line.line, text: line.text });
        }
      }

      hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      const items = hits.slice(start, start + limit);
      return { items, total: hits.length, cursor: start + items.length < hits.length ? String(start + items.length) : null };
    },
    touch(path: string) {
      history = noteAccess(history, normalizePath(path), Date.now());
      options.onHistoryChange?.(history);
    },
    indexed() {
      return entries.size;
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
      entries.clear();
      byPath.clear();
    },
  };
}
