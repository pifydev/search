/**
 * What belongs in the index.
 *
 * An index that holds `node_modules` is an index that answers slowly and
 * wrongly — the file you meant is buried under ten thousand you did not. The
 * rules here are deliberately boring and hard-coded rather than a gitignore
 * parser: the point is to be right about the obvious cases with no
 * dependencies, and to stay predictable.
 *
 * Pure decisions, so the walker that uses them can be tested without a disk.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

/** Directories nothing good ever comes out of. */
export const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".gradle",
  ".idea",
  ".vscode-test",
  "coverage",
  ".nyc_output",
  "vendor",
  "Pods",
  ".terraform",
  ".DS_Store",
]);

/** Extensions whose contents are never worth a text search. */
export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tiff", "psd",
  "mp3", "mp4", "wav", "ogg", "flac", "avi", "mov", "mkv", "webm",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "lib", "obj", "pdb",
  "class", "pyc", "pyo", "wasm", "node",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3", "pack", "idx",
  // "lock" is deliberately absent: yarn.lock, Cargo.lock, bun.lock and
  // Gemfile.lock are text the model greps often, and excluding them made a
  // literal search for a pinned version report "no match" over a file that
  // plainly contains it.
]);

/** Largest file whose content is indexed — fff's cap, and for its reason. */
export const MAX_INDEXABLE_BYTES = 2 * 1024 * 1024;
/** Largest file read at all during a search. */
export const MAX_SEARCHABLE_BYTES = 10 * 1024 * 1024;

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function skipDirectory(name: string): boolean {
  return SKIP_DIRS.has(name);
}

/** Whether this path is worth listing at all (it may still be binary). */
export function includeFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "" || name.startsWith(".DS_Store")) return false;
  return true;
}

/** Whether this file's *content* should go into the trigram index. */
export function indexContent(path: string, bytes: number): boolean {
  if (bytes > MAX_INDEXABLE_BYTES || bytes === 0) return false;
  return !BINARY_EXTENSIONS.has(extensionOf(path));
}

/** Forward slashes everywhere, so a path means the same thing on Windows. */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Turn a path as pi hands it to a tool — which its `read`/`edit`/`write`
 * schemas document as "relative or absolute", and which may start with `~` —
 * into the root-relative key the index stores under, or null when it points
 * outside the tree.
 *
 * The bug this fixes: the frecency history was keyed on the raw tool path, so
 * an absolute `D:/project/x/src/a.ts` never equalled the index's `src/a.ts`
 * and the ranking boost the docs promise silently never applied.
 */
export function toIndexKey(root: string, rawPath: string): string | null {
  let p = rawPath;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = resolve(homedir(), p.slice(2));
  const rel = normalizePath(relative(root, resolve(root, p)));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * A minimal `.gitignore` reading: the lines people actually write. Globs with
 * `**`, negations and anchors are honoured; anything more exotic is ignored
 * rather than half-understood, because a wrong ignore hides files silently.
 */
export function parseIgnore(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function ignoreMatches(patterns: readonly string[], relPath: string): boolean {
  let ignored = false;
  for (const raw of patterns) {
    const negate = raw.startsWith("!");
    const pattern = negate ? raw.slice(1) : raw;
    if (matchesGlob(pattern, relPath)) ignored = !negate;
  }
  return ignored;
}

function matchesGlob(pattern: string, path: string): boolean {
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.slice(1) : pattern;
  const dirOnly = body.endsWith("/");
  const clean = dirOnly ? body.slice(0, -1) : body;

  // `**` is lifted out by splitting rather than parked on a placeholder
  // byte: the old NUL placeholder worked, but a raw control byte in the
  // source made git treat this whole file as binary - no diffs, no review,
  // no grep. Splitting cannot collide with anything in the input.
  const escaped = clean
    .split("**")
    .map((segment) =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]"),
    )
    .join(".*");

  const re = new RegExp(anchored ? `^${escaped}(/|$)` : `(^|/)${escaped}(/|$)`);
  return re.test(path);
}
