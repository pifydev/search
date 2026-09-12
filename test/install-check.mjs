/**
 * Does the published tarball actually work, on this platform, as installed?
 *
 * Every other test in this repository runs the code out of the working tree,
 * where every file exists whether or not `package.json` ships it. That is not
 * what a user gets. A file left out of `files` is invisible until someone
 * installs the package and a search quietly finds nothing.
 *
 * So this packs the working tree, installs the tarball into a throwaway
 * directory, and exercises the *installed* copy: the extension is loaded the
 * way pi loads it — raw TypeScript through jiti — and the engine is pointed at
 * a real tree and asked real questions.
 *
 * No model and no API key, so CI can run it on Linux, macOS and Windows.
 * `test/live/install-wire.mjs` covers the other half, driving the real tools
 * through pi itself, and needs a provider.
 *
 *   node test/install-check.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NL = String.fromCharCode(10);
const TOKEN = ["ZQ", "VX", "WU"].join("") + "_MARKER";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

const home = mkdtempSync(join(tmpdir(), "pify-installcheck-"));
const repo = mkdtempSync(join(tmpdir(), "pify-installcheck-repo-"));

try {
  // ── Pack and install, the way npm would ──────────────────────────────
  const packed = spawnSync("npm", ["pack", "--pack-destination", home], {
    cwd: PKG,
    encoding: "utf8",
    shell: true,
    windowsHide: true,
    timeout: 300_000,
  });
  const tarball = String(packed.stdout ?? "").trim().split(NL).pop();
  check("npm pack produced a tarball", Boolean(tarball) && existsSync(join(home, tarball)), tarball ?? "");

  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "consumer", private: true }, null, 2));
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", join(home, tarball)], {
    cwd: home,
    encoding: "utf8",
    shell: true,
    windowsHide: true,
    timeout: 300_000,
  });
  check("npm install of the tarball succeeded", install.status === 0, String(install.stderr ?? "").trim().slice(0, 200));

  const installed = join(home, "node_modules", "@pify", "search");

  // pi supplies the peer packages from its own installation, so a consumer
  // directory has to stand in for that or the extension cannot resolve its
  // imports. Linking rather than installing keeps this offline and fast, and
  // still exercises real module resolution. Junctions work on Windows without
  // elevation; everything else takes a plain directory symlink.
  const peerRoot = join(home, "node_modules", "@earendil-works");
  mkdirSync(peerRoot, { recursive: true });
  for (const peer of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
    const source = join(PKG, "node_modules", "@earendil-works", peer);
    if (!existsSync(source)) continue;
    try {
      symlinkSync(source, join(peerRoot, peer), process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Already there, or a filesystem that will not link — the load check
      // below reports the consequence either way.
    }
  }
  for (const bare of ["typebox", "jiti"]) {
    const source = join(PKG, "node_modules", bare);
    if (!existsSync(source)) continue;
    try {
      symlinkSync(source, join(home, "node_modules", bare), process.platform === "win32" ? "junction" : "dir");
    } catch {
      // ditto
    }
  }

  // ── Is everything pi needs actually in the tarball? ──────────────────
  // The manifest names these; a `files` list that drifts from it is how a
  // package installs cleanly and then does nothing.
  const manifest = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(join(installed, "package.json"), "utf8")),
  );
  for (const rel of manifest.pi.extensions) {
    check(`the manifest's extension is shipped: ${rel}`, existsSync(join(installed, rel)));
  }
  for (const rel of manifest.pi.skills ?? []) {
    check(`the manifest's skill directory is shipped: ${rel}`, existsSync(join(installed, rel)));
  }
  check("the package declares no runtime dependencies", !manifest.dependencies, JSON.stringify(manifest.dependencies ?? {}));

  // ── Load it the way pi does: raw TypeScript, through jiti ────────────
  const jiti = createJiti(join(installed, "package.json"));
  let extension = null;
  try {
    extension = await jiti.import(join(installed, "extensions", "search.ts"), { default: true });
  } catch (err) {
    console.log(`  load error: ${err instanceof Error ? err.message : String(err)}`);
  }
  // This is the check that catches a missing `src/` file: the extension
  // imports its whole engine at module scope, so a gap in `files` throws here
  // rather than at the user's first search.
  check("the extension loads through jiti with every import resolved", typeof extension === "function");

  // ── Point the installed engine at a real tree ────────────────────────
  mkdirSync(join(repo, "src", "routes"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), `generated/${NL}*.log${NL}`);
  mkdirSync(join(repo, "generated"), { recursive: true });
  writeFileSync(join(repo, "src", "routes", "auth.ts"), `export const t = "${TOKEN}";${NL}`);
  writeFileSync(join(repo, "generated", "out.ts"), `export const t = "${TOKEN}";${NL}`);
  writeFileSync(join(repo, "debug.log"), `${TOKEN}${NL}`);
  writeFileSync(join(repo, "node_modules", "junk", "index.js"), `${TOKEN}${NL}`);

  const { builtinEngine } = await jiti.import(join(installed, "src", "builtin.ts"));
  const engine = builtinEngine(repo);
  await engine.ready(20_000);

  const hits = (await engine.grep(TOKEN, { limit: 20 })).items.map((i) => i.path).sort();
  check("the installed engine finds a string in a file", hits.includes("src/routes/auth.ts"), hits.join(", ") || "(none)");
  check("it does not search node_modules", !hits.some((p) => p.startsWith("node_modules/")), hits.join(", "));
  check(
    "it honours the repository's .gitignore",
    !hits.some((p) => p.startsWith("generated/") || p.endsWith(".log")),
    hits.join(", "),
  );

  const found = (await engine.find("auth", { limit: 5 })).items.map((i) => i.path);
  check("the installed engine finds a file by a partial name", found.includes("src/routes/auth.ts"), found.join(", "));

  // Paths must come back in one shape whatever the platform separator is,
  // because everything downstream — the cursor, the formatter, the model —
  // reads them as text.
  check("paths are reported with forward slashes on every platform", !hits.some((p) => p.includes("\\")), hits.join(", "));

  engine.dispose();

  // ── The native loader must be a no-op, not a crash, with no binary ───
  const { loadNative, tripleOf } = await jiti.import(join(installed, "src", "native.ts"));
  const triple = tripleOf(process.platform, process.arch);
  const native = loadNative(repo);
  console.log(
    native
      ? `native core loaded for ${triple}`
      : `no native binary for ${triple ?? `${process.platform}-${process.arch}`} — the fallback is what users get today`,
  );
  check("asking for the native core never throws, binary or not", true);
  native?.dispose();

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
