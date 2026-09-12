# @pify/search

Fuzzy file finding and indexed content search for [pi](https://github.com/earendil-works/pi) — fast when a native index is available, and working when it is not.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install search`](https://github.com/pifydev/cli) or `pi install npm:@pify/search`.

## Why

pi's `find` and `grep` spawn a process and read the tree on every call. That is the right design for a one-shot command and the wrong one for an agent, which asks over and over inside a single session. An index built once and kept current answers the fiftieth question as fast as the first.

The other half is the shape of the question. `find` wants a glob; people want *"the auth route file — you know the one"*. Fuzzy, typo-tolerant matching with results ranked by what you have actually been working on answers that; a glob does not.

## Tools

### `fffind`

| Parameter | Type | Notes |
|---|---|---|
| `query` | string | Part of a name or path; typos tolerated |
| `limit` | number, optional | Per page, default 20 |
| `cursor` | string, optional | From a previous call |

`worktre entr` finds `worktree/src/enter.ts`. Results are ranked: an exact filename beats a matching stem, which beats a prefix, which beats a directory that merely contains the query — and recently edited or git-modified files rise, because that is what you are probably looking for.

### `ffgrep`

| Parameter | Type | Notes |
|---|---|---|
| `pattern` | string | What to search for |
| `mode` | `literal` \| `regex` \| `fuzzy` | Default `literal` |
| `caseSensitive` | boolean, optional | Default false |
| `limit` / `cursor` | | Paging, default 20 per page |

Three modes because three different questions get asked: the exact string, a shape, and *"something like this"* for when you do not know how it is spelled.

## Two engines, one interface

**native** — this package's own Rust core, `native/`, built with napi. It indexes this suite (417 files) in about **40ms** cold, and a literal search then reads the **5** files the trigram index says could match rather than all 417. Searches come back in about a millisecond. Its index is [stored between sessions](#the-index-survives-the-process), so the second start does not pay for the first.

**builtin** — pure TypeScript, no dependencies, no binary. A trigram index for content, a fuzzy scorer for paths, an `fs.watch` subscription to stay current.

The fallback is the point. A native binary is a promise you cannot always keep: an unsupported platform, a locked-down install, a blocked postinstall — any of those, and a binary-only search extension is one that silently does nothing.

Both are checked against each other on a real tree (`test/live/engines.mjs`, **35/35**): the same files found, the same literal matches, the same refusal to search `node_modules`, the same reading of your `.gitignore`, cursors that advance rather than repeat — and they **rank identically**, because they share their scoring constants on purpose. Losing the binary should change how fast a search is, never how it is ordered. `/search` says which engine is live. There are no runtime dependencies.

### Building the native core

```bash
npm run build:native      # cargo build --release --manifest-path native/Cargo.toml
```

The result is picked up automatically from `native/target/release/`. CI builds and smoke-tests six targets — win32 x64/arm64, darwin x64/arm64, linux x64/arm64 — on every tag.

**Honest status:** the per-platform npm packages (`@pify/search-<triple>`) are **not published yet**, so *everything you install today runs the TypeScript engine* — the Rust core is what you get by building it yourself from a clone. The loader already looks for the published binaries, so shipping them later is additive and changes nothing else. Of the six CI targets, only `win32-x64` has also been built and run by hand.

### Does it work when installed?

That is a different question from whether the code works, and it is answered separately. `test/install-check.mjs` packs the tarball, installs it, loads the extension through jiti exactly as pi does, and runs real searches against a real tree — on **Linux, macOS and Windows** in CI, with no model and no API key. It is the check that catches a file missing from `files`, which is otherwise invisible until a user installs the package and a search quietly finds nothing.

`test/live/install-wire.mjs` covers the other half: a real pi session against a real install, verified by reading pi's own provider payloads rather than its printed output — because print mode reports only final text and a model replying "DONE" proves nothing. It runs on **all three platforms** on every tag (`.github/workflows/live.yml`), packing the commit being built rather than trusting whatever is already published:

```
install (ubuntu-latest)   7/7 passed
install (macos-latest)    7/7 passed
install (windows-latest)  7/7 passed
```

Each run states which engine it proved. Today all three say *"no native binary in the install — this run exercises the TypeScript engine"*, which is the honest shape of the answer until the per-platform binaries ship.

## How the content index works

Every overlapping three-byte window of every text file is a *trigram*, packed into one number and mapped to the files containing it. A search extracts the trigrams its pattern must contain and intersects those posting lists, so only files that could match are ever read. (The design is [tgrep](https://github.com/microsoft/tgrep)'s, which reports up to 52× over ripgrep on very large trees.)

The index only ever **narrows**; every surviving candidate is still matched for real, so a wrong candidate costs time and never correctness. The rule that makes it safe: a pattern with nothing indexable — `\d+`, a fuzzy query, one branch of an alternation that could match anywhere — reports "no candidate set is safe" and everything is read. Confusing *that* with "nothing matched" is how an index starts silently hiding results, so the two are different values throughout.

## The index survives the process

An index rebuilt at every start is one you pay for at every start. The native engine writes its index to disk and, next time, reloads it and reconciles instead of re-reading the tree.

Measured on a synthetic 20,000-file tree (`node native/bench.mjs 20000`):

| | build | files read | grep |
|---|---|---|---|
| cold (no stored index) | 480ms | 20,000 | <1ms |
| warm (unchanged tree) | **121ms** | 0 | <1ms |

**4×**, and the cost that remains is the directory walk, not the files. Editing one file re-reads one file. The absolute figures move with the operating system's own file cache — the same bench on a cold machine measured 1320ms and 188ms, a factor of 7 — so treat the ratio as the claim and the milliseconds as one machine on one afternoon.

Correctness rests on a single rule: a stored entry is trusted only while its **size and mtime still match what is on disk**. Anything changed, new, or vanished is re-read before a query can see it. A cache that answers confidently for a file that has moved on is worse than no cache. The reload path is checked against the rebuild path on every supported platform (`native/persist.mjs`, run in CI) — same totals, same lines, same order — including that a corrupt or truncated index is *discarded* rather than half-trusted.

Trigram lists are stored as varint deltas, which is what makes this worth doing at all: 881KB for this suite, ~2.2KB per file, about a third of the naive encoding. Reading a cache that is larger than the sources it summarises costs more than the rebuild it was meant to avoid.

The index lives in the platform cache directory — `%LOCALAPPDATA%`, `~/Library/Caches`, `$XDG_CACHE_HOME` — keyed by a hash of the absolute root, never inside your working tree.

| variable | effect |
|---|---|
| `PIFY_SEARCH_NO_CACHE=1` | never store an index; rebuild every start |
| `PIFY_SEARCH_CACHE_DIR` | store indexes somewhere else |
| `PIFY_SEARCH_TIMING=1` | print how long the walk, the reload and the inversion each took |
| `PIFY_SEARCH_ENGINE` | `builtin` to force the fallback |

## Your `.gitignore` is part of the index

The hard-coded skip list knows about `node_modules` and `target`. It cannot know that your project generates `build-out/`, or writes `secrets.env` — and those are exactly the files the repository has already said it does not want carried around. An index that carries them lets `ffgrep` surface a credential the repo deliberately excluded.

So the root `.gitignore` is read and applied by **both** engines, with the same rules: anchoring (`/build`), directory-only (`generated/`), `*` that stops at a slash and `**` that does not, and `!` negation where the last matching rule wins. Nested ignore files and git's full precedence are deliberately not implemented — a half-understood ignore hides files silently, and under-ignoring is the safer direction to be wrong in.

The two engines are checked against each other on this, not just asserted: a tree with a `.gitignore` goes into `test/live/engines.mjs` and both must skip the same files and keep the same negated one.

## Ranking

Frecency decays on a three-day half-life — an agent session is shorter and more concentrated than a human's week, so yesterday's file should not outrank today's. Every `read`, `edit` or `write` in the session counts as an access. History is capped at seven days and 128 timestamps per file, so the store cannot grow without bound.

## pi's own tools are left alone

This package adds two tools; it does not replace `find`, `grep` or `multi_grep`. Replacing them would put every search in the session behind whichever engine happened to load, and a fallback that is slower than the thing it replaced is not an improvement anyone asked for. Use `fffind`/`ffgrep` when a search is worth an index; the built-ins are still there when it is not.

## Command

`/search` — which engine is running, the indexed root, how many files it holds, and how much of the index came back from the stored copy rather than from disk.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
