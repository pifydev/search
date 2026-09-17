import { test } from "node:test";
import assert from "node:assert/strict";

import type { ContentHit, FileHit, Page } from "../src/engine.ts";
import { formatFiles, formatMatches } from "../src/format.ts";

/**
 * These guard the model-facing text, which the pagination tests never touch:
 * they drive raw Page objects, so the "N more" arithmetic and the unlabelled
 * lower-bound total could be wrong while every assertion passed.
 */

function grepPage(over: Partial<Page<ContentHit>>): Page<ContentHit> {
  return {
    items: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.ts`, line: 1, text: "x" })),
    total: 100,
    cursor: "40",
    ...over,
  };
}

test('"N more" counts from the cursor offset, not just the current page', () => {
  // 100 matches, showing items 40–59: 60 remain, not 80 (total minus one page).
  const text = formatMatches(grepPage({}), "needle", "literal");
  assert.match(text, /60 more/, "remaining must be total minus the cursor offset");
  assert.doesNotMatch(text, /80 more/, "must not subtract only the current page");
  assert.match(text, /cursor="40"/);
});

test("fffind's more line counts from the cursor too", () => {
  const page: Page<FileHit> = {
    items: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.ts` })),
    total: 100,
    cursor: "40",
  };
  assert.match(formatFiles(page, "f"), /60 more/);
});

test("a non-exhaustive total reads as a lower bound, never an exact count", () => {
  // The "all" fallback stops one page past the ask, so its total is a budget,
  // not the answer. It must say "at least" and must not print a bogus "N more".
  const text = formatMatches(grepPage({ total: 21, cursor: "20", exact: false }), "needle", "fuzzy");
  assert.match(text, /at least 21 matches/, "a lower bound must be labelled");
  assert.match(text, /More results/, "an inexact page must not state a remaining count");
  assert.doesNotMatch(text, /\d+ more\./, "a lower-bound page must not print 'N more.'");
});

test("an exact total is stated plainly, with a real remaining count", () => {
  const text = formatMatches(grepPage({ total: 100, cursor: "40", exact: true }), "needle", "literal");
  assert.match(text, /100 matches for/);
  assert.match(text, /60 more/);
  assert.doesNotMatch(text, /at least/);
});

test("a search during the build says the index is still filling in", () => {
  const empty: Page<ContentHit> = { items: [], total: 0, cursor: null };
  assert.match(formatMatches(empty, "needle", "literal", 812), /index still building: 812 files/);
  const emptyFiles: Page<FileHit> = { items: [], total: 0, cursor: null };
  assert.match(formatFiles(emptyFiles, "needle", 812), /index still building: 812 files/);
  // When the count is omitted (index ready) the note is absent.
  assert.doesNotMatch(formatMatches(empty, "needle", "literal"), /still building/);
});
