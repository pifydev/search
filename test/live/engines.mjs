/**
 * Do the two engines answer the same questions?
 *
 * The package promises that a tool never learns which engine it got. That is
 * only true if they agree, and agreement is not something a unit test can
 * check: one is a Rust index and the other is this repository's own code.
 *
 * So both are pointed at a real tree and asked the same things. The fast one
 * is allowed to be better ordered and to find more — it has git status and
 * frecency the fallback cannot see — but a file that exists must be found by
 * both, and a string that is in a file must be found by both.
 *
 *   bun run test/live/engines.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinEngine } from "../../src/builtin.ts";
import { loadFff } from "../../src/engine.ts";

const NL = String.fromCharCode(10);
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

const root = mkdtempSync(join(tmpdir(), "pify-search-"));
const write = (rel, body) => {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
};

try {
  write("src/routes/auth.ts", `export function authenticate() {${NL}  return SENTINEL_TOKEN;${NL}}${NL}`);
  write("src/auth/helpers.ts", `// helpers for auth${NL}export const helper = 1;${NL}`);
  write("docs/authentication.md", `# Authentication${NL}${NL}Describes SENTINEL_TOKEN handling.${NL}`);
  write("src/unrelated.ts", `export const x = 42;${NL}`);
  // Things the index must refuse to search.
  write("node_modules/junk/index.js", `SENTINEL_TOKEN everywhere${NL}`);
  writeFileSync(join(root, "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x53]));

  const builtin = builtinEngine(root);
  await builtin.ready(20_000);
  const fff = await loadFff(root);
  if (fff) await fff.ready(20_000);

  console.log(`engines: builtin${fff ? " + fff" : " only (fff unavailable here)"}`);
  console.log(`builtin indexed ${builtin.indexed?.()} files${NL}`);

  const engines = [["builtin", builtin], ...(fff ? [["fff", fff]] : [])];

  for (const [name, engine] of engines) {
    const found = await engine.find("auth", { limit: 10 });
    const paths = found.items.map((i) => i.path);
    console.log(`  ${name} find("auth") -> ${paths.join(", ")}`);
    check(`${name}: finds the file whose name is the query`, paths.includes("src/routes/auth.ts"), paths.join(", "));
    check(`${name}: ranks it first`, paths[0] === "src/routes/auth.ts", paths[0] ?? "(none)");

    const typo = await engine.find("authetication", { limit: 10 });
    check(
      `${name}: tolerates a typo`,
      typo.items.some((i) => i.path.includes("authentication")),
      typo.items.map((i) => i.path).join(", "),
    );

    const lit = await engine.grep("SENTINEL_TOKEN", { mode: "literal", limit: 20 });
    const hitPaths = [...new Set(lit.items.map((i) => i.path))].sort();
    console.log(`  ${name} grep(literal) -> ${hitPaths.join(", ")}`);
    check(`${name}: finds the string in both files that hold it`, hitPaths.includes("src/routes/auth.ts") && hitPaths.includes("docs/authentication.md"), hitPaths.join(", "));
    check(`${name}: does not search node_modules`, !hitPaths.some((p) => p.includes("node_modules")), hitPaths.join(", "));
    check(`${name}: reports a line number`, lit.items.every((i) => i.line > 0));

    const re = await engine.grep("SENTINEL_\\w+", { mode: "regex", limit: 20 });
    check(`${name}: regex mode works`, re.items.length > 0, `${re.items.length} matches`);

    const miss = await engine.grep("ZZZ_NOT_PRESENT_ANYWHERE", { mode: "literal", limit: 5 });
    check(`${name}: a miss is empty rather than everything`, miss.items.length === 0, `${miss.items.length}`);

    // Pagination has to end, or an agent pages forever.
    const first = await engine.grep("SENTINEL_TOKEN", { mode: "literal", limit: 1 });
    check(`${name}: a partial page offers a cursor`, first.cursor !== null, String(first.cursor));
    if (first.cursor) {
      const second = await engine.grep("SENTINEL_TOKEN", { mode: "literal", limit: 1, cursor: first.cursor });
      check(
        `${name}: the cursor advances rather than repeating`,
        second.items[0]?.path !== first.items[0]?.path || second.items[0]?.line !== first.items[0]?.line,
        `${first.items[0]?.path}:${first.items[0]?.line} then ${second.items[0]?.path}:${second.items[0]?.line}`,
      );
    }
  }

  // The claim the whole package rests on: a tool cannot tell them apart.
  if (fff) {
    const a = new Set((await builtin.grep("SENTINEL_TOKEN", { mode: "literal", limit: 50 })).items.map((i) => `${i.path}:${i.line}`));
    const b = new Set((await fff.grep("SENTINEL_TOKEN", { mode: "literal", limit: 50 })).items.map((i) => `${i.path}:${i.line}`));
    const onlyA = [...a].filter((x) => !b.has(x));
    const onlyB = [...b].filter((x) => !a.has(x));
    check(
      "both engines return the same literal matches",
      onlyA.length === 0 && onlyB.length === 0,
      `builtin-only: ${onlyA.join(",") || "none"} · fff-only: ${onlyB.join(",") || "none"}`,
    );
  }

  builtin.dispose();
  fff?.dispose();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`${NL}${passed}/${passed + failed} passed`);
process.exitCode = failed === 0 ? 0 : 1;
