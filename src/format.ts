/**
 * How results read.
 *
 * A search result is consumed by a model that will decide what to open next,
 * so the shape matters: one line per hit, path first, and the cursor stated in
 * words rather than left in a details field the model may not look at. A
 * result set that silently stops at twenty looks like a complete answer, which
 * is how an agent concludes something does not exist.
 */

import type { ContentHit, FileHit, GrepMode, Page, SearchEngine } from "./engine.ts";

function more(page: Page<unknown>, tool: string): string {
  if (!page.cursor) return "";
  const shown = page.items.length;
  return `\n\n${page.total - shown} more. Continue with ${tool} cursor="${page.cursor}".`;
}

export function formatFiles(page: Page<FileHit>, query: string): string {
  if (page.items.length === 0) {
    return `No file matches "${query}". Try fewer characters — matching is fuzzy, so a fragment of the name works better than a guess at the full path.`;
  }
  const lines = page.items.map((hit) => {
    const marks: string[] = [];
    if (hit.git) marks.push(hit.git);
    return `${hit.path}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`;
  });
  return `${page.total} file${page.total === 1 ? "" : "s"} match "${query}", best first:\n${lines.join("\n")}${more(page, "fffind")}`;
}

export function formatMatches(page: Page<ContentHit>, pattern: string, mode: GrepMode): string {
  if (page.items.length === 0) {
    const hint =
      mode === "literal"
        ? ' Try mode="fuzzy" if you are unsure of the exact wording, or mode="regex" for a pattern.'
        : "";
    return `No match for "${pattern}" (${mode}).${hint}`;
  }
  const lines = page.items.map((hit) => `${hit.path}:${hit.line}: ${hit.text.trim().slice(0, 200)}`);
  return `${page.total} match${page.total === 1 ? "" : "es"} for "${pattern}" (${mode}):\n${lines.join("\n")}${more(page, "ffgrep")}`;
}

export function formatStatus(engine: SearchEngine | null, root: string): string {
  if (!engine) {
    return "No search engine is running. fffind and ffgrep will start one on first use.";
  }
  const lines = [
    `Engine: ${engine.name === "fff" ? "fff (native index, live watcher)" : "builtin (pure TypeScript, no native binary)"}`,
    `Root:   ${root}`,
  ];
  const count = engine.indexed?.();
  if (typeof count === "number") lines.push(`Files:  ${count} indexed`);
  if (engine.name === "builtin") {
    lines.push(
      "",
      "The native engine was not available — either @ff-labs/fff-node is not installed or it has no",
      "binary for this platform. The builtin engine is slower but needs nothing installed.",
    );
  }
  return lines.join("\n");
}
