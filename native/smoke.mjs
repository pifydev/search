import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TRIPLE = `${process.platform}-${process.arch}`;
const core = require(join(here, "..", `pify-search.${TRIPLE}.node`));
console.log(`loaded pify-search.${TRIPLE}.node`);

const root = process.argv[2] ?? join(here, "..", "..");
const t0 = Date.now();
const idx = new core.SearchIndex(root, 200000);
console.log(`index: ${idx.fileCount()} files, ${idx.indexedCount()} with content, ${Date.now() - t0}ms`);

// Drawn from this package's own Rust sources, so the run says the same thing
// whether the root is the whole suite or just this repository — which is what
// CI checks out. A probe that reports 0 here would look like a broken binary.
const cases = [
  ["literal", "plan_for_regex"],
  ["regex", "still_\\w+"],
  ["regex", "pub fn \\w+"],
  ["regex", "^(pub )?fn (extract|intersect)"],
  ["fuzzy", "plan_for_rgex"],
];
for (const [mode, pattern] of cases) {
  const t = Date.now();
  const r = idx.grep(pattern, mode, 3, 0, true);
  const first = r.items[0] ? `${r.items[0].path}:${r.items[0].line}` : "";
  console.log(
    `${mode.padEnd(8)} ${JSON.stringify(pattern).padEnd(28)} total=${String(r.total).padStart(4)}` +
      ` scanned=${String(r.scanned).padStart(5)} ${String(Date.now() - t).padStart(4)}ms  ${first}`,
  );
}

// Deliberately misspelled: the point of the fuzzy finder is that it survives a
// typo, so a probe spelled correctly would not test anything.
const t = Date.now();
const f = idx.find("trigrm", 3, 0, Date.now());
console.log(`find "trigrm" ${Date.now() - t}ms ->`, f.items.map((i) => i.path).join(", ") || "(nothing)");

try {
  idx.grep("(unclosed", "regex", 3, 0, true);
  console.log("BAD: an invalid regex was accepted");
} catch (e) {
  console.log("invalid regex rejected:", String(e.message).split("\n")[0]);
}
