# Getting started with codegraph-lite

This guide covers how to install CodeGraph on your machine, turn it on for the repos you choose, and use it from Claude Code. It assumes macOS.

**What you get.** Claude Code answers "how does X reach Y", "who calls this", and "what breaks if I change this" from a local code graph, with fewer file reads and searches.

**What stays local.** The graph never leaves your machine. This fork has no telemetry, update checks or downloads; see [`PRIVACY-AUDIT.md`](../PRIVACY-AUDIT.md). It runs only in the checkouts you turn it on in, and nothing it writes ends up in git.

## 1. Before you start (once per machine)

| You need | Check | If it's missing |
|---|---|---|
| git | `git --version` | `xcode-select --install` |
| Node 22.12 or newer, below 25 | `node -v` | `brew install node@22`, then `echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zprofile` and open a new terminal |
| Claude Code, logged in | `claude --version` | Install Claude Code and log in |

## 2. Install CodeGraph (once per machine)

```bash
git clone --branch v1.6.2-lite.1 https://github.com/CarterChen247/codegraph-lite.git ~/Documents/Github/codegraph-lite
cd ~/Documents/Github/codegraph-lite
npm ci && npm run build && npm link
```

- **Network:** `npm ci` is the only step that uses the network. It downloads dependencies from the npm registry. If your network blocks the registry, ask for access to it.
- **What `npm link` does:** it puts this build's `codegraph` on your PATH. It is safe to run. If you later run `npm install -g @colbymchenry/codegraph` by mistake, it fails with `EEXIST` instead of replacing this build. Don't add `--force`.
- **The reviewed version:** `--branch v1.6.2-lite.1` checks out a reviewed release instead of `main`. Git will say you are in "detached HEAD", which is expected.
  - **Tag names:** `v<upstream version>-lite.<n>`. The latest is in the repo's tags: `git tag --sort=-creatordate | head -1`.
  - **Agreed version:** if your team has agreed on a different tag, use that one instead.

## 3. Turn it on in a repo (once per repo or worktree)

At the root of the repo:

```bash
cd ~/work/my-repo
codegraph install -l private
```

You should see a few `✓` lines, the index being built, and finally `✓ Verified: git status unchanged …`.

- **Worktrees:** a worktree is a separate checkout, from `git worktree add` or a Claude Code worktree under `.claude/worktrees/<name>/`. Run the same command at the worktree's root. Each worktree gets its own index, so it answers for its own branch.
- **Nothing in git:** `git status` stays clean and nothing shows up in your PRs. The setup lives in:
  - your own `~/.claude.json`, for this path only;
  - `.claude/settings.local.json`;
  - `.codegraph/`.

  Both repo files are ignored through `.git/info/exclude`.
- **Errors:** if it refuses, the message says why and nothing was written. Typical reasons: you're not at the checkout root, `claude` isn't installed, or `.claude/settings.local.json` is broken.

## 4. Check it's working

```bash
cd ~/work/my-repo
claude
```

- If Claude Code asks whether you trust the folder, say yes.
- Type `/mcp`. `codegraph` should be listed and connected.
- If it isn't listed, quit and run `claude mcp get codegraph` in the repo root. If that finds nothing, run `codegraph install -l private` again.

## 5. Ask Claude

CodeGraph helps most with questions about how the code fits together:

| Ask | What helps behind the scenes |
|---|---|
| "How does a login request get from the controller to the database?" | The prompt hook adds the relevant code and call paths before Claude reads your question |
| "Who calls `calculateTotal`?" | `codegraph_callers` |
| "What would changing `UserService.save` affect?" | `codegraph_impact` |
| "Where is the payment retry logic?" | `codegraph_search`, `codegraph_explore` |

- **No permission prompts:** CodeGraph's tools (`mcp__codegraph__…`) are allowed without asking. They only read the local index.
- **Other prompts:** a plain request like "fix this typo" gets nothing added and costs about 0.1 s.
- **Name things:** questions that name real functions, classes or files work best.

## Day to day

| Situation | Do |
|---|---|
| You changed code | Nothing. While Claude Code is open, the index follows your edits. To refresh it right now, run `codegraph install -l private` again |
| A new worktree | `cd <worktree> && codegraph install -l private` |
| Update CodeGraph to a newer reviewed release | `cd ~/Documents/Github/codegraph-lite && git fetch --tags && git checkout <new tag> && npm ci && npm run build`, then restart Claude Code. Enabled repos need nothing else |
| You moved the `codegraph-lite` folder | Run `codegraph install -l private` again in each enabled repo. The setup points at the build by its full path |
| Stop using it in a repo | `codegraph uninstall -l private`. Add `codegraph uninit` to delete the index too |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `codegraph: command not found` | You skipped `npm link`, or Node isn't on PATH | Run `npm link` in the clone, and open a new terminal |
| `/mcp` has no `codegraph` | Not enabled in this exact directory, or you're in a subdirectory or another worktree | `codegraph install -l private` at that checkout's root |
| Answers describe another branch's code | You're in a worktree that wasn't enabled, so it borrowed a parent's index | `codegraph install -l private` in the worktree |
| `--location private needs Claude Code's claude command on PATH` | Claude Code isn't installed, or isn't on PATH | Install it, then re-run |

**Platforms.** This setup has been tested on macOS. Linux should work. Windows isn't supported, because the hook command uses POSIX shell quoting.
