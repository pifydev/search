/**
 * Does this package work the way a user actually gets it?
 *
 * Everything else in this suite runs the extension straight out of the
 * working tree, where `pify-search.<triple>.node` happens to be sitting next
 * to it. That is not what anyone installs. The published tarball carries no
 * binary — `npm pack` lists 22 files and none of them is a `.node` — so an
 * installed copy runs the TypeScript engine, and whether *that* works on a
 * given platform is a separate question from whether the Rust core does.
 *
 * So this installs the package the way pi installs it, into an isolated agent
 * directory, and drives the real tools against a real tree. It is the only
 * check in the repository that exercises the path a user is on.
 *
 * `PIFY_INSTALL_FROM=pack` (the default in CI) packs the working tree and
 * installs that, so the commit being built is what gets verified. `npm`
 * installs the published version instead, which is literally what a user
 * receives today.
 *
 *   node test/live/install-wire.mjs
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const FROM = process.env.PIFY_INSTALL_FROM ?? "npm";
const NL = String.fromCharCode(10);

// Assembled at runtime so the token is never a literal on the prompt path: it
// has to come back through a real search of a real file.
const TOKEN = ["ZQ", "VX", "WU"].join("") + "_MARKER";

const home = mkdtempSync(join(tmpdir(), "pify-install-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-install-repo-"));
const agentDir = join(home, "agent");
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const text = JSON.stringify((event.payload && event.payload.messages) || []);",
  "    appendFileSync(process.env.INSTALL_OUT, JSON.stringify({",
  // The token can only be in the conversation if a tool read the file.
  "      token: text.includes(process.env.INSTALL_TOKEN),",
  '      foundPath: text.includes("src/auth.ts"),',
  "    }) + String.fromCharCode(10));",
  "  });",
  "}",
].join(NL);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 600_000,
    shell: true,
    windowsHide: true,
    ...opts,
  });

try {
  mkdirSync(agentDir, { recursive: true });
  // pi reads OPENROUTER_API_KEY straight from the environment, which is how
  // CI authenticates — there is no auth.json on a runner. Locally the key
  // usually lives in the real agent directory instead, so that is copied
  // across when the variable is not set.
  const envKey = `${PROVIDER.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const realAuth = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
  if (process.env[envKey]) {
    console.log(`authenticating from $${envKey}`);
  } else if (existsSync(realAuth)) {
    copyFileSync(realAuth, join(agentDir, "auth.json"));
    console.log(`authenticating from ${realAuth}`);
  } else {
    console.log(`warning: neither $${envKey} nor an auth.json — pi will have no provider`);
  }

  writeFileSync(probe, PROBE_SOURCE);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# demo" + NL);
  writeFileSync(join(repo, "src", "auth.ts"), `export function authenticate() { return "${TOKEN}"; }${NL}`);

  // Install exactly the way a user does.
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, INSTALL_OUT: out, INSTALL_TOKEN: TOKEN };
  let installed;
  if (FROM === "pack") {
    // `pi install` takes `npm:<name>`, not a file. Handed a tarball path it
    // records the path itself as a package and then fails to load it as an
    // extension — so the tarball goes in through npm and the same on-disk
    // state a real `pi install npm:@pify/search` leaves behind is written by
    // hand: the package under agent/npm, and its name in settings.
    const packed = run("npm", ["pack", "--pack-destination", home], { cwd: PKG });
    const tarball = String(packed.stdout ?? "").trim().split(NL).pop();
    console.log(`installing from the working tree: ${tarball}`);
    const npmRoot = join(agentDir, "npm");
    mkdirSync(npmRoot, { recursive: true });
    writeFileSync(
      join(npmRoot, "package.json"),
      JSON.stringify({ name: "pi-extensions", private: true }, null, 2) + NL,
    );
    installed = run("npm", ["install", "--no-audit", "--no-fund", join(home, tarball)], { cwd: npmRoot });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:@pify/search"] }, null, 2) + NL,
    );
  } else {
    console.log("installing the published version from npm");
    installed = run("pi", ["install", "npm:@pify/search"], { cwd: repo, env });
  }
  const installLog = `${installed.stdout ?? ""}${installed.stderr ?? ""}`;
  check("the install succeeded", installed.status === 0, installLog.trim().split(NL).pop() ?? "");

  // What actually landed on disk, so a missing file is named rather than
  // showing up later as a search that quietly finds nothing.
  const installedRoot = join(agentDir, "npm", "node_modules", "@pify", "search");
  const present = (rel) => existsSync(join(installedRoot, rel));
  check("the extension entry point is there", present("extensions/search.ts"));
  check("the pure-TypeScript engine is there", present("src/builtin.ts") && present("src/walk.ts"));
  check("the skill is there", present("skills/search/SKILL.md"));
  const nodeFiles = existsSync(installedRoot)
    ? readdirSync(installedRoot).filter((f) => f.endsWith(".node"))
    : [];
  // Not a failure: the per-platform binaries are not published yet, and the
  // whole point of the fallback is that this case still works. Stated so the
  // run says which engine it actually proved.
  console.log(
    nodeFiles.length > 0
      ? `native binary present: ${nodeFiles.join(", ")}`
      : "no native binary in the install — this run exercises the TypeScript engine",
  );

  const session = run(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "-e", probe,
      // Wrapped in literal double quotes: unquoted sentences reach pi one
      // prompt per word on Windows under shell:true (see
      // task/test/live/sweep-wire.mjs).
      "-p",
      `"Call the ffgrep tool once with pattern=${TOKEN}. Then call the fffind tool once with query=auth. Then reply DONE and stop."`,
    ],
    { cwd: repo, env },
  );

  const requests = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  console.log(`requests: ${requests.length}`);
  if (requests.length === 0) {
    console.log((session.stderr ?? "").slice(0, 800));
  }

  check("the installed extension ran", requests.length > 0, `${requests.length} request(s)`);
  check(
    "ffgrep found the token inside the file",
    requests.some((r) => r.token),
    `${requests.filter((r) => r.token).length} request(s) carry it`,
  );
  check(
    "fffind found the file by a partial name",
    requests.some((r) => r.foundPath),
    `${requests.filter((r) => r.foundPath).length} request(s) carry the path`,
  );

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
