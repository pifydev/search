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
