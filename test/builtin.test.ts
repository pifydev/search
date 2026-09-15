import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinEngine } from "../src/builtin.ts";
import type { ContentHit, Page } from "../src/engine.ts";

/**
 * A throwaway tree, its root injected straight into the engine.
 *
 * Roots are passed in rather than exported through the environment on purpose:
 * `os.homedir()` and the cache path can be cached on first read under bun, so
 * overriding HOME after the process starts would not take. Injecting the root
 * keeps the test honest and off the real filesystem the walker would otherwise
 * find.
 */
function makeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pify-search-builtin-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/** Drain every page through the cursor, the way a caller paginates. */
async function drain(
  engine: ReturnType<typeof builtinEngine>,
  pattern: string,
  limit: number,
): Promise<{ items: ContentHit[]; firstTotal: number; pages: number }> {
  const items: ContentHit[] = [];
  let cursor: string | undefined;
  let firstTotal = -1;
  let pages = 0;
  // A generous ceiling so a pagination bug loops out instead of hanging.
  for (let guard = 0; guard < 1000; guard++) {
    const page: Page<ContentHit> = await engine.grep(pattern, {
      mode: "literal",
      limit,
      ...(cursor ? { cursor } : {}),
    });
    pages++;
    if (firstTotal < 0) firstTotal = page.total;
    items.push(...page.items);
    if (page.cursor === null) break;
    cursor = page.cursor;
  }
  return { items, firstTotal, pages };
}

test("builtin grep paginates a narrowed search without skips, dups, or an undercounted total", async () => {
  // Each pair puts a match both inside a directory `dNN` and in a sibling file
  // `dNN.txt`. readdir yields `dNN` before `dNN.txt`, so the depth-first walk
  // indexes `dNN/inner.txt` first — yet `dNN.txt` sorts *before* `dNN/inner.txt`
  // by path (`.` < `/`). Scan order is therefore the reverse of path order for
  // every pair, which is exactly the condition the old code mishandled: it read
  // in scan order, capped at one page past the ask, then sorted — so the true
  // first matches were never read, and `total` stopped at the cap.
  const NEEDLE = "NEEDLEWORD";
  const files: Record<string, string> = {};
  const expected: string[] = [];
  const PAIRS = 15; // 30 matches, well past the page limit
  for (let i = 0; i < PAIRS; i++) {
    const tag = String(i).padStart(2, "0");
    files[`d${tag}/inner.txt`] = `${NEEDLE}\n`;
    files[`d${tag}.txt`] = `${NEEDLE}\n`;
    expected.push(`d${tag}/inner.txt`, `d${tag}.txt`);
  }
  const total = expected.length;
  // Derive the oracle with the engine's own comparator, so the assertion is
  // about no-skip/no-dup/correct-total rather than any particular collation.
  expected.sort((a, b) => a.localeCompare(b));

  const dir = makeTree(files);
  const engine = builtinEngine(dir);
  try {
    await engine.ready(5000);

    const limit = 10;
    const { items, firstTotal, pages } = await drain(engine, NEEDLE, limit);

    // The count the first page advertises must be the real one, not the cap.
    assert.equal(firstTotal, total, "total must count every match, not stop at the page budget");
    assert.equal(items.length, total, "pagination must surface every match exactly once");
    assert.ok(pages >= Math.ceil(total / limit), `expected multiple pages, saw ${pages}`);

    const paths = items.map((hit) => hit.path);
    assert.deepEqual(new Set(paths).size, total, "no path may appear on two pages");
    assert.deepEqual(paths, expected, "matches must arrive in sorted path order, no skips");
  } finally {
    engine.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("builtin grep surfaces an invalid regex instead of reporting no match", async () => {
  const dir = makeTree({ "a.txt": "hello world\n" });
  const engine = builtinEngine(dir);
  try {
    await engine.ready(5000);

    // An unbalanced group is a caller mistake. Silently returning "no match"
    // would read as "the pattern is fine and nothing has it".
    await assert.rejects(
      () => engine.grep("(unclosed", { mode: "regex" }),
      /invalid regex/i,
      "a broken regex must be reported, not swallowed into an empty page",
    );

    // A valid regex over the same tree still works, and an empty pattern is a
    // no-op rather than an error — only a malformed regex is surfaced.
    const ok = await engine.grep("h.llo", { mode: "regex" });
    assert.equal(ok.total, 1);
    const empty = await engine.grep("", { mode: "regex" });
    assert.equal(empty.total, 0);
  } finally {
    engine.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
