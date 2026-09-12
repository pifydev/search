import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TrigramIndex,
  literalRuns,
  planForLiteral,
  planForPatterns,
  planForRegex,
  trigramsOf,
} from "../src/trigram.ts";

test("a trigram is three bytes packed, so equal text gives equal trigrams", () => {
  assert.deepEqual([...trigramsOf("abc")], [(97 << 16) | (98 << 8) | 99]);
  assert.equal(trigramsOf("abcd").size, 2);
  // Below three characters there is nothing to index.
  assert.equal(trigramsOf("ab").size, 0);
  assert.equal(trigramsOf("").size, 0);
});

test("only literal runs of three or more imply required trigrams", () => {
  assert.deepEqual(literalRuns("hello"), ["hello"]);
  assert.deepEqual(literalRuns("foo.*bar"), ["foo", "bar"]);
  // A quantifier applies to the character before it, which is therefore not
  // required either — `colou?r` must not require the `u`.
  assert.deepEqual(literalRuns("colou?rful"), ["colo", "rful"]);
  assert.deepEqual(literalRuns("a+bcde"), ["bcde"]);
  // Nothing long enough to index.
  assert.deepEqual(literalRuns("a.b"), []);
});

test("a delimiter's contents are never a required run", () => {
  // The bug this pins: breaking at `[` but leaving what followed behind made
  // `x[abcdef]y` require abc/bcd/cde/def, none of which a matching `xay`
  // contains — so the index excluded a file that genuinely matched. Measured
  // against node's own regex before the fix: it said the file matched and the
  // search returned nothing.
  assert.deepEqual(literalRuns("x[abcdef]y"), []);
  assert.deepEqual(literalRuns("[abcdef]"), []);
  // Same shape with a quantifier: `2,4` is a count, not text to match.
  assert.deepEqual(literalRuns("a{2,4}bcdef"), ["bcdef"]);
  assert.deepEqual(literalRuns("x{10,200}y"), []);
  // A group's contents ARE required when nothing inside varies, so they stay.
  assert.deepEqual(literalRuns("a(bcdef)g"), ["bcdef"]);
  // An escaped bracket is an ordinary character and must not start a skip.
  assert.deepEqual(literalRuns("ab\\[cdef"), ["ab[cdef"]);
  // An unterminated class is a malformed regex; the planner's only duty is to
  // invent no requirement from it.
  assert.deepEqual(literalRuns("xy[abcdef"), []);
  // A class must not narrow the plan either — the run is what feeds it.
  assert.deepEqual(planForRegex("x[abcdef]y", false), { kind: "all" });
});

test("an optional group's contents are never required", () => {
  // The group-stack case the first fix missed: by the time `)?` is seen the
  // group's runs are already pushed, so they must be *retracted*. Before this,
  // `(abcd)?xyz` demanded the trigrams of abcd and a file containing only
  // `xyz` matched the regex while the index excluded it.
  assert.deepEqual(literalRuns("(abcd)?xyz"), ["xyz"]);
  assert.deepEqual(literalRuns("(abcd)*xyz"), ["xyz"]);
  assert.deepEqual(literalRuns("(abcd){0,2}xyz"), ["xyz"]);
  // Nesting: the outer quantifier retracts the inner group's runs too.
  assert.deepEqual(literalRuns("((abc)de)?fgh"), ["fgh"]);
  // `+` means at least once, so the contents stay required.
  assert.deepEqual(literalRuns("(abc)+def"), ["abc", "def"]);
  assert.deepEqual(literalRuns("(abc)def"), ["abc", "def"]);
  // (?:…) is an ordinary group in disguise, not a quantifier and a colon.
  assert.deepEqual(literalRuns("(?:abcd)efg"), ["abcd", "efg"]);
  assert.deepEqual(literalRuns("(?:abcd)?efg"), ["efg"]);
  // Lookarounds are dropped conservatively — the negative form MUST be,
  // because requiring what it forbids excludes exactly the matching files.
  assert.deepEqual(literalRuns("(?!abcd)efg"), ["efg"]);
  assert.deepEqual(literalRuns("(?=abcd)efg"), ["efg"]);
  // An escaped paren is an ordinary character, not a group.
  assert.deepEqual(literalRuns("abc\\(def"), ["abc(def"]);
});

