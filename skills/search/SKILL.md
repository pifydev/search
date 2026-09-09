---
name: search
description: Use when looking for a file whose name you only half remember, or searching code for a string, symbol, or pattern — especially when you will search more than once in a session
---

# Searching this project

`@pify/search` keeps an index in memory, so the second search in a session is
as cheap as the first. Prefer it over `find` and `grep`, which re-read the tree
every time they run.

## Finding a file

`fffind query="auth route"` — fuzzy and typo-tolerant. Give a fragment of the
name rather than a guess at the full path: `worktre entr` finds
`worktree/src/enter.ts`. Results are ranked, so the first one is usually the
one you meant — recently edited and git-modified files rank higher.

## Searching contents

`ffgrep pattern="..."` with one of three modes:

- `literal` (default) — an exact string. Use it when you know the spelling.
- `regex` — a pattern. Use it for shapes, like `function\s+handle\w+`.
- `fuzzy` — when you are unsure of the wording. Use it after a literal search
  comes back empty, before concluding the thing does not exist.

## Paging

Both tools return a `cursor` when there is more. An empty first page means no
match; a page with a cursor does **not** mean the whole answer — fetch the next
page before concluding anything about how often something appears.

## When not to use this

Reading a file you already know the path of: use `read`. Listing one directory:
use `ls`. This is for finding things.
