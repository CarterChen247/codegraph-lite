/**
 * CLI binary removal for `codegraph uninstall` (the #1071 shadow, uninstall
 * edition).
 *
 * Before this module, three disconnected paths each removed PART of an
 * installation and none removed it all: `codegraph uninstall` swept agent
 * configs only, `install.sh --uninstall` deleted the bundle only, and npm's
 * `preuninstall` hook cleaned configs when npm removed its own package. A
 * user with more than one install method (the common drift: npm first, the
 * bundle later — or vice versa) ran `codegraph uninstall` and still had a
 * working `codegraph` on PATH.
 *
 * This module makes `codegraph uninstall` complete: PLAN every binary
 * install present on the machine (bundle layout(s), the bin-dir shim), then
 * EXECUTE the removals. Privacy hardening (#6): this build never asks npm about,
 * or runs `npm uninstall -g` against, the official npm package — a user who
 * installed it removes it with npm themselves. Split planner/executor with
 * injected side effects, same convention as the upgrade orchestrator.
 *
 * Safety rules:
 *   - A source checkout is REPORTED, never deleted — a git repo is the
 *     user's working tree, not an "install".
 *   - A project-local npm install is left alone — the project's
 *     package.json owns it, not the machine-level uninstaller.
 *   - On unix the default install dir (`~/.codegraph`) doubles as the
 *     machine-level state dir (telemetry choice, daemon records, the
 *     update-check cache) — only the install ARTIFACTS (`versions/`,
 *     `current`) are removed there, never the whole dir. A dedicated
 *     install dir (Windows `%LOCALAPPDATA%\codegraph`, or a custom
 *     `CODEGRAPH_INSTALL_DIR`) is removed wholesale.
 *   - The bin-dir shim is removed only when it verifiably points into a
 *     detected install dir — a user's unrelated `codegraph` file survives.
 *   - Windows cannot DELETE a running exe but CAN rename it (the same
 *     trick the in-place upgrade uses): a locked `node.exe` is renamed
 *     aside and reported as a leftover for the user to delete after the
 *     window closes, instead of failing the whole removal.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectInstallMethod } from './index';

// ---------------------------------------------------------------------------
// Planner (pure — every probe injected)
// ---------------------------------------------------------------------------

export interface RemoveBinaryProbes {
  /** `__filename` of the running CLI entry (dist/bin/codegraph.js). */
  filename: string;
  platform: NodeJS.Platform;
  cwd: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  exists: (p: string) => boolean;
  /** Symlink target (raw link text), or null when not a symlink / unreadable. */
  readlink: (p: string) => string | null;
}

export interface BinaryRemovalPlan {
  /** Filesystem paths to delete (bundle dirs / artifacts, shim links). */
  paths: string[];
  /** Running from a git checkout — surfaced to the user, never deleted. */
  sourceRoot: string | null;
  /** One human line per planned removal, for the confirm prompt. */
  summary: string[];
}

export function defaultProbes(filename: string): RemoveBinaryProbes {
  return {
    filename,
    platform: process.platform,
    cwd: process.cwd(),
    env: process.env,
    homedir: os.homedir(),
    exists: fs.existsSync,
    readlink: (p) => {
      try { return fs.readlinkSync(p); } catch { return null; }
    },
  };
}

/**
 * Path math keyed on the TARGET platform (not the host) — same convention as
 * `detectInstallMethod`, so the planner is deterministic when unit-tested with
 * a win32 fixture on a POSIX host and vice versa. In production the probe's
 * platform always matches the running host.
 */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** The machine-level state dir that must survive an artifacts-only removal. */
function stateDir(p: RemoveBinaryProbes): string {
  return pathFor(p.platform).join(p.homedir, '.codegraph');
}

/** Candidate bundle install dirs: the running binary's own, plus the defaults. */
function installDirCandidates(p: RemoveBinaryProbes): string[] {
  const P = pathFor(p.platform);
  const dirs: string[] = [];
  const method = detectInstallMethod({
    filename: p.filename,
    platform: p.platform,
    cwd: p.cwd,
    exists: p.exists,
  });
  if (method.kind === 'bundle' && method.installDir) dirs.push(method.installDir);
  if (p.env.CODEGRAPH_INSTALL_DIR) dirs.push(p.env.CODEGRAPH_INSTALL_DIR);
  // Platform defaults — probed even when the RUNNING binary is npm/source,
  // because the whole point is clearing installs the user forgot about.
  if (p.platform === 'win32') {
    if (p.env.LOCALAPPDATA) dirs.push(P.join(p.env.LOCALAPPDATA, 'codegraph'));
  } else {
    dirs.push(stateDir(p));
  }
  return [...new Set(dirs.map((d) => P.resolve(d)))];
}