test("case-sensitive grep still narrows through the folded index", () => {
  // The index stores only case-folded trigrams. Planning with the caller's
  // sensitivity asked a lowercase index for "TOD"/"ODO" and got nothing —
  // "no match" over a tree full of TODOs. The plan must always speak the
  // index's encoding; the matcher owns case sensitivity.
  const index = new TrigramIndex();
  index.add(1, "// TODO: fix this later");
  const plan = planForLiteral("TODO", true);
  assert.deepEqual(index.candidates(plan), new Set([1]));
});

test("an unindexable pattern says so rather than narrowing wrongly", () => {
  // This is the whole correctness question: null candidates means "read
  // everything", and an empty set means "read nothing". Confusing them is how
  // an index starts hiding results.
  assert.deepEqual(planForRegex("\\d+", false), { kind: "all" });
  assert.deepEqual(planForRegex(".*", false), { kind: "all" });
  assert.deepEqual(planForLiteral("ab", false), { kind: "all" });
});

test("alternation unions, and one unindexable branch absorbs the plan", () => {
  const plan = planForRegex("hello|world", false);
  assert.equal(plan.kind, "or");
  // A branch that could match anywhere makes no candidate set safe.
  assert.deepEqual(planForRegex("hello|\\d+", false), { kind: "all" });
  assert.deepEqual(planForPatterns([{ kind: "and", trigrams: [1] }, { kind: "all" }]), { kind: "all" });
});

test("case folding happens at plan time, matching how content is indexed", () => {
  const upper = planForLiteral("HELLO", true);
  const lower = planForLiteral("hello", true);
  assert.deepEqual(upper, lower);
});

test("candidates intersect for AND and union for OR", () => {
  const index = new TrigramIndex();
  index.add(1, "the quick brown fox");
  index.add(2, "the quick red fox");
  index.add(3, "nothing here at all");

  const quick = index.candidates(planForLiteral("quick", true))!;
  assert.deepEqual([...quick].sort(), [1, 2]);

  const brown = index.candidates(planForLiteral("brown", true))!;
  assert.deepEqual([...brown], [1]);

  const either = index.candidates({
    kind: "or",
    branches: [planForLiteral("brown", true), planForLiteral("red f", true)],
  })!;
  assert.deepEqual([...either].sort(), [1, 2]);
});

test("a miss is an empty set, not everything", () => {
  const index = new TrigramIndex();
  index.add(1, "hello world");
  const none = index.candidates(planForLiteral("zzzzz", true));
  assert.notEqual(none, null, "an answerable query must never widen to a full scan");
  assert.equal(none!.size, 0);
  // Whereas an unindexable plan genuinely means everything.
  assert.equal(index.candidates({ kind: "all" }), null);
});

test("re-adding a file replaces its postings instead of accumulating them", () => {
  const index = new TrigramIndex();
  index.add(1, "alpha content");
  assert.equal(index.candidates(planForLiteral("alpha", true))!.size, 1);
  index.add(1, "beta content");
  assert.equal(index.candidates(planForLiteral("alpha", true))!.size, 0, "stale postings would return deleted text");
  assert.equal(index.candidates(planForLiteral("beta", true))!.size, 1);
  assert.equal(index.size, 1);
});

test("removing a file removes it from every posting list", () => {
  const index = new TrigramIndex();
  index.add(1, "shared text here");
  index.add(2, "shared text there");
  index.remove(1);
  assert.deepEqual([...index.candidates(planForLiteral("shared", true))!], [2]);
  assert.equal(index.has(1), false);
  // Removing something absent is not an error.
  index.remove(99);
  assert.equal(index.size, 1);
});
