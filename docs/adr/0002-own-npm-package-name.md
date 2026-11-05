# ADR-0002: Give the fork its own npm package name

- **Status:** Accepted, 2026-11-05
- **Decided in:** #18 (PR #19)

## Context

This fork is built from source and put on PATH with `npm link`. Before #18 it kept upstream's package name, `@colbymchenry/codegraph`. To npm, the official package was then simply a newer version of the linked build.

In an isolated npm prefix, `npm install -g @colbymchenry/codegraph` exited 0, printed `changed 1 package`, and **silently** swapped the link for upstream. That swap brings back telemetry and the update check. Nothing warned the user, and nothing failed.

## Decision

- **Rename the package** to `@carterchen247/codegraph-lite`.
- **Keep the bin as `codegraph`.** Every agent config and the docs keep working unchanged.
- **Use a scoped name.** It is scoped rather than plain (for example `codegraph-lite`), because only the owner of `@carterchen247` can publish under it.
- **Fix the CLI's module-load failure hint.** It said to reinstall the official package. It now says to rebuild the checkout.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Keep upstream's name and tell people not to run `npm install -g` / `npm update -g`** | That relies on memory. One mistyped command silently undoes the hardening. |
| **Skip `npm link`: put a hand-made symlink earlier on PATH, e.g. `~/.local/bin`** | npm never touches the link, but the protection then depends on PATH order. Any environment with a different order runs upstream, and you can't tell from inside it. A failure you can see beats one you can't. |
| **An unscoped new name** | Anyone can publish an unscoped name to the registry. A future `npm update -g` or `npm install -g` of that name could then fetch someone else's code. |

## Consequences

Verified in an isolated prefix:

- **Installing the official package next to this one now fails:** `npm install -g @colbymchenry/codegraph` exits 1 with `EEXIST: file already exists …/bin/codegraph`, and the link stays. Only `--force` overwrites it, and the docs say not to use it.
- **`npm update -g` leaves the link in place,** offline and online. The name isn't on the registry.
- **Upstream syncs** may conflict on the `name` line of `package.json` / `package-lock.json`. Keep this fork's side.
- **Not verified:** whether the `@carterchen247` npm account exists. Registering it, which is free, reserves the scope.
- **Not affected:** checkouts enabled with `--location private` ([ADR-0003](0003-install-location-private.md)). They call the build by absolute path, so they don't depend on PATH or on `npm link` at all. `npm link` only matters for typing `codegraph` in a terminal.
