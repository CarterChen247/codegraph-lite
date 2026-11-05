# ADR-0003: `codegraph install --location private`, a per-checkout personal setup

- **Status:** Accepted, 2026-11-05
- **Decided in:** #20, #22 (superseded), #24 (PR #25), #26 (PR #27)

## Context

The fork is meant for **a few chosen repos and their worktrees**, on a machine with many other repos, under security requirements.

Every other repo must stay untouched: no MCP server, no prompt hook, no per-prompt cost, and nothing reads prompts typed there. The setup must also never end up in git, because team repos are shared.

Claude Code has three settings scopes:

| Scope | Applies to | Seen by | Lives in |
|---|---|---|---|
| user | every project | you | `~/.claude.json` (top level), `~/.claude/settings.json` |
| project | this repo | the team (meant to be committed) | `.mcp.json`, `.claude/settings.json` |
| local | this project | you | `~/.claude.json` (keyed by the project path), `.claude/settings.local.json` |

Upstream's installer offers `global`, which is user scope, and `local`, which is project scope. Neither fits.

## Decision

Add a third mode, `codegraph install -l private` / `codegraph uninstall -l private`. It sets up Claude Code's **local** scope in the current checkout.

**What it writes:**

- **Ignore rules first.** `.claude/settings.local.json` and `.codegraph/` go into `<git common dir>/info/exclude`. Every worktree shares that file, and it is never pushed.
- **The MCP server, through Claude Code's own CLI:** `claude mcp add --scope local codegraph -- <node> <this build>/dist/bin/codegraph.js serve --mcp`, run in the checkout with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- **The prompt hook and auto-allow** for `mcp__codegraph__*`, merged into `.claude/settings.local.json`.
- **The index, by default:** `init --local-only`, or a sync when one already exists. `--no-init` skips it.

**Then it verifies,** and fails if any check does:

- `git status` is unchanged;
- no codegraph git hook exists;
- the index holds nothing under `.claude/worktrees/`;
- `claude mcp get` finds the server.

**What it refuses.** Before writing anything, it stops if:

- `claude` is not on PATH;
- the directory is not a checkout root;
- a non-Claude `--target` is given;
- `settings.local.json` is not valid JSON.

**How it is built:**

- **Routed at the CLI entry, not added to `Location`.** `Location` stays `'global' | 'local'`, and `private` is handled before any agent target runs. Across 23 files, the targets read "not global" as `local`, which means the repo's shared files. A third value would have been silently treated that way.
- **Absolute paths** to the build in the MCP command and the hook, so no `codegraph` on PATH can stand in for it.
- **Claude Code only.**
- **No `CLAUDE.md` instructions block.** The MCP `initialize` instructions already guide the agent.
- **No git hooks.** A new worktree is enabled by running the command in it.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **`codegraph install` (global)** | The hook would run on every prompt in every repo (~0.1 s each) and read every prompt typed anywhere. The point is to touch only the chosen repos. |
| **`codegraph install --location local`** | It writes the repo's **shared** `.mcp.json` and `.claude/settings.json`, which are easy to commit. If the repo already tracks them, it edits tracked files, which `exclude` cannot hide. |
| **A standalone script** (#22, PR #23, closed) | The same behaviour, but outside the installer: a second copy of the logic, with no test coverage and a second entry point to document. |
| **A global hook gated by `[ -d .codegraph ] && …`** | It costs about 1 ms outside chosen repos and writes nothing into repos. But a shell still runs on every prompt in every repo, and any directory with a `.codegraph/` would trigger it. Strict isolation wins under the security requirement. |
| **Write `~/.claude.json` directly instead of calling `claude mcp add`** | This makes full automated testing possible, but this fork would then own a file format that Claude Code defines and rewrites while it runs. The CLI is the supported interface. Tests use a stand-in `claude`, and the real format was checked by hand. |
| **Add a third value to `Location`** | Every target would silently treat it as `local` and write the shared files: the opposite of the goal, with no error. |
| **A `codegraph enable` alias, a setup shell script, or a Claude Code slash command** | The alias duplicates `install` under a second name. The shell script only chains four commands that `docs/ONBOARDING.md` already lists. A slash command needs a file in the user scope. Indexing by default removed the one flag the alias would have saved. |
| **A `post-checkout` git hook to enable new worktrees automatically** | It writes into `.git/hooks`, which the security requirement rules out. Upstream's own git sync hooks are only offered when the file watcher is off (`CODEGRAPH_NO_WATCH=1` or WSL2 `/mnt`), never on macOS, and the install verifies that none exist. |

## Consequences

- **Disk.** Each worktree has its own index, so it answers for its own branch, at the cost of disk space and a few seconds of indexing per worktree.
- **Absolute paths.** Moving the `codegraph-lite` clone breaks enabled checkouts until the install is re-run in each. Updating it in place needs nothing.
- **`~/.claude.json` keeps stale entries.** The entry for a deleted worktree's path stays until `uninstall -l private` runs there. It is harmless, but untidy.
- **Platforms.** It is tested on macOS. The hook command uses POSIX shell quoting, so Windows isn't supported. Linux is untested.
- **Upstream syncs.** The code lives in `src/installer/private-claude.ts`, plus a routing block in each of `install` and `uninstall` in `src/bin/codegraph.ts`. Conflicts should stay small.
- **Tests.** `__tests__/installer-private.test.ts` drives the built CLI with a stand-in `claude` on PATH. A mutation check confirmed that it fails when the settings merge or the traffic switch breaks.
