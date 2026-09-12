// Does the index actually survive the process, and does surviving change the
// answers? Those are two separate claims and this checks both. A cache that
// makes startup fast but shifts a single result is a bug, not an optimisation.

import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TRIPLE = `${process.platform}-${process.arch}`;
const core = require(join(here, "..", `pify-search.${TRIPLE}.node`));

const root = process.argv[2] ?? join(here, "..", "..");
const cacheDir = mkdtempSync(join(tmpdir(), "pify-search-"));
const cache = join(cacheDir, "index.bin");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

const NOW = 1757000000000; // fixed, so frecency cannot make two runs differ
// Probes drawn from this package's own Rust sources, so the run means the same
// thing whether the root is the whole suite or just this repository — which is
// what CI checks out. A probe that matches nothing would let every comparison
// below pass by comparing empty to empty, so `results are not vacuously empty`
// guards them.
const probe = (idx) => ({
  literal: idx.grep("plan_for_regex", "literal", 20, 0, true),
  regex: idx.grep("pub fn \\w+", "regex", 20, 0, true),
  find: idx.find("trigrm", 10, 0, NOW),
});
const shape = (p) => ({
  literal: p.literal.items.map((i) => `${i.path}:${i.line}`),
  literalTotal: p.literal.total,
  regex: p.regex.items.map((i) => `${i.path}:${i.line}`),
  regexTotal: p.regex.total,
  find: p.find.items.map((i) => `${i.path}#${i.score}`),
});

// --- Cold: nothing on disk, everything must be read. -----------------------
const coldStart = Date.now();
const cold = new core.SearchIndex(root, 200000, cache);
const coldMs = Date.now() - coldStart;
const coldFiles = cold.fileCount();
const coldIndexed = cold.indexedCount();
console.log(
  `cold  ${coldFiles} files, ${coldIndexed} indexed, reused=${cold.reusedCount()} rebuilt=${cold.rebuiltCount()}, ${coldMs}ms`,
);
check("a cold build reuses nothing", cold.reusedCount() === 0);
check("a cold build reads every indexable file", cold.rebuiltCount() === coldIndexed);
const cacheBytes = statSync(cache).size;
check("the cold build wrote a cache", cacheBytes > 0, `${(cacheBytes / 1024).toFixed(0)}KB for ${coldIndexed} files, ${(cacheBytes / coldIndexed).toFixed(0)}B each`);

const coldResults = shape(probe(cold));

// --- Warm: same tree, untouched. Everything should be reused. --------------
const warmStart = Date.now();
const warm = new core.SearchIndex(root, 200000, cache);
const warmMs = Date.now() - warmStart;
console.log(
  `warm  ${warm.fileCount()} files, ${warm.indexedCount()} indexed, reused=${warm.reusedCount()} rebuilt=${warm.rebuiltCount()}, ${warmMs}ms`,
);
check("an unchanged tree re-reads nothing", warm.rebuiltCount() === 0, `rebuilt=${warm.rebuiltCount()}`);
check("an unchanged tree reuses every indexed file", warm.reusedCount() === coldIndexed);
check("the file count is unchanged", warm.fileCount() === coldFiles);
check("the indexed count is unchanged", warm.indexedCount() === coldIndexed);

const warmResults = shape(probe(warm));
check(
  "a reloaded index gives byte-identical answers",
  JSON.stringify(warmResults) === JSON.stringify(coldResults),
  warmResults.literalTotal === coldResults.literalTotal ? "" : `${coldResults.literalTotal} vs ${warmResults.literalTotal}`,
);
// Every comparison above is an equality check, and empty equals empty. Without
// this the whole file would pass just as happily against an index that found
// nothing at all.
check(
  "results are not vacuously empty",
  coldResults.literalTotal > 0 && coldResults.regexTotal > 0 && coldResults.find.length > 0,
  `literal=${coldResults.literalTotal} regex=${coldResults.regexTotal} find=${coldResults.find.length}`,
);
// Not a fixed ratio: on a small tree the walk dominates and the win is modest.
// The claim is only that reloading is never *slower* than re-reading.
check("reloading is not slower than rebuilding", warmMs <= coldMs, `${coldMs}ms -> ${warmMs}ms`);

// --- Changed: one new file must be picked up, the rest still reused. -------
// Assembled at runtime on purpose: this file lives inside the tree being
// indexed, so a literal marker would match its own source and the count would
// measure the test rather than the index.
const MARKER = ["zz", "qq", "xx"].join("") + "-marker";
const added = join(root, "pify-search-persist-probe.txt");
writeFileSync(added, `${MARKER} unique string for the persistence probe\n`);
try {
  const changed = new core.SearchIndex(root, 200000, cache);
  console.log(`change reused=${changed.reusedCount()} rebuilt=${changed.rebuiltCount()}`);
  check("a new file is read", changed.rebuiltCount() === 1, `rebuilt=${changed.rebuiltCount()}`);
  check("the untouched files are still reused", changed.reusedCount() === coldIndexed);
  const hit = changed.grep(MARKER, "literal", 5, 0, true);
  check("the new file is searchable", hit.total === 1, `total=${hit.total}`);
} finally {
  rmSync(added, { force: true });
}

// A file that vanishes must vanish from the answers too — a cache that keeps
// answering for deleted files is the failure mode that makes indexes untrusted.
const after = new core.SearchIndex(root, 200000, cache);
check("a deleted file leaves the index", after.grep(MARKER, "literal", 5, 0, true).total === 0);
check("the deletion restores the original file count", after.fileCount() === coldFiles);

// --- Corruption must degrade to a rebuild, never to a wrong answer. --------
writeFileSync(cache, Buffer.from("PIFYSRC2garbage-not-a-real-index-at-all"));
const salvaged = new core.SearchIndex(root, 200000, cache);
check("a corrupt cache is discarded", salvaged.reusedCount() === 0);
check("a corrupt cache still yields correct results", salvaged.indexedCount() === coldIndexed);
check(
  "results survive a corrupt cache",
  JSON.stringify(shape(probe(salvaged))) === JSON.stringify(coldResults),
);

rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? "\nall persistence checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
