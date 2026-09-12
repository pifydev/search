// The addon persisting is one claim; the package's loader wiring the cache
// through and reporting it is another. This exercises the path the extension
// actually takes.
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const jiti = createJiti(join(pkg, "package.json"));
const dir = mkdtempSync(join(tmpdir(), "pify-loader-"));
process.env.PIFY_SEARCH_CACHE_DIR = dir;
delete process.env.PIFY_SEARCH_NO_CACHE;
delete process.env.PIFY_SEARCH_ENGINE;

const { loadNative } = await jiti.import(join(pkg, "src", "native.ts"));
const { formatStatus } = await jiti.import(join(pkg, "src", "format.ts"));
const root = process.argv[2] ?? join(pkg, "..");

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) bad++;
};

const cold = loadNative(root);
check("the loader returns the native engine", cold?.name === "native");
check("a cold load reuses nothing", cold.stats().reused === 0, JSON.stringify(cold.stats()));
const files = readdirSync(dir);
check("the loader wrote exactly one index file", files.length === 1, files.join(","));
check("the index has a stable extension", files[0]?.endsWith(".idx"), files[0]);
check("the index is not empty", statSync(join(dir, files[0])).size > 0);

const coldHits = (await cold.grep("danglingReferences")).items.map((i) => `${i.path}:${i.line}`);
cold.dispose();

const warm = loadNative(root);
check("a warm load reuses the whole index", warm.stats().rebuilt === 0, JSON.stringify(warm.stats()));
check("a warm load still finds the same lines", JSON.stringify((await warm.grep("danglingReferences")).items.map((i) => `${i.path}:${i.line}`)) === JSON.stringify(coldHits));
check("the results are not vacuously empty", coldHits.length > 0, `${coldHits.length} hits`);
check("no second index file appeared", readdirSync(dir).length === 1, readdirSync(dir).join(","));

const status = formatStatus(warm, root);
check("status reports the cache", /Index:\s+\d+ reused from cache/.test(status), status.split("\n").find((l) => l.startsWith("Index:")) ?? "(no Index line)");
warm.dispose();

// Opting out must actually opt out: no file, and still correct answers.
const otherDir = mkdtempSync(join(tmpdir(), "pify-loader-off-"));
process.env.PIFY_SEARCH_CACHE_DIR = otherDir;
process.env.PIFY_SEARCH_NO_CACHE = "1";
const off = loadNative(root);
check("PIFY_SEARCH_NO_CACHE writes nothing", readdirSync(otherDir).length === 0);
check("PIFY_SEARCH_NO_CACHE still searches correctly", JSON.stringify((await off.grep("danglingReferences")).items.map((i) => `${i.path}:${i.line}`)) === JSON.stringify(coldHits));
off.dispose();

rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
rmSync(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(bad === 0 ? "\nall loader checks passed" : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
