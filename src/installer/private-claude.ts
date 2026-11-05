/**
 * `codegraph install --location private` (privacy hardening, #24).
 *
 * Enables CodeGraph for Claude Code in ONE checkout, in Claude Code's own
 * *local* scope: this project, this user. The checkout can be a repo's main
 * checkout, a `git worktree add` worktree, or a `.claude/worktrees/<name>`.
 * Every other repo stays untouched, and nothing written here is committed:
 *
 *   ignore      <git common dir>/info/exclude (shared by every worktree), first
 *   MCP server  `claude mcp add --scope local` → ~/.claude.json, keyed by the path
 *   prompt hook + auto-allow   <checkout>/.claude/settings.local.json (merged)
 *   index       `--init` → `init --local-only` (the CLI runs it, between install and verify)
 *
 * It is not a `Location`: every agent target treats "not global" as `local`,
 * which writes the repo's SHARED files, so `private` is routed here before any
 * target runs. Claude Code only. Commands name this build by absolute path, so
 * no other `codegraph` on PATH can stand in for it. No git hooks, and no
 * instructions block (the MCP `initialize` instructions already carry it).
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createDatabase } from '../db/sqlite-adapter';

const PERMISSION = 'mcp__codegraph__*';
const EXCLUDE_BEGIN = '# >>> codegraph-lite private install >>>';
const EXCLUDE_END = '# <<< codegraph-lite private install <<<';
const EXCLUDE_LINES = ['.claude/settings.local.json', '.codegraph/'];
const SYNC_HOOK_MARKER = '# >>> codegraph sync hook >>>';
/** Asks Claude Code for no telemetry, error reporting or update checks while it edits its config. */
const CLAUDE_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

export interface PrivateCheckout {
  dir: string;
  commonDir: string;
  hooksDir: string;
  settingsFile: string;
}

export class PrivateInstallError extends Error {}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): { code: number; out: string; stdout: string; missing: boolean } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env, windowsHide: true, timeout: 120_000 });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), stdout: (r.stdout ?? '').trim(), missing };
}

function git(dir: string, ...args: string[]): string {
  const r = run('git', ['-C', dir, ...args], dir);
  if (r.code !== 0) throw new PrivateInstallError(`git ${args.join(' ')} failed in ${dir}: ${r.out}`);
  return r.stdout;
}

function claude(c: PrivateCheckout, ...args: string[]): { code: number; out: string } {
  const r = run('claude', args, c.dir, { ...process.env, ...CLAUDE_ENV });
  if (r.missing) throw new PrivateInstallError('`--location private` needs Claude Code\'s `claude` command on PATH.');
  return r;
}

/** First executable `name` on PATH, as PATH names it (not a realpath), or null. Runs nothing. */
function onPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* next */ }
    }
  }
  return null;
}

/** The `node` on PATH (Homebrew's stable opt/ link survives upgrades; a versioned realpath doesn't). */
function nodeOnPath(): string {
  return onPath('node') ?? process.execPath;
}

function requireClaude(): void {
  if (!onPath('claude')) throw new PrivateInstallError('`--location private` needs Claude Code\'s `claude` command on PATH.');
}

