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

## Three engines, one interface

**native** — this package's own Rust core, `native/`, built with napi. It indexes this suite (417 files) in **33ms**, and a literal search then reads the **5** files the trigram index says could match rather than all 417. Searches come back in about a millisecond.

**fff** — [`@ff-labs/fff-node`](https://github.com/dmtrKovalenko/fff), used when it is installed and the native core is not. A mature engine with its own watcher and git integration.

**builtin** — pure TypeScript, no dependencies, no binary. A trigram index for content, a fuzzy scorer for paths, an `fs.watch` subscription to stay current.

The fallback is the point. A native binary is a promise you cannot always keep: an unsupported platform, a locked-down install, a blocked postinstall — any of those, and a binary-only search extension is one that silently does nothing.

All three are checked against each other on a real tree (`test/live/engines.mjs`, **33/33**): the same files found, the same literal matches, the same refusal to search `node_modules`, cursors that advance rather than repeat — and native and builtin **rank identically**, because they share their scoring constants on purpose. Losing the binary should change how fast a search is, never how it is ordered. `/search` says which engine is live.

### Building the native core

```bash
npm run build:native      # cargo build --release --manifest-path native/Cargo.toml
```

The result is picked up automatically from `native/target/release/`. CI builds and smoke-tests six targets — win32 x64/arm64, darwin x64/arm64, linux x64/arm64 — on every tag.

**Honest status:** only `win32-x64` has been built and verified by hand; the other five are proven by CI and nothing more. Per-platform npm packages (`@pify/search-<triple>`) are not published yet, so an installed copy of this package uses fff if you have it and the TypeScript engine otherwise. The loader already looks for them, so publishing is additive.

## How the content index works

Every overlapping three-byte window of every text file is a *trigram*, packed into one number and mapped to the files containing it. A search extracts the trigrams its pattern must contain and intersects those posting lists, so only files that could match are ever read. (The design is [tgrep](https://github.com/microsoft/tgrep)'s, which reports up to 52× over ripgrep on very large trees.)

The index only ever **narrows**; every surviving candidate is still matched for real, so a wrong candidate costs time and never correctness. The rule that makes it safe: a pattern with nothing indexable — `\d+`, a fuzzy query, one branch of an alternation that could match anywhere — reports "no candidate set is safe" and everything is read. Confusing *that* with "nothing matched" is how an index starts silently hiding results, so the two are different values throughout.

## Ranking

Frecency decays on a three-day half-life — an agent session is shorter and more concentrated than a human's week, so yesterday's file should not outrank today's. Every `read`, `edit` or `write` in the session counts as an access. History is capped at seven days and 128 timestamps per file, so the store cannot grow without bound.

## pi's own tools are left alone

This package adds two tools; it does not replace `find`, `grep` or `multi_grep`. Replacing them would put every search in the session behind whichever engine happened to load, and a fallback that is slower than the thing it replaced is not an improvement anyone asked for. Use `fffind`/`ffgrep` when a search is worth an index; the built-ins are still there when it is not.

## Command

`/search` — which engine is running, the indexed root, and how many files it holds.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
