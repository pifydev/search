import { describe, expect, test } from "bun:test";
import { basename, isAbsolute } from "node:path";

import { cachePathFor } from "../src/native.ts";

const withEnv = <T>(vars: Record<string, string | undefined>, run: () => T): T => {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const clean = { PIFY_SEARCH_NO_CACHE: undefined, PIFY_SEARCH_CACHE_DIR: undefined };

describe("cachePathFor", () => {
  test("puts the index outside the tree it describes", () => {
    const path = withEnv(clean, () => cachePathFor("/home/dev/project"));
    expect(path).toBeDefined();
    expect(isAbsolute(path!)).toBe(true);
    // The failure this guards is an index landing in someone's working tree,
    // where it shows up in `git status` and in diffs.
    expect(path!.includes("/home/dev/project")).toBe(false);
  });

  test("two trees never share an index", () => {
    const [a, b] = withEnv(clean, () => [
      cachePathFor("/home/dev/alpha/service"),
      cachePathFor("/home/dev/beta/service"),
    ]);
    // Same basename on purpose: if the name were the only key, these two
    // checkouts would overwrite each other's index and answer for the wrong
    // tree — a wrong result, not merely a slow one.
    expect(basename(a!).startsWith("service-")).toBe(true);
    expect(basename(b!).startsWith("service-")).toBe(true);
    expect(a).not.toBe(b);
  });

  test("the same tree resolves to the same index every time", () => {
    const [a, b] = withEnv(clean, () => [
      cachePathFor("/home/dev/project"),
      cachePathFor("/home/dev/project/"),
    ]);
    expect(a).toBe(b);
  });

  test("a relative root is resolved before it is keyed", () => {
    const [dot, absolute] = withEnv(clean, () => [cachePathFor("."), cachePathFor(process.cwd())]);
    expect(dot).toBe(absolute);
  });

  test("PIFY_SEARCH_CACHE_DIR relocates it", () => {
    const path = withEnv({ ...clean, PIFY_SEARCH_CACHE_DIR: "/tmp/somewhere" }, () =>
      cachePathFor("/home/dev/project"),
    );
    expect(path!.replace(/\\/g, "/").startsWith("/tmp/somewhere/")).toBe(true);
  });

  test("PIFY_SEARCH_NO_CACHE turns persistence off entirely", () => {
    const path = withEnv({ ...clean, PIFY_SEARCH_NO_CACHE: "1" }, () =>
      cachePathFor("/home/dev/project"),
    );
    expect(path).toBeUndefined();
  });

  test("a root full of path-hostile characters still yields one filename", () => {
    const path = withEnv(clean, () => cachePathFor("/home/dev/we:ird name/*sub?"));
    const name = basename(path!);
    expect(/^[A-Za-z0-9._-]+\.idx$/.test(name)).toBe(true);
  });
});
