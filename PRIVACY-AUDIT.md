# Privacy audit — codegraph-lite

`codegraph-lite` is a fork of [CodeGraph](https://github.com/colbymchenry/codegraph) that **cannot make an outbound network connection**. Upstream sends usage telemetry and checks GitHub for updates by default, and it ships commands that download and run remote code. This fork deletes every one of those paths from the code. They are removed, not switched off: no setting, env var or default can turn them back on.

Everything local still works: indexing, sync, every query command, the MCP server and its daemon, and the browser viewer (loopback only).

Two tests keep it that way across upstream syncs, and a script proves it on a machine with no network. See [Verification](#verification).

Spec: issue #1. Work: #2–#9, one PR each.

## Install

This build is only ever built from source. The upstream package `@colbymchenry/codegraph` on npm is the upstream build, with telemetry.

The fork has its own package name, `@carterchen247/codegraph-lite` (#18), and keeps the same `codegraph` bin. A shared name would let npm treat the official package as an update of this one. That was verified in an isolated npm prefix:

| After `npm link` of this checkout | Shared name (before #18) | Own name |
|---|---|---|
| `npm install -g @colbymchenry/codegraph` | exit 0, `changed 1 package`: the link is **silently replaced** by upstream | exit 1, `EEXIST: file already exists …/bin/codegraph`: **refused**, this build stays |
| `npm update -g` | n/a | `up to date`: the link stays (the name isn't on the registry) |

Only `--force` would let the official package overwrite the `codegraph` bin. Don't use it.

```bash
git clone git@github.com:CarterChen247/codegraph-lite.git
cd codegraph-lite
npm ci                 # needs Node 22.12+ (< 25); the only network step, to the npm registry
npm run build
npm link               # optional: puts this checkout's `codegraph` on PATH for terminal use
```

### Enable it per checkout (recommended)

`scripts/codegraph-local.mjs` turns CodeGraph on for Claude Code in **one checkout at a time** (#22). That can be a repo's main checkout, a `git worktree add` worktree, or a Claude Code worktree (`.claude/worktrees/<name>/`). Every other repo stays untouched: no MCP server, no prompt hook, no per-prompt cost. Nothing it writes is ever committed.

```bash
node scripts/codegraph-local.mjs enable  <checkout>   # also re-syncs if already enabled
node scripts/codegraph-local.mjs status  <checkout>
node scripts/codegraph-local.mjs disable <checkout>
```

| What | Where | Committed? |
|---|---|---|
| Index | `<checkout>/.codegraph/` (`init --local-only`: its own `.gitignore` ignores itself too) | no |
| MCP server | `~/.claude.json`, Claude Code **local scope**, keyed by `<checkout>`, via `claude mcp add --scope local` | no (outside the repo) |
| Prompt hook and auto-allow `mcp__codegraph__*` | `<checkout>/.claude/settings.local.json`, merged with your existing keys | no |
| Ignore rules for the two files above | `<git common dir>/info/exclude`, shared by every worktree, never pushed | no |

`enable` then verifies its own work and fails if any check doesn't hold:

- `git status` is unchanged;
- no codegraph git hook exists in `.git/hooks` or `core.hooksPath`;
- the index holds nothing under `.claude/worktrees/`, which is another checkout's code;
- `claude mcp get codegraph` finds the server.

More details:

- **Pinned to this build.** The MCP command and the hook call this build by absolute path, `<node on PATH> <checkout of this repo>/dist/bin/codegraph.js`. No other `codegraph` on PATH, including the official package, can stand in for it, and `npm link` isn't required.
- **Worktrees.** Each worktree gets its own index, so it never reads the main checkout's index of another branch. After creating a worktree, run `enable` on it. There are no git hooks, so nothing does this automatically.
- **No instructions block.** Nothing is written to `CLAUDE.md`, because the MCP server's `initialize` instructions already tell the agent how to use the tools.
- **Claude Code only.** Codex's project config would live inside the repo.
- **Tested** on a scratch repo with a main checkout, a sibling `git worktree add` worktree and a nested `.claude/worktrees/feat`, with a sandboxed HOME and the network denied:
  - the MCP entry was visible in those three paths and in no other repo;
  - each worktree's hook injected symbols from its own branch;
  - a pre-existing `settings.local.json` key survived `enable` and `disable`;
  - re-running `enable` added nothing;
  - `disable` left no MCP entry, hook, permission or `.codegraph/`.

`codegraph install` (upstream's installer) still works. It configures agents globally (or `--location local`, which writes the shared `.claude/settings.json` and `.mcp.json` into the repo), so prefer the script above.

**How `npm link` works:** it creates two links and copies nothing: `<npm prefix>/lib/node_modules/@carterchen247/codegraph-lite` points at this checkout, and `<npm prefix>/bin/codegraph` points at its `dist/bin/codegraph.js`. Every terminal, and every agent's MCP entry, then runs this build. To remove it, run `npm unlink -g` in the checkout.

**To update**, which is also what `codegraph upgrade` prints:

```bash
git pull && npm ci && npm run build
```

Then restart open agent sessions so their MCP servers load the new build. Run `codegraph-local.mjs enable` again on a checkout to re-sync its index.

## Every network point, and what happened to it

These are the findings of the audit of upstream at `f72c9d2e`.

| # | What | Upstream behaviour | Disposition | PR |
|---|---|---|---|---|
| A1 | **Telemetry** | On by default. POSTed a random machine ID, version, OS/arch, command and tool names with counts, the MCP client name, agent IDs and language names to `telemetry.getcodegraph.com`. Kept a machine ID and queue under `~/.codegraph/` | **Deleted.** The module is an inert stand-in that keeps its public shape, so call sites stay untouched. `codegraph telemetry` says it is removed. The installer's consent prompt never shows | #3 |
| A2 | **Update check** | On by default. Every MCP server start asked `github.com` / `api.github.com` for the latest release, cached the answer, and put an "update available" notice in the server log, the `initialize` instructions and `codegraph_status` | **Deleted.** No request, no cache, no notice | #4 |
| A3 | **Beta waitlist** | After `install` / `upgrade`, offered to send an email address you typed to `getcodegraph.com/api/waitlist` | **Deleted**, module and prompt | #6 |
| A4 | **`codegraph upgrade`** | Resolved the latest version on GitHub, then piped the remote `install.sh` into `sh` with the full environment, downloaded a release zip through PowerShell, or ran `npm install` of the official package. Any of these replaced this build with upstream | **Replaced.** It now prints the source-update commands above and downloads nothing | #5 |
| C1 | **Installer global install** | `codegraph install` offered to run `npm install -g @colbymchenry/codegraph`, which would shadow this build on PATH | **Deleted** | #6 |
| C2 | **Uninstaller npm removal** | `codegraph uninstall` ran `npm root -g` and `npm uninstall -g @colbymchenry/codegraph` | **Deleted.** It removes bundle artifacts and the launcher link only. An official npm install is left for you to remove with npm | #6 |
| A5 | **npm shim self-heal** (`scripts/npm-shim.js`) | Downloaded a release archive when the official npm package's platform binary was missing | **Untouched.** It runs only inside the official npm packaging, never in a source build. It is outside the static scan | — |

Upstream sent no source code, file paths, repository or symbol names, or env values in any of these. The removal is about guaranteeing that stays true. It also deletes the identifiers (machine ID, IP to GitHub) and the remote code execution (`curl | sh`).

## What still uses a socket, and why it is local

All of these are allowlisted in the static scan, each with its reason.

| What | Where it listens or connects | Notes |
|---|---|---|
| MCP daemon | A Unix socket at `<project>/.codegraph/daemon.sock`, mode `0600` (a named pipe on Windows, default ACL) | Carries MCP traffic between agent sessions and the shared daemon. `CODEGRAPH_NO_DAEMON=1` runs in-process instead |
| Viewer server (`codegraph ui`) | `127.0.0.1` only, hard-coded | **No auth token:** any local process can read it while it runs, but such a process could read the files directly anyway. Sends `connect-src 'self'` and other strict CSP headers. Still gated behind `CODEGRAPH_UI=1` upstream |
| Viewer front end | `fetch` / `EventSource` to its own origin | Same origin only. The CSP blocks any other origin |
| Windows process lookup | Local PowerShell `Get-CimInstance Win32_Process` | Reads a local process's command line. No network |

## Other local behaviour worth knowing

None of this is network traffic.

- **`~/.codegraph/daemons/`:** the daemon registry. Records are written while a daemon runs and removed when it exits. Nothing else is written to `~/.codegraph/`.
- **`<project>/.codegraph/`:** the index database and the daemon's socket, pid and log files. It is gitignored by `codegraph init`.
- **Agent configs:** `codegraph install` writes MCP entries and a short instructions block into each agent's config files (`~/.claude/…`, `~/.codex/…`, and so on). `codegraph uninstall` removes them.
- **`CODEGRAPH_BROWSER`:** if set, `codegraph ui` runs that value as the command that opens the viewer URL (`shell: false`). Don't set it from an untrusted source.
- **No-op env vars:** these no longer do anything:
  - `CODEGRAPH_TELEMETRY`, `CODEGRAPH_TELEMETRY_ENDPOINT` and `serve --no-telemetry`;
  - `DO_NOT_TRACK`, for telemetry and the update check;
  - `CODEGRAPH_NO_UPDATE_CHECK`;
  - `CODEGRAPH_VERSION`, for `upgrade`.

## Third-party dependencies

None of them has network code CodeGraph can reach. `commander`'s `spawn` serves executable subcommands, which CodeGraph never defines. `web-tree-sitter`'s `fetch` and XHR sit in browser-only branches. The viewer bundle fetches only its own origin.

The full findings and the commands to re-run are in [`docs/privacy/dependency-network-audit.md`](docs/privacy/dependency-network-audit.md) (#8).

Out of scope: dev dependencies, and `npm ci`'s own traffic to the npm registry.

## Verification

| Check | What it proves | Where |
|---|---|---|
| **Network tripwire** (runtime) | The built CLI makes zero outbound attempts. Every process it starts preloads a tripwire through `NODE_OPTIONS`; that includes the CLI's re-exec, the MCP daemon and worker threads. The tripwire records, then fails, any `fetch`, `net`/`tls`/`http(s)` connect or DNS lookup that isn't loopback, and any spawn of curl, wget, npm or PowerShell. Commands run: `init`, `index`, `query`, `explore`, `telemetry`, `upgrade`, `prompt-hook` (one prompt per gate tier: explore injected, symbol list injected, nothing injected; #20), and `serve --mcp` in-process and in daemon mode. Then it checks that no telemetry or update-check file exists. No opt-out env var is set, and the inherited ones are stripped | `__tests__/network-tripwire.test.ts` (#2–#5) |
| **Static scan** (source) | `src/` and `ui/src/` contain no network import, request call or network-program spawn outside a 7-entry allowlist. Each entry has a reason. A stale entry fails too. This catches network code an upstream sync adds that nothing runs yet | `__tests__/network-static-scan.test.ts` (#7) |
| **Offline check** (whole system) | Everything works with the network denied at the OS level, with no errors, no hangs and no state left behind | `docs/privacy/offline-check.sh` (#9, macOS) |

Each check was confirmed to **fail on the pre-hardening upstream code**, so a pass means something:

- **Tripwire:** with the opt-outs removed it recorded `telemetry.getcodegraph.com`, `github.com:443` and `api.github.com:443`.
- **Static scan:** pointed at upstream `f72c9d2e`, it flagged every path in the table above.
- **Offline check:** against an upstream build it failed 3 times. `upgrade` couldn't reach GitHub, and it left `telemetry.json`, `telemetry-queue.jsonl` and `update-check.json` behind.

### Offline run, 2026-11-05

`bash docs/privacy/offline-check.sh` ran on macOS against a snapshot of this repo's `src/` (360 files), in a fresh HOME.

Two sandboxes were used:

- **For the CLI and MCP:** every network operation is denied. Local Unix sockets are allowed, except mDNSResponder's, because DNS lookups go through that socket and a lookup would leak the hostname.
- **For the viewer:** the same, plus loopback TCP.

```text
  codegraph init -y .                              exit=0   3623 ms
  codegraph index .                                exit=0   3552 ms
  codegraph sync .                                 exit=0    250 ms
  codegraph status .                               exit=0    236 ms
  codegraph query main                             exit=0    152 ms
  codegraph explore main                           exit=0    257 ms
  codegraph telemetry status                       exit=0    138 ms
  codegraph telemetry on                           exit=0    135 ms
  codegraph upgrade --check                        exit=0    139 ms
  codegraph upgrade                                exit=0    136 ms
  prompt-hook: "how does main work"                exit=0    247 ms  injected=1
  prompt-hook: "fix the typo in the readme"        exit=0    151 ms  injected=0
  serve --mcp: initialize                          85 ms
  serve --mcp: codegraph_explore                   295 ms
  serve --mcp: codegraph_status                    125 ms
  ui (viewer, loopback only)                       page=200 listen=127.0.0.1:42148

  ~/.codegraph afterwards: daemons

OFFLINE CHECK PASSED
```

- **No hangs:** no command waited on a network timeout. Indexing 360 files took under 4 s.
- **Real answers:** `query`, `callers` and `explore` returned real results. `explore` returned about 19 KB of source and call paths.
- **Prompt hook:** Claude Code runs `codegraph prompt-hook` on every prompt the user sends, with the prompt text. With the network denied, it injected context for the structural prompt and nothing for the plain one (#20).
- **MCP server:** `initialize` and `codegraph_status` carried no update notice. The daemon exited on its idle timeout, and its log has no network errors.
- **Viewer:** it listened on `127.0.0.1` only and sent its CSP.

### Known test-suite baseline on this Mac

`npm test` passes except for 31 tests in two files. The same failures, by name, are present on every PR in this series, and they are environmental rather than privacy-related:

- **`installer-targets.test.ts` (30):** the test compares `/var/…` with `/private/var/…`; on macOS `/var` is a symlink.
- **`bundle-launcher.test.ts` (1):** Homebrew's `node` loads `libnode.*.dylib`, which a copied bundle doesn't have.

## After every upstream sync

1. **Resolve conflicts in this fork's favour** in these files (and keep `"name": "@carterchen247/codegraph-lite"` in `package.json` / `package-lock.json`):
   - `src/telemetry/index.ts`
   - `src/upgrade/update-check.ts`
   - `src/upgrade/index.ts`
   - `src/upgrade/remove-binary.ts`
   - the `telemetry` and `upgrade` commands in `src/bin/codegraph.ts`
   - steps 2 and 5½ of `src/installer/index.ts`

   If upstream changed those features, read what changed. New call sites that use the stand-ins can stay as they are.
2. **Rebuild and run the tests:** `npm ci && npm run build && npm test`.
   - `network-static-scan` fails on any new network code. Remove the code, or, if it is genuinely local, allowlist it with a reason.
   - `network-tripwire` fails on any new outbound attempt by the commands it runs.
   - Expect only the 31 baseline failures above.
3. **Re-run the dependency audit:** the commands are in `docs/privacy/dependency-network-audit.md`. Update its tables if the tree changed.
4. **Run the offline check:** `bash docs/privacy/offline-check.sh` must print `OFFLINE CHECK PASSED`.
5. **Look for new automatic behaviour:** grep the new upstream `CHANGELOG.md` entries and any new `src/` files for telemetry, update, analytics, waitlist or upload features, in case something reaches the network in a shape the scan doesn't know. Add any you find to the table above.
6. **Update this file** in the same change.
