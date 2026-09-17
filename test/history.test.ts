import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { builtinEngine } from "../src/builtin.ts";
import { mergeHistories, type History } from "../src/frecency.ts";
import { toIndexKey } from "../src/walk.ts";

test("mergeHistories unions two sessions' touches instead of letting one win", () => {
  // The file key is a hash of the cwd, so two sessions in one repo share it.
  // A plain overwrite dropped the other session's accesses; a merge keeps both.
  const a: History = { "src/a.ts": [100, 200], "src/b.ts": [300] };
  const b: History = { "src/a.ts": [200, 400], "src/c.ts": [500] };
  const merged = mergeHistories(a, b);
  assert.deepEqual(merged["src/a.ts"], [100, 200, 400], "identical stamps collapse, the rest survive");
  assert.deepEqual(merged["src/b.ts"], [300]);
  assert.deepEqual(merged["src/c.ts"], [500]);
});

test("toIndexKey turns an absolute or ~-path into the root-relative index key", () => {
  const root = process.platform === "win32" ? "D:/project/app" : "/project/app";
  assert.equal(toIndexKey(root, join(root, "src/routes/auth.ts")), "src/routes/auth.ts");
  assert.equal(toIndexKey(root, "src/routes/auth.ts"), "src/routes/auth.ts");
  // A path outside the tree is dropped rather than stored as an unusable key.
  assert.equal(toIndexKey(root, "../elsewhere/x.ts"), null);
  const outside = process.platform === "win32" ? "D:/other/x.ts" : "/other/x.ts";
  assert.equal(toIndexKey(root, outside), null);
});

test("touching an absolute path boosts the relative entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pify-search-history-"));
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  writeFileSync(join(dir, "src", "routes", "auth.ts"), "export const auth = 1\n");
  const engine = builtinEngine(dir);
  try {
    await engine.ready(5000);

    const scoreOf = async () =>
      (await engine.find("auth")).items.find((h) => h.path === "src/routes/auth.ts")?.score ?? 0;

    const before = await scoreOf();
    // The path exactly as pi hands it to a tool: absolute. Before the fix this
    // was stored verbatim and never matched the "src/routes/auth.ts" entry.
    const absolute = join(dir, "src", "routes", "auth.ts");
    assert.ok(isAbsolute(absolute));
    const key = toIndexKey(dir, absolute);
    assert.equal(key, "src/routes/auth.ts");
    engine.touch?.(key!);
    engine.touch?.(key!);

    const after = await scoreOf();
    assert.ok(after > before, `an absolute-path touch must raise the entry's score (${before} -> ${after})`);
  } finally {
    engine.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
