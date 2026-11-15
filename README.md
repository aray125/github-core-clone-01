# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/c/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/aray125/github-core-clone-01/rank.svg)](https://make.fun/c/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/aray125/github-core-clone-01/reward.svg)](https://make.fun/c/github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: git smart HTTP
(upload-pack protocol v2 and v0, receive-pack v0), REST v3, GraphQL v4 and MCP,
all served from its own in-memory store. No git binary, no database, no external
service — only the Node standard library.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: it binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL`, and polls `/done` until the trial ends. It needs
`MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in the environment.

## Layout

- `main.ts` — the entry lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP server, routing, and the REST v3 surface.
- `store.ts` — the forge's store: objects, refs, issues, labels, pull requests,
  plus the deterministic scenario viewer (derived from the contest's fixed seed).
- `git.ts` — pkt-line framing, packfiles, upload-pack v2/v0 and receive-pack.
- `graphql.ts` — a small GraphQL parser and executor (repository, issues, pull
  requests, node, `__type`, and the create/close/merge/comment mutations).
- `mcp.ts` — MCP over JSON-RPC 2.0 (2026-07-28 era, with the legacy initialize
  handshake): create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request.

## Determinism

Every timestamp comes from a fixed epoch plus a monotonic sequence; nothing reads
a clock or an unseeded random source. Two runs on the same requests behave
identically, so the trial's live and replay runs agree.
