/**
 * `codegraph upgrade` — privacy-hardened build (#5).
 *
 * Upstream CodeGraph upgrades itself: it asks GitHub for the latest release,
 * then pipes the remote `install.sh` into a shell with the full environment,
 * downloads a release archive with PowerShell, or runs `npm install` for the
 * official package. Every one of those paths reaches the network and replaces
 * this fork's build with the official one, so all of them are deleted. What
 * remains:
 *
 *   - `sourceUpgradeInstructions` — what `codegraph upgrade` prints instead:
 *     how to update a source build of this fork (pull, `npm ci`, build).
 *   - install-method detection, used by the upgrade command and the
 *     uninstaller's binary-removal step.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Install-method detection (pure — fully unit-testable via injected probes)
// ---------------------------------------------------------------------------

export type InstallMethod =
  | { kind: 'bundle'; os: 'unix' | 'windows'; bundleRoot: string; installDir: string | null }
  | {
      kind: 'npm';
      scope: 'global' | 'local';
      /** Local only: the project folder whose node_modules holds this install, where npm runs. */
      root?: string;
    }
  | { kind: 'npx' }
  /** Installed by another package manager, which has to upgrade it (npm can't). */
  | { kind: 'package-manager'; manager: 'pnpm' | 'yarn' | 'bun'; global: boolean }
  | { kind: 'source'; root: string }
  | { kind: 'unknown'; reason: string };

export interface DetectInput {
  /** `__filename` of the running CLI module — `<…>/dist/bin/codegraph.js`. */
  filename: string;
  platform: NodeJS.Platform;
  /**
   * The folder `upgrade` runs from. Detection doesn't read it: where an
   * install lives says how it was installed, from any folder (#2477).
   */
  cwd?: string;
  /** Injectable existence probe (defaults to fs.existsSync) — for tests. */
  exists?: (p: string) => boolean;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Where the bundle installer keeps its install root, derived from the bundle
 * dir so an upgrade reuses a custom `CODEGRAPH_INSTALL_DIR`. Returns null when
 * the layout isn't the one the installer creates (then the installer falls
 * back to its own default).
 *
 *   unix:    <installDir>/versions/<vX.Y.Z>   (bundleRoot)  → <installDir>
 *   windows: <installDir>\current             (bundleRoot)  → <installDir>
 */
export function deriveInstallDir(
  bundleRoot: string,
  os: 'unix' | 'windows',
  exists: (p: string) => boolean
): string | null {
  // Use the TARGET platform's path semantics (not the host's), so this is
  // deterministic when reasoning about a Windows layout from a POSIX host (CI)
  // and vice-versa. In production `os` always matches the running platform.
  const P = os === 'windows' ? path.win32 : path.posix;
  if (os === 'windows') {
    if (P.basename(bundleRoot).toLowerCase() === 'current') {
      return P.dirname(bundleRoot);
    }
    return null;
  }
  // unix: bundleRoot is <installDir>/versions/<version>
  const parent = P.dirname(bundleRoot);
  if (P.basename(parent) === 'versions') {
    const installDir = P.dirname(parent);
    return exists(installDir) ? installDir : P.dirname(parent);
  }
  return null;
}

export function detectInstallMethod(input: DetectInput): InstallMethod {
  const exists = input.exists ?? fs.existsSync;
  const isWin = input.platform === 'win32';
  // Path math keyed on the TARGET platform so detection is host-independent
  // (a Windows layout resolves correctly even when unit-tested on macOS/Linux).
  const P = isWin ? path.win32 : path.posix;
  const binDir = P.dirname(input.filename); // <…>/bin

  const norm = toPosix(input.filename);

  // Path-based checks come FIRST. The npm thin-installer's per-platform
  // package (@colbymchenry/codegraph-<platform>-<arch>) is itself a complete
  // bundle — vendored node + bin/ launcher — living inside node_modules, so
  // the layout sniff below would misread every npm install as a standalone
  // bundle. `upgrade` would then curl install.sh into ~/.codegraph: a SECOND
  // install that never wins the PATH race against npm's shim, leaving
  // `codegraph -v` permanently on the old version (the #1071 shadow,
  // self-inflicted). A path under node_modules is authoritative about HOW the
  // user installed, whatever the artifact inside looks like.

  // npx cache: <…>/_npx/<hash>/node_modules/@colbymchenry/codegraph/…
  // (checked before npm — the npx cache path also contains /node_modules/).
  if (norm.includes('/_npx/')) {
    return { kind: 'npx' };
  }

  // npm install (global or local): lives under a node_modules tree. Which of
  // the two is read from npm's own layout, never from cwd (#2477). A global
  // prefix often sits inside the home folder — Windows `%APPDATA%\npm`, nvm,
  // fnm, `~/.npm-global` — so "the running file is under cwd" took every such
  // global install for a local one whenever `upgrade` ran from home: `npm
  // install` without -g left the global copy stale and dropped a stray local
  // one into the home folder.
  const nodeModulesAt = norm.indexOf('/node_modules/');
  if (nodeModulesAt !== -1) {
    // The folder holding the outermost node_modules (the same offset in
    // `filename`, which `toPosix` only changes slash by slash): the global
    // prefix on Windows, `<prefix>/lib` on POSIX, or the project root.
    let owner = input.filename.slice(0, nodeModulesAt);
    if (owner === '' || /^[A-Za-z]:$/.test(owner)) owner += P.sep; // a tree at a filesystem/drive root
    // pnpm, yarn and bun keep their global packages in a folder that looks
    // like an npm project (a package.json beside node_modules); running npm
    // there, or a second copy through npm, is never the upgrade.
    const manager = otherPackageManager(norm, owner, P, exists);
    if (manager) return manager;
    if (isNpmGlobalTree(owner, P, isWin, exists)) return { kind: 'npm', scope: 'global' };
    // A project's install is upgraded in that project, whatever folder
    // `upgrade` runs from: npm run anywhere else — outside the project, or in
    // another project inside it, as in a home folder that is itself one —
    // installs a second copy there and leaves this one as it was.
    return { kind: 'npm', scope: 'local', root: P.resolve(owner) };
  }

  // Bundle: <root>/lib/dist/bin/codegraph.js → <root> is up 3 from bin/.
  // A bundle has a vendored node + a launcher script as siblings of lib/.
  const bundleRoot = P.resolve(binDir, '..', '..', '..');
  const vendoredNode = P.join(bundleRoot, isWin ? 'node.exe' : 'node');
  const launcher = P.join(bundleRoot, 'bin', isWin ? 'codegraph.cmd' : 'codegraph');
  if (exists(vendoredNode) && exists(launcher)) {
    const os = isWin ? 'windows' : 'unix';
    return { kind: 'bundle', os, bundleRoot, installDir: deriveInstallDir(bundleRoot, os, exists) };
  }

  // Source checkout: running <repo>/dist/bin/codegraph.js with a sibling .git.
  const repoRoot = P.resolve(binDir, '..', '..');
  if (exists(P.join(repoRoot, 'package.json')) && exists(P.join(repoRoot, '.git'))) {
    return { kind: 'source', root: repoRoot };
  }

  return { kind: 'unknown', reason: `unrecognized install layout at ${input.filename}` };
}

