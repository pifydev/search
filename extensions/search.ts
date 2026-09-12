/**
 * @pify/search — fuzzy file finding and indexed content search for pi.
 *
 * pi's `find` and `grep` spawn a process and read the tree on every call.
 * That is the right design for a one-shot command and the wrong one for an
 * agent, which asks over and over inside a single session. An index built once
 * and kept current answers the second question and the fiftieth from memory.
 *
 * Two engines behind one interface. The fast path is this package's own Rust
 * core — a trigram index over contents, typo-resistant path matching, git
 * status and frecency — which keeps its index between sessions. The fallback
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SearchEngine } from "../src/engine.ts";
import { loadNative } from "../src/native.ts";
import { builtinEngine } from "../src/builtin.ts";
import { parseHistory, pruneHistory, type History } from "../src/frecency.ts";
import { formatFiles, formatMatches, formatStatus } from "../src/format.ts";

const READY_TIMEOUT_MS = 20_000;

export default function searchExtension(pi: ExtensionAPI) {
  let engine: SearchEngine | null = null;
  let starting: Promise<SearchEngine | null> | null = null;
  let root = "";
  let historyFile: string | null = null;

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

  function saveHistory(history: History): void {
    if (!historyFile) return;
    try {
      mkdirSync(dirname(historyFile), { recursive: true });
      writeFileSync(historyFile, `${JSON.stringify(pruneHistory(history, Date.now()))}\n`);
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
        // This package's own core when there is a binary for this platform,
        // and the fallback that always works when there is not.
        const chosen =
          loadNative(root) ??
          builtinEngine(root, { history: loadHistory(), onHistoryChange: saveHistory });
        await chosen.ready(READY_TIMEOUT_MS);
        engine = chosen;
        return chosen;
      })();
    }
    return starting;
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "fffind",
    label: "Find files",
    description:
      "Find files by name or path with fuzzy, typo-tolerant matching, ranked so the file you meant " +
      "comes first — recently edited and git-modified files rank higher. Prefer this over find/ls " +
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
        content: [{ type: "text", text: formatFiles(page, params.query) }],
        details: { total: page.total, cursor: page.cursor, engine: active.name },
      };
    },
  });

  pi.registerTool({
    name: "ffgrep",
    label: "Search contents",
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
        content: [{ type: "text", text: formatMatches(page, params.pattern, params.mode ?? "literal") }],
        details: { total: page.total, cursor: page.cursor, engine: active.name },
      };
    },
  });

  // ── Frecency: what the session actually touched ──────────────────────

  pi.on("tool_call", async (event) => {
    const name = (event as { toolName?: string }).toolName;
    if (name !== "read" && name !== "edit" && name !== "write") return undefined;
    const path = (event as { input?: { path?: unknown } }).input?.path;
    if (typeof path === "string") engine?.touch?.(path);
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    // The agent just changed a file, so the index is stale for it. Re-reading
    // one path is cheap; noticing later that a search missed a line the agent
    // itself wrote is not.
    const name = (event as { toolName?: string }).toolName;
    if (name !== "edit" && name !== "write") return;
    if ((event as { isError?: boolean }).isError === true) return;
    const path = (event as { input?: Record<string, unknown> }).input?.path;
    if (typeof path === "string") engine?.refresh?.(path);
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Indexing starts now rather than at the first search, so the first
    // question is as fast as the fiftieth. Deliberately not awaited: a large
    // tree must not hold up the session.
    void ensureEngine(ctx);
  });

  pi.on("session_shutdown", async () => {
    engine?.dispose();
    engine = null;
    starting = null;
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
