import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinEngine } from "../src/builtin.ts";
import type { ContentHit, Page } from "../src/engine.ts";
import { formatMatches } from "../src/format.ts";

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

test("the scan yields the event loop instead of freezing it for the whole walk", async () => {
  // A synthetic tree big enough to cross the yield threshold several times.
  const files: Record<string, string> = {};
  for (let i = 0; i < 1000; i++) files[`d${i % 20}/f${i}.txt`] = "x\n";
  const dir = makeTree(files);
  const engine = builtinEngine(dir);
  try {
    // Armed before the scan starts. A synchronous walk would run to completion
    // in one tick and this would only fire — seeing a finished index — after
    // ready() resolved. A cooperative walk yields, so it fires mid-scan.
    let filesWhenTimerFired = -1;
    setTimeout(() => {
      filesWhenTimerFired = engine.indexed?.() ?? -1;
    }, 0);

    await engine.ready(5000);
    const total = engine.indexed?.() ?? 0;

    assert.ok(total >= 1000, `expected the whole tree indexed, saw ${total}`);
    assert.ok(filesWhenTimerFired >= 0, "a timer must fire during the scan — the scan must yield the loop");
    assert.ok(
      filesWhenTimerFired < total,
      `the timer fired mid-scan; saw ${filesWhenTimerFired} of ${total} files, so the walk did not block`,
    );
  } finally {
    engine.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a text file too big to index is still a literal grep candidate", async () => {
  // 2.1MB is over MAX_INDEXABLE_BYTES (2MB) but under MAX_SEARCHABLE_BYTES
  // (10MB): it is not in the trigram index, yet a literal search must still
  // read it — the index may only narrow, never hide a file it should read.
  const filler = `${"lorem ipsum ".repeat(100)}\n`.repeat(1800); // ~2.1MB
  const dir = makeTree({
    "schema.json": `${filler}"orderTotalCents": 42\n`,
    "small.json": '{"x":1}\n',
  });
  const engine = builtinEngine(dir);
  try {
    await engine.ready(5000);
    const page = await engine.grep("orderTotalCents", { mode: "literal" });
    assert.equal(page.total, 1, "a 2.1MB text file must be searched in literal mode");
    assert.equal(page.items[0]?.path, "schema.json");
    assert.equal(page.exact, true, "a narrowed page's total is exact");
  } finally {
    engine.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("lock files are text, so they are searchable in literal mode", async () => {
  const dir = makeTree({ "bun.lock": '"@pify/search": "0.4.7"\n', "a.ts": "x\n" });
  const engine = builtinEngine(dir);
  try {
    await engine.ready(5000);
    const page = await engine.grep("@pify/search", { mode: "literal" });
    assert.equal(page.total, 1, "a .lock file must be searchable, not treated as binary");
    assert.equal(page.items[0]?.path, "bun.lock");
  } finally {
    engine.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a fuzzy grep past the page budget reports a lower bound, not an exact total", async () => {
  // Fuzzy has no indexable substring, so it takes the "all" path and stops one
  // page past the ask; its total is a budget and must be labelled as such.
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`f${i}.txt`] = "handlerFunction\n";
  const dir = makeTree(files);
  const engine = builtinEngine(dir);
  try {
    await engine.ready(5000);
    const page = await engine.grep("handlerFunction", { mode: "fuzzy", limit: 10 });
    assert.equal(page.exact, false, "the un-narrowed fuzzy path cannot claim an exact total");
    assert.ok(page.cursor, "there is another page");
    const text = formatMatches(page, "handlerFunction", "fuzzy");
    assert.match(text, /at least/, "the formatted text must not state the budget as exact");
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