export function planBinaryRemoval(p: RemoveBinaryProbes): BinaryRemovalPlan {
  const P = pathFor(p.platform);
  const plan: BinaryRemovalPlan = {
    paths: [],
    sourceRoot: null,
    summary: [],
  };

  const method = detectInstallMethod({
    filename: p.filename,
    platform: p.platform,
    cwd: p.cwd,
    exists: p.exists,
  });
  if (method.kind === 'source') {
    plan.sourceRoot = method.root;
  }

  // --- Bundle install(s) ----------------------------------------------------
  const installDirs: string[] = [];
  for (const dir of installDirCandidates(p)) {
    // A dir counts as a bundle install only when it carries install artifacts.
    const artifacts = ['versions', 'current']
      .map((a) => P.join(dir, a))
      .filter((a) => p.exists(a) || p.readlink(a) !== null); // `current` is a symlink on unix
    if (artifacts.length === 0) continue;
    installDirs.push(dir);
    if (P.resolve(dir) === P.resolve(stateDir(p))) {
      // Shared with machine-level state: remove artifacts only.
      plan.paths.push(...artifacts);
      plan.summary.push(`bundle install at ${dir} (versions/ and current — state files kept)`);
    } else {
      plan.paths.push(dir);
      plan.summary.push(`bundle install at ${dir}`);
    }
  }

  // --- Bin-dir shim (unix installer's symlink) --------------------------------
  const binDir = p.env.CODEGRAPH_BIN_DIR
    ?? (p.platform === 'win32' ? null : P.join(p.homedir, '.local', 'bin'));
  if (binDir) {
    const shim = P.join(binDir, 'codegraph');
    const target = p.readlink(shim);
    // Only when the link demonstrably points into a bundle install dir —
    // resolved against the link's own directory, since install.sh links an
    // absolute target but a hand-made relative link must still verify.
    if (target !== null) {
      const resolved = P.resolve(binDir, target);
      const ours = installDirs.some((d) => resolved.startsWith(P.resolve(d) + P.sep))
        || resolved.includes(`${P.sep}.codegraph${P.sep}`);
      if (ours) {
        plan.paths.push(shim);
        plan.summary.push(`launcher link at ${shim}`);
      }
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Executor (injected side effects)
// ---------------------------------------------------------------------------

export interface RemoveBinaryDeps {
  platform: NodeJS.Platform;
  /** The running node binary — the file Windows will hold a lock on. */
  execPath: string;
  rm: (p: string) => void;
  rename: (from: string, to: string) => void;
}

export interface BinaryRemovalResult {
  removed: string[];
  /** Paths that could not be (fully) removed — surfaced with manual steps. */
  leftovers: string[];
}

export function defaultRemoveDeps(): RemoveBinaryDeps {
  return {
    platform: process.platform,
    execPath: process.execPath,
    rm: (p) => fs.rmSync(p, { recursive: true, force: true }),
    rename: (from, to) => fs.renameSync(from, to),
  };
}

/**
 * Rename the running (locked) node.exe out of `dir` so the rest of the tree
 * deletes cleanly — Windows allows renaming a mapped image, just not deleting
 * it. Returns the leftover path, or null when nothing needed moving.
 */
function moveLockedExeAside(dir: string, deps: RemoveBinaryDeps): string | null {
  if (deps.platform !== 'win32') return null;
  const P = pathFor(deps.platform);
  const resolvedDir = P.resolve(dir) + P.sep;
  if (!P.resolve(deps.execPath).startsWith(resolvedDir)) return null;
  const leftover = P.join(P.dirname(P.resolve(dir)), `codegraph-old-node-${process.pid}.exe`);
  try {
    deps.rename(deps.execPath, leftover);
    return leftover;
  } catch {
    return null; // rename failed too — the rm error will surface the dir
  }
}

export function executeBinaryRemoval(
  plan: BinaryRemovalPlan,
  deps: RemoveBinaryDeps = defaultRemoveDeps(),
): BinaryRemovalResult {
  const result: BinaryRemovalResult = { removed: [], leftovers: [] };

  const P = pathFor(deps.platform);
  for (const p of plan.paths) {
    // Planner-emitted paths are always deep, specific artifacts; this guard
    // exists so no future planner bug can ever hand the executor a root.
    if (P.resolve(p) === P.parse(P.resolve(p)).root) {
      result.leftovers.push(p);
      continue;
    }
    try {
      deps.rm(p);
      result.removed.push(p);
    } catch {
      // Windows: the running exe inside this tree is deletable-after-rename.
      const moved = moveLockedExeAside(p, deps);
      try {
        deps.rm(p);
        result.removed.push(p);
        if (moved) result.leftovers.push(moved);
      } catch {
        result.leftovers.push(p);
      }
    }
  }

  return result;
}
