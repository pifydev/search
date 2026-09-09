// How much the stored index is actually worth, on a tree big enough to tell.
//
// The suite's own 421 files cannot answer that: the walk dominates and the
// difference is inside the noise. This writes a synthetic tree of the size the
// feature exists for and measures a cold build against a warm one. Run with
// PIFY_SEARCH_TIMING=1 to see which of walk, load and invert is paying.
//
//   node native/bench.mjs 20000
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const core = require(join(here, "..", `pify-search.${process.platform}-${process.arch}.node`));

const N = Number(process.argv[2] ?? 20000);
const tree = mkdtempSync(join(tmpdir(), "pify-scale-"));
const cache = join(tree, ".cache", "index.bin");

// Plausible source files, not repeated filler: identical content would give an
// unrealistically tiny trigram set and flatter the cache size.
const words = ["handler","request","payload","session","resolve","dispatch","buffer","context","registry","adapter","descriptor","validate","transform","interval","snapshot","fragment","boundary","threshold"];
for (let i = 0; i < N; i++) {
  const dir = join(tree, `pkg${i % 40}`, `mod${(i >> 4) % 30}`);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let l = 0; l < 40; l++) {
    const a = words[(i * 7 + l * 3) % words.length];
    const b = words[(i * 13 + l * 5) % words.length];
    lines.push(`export function ${a}${l}_${i % 97}(${b}: string) { return ${b}.length + ${l}; }`);
  }
  if (i === N - 1) lines.push("const needleForScaleTest = 1;");
  writeFileSync(join(dir, `f${i}.ts`), lines.join("\n"));
}

const run = (label) => {
  const t = Date.now();
  const idx = new core.SearchIndex(tree, 500000, cache);
  const ms = Date.now() - t;
  const g = Date.now();
  const hits = idx.grep("needleForScaleTest", "literal", 5, 0, true);
  console.log(`${label.padEnd(6)} build ${String(ms).padStart(6)}ms  reused=${String(idx.reusedCount()).padStart(6)} rebuilt=${String(idx.rebuiltCount()).padStart(6)}  grep ${Date.now() - g}ms total=${hits.total} scanned=${hits.scanned}`);
  return ms;
};

console.log(`${N} files written to a temp tree`);
const cold = run("cold");
console.log(`cache ${(statSync(cache).size / 1048576).toFixed(1)}MB`);
const warm = run("warm");
const warm2 = run("warm2");
console.log(`\ncold ${cold}ms -> warm ${Math.min(warm, warm2)}ms  (${(cold / Math.min(warm, warm2)).toFixed(1)}x)`);
rmSync(tree, { recursive: true, force: true });