/** A pnpm, yarn or bun install, from its `.pnpm` layout or its lockfile beside node_modules. */
function otherPackageManager(
  norm: string,
  owner: string,
  P: path.PlatformPath,
  exists: (p: string) => boolean,
): Extract<InstallMethod, { kind: 'package-manager' }> | null {
  const where = toPosix(owner).toLowerCase();
  if (norm.includes('/node_modules/.pnpm/') || exists(P.join(owner, 'pnpm-lock.yaml'))) {
    return { kind: 'package-manager', manager: 'pnpm', global: /\/pnpm\/global\//.test(where + '/') };
  }
  if (exists(P.join(owner, 'yarn.lock'))) {
    return { kind: 'package-manager', manager: 'yarn', global: /\/yarn\/(?:data\/)?global$/.test(where) };
  }
  if (exists(P.join(owner, 'bun.lockb')) || exists(P.join(owner, 'bun.lock'))) {
    return { kind: 'package-manager', manager: 'bun', global: /\/\.bun\/install\/global$/.test(where) };
  }
  return null;
}

/**
 * Whether the node_modules tree in `owner` is npm's global one, read from
 * where npm put the launcher: beside a global tree — `<prefix>\codegraph.cmd`
 * on Windows, `<prefix>/bin/codegraph` next to `<prefix>/lib/node_modules` on
 * POSIX — and in `node_modules/.bin` of a project folder (one with a
 * package.json) for a local install. A tree with neither is taken for
 * global, since no project owns it.
 */
function isNpmGlobalTree(
  owner: string,
  P: path.PlatformPath,
  isWin: boolean,
  exists: (p: string) => boolean,
): boolean {
  const globalLauncher = isWin
    ? exists(P.join(owner, 'codegraph.cmd'))
    : P.basename(owner) === 'lib' && exists(P.join(P.dirname(owner), 'bin', 'codegraph'));
  if (globalLauncher) return true;
  const bin = P.join(owner, 'node_modules', '.bin');
  const local = exists(P.join(bin, 'codegraph')) || exists(P.join(bin, 'codegraph.cmd'))
    || exists(P.join(owner, 'package.json'));
  return !local;
}

// ---------------------------------------------------------------------------
// What `codegraph upgrade` prints
// ---------------------------------------------------------------------------

/**
 * How to update this build. A source checkout gets the exact commands for its
 * own folder; any other layout is told that this fork is only built from source.
 */
export function sourceUpgradeInstructions(method: InstallMethod): string {
  const where = method.kind === 'source' ? method.root : '<your codegraph-lite checkout>';
  const lines = [
    'This is a privacy-hardened build of CodeGraph: `codegraph upgrade` downloads nothing.',
    'To update, pull the fork and rebuild it from source:',
    '',
    `  cd ${JSON.stringify(where)}`,
    '  git pull',
    '  npm ci',
    '  npm run build',
    '',
    'The `codegraph` on your PATH (via `npm link`) runs the new build right away.',
    'Restart open agent sessions so their MCP servers pick it up.',
  ];
  if (method.kind !== 'source') {
    lines.push('', `(Detected install: ${method.kind}. Only a source build of this fork is supported.)`);
  }
  return lines.join('\n');
}