/** This build's CLI entry: dist/installer/private-claude.js → dist/bin/codegraph.js. */
function cliEntry(): string {
  return path.resolve(__dirname, '..', 'bin', 'codegraph.js');
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** Ours, or one an upstream install wrote. */
const isPromptHook = (cmd: unknown): boolean =>
  typeof cmd === 'string' && /codegraph(?:\.js'?|\.cmd)? prompt-hook$/.test(cmd);

/** Resolves and checks the checkout. Throws before anything is written. */
export function resolveCheckout(cwd: string): PrivateCheckout {
  const dir = fs.realpathSync(cwd);
  let top: string;
  try {
    top = fs.realpathSync(git(dir, 'rev-parse', '--show-toplevel'));
  } catch {
    throw new PrivateInstallError(`${dir} is not a git checkout. Run this at the root of the repo or worktree to enable.`);
  }
  if (top !== dir) throw new PrivateInstallError(`${dir} is inside the checkout ${top}. Run this at the checkout's root.`);
  return {
    dir,
    commonDir: git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    hooksDir: git(dir, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'),
    settingsFile: path.join(dir, '.claude', 'settings.local.json'),
  };
}

export function gitStatus(c: PrivateCheckout): Set<string> {
  return new Set(git(c.dir, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean));
}

// ---------------------------------------------------------------- exclude

const excludeFile = (c: PrivateCheckout): string => path.join(c.commonDir, 'info', 'exclude');

function ensureExcludeBlock(c: PrivateCheckout): boolean {
  const file = excludeFile(c);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  if (text.includes(EXCLUDE_BEGIN)) return false;
  if (text && !text.endsWith('\n')) text += '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}${EXCLUDE_BEGIN}\n${EXCLUDE_LINES.join('\n')}\n${EXCLUDE_END}\n`);
  return true;
}

// ---------------------------------------------------------- settings.local.json

type Settings = Record<string, any>;

function readSettings(c: PrivateCheckout): Settings {
  if (!fs.existsSync(c.settingsFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(c.settingsFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* falls through */ }
  throw new PrivateInstallError(`${c.settingsFile} is not a JSON object. Fix it first; nothing was changed.`);
}

function writeSettings(c: PrivateCheckout, settings: Settings): void {
  if (Object.keys(settings).length === 0) {
    fs.rmSync(c.settingsFile, { force: true });
    try { fs.rmdirSync(path.dirname(c.settingsFile)); } catch { /* not empty, or gone */ }
    return;
  }
  fs.mkdirSync(path.dirname(c.settingsFile), { recursive: true });
  fs.writeFileSync(c.settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

const hookGroups = (s: Settings): any[] => (Array.isArray(s.hooks?.UserPromptSubmit) ? s.hooks.UserPromptSubmit : []);
const hasHook = (s: Settings): boolean =>
  hookGroups(s).some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isPromptHook(h?.command)));
const hasPermission = (s: Settings): boolean =>
  Array.isArray(s.permissions?.allow) && s.permissions.allow.includes(PERMISSION);

function addHookAndPermission(s: Settings, command: string, autoAllow: boolean): Settings {
  if (!hasHook(s)) {
    s.hooks ??= {};
    s.hooks.UserPromptSubmit ??= [];
    s.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command }] });
  }
  if (autoAllow && !hasPermission(s)) {
    s.permissions ??= {};
    s.permissions.allow ??= [];
    s.permissions.allow.push(PERMISSION);
  }
  return s;
}

function removeHookAndPermission(s: Settings): Settings {
  if (s.hooks?.UserPromptSubmit) {
    s.hooks.UserPromptSubmit = hookGroups(s)
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isPromptHook(h?.command)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (s.hooks.UserPromptSubmit.length === 0) delete s.hooks.UserPromptSubmit;
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
  }
  if (Array.isArray(s.permissions?.allow)) {
    s.permissions.allow = s.permissions.allow.filter((p: unknown) => p !== PERMISSION);
    if (s.permissions.allow.length === 0) delete s.permissions.allow;
    if (Object.keys(s.permissions).length === 0) delete s.permissions;
  }
  return s;
}

// ------------------------------------------------------------------- checks

function syncHookFiles(c: PrivateCheckout): string[] {
  const dirs = new Set([c.hooksDir]);
  const custom = run('git', ['-C', c.dir, 'config', '--get', 'core.hooksPath'], c.dir).stdout;
  if (custom) dirs.add(path.resolve(c.dir, custom));
  const hits: string[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes(SYNC_HOOK_MARKER)) hits.push(file);
      } catch { /* unreadable */ }
    }
  }
  return hits;
}

