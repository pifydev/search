/**
 * @pify/search — fuzzy file finding and indexed content search for pi.
 *
 * pi's `find` and `grep` spawn a process and read the tree on every call.
 * That is the right design for a one-shot command and the wrong one for an
 * agent, which asks over and over inside a single session. An index built once
 * and kept current answers the second question and the fiftieth from memory.
 *
 * Two engines behind one interface. The fast path is this package's own Rust
 * core — a trigram index over contents, typo-resistant path matching, and
 * frecency — which keeps its index between sessions. The fallback
 * is pure TypeScript with no dependencies, because a native binary is a
 * promise you cannot always keep: an unsupported platform or a blocked
 * postinstall would otherwise leave a search extension that does nothing.
 *
 * pi's own tools are left alone. Replacing `grep` and `find` would put every
 * search in the session behind whichever engine loaded, and a fallback that is
 * slower than the thing it replaced is not an improvement anyone asked for.
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SearchEngine } from "../src/engine.ts";
import { loadNative } from "../src/native.ts";
import { builtinEngine } from "../src/builtin.ts";
import { mergeHistories, parseHistory, pruneHistory, type History } from "../src/frecency.ts";
import { toIndexKey } from "../src/walk.ts";
import { formatFiles, formatMatches, formatStatus } from "../src/format.ts";

const READY_TIMEOUT_MS = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default function searchExtension(pi: ExtensionAPI) {
  let engine: SearchEngine | null = null;
  let starting: Promise<SearchEngine | null> | null = null;
  let root = "";
  let historyFile: string | null = null;
  // False until the first index build has landed, so a search mid-build can say
  // so rather than looking like it found nothing.
  let indexReady = false;
  // Debounced, merge-on-write history persistence (see flushHistory).
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingHistory: History | null = null;
  // Debounced re-walk after bash, which can create/delete/move files with no
  // per-file signal the extension could forward.
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  function historyPath(cwd: string): string {
    const key = createHash("sha256").update(cwd.toLowerCase()).digest("hex").slice(0, 12);
    return join(getAgentDir(), "pify-search", `${key}.json`);
  }

  function loadHistory(): History {
    if (!historyFile) return {};
    try {
      return pruneHistory(parseHistory(readFileSync(historyFile, "utf8")), Date.now());
    } catch {
      return {};
    }
  }

  // Coalesce a burst of touches into one write ~500ms later. The engine calls
  // this on every read/edit/write, and each write is a whole-file rewrite; a
  // debounce turns forty touches into one.
  function saveHistory(history: History): void {
    if (!historyFile) return;
    pendingHistory = history;
    if (saveTimer) return;
    saveTimer = setTimeout(flushHistory, 500);
  }

  function flushHistory(): void {
    saveTimer = null;
    const mine = pendingHistory;
    pendingHistory = null;
    if (!historyFile || !mine) return;
    try {
      const now = Date.now();
      // Merge with whatever other sessions in this cwd have written since we
      // loaded: the file key is a hash of the cwd, so a plain overwrite made two
      // sessions in one repo clobber each other's touches. Re-read, fold ours
      // in, then write to a temp file and rename over the target so a reader
      // that races the write never sees a half-written, unparseable file.
      let onDisk: History = {};
      try {
        onDisk = parseHistory(readFileSync(historyFile, "utf8"));
      } catch {
        onDisk = {};
      }
      const merged = pruneHistory(mergeHistories(onDisk, mine), now);
      mkdirSync(dirname(historyFile), { recursive: true });
      const tmp = `${historyFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(merged)}\n`);
      renameSync(tmp, historyFile);
    } catch {
      // A history that cannot be written costs ranking, never a search.
    }
  }

  /** Start once; every caller awaits the same start. */
  async function ensureEngine(ctx: ExtensionContext): Promise<SearchEngine | null> {
    if (engine) return engine;
    if (!starting) {
      root = ctx.cwd;
      historyFile = historyPath(ctx.cwd);
      starting = (async () => {
        // Yield first, so this returns to pi before any indexing runs. The
        // builtin scan and the native constructor are both real work; running
        // them inline would block the event loop, freezing the TUI and every
        // extension whose session_start pi has yet to await.
        await new Promise((resolve) => setImmediate(resolve));
        // This package's own core when there is a binary for this platform,
        // and the fallback that always works when there is not.
        const chosen =
          loadNative(root) ??
          builtinEngine(root, { history: loadHistory(), onHistoryChange: saveHistory });
        // Publish the engine immediately so a search can serve from the index
        // as it fills; the builtin scan reads from partial maps meanwhile.
        engine = chosen;
        const settled = chosen.ready(READY_TIMEOUT_MS).then(
          () => {
            indexReady = true;
            return true;
          },
          () => {
            indexReady = true;
            return false;
          },
        );
        // Honour the timeout here rather than in each engine (where it was dead
        // code): if the build outruns it, hand back the partial index anyway.
        await Promise.race([settled, sleep(READY_TIMEOUT_MS).then(() => false)]);
        return chosen;
      })();
    }
    return starting;
  }

  /** How many files the index holds, when a search runs before the build lands. */
  function buildingCount(): number | undefined {
    return indexReady ? undefined : engine?.indexed?.();
  }

  function scheduleReconcile(): void {
    if (!engine?.reconcile) return;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      engine?.reconcile?.();
    }, 1_000);
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "fffind",
    label: "Find files",
    // Without a snippet a custom tool is left out of the system prompt's
    // "Available tools" list entirely — pi filters that list by exactly this
    // field. Measured: the API schema carried fffind and ffgrep while the
    // prompt named only read/bash/edit/write, and described bash as
    // "Execute bash commands (ls, grep, find, etc.)". The prompt was pointing
    // the agent at bash grep while the tools built for the job went unnamed.
    promptSnippet: "Find files by fuzzy name or path, ranked by relevance",
    promptGuidelines: [
      "Use fffind to locate a file by an approximate name instead of `find` or `ls` through bash.",
    ],
    description:
      "Find files by name or path with fuzzy, typo-tolerant matching, ranked so the file you meant " +
      "comes first — recently edited files rank higher. Prefer this over find/ls " +
      "when you know roughly what the file is called but not exactly where it is. Returns a cursor " +
      "for the next page when there are more results.",
    parameters: Type.Object({
      query: Type.String({ description: "Part of the filename or path; typos are tolerated" }),
      limit: Type.Optional(Type.Number({ description: "Results per page (default 20)" })),
      cursor: Type.Optional(Type.String({ description: "Cursor from a previous call" })),
    }),
    async execute(_id, params: { query: string; limit?: number; cursor?: string }, _signal, _onUpdate, ctx) {
      const active = await ensureEngine(ctx as ExtensionContext);
      if (!active) throw new Error("No search engine available.");
      const page = await active.find(params.query.trim(), {
        limit: Math.min(100, Math.max(1, params.limit ?? 20)),
        ...(params.cursor ? { cursor: params.cursor } : {}),
      });
      return {
        content: [{ type: "text", text: formatFiles(page, params.query, buildingCount()) }],
        details: { total: page.total, cursor: page.cursor, engine: active.name },
      };
    },
  });

  pi.registerTool({
    name: "ffgrep",
    label: "Search contents",
    promptSnippet: "Search file contents with a literal, regex, or fuzzy pattern over an index",
    promptGuidelines: [
      "Use ffgrep to search file contents instead of `grep` or `rg` through bash: it reads only the files a trigram index says could match, and it skips node_modules and anything the repository's .gitignore excludes.",
    ],
    description:
      "Search file contents from an in-memory index rather than re-reading the tree. mode=literal " +
      "(default) for an exact string, regex for a pattern, fuzzy when you are unsure of the exact " +
      "wording. Prefer this over grep for repeated searches in one session. Returns a cursor for " +
      "the next page when there are more matches.",
    parameters: Type.Object({
      pattern: Type.String({ description: "What to search for" }),
      mode: Type.Optional(StringEnum(["literal", "regex", "fuzzy"] as const)),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Default false" })),
      limit: Type.Optional(Type.Number({ description: "Matches per page (default 20)" })),
      cursor: Type.Optional(Type.String({ description: "Cursor from a previous call" })),
    }),
    async execute(
      _id,
      params: { pattern: string; mode?: "literal" | "regex" | "fuzzy"; caseSensitive?: boolean; limit?: number; cursor?: string },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const active = await ensureEngine(ctx as ExtensionContext);
      if (!active) throw new Error("No search engine available.");
      const page = await active.grep(params.pattern, {
        mode: params.mode ?? "literal",
        caseInsensitive: params.caseSensitive !== true,
        limit: Math.min(100, Math.max(1, params.limit ?? 20)),
        ...(params.cursor ? { cursor: params.cursor } : {}),
      });
      return {
        content: [
          { type: "text", text: formatMatches(page, params.pattern, params.mode ?? "literal", buildingCount()) },
        ],
        details: { total: page.total, cursor: page.cursor, engine: active.name },
      };
    },
  });

  // ── Frecency: what the session actually touched ──────────────────────

  pi.on("tool_call", async (event) => {
    const name = (event as { toolName?: string }).toolName;
    if (name !== "read" && name !== "edit" && name !== "write") return undefined;
    const path = (event as { input?: { path?: unknown } }).input?.path;
    // pi forwards the model's raw path, which its schemas allow to be absolute
    // or `~`-prefixed. The index keys on root-relative paths, so an absolute
    // path here never matched an entry and the frecency boost silently never
    // landed. Normalise to the index's key, or drop it when it points outside.
    if (engine && typeof path === "string") {
      const rel = toIndexKey(root, path);
      if (rel) engine.touch?.(rel);
    }
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    const name = (event as { toolName?: string }).toolName;
    if ((event as { isError?: boolean }).isError === true) return;
    // The agent just changed a file, so the index is stale for it. Re-reading
    // one path is cheap; noticing later that a search missed a line the agent
    // itself wrote is not.
    if (name === "edit" || name === "write") {
      const path = (event as { input?: Record<string, unknown> }).input?.path;
      if (engine && typeof path === "string") {
        const rel = toIndexKey(root, path);
        if (rel) engine.refresh?.(rel);
      }
      return;
    }
    // bash can create, delete, move or rewrite files with no per-file signal
    // (sed, git checkout, a formatter, a scaffolder). The native engine has no
    // watcher it can fully trust, so re-walk and reconcile — debounced, since a
    // command often runs several file operations in a row.
    if (name === "bash") scheduleReconcile();
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Indexing starts now rather than at the first search, so the first
    // question is as fast as the fiftieth. Not awaited, and now genuinely
    // deferred: ensureEngine yields before it touches the disk, so a large tree
    // no longer holds up this handler or the extensions loaded after it.
    void ensureEngine(ctx);
  });

  pi.on("session_shutdown", async () => {
    // Land any debounced touches before the engine goes, so a short session's
    // ranking is not lost to a timer that never fired.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    flushHistory();
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
    engine?.dispose();
    engine = null;
    starting = null;
    indexReady = false;
  });

  pi.registerCommand("search", {
    description: "Which search engine is running, and what it has indexed",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const active = await ensureEngine(ctx);
      ctx.ui.notify(formatStatus(active, root), "info");
    },
  });
}
