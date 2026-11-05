# ADR-0001: Remove network features from the code instead of switching them off

- **Status:** Accepted, 2026-11-04
- **Decided in:** #1 (spec), #2–#9 (implementation)

## Context

Upstream CodeGraph reaches the network in four ways:

- telemetry, on by default;
- an update check against GitHub, on by default;
- a beta waitlist;
- `codegraph upgrade`, which pipes a remote `install.sh` into `sh` with the full environment, or runs `npm install` of the official package.

Upstream sends no source code in any of these. Still, this fork runs on code bases under security requirements, and it must be able to show that **nothing** leaves the machine, now and after every upstream sync.

Upstream already offers off-switches: `codegraph telemetry off`, `CODEGRAPH_TELEMETRY=0`, `DO_NOT_TRACK`, `CODEGRAPH_NO_UPDATE_CHECK`.

## Decision

1. **Delete each outbound path from the code.** Turning it off is not enough. Where call sites are spread across the code base (telemetry is called from 14 files), the module becomes an **inert stand-in** that keeps upstream's exported names and signatures, so every call site compiles unchanged. `codegraph upgrade` is replaced by a message that explains how to update from source.
2. **Guard the result three ways, each proven to fail on upstream's code:**
   - **Runtime tripwire** (`__tests__/network-tripwire.test.ts`). The CLI, its re-exec, the MCP daemon and worker threads preload the tripwire through `NODE_OPTIONS`. It records and fails any non-loopback `fetch`, connect or DNS lookup, and any spawn of curl, wget, npm or PowerShell. No opt-out env var is set.
   - **Static scan** (`__tests__/network-static-scan.test.ts`). It finds network imports, request calls and network-program spawns anywhere in `src/` and `ui/src/` outside a 7-entry allowlist. Each entry has a reason, and a stale entry also fails. This catches network code an upstream sync adds that nothing runs yet.
   - **Offline check** (`docs/privacy/offline-check.sh`). It runs the whole command set, an MCP session, the prompt hook and the viewer under macOS `sandbox-exec` with the network denied, including mDNSResponder's socket so DNS can't leak a name.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Turn them off by default with the existing env vars or config** | A switch can be missed, reset, or set wrongly in one environment. An upstream sync can also add a new path that the switch doesn't cover. With no code, there is nothing to switch back on. |
| **Delete every call site as well as the module** | Telemetry alone touches 14 files. Upstream keeps changing them, so every sync would conflict across the code base. A stand-in keeps the diff to a few files. |
| **Rely on one check only** | Each one alone misses something. The tripwire sees only code that runs. The scan sees only shapes it knows about. The offline check is manual and macOS-only. Together they cover what runs, what doesn't run yet, and the whole system. |
| **Patch third-party dependencies too** | The audit (`docs/privacy/dependency-network-audit.md`) found that no dependency has network code CodeGraph can reach. Patching code that can't run is a cost with no benefit. |

## Consequences

- **Upstream syncs.** A sync that changes these modules conflicts in a small, known set of files: `src/telemetry/index.ts`, `src/upgrade/update-check.ts`, `src/upgrade/index.ts`, `src/upgrade/remove-binary.ts`, two commands in `src/bin/codegraph.ts`, and two installer steps. Keep this fork's side. New call sites that use the stand-ins are harmless.
- **New network code fails the suite.** It must either be deleted, or, if it is genuinely local, allowlisted with a reason.
- **Lost features.** Upstream's self-update, update notices and usage stats are gone by design. Updates come from `git pull && npm ci && npm run build`.
- **Docs.** `PRIVACY-AUDIT.md` is the running record of what was removed and the post-sync checklist.