/** Indexed files under `.claude/worktrees/`: another checkout's code. null when there is no index. */
function nestedWorktreeFiles(c: PrivateCheckout): number | null {
  const db = path.join(c.dir, '.codegraph', 'codegraph.db');
  if (!fs.existsSync(db)) return null;
  const { db: handle } = createDatabase(db, { readOnly: true });
  try {
    const row = handle.prepare("SELECT count(*) AS n FROM files WHERE path LIKE '.claude/worktrees/%'").get() as { n: number };
    return Number(row.n);
  } finally {
    handle.close();
  }
}

// ------------------------------------------------------------------ install

export interface PrivateInstallResult {
  checkout: PrivateCheckout;
  /** `git status` before anything was written, for `verifyPrivate`. */
  before: Set<string>;
  steps: string[];
}

export function installPrivate(cwd: string, opts: { autoAllow?: boolean } = {}): PrivateInstallResult {
  const c = resolveCheckout(cwd);
  requireClaude();
  const before = gitStatus(c);
  const settings = readSettings(c); // fail on a broken file before writing anything
  const steps: string[] = [];

  // Ignore first, so nothing created below ever shows as untracked.
  steps.push(ensureExcludeBlock(c) ? `ignore rules added to ${excludeFile(c)}` : 'ignore rules already in .git/info/exclude');

  const node = nodeOnPath();
  const bin = cliEntry();
  claude(c, 'mcp', 'remove', '--scope', 'local', 'codegraph'); // re-add with this build's paths
  const add = claude(c, 'mcp', 'add', '--scope', 'local', 'codegraph', '--', node, bin, 'serve', '--mcp');
  if (add.code !== 0) throw new PrivateInstallError(`claude mcp add failed: ${add.out}`);
  steps.push('MCP server registered in Claude Code\'s local scope (~/.claude.json, this path only)');

  const autoAllow = opts.autoAllow !== false;
  writeSettings(c, addHookAndPermission(settings, `${shellQuote(node)} ${shellQuote(bin)} prompt-hook`, autoAllow));
  steps.push(`prompt hook${autoAllow ? ` + ${PERMISSION}` : ''} in ${c.settingsFile}`);

  return { checkout: c, before, steps };
}

/** Everything that must hold after a private install; empty when it all does. */
export function verifyPrivate(c: PrivateCheckout, before: Set<string>): string[] {
  const problems: string[] = [];
  const added = [...gitStatus(c)].filter((line) => !before.has(line));
  if (added.length) problems.push(`git status gained: ${added.join(', ')}`);
  const hooks = syncHookFiles(c);
  if (hooks.length) problems.push(`a codegraph git hook exists: ${hooks.join(', ')}`);
  const nested = nestedWorktreeFiles(c);
  if (nested) problems.push(`the index holds ${nested} file(s) under .claude/worktrees/ (another checkout's code)`);
  if (claude(c, 'mcp', 'get', 'codegraph').code !== 0) problems.push('`claude mcp get codegraph` does not find the server');
  if (!hasHook(readSettings(c))) problems.push(`no prompt hook in ${c.settingsFile}`);
  return problems;
}

// ---------------------------------------------------------------- uninstall

/** Reverses a private install. The `.codegraph/` index stays: that is `codegraph uninit`. */
export function uninstallPrivate(cwd: string): { checkout: PrivateCheckout; steps: string[]; left: string[] } {
  const c = resolveCheckout(cwd);
  requireClaude();
  const settings = readSettings(c);
  const steps: string[] = [];
  claude(c, 'mcp', 'remove', '--scope', 'local', 'codegraph');
  steps.push('MCP server removed from Claude Code\'s local scope for this path');
  writeSettings(c, removeHookAndPermission(settings));
  steps.push(`prompt hook + ${PERMISSION} removed from ${c.settingsFile}`);

  const left: string[] = [];
  if (claude(c, 'mcp', 'get', 'codegraph').code === 0) left.push('the MCP server is still registered');
  const after = readSettings(c);
  if (hasHook(after) || hasPermission(after)) left.push(`a hook or permission is still in ${c.settingsFile}`);
  return { checkout: c, steps, left };
}
