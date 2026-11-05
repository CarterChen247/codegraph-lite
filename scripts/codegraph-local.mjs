#!/usr/bin/env node
/**
 * Enable CodeGraph for Claude Code in ONE checkout: a repo's main checkout, a
 * `git worktree add` worktree, or a Claude Code worktree (.claude/worktrees/x).
 * Privacy hardening #22. Every other repo stays untouched, and nothing written
 * here is ever committed:
 *
 *   index       <path>/.codegraph/           (`init --local-only`: ignores itself)
 *   MCP server  ~/.claude.json, local scope  (Claude Code keys it by <path>)
 *   prompt hook <path>/.claude/settings.local.json  (+ auto-allow mcp__codegraph__*)
 *   ignore      <git common dir>/info/exclude      (shared by every worktree)
 *
 * No git hooks: a new worktree is set up by running `enable` on it. Commands use
 * absolute paths to this build (node + dist/bin/codegraph.js), so no other
 * `codegraph` on PATH can stand in for it.
 *
 *   node scripts/codegraph-local.mjs enable  <path>
 *   node scripts/codegraph-local.mjs disable <path>
 *   node scripts/codegraph-local.mjs status  <path>
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'dist', 'bin', 'codegraph.js');
const PERMISSION = 'mcp__codegraph__*';
const EXCLUDE_BEGIN = '# >>> codegraph-lite local setup >>>';
const EXCLUDE_END = '# <<< codegraph-lite local setup <<<';
const EXCLUDE_LINES = ['.claude/settings.local.json', '.codegraph/'];
const SYNC_HOOK_MARKER = '# >>> codegraph sync hook >>>';

/** The `node` on PATH as named there (e.g. Homebrew's stable opt/ link), not a versioned realpath. */
function nodeOnPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return process.execPath;
}
const NODE = nodeOnPath();
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const HOOK_COMMAND = `${shellQuote(NODE)} ${shellQuote(BIN)} prompt-hook`;
/** Ours, or one an upstream install wrote. */
const isPromptHook = (cmd) => typeof cmd === 'string' && /codegraph(?:\.js'?|\.cmd)? prompt-hook$/.test(cmd);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), stdout: (r.stdout ?? '').trim(), error: r.error };
}
function git(dir, ...args) {
  const r = run('git', ['-C', dir, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.out}`);
  return r.stdout;
}
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function checkout(target) {
  if (!target) die('usage: codegraph-local.mjs <enable|disable|status> <path>');
  let dir;
  try { dir = fs.realpathSync(path.resolve(target)); } catch { die(`no such directory: ${target}`); }
  let top;
  try { top = fs.realpathSync(git(dir, 'rev-parse', '--show-toplevel')); } catch { die(`not a git checkout: ${dir}`); }
  if (top !== dir) die(`${dir} is inside the checkout ${top}; pass the checkout's root`);
  return {
    dir,
    commonDir: git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    hooksDir: git(dir, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'),
    settingsFile: path.join(dir, '.claude', 'settings.local.json'),
    db: path.join(dir, '.codegraph', 'codegraph.db'),
  };
}

function gitStatus(dir) {
  return new Set(git(dir, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean));
}

// ----------------------------------------------------------- .git/info/exclude

function excludeFile(c) {
  return path.join(c.commonDir, 'info', 'exclude');
}
function hasExcludeBlock(c) {
  try { return fs.readFileSync(excludeFile(c), 'utf8').includes(EXCLUDE_BEGIN); } catch { return false; }
}
function ensureExcludeBlock(c) {
  if (hasExcludeBlock(c)) return false;
  const file = excludeFile(c);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  if (text && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, `${text}${EXCLUDE_BEGIN}\n${EXCLUDE_LINES.join('\n')}\n${EXCLUDE_END}\n`);
  return true;
}

// ------------------------------------------------------ .claude/settings.local.json

function readSettings(c) {
  if (!fs.existsSync(c.settingsFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(c.settingsFile, 'utf8'));
  } catch (err) {
    die(`${c.settingsFile} is not valid JSON (${err.message}); fix it first, nothing was changed there`);
  }
}
function writeSettings(c, settings) {
  if (Object.keys(settings).length === 0) {
    fs.rmSync(c.settingsFile, { force: true });
    try { fs.rmdirSync(path.dirname(c.settingsFile)); } catch { /* not empty, or gone */ }
    return;
  }
  fs.mkdirSync(path.dirname(c.settingsFile), { recursive: true });
  fs.writeFileSync(c.settingsFile, JSON.stringify(settings, null, 2) + '\n');
}
function hookGroups(settings) {
  const groups = settings.hooks?.UserPromptSubmit;
  return Array.isArray(groups) ? groups : [];
}
function hasHook(settings) {
  return hookGroups(settings).some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isPromptHook(h?.command)));
}
function hasPermission(settings) {
  return Array.isArray(settings.permissions?.allow) && settings.permissions.allow.includes(PERMISSION);
}
function addHookAndPermission(settings) {
  if (!hasHook(settings)) {
    settings.hooks ??= {};
    settings.hooks.UserPromptSubmit ??= [];
    settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  }
  if (!hasPermission(settings)) {
    settings.permissions ??= {};
    settings.permissions.allow ??= [];
    settings.permissions.allow.push(PERMISSION);
  }
  return settings;
}
function removeHookAndPermission(settings) {
  if (settings.hooks?.UserPromptSubmit) {
    settings.hooks.UserPromptSubmit = hookGroups(settings)
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isPromptHook(h?.command)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  if (Array.isArray(settings.permissions?.allow)) {
    settings.permissions.allow = settings.permissions.allow.filter((p) => p !== PERMISSION);
    if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
  }
  return settings;
}

// ---------------------------------------------------------- Claude Code MCP (local scope)

function claude(c, ...args) {
  const r = run('claude', args, { cwd: c.dir });
  if (r.error) die('the `claude` CLI is not on PATH');
  return r;
}
const mcpRegistered = (c) => claude(c, 'mcp', 'get', 'codegraph').code === 0;

// ------------------------------------------------------------------- checks

function syncHookFiles(c) {
  const dirs = new Set([c.hooksDir]);
  const custom = run('git', ['-C', c.dir, 'config', '--get', 'core.hooksPath']).stdout;
  if (custom) dirs.add(path.resolve(c.dir, custom));
  const hits = [];
  for (const dir of dirs) {
    let names = [];
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

async function indexedFiles(c) {
  if (!fs.existsSync(c.db)) return null;
  process.removeAllListeners('warning'); // node:sqlite's ExperimentalWarning
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(c.db, { readOnly: true });
  try {
    const total = db.prepare('SELECT count(*) AS n FROM files').get().n;
    const nested = db.prepare("SELECT count(*) AS n FROM files WHERE path LIKE '.claude/worktrees/%'").get().n;
    return { total, nested };
  } finally {
    db.close();
  }
}

function codegraph(c, ...args) {
  return run(NODE, [BIN, ...args], { cwd: c.dir });
}

// ------------------------------------------------------------------ commands

async function enable(c) {
  if (!fs.existsSync(BIN)) die(`no build at ${BIN}; run \`npm ci && npm run build\` in ${REPO}`);
  const before = gitStatus(c.dir);

  // Ignore first, so nothing created below ever shows up as untracked.
  console.log(ensureExcludeBlock(c) ? `✓ ignore    added to ${excludeFile(c)}` : '✓ ignore    already in .git/info/exclude');

  const indexed = fs.existsSync(path.join(c.dir, '.codegraph'));
  const idx = indexed ? codegraph(c, 'sync', c.dir) : codegraph(c, 'init', '-y', '--local-only', c.dir);
  if (idx.code !== 0) die(`codegraph ${indexed ? 'sync' : 'init'} failed:\n${idx.out}`);
  const files = await indexedFiles(c);
  console.log(`✓ index     ${indexed ? 'synced' : 'built'}: ${files?.total ?? '?'} files in ${path.join(c.dir, '.codegraph')}`);

  claude(c, 'mcp', 'remove', '--scope', 'local', 'codegraph'); // idempotent re-add with this build's paths
  const add = claude(c, 'mcp', 'add', '--scope', 'local', 'codegraph', '--', NODE, BIN, 'serve', '--mcp');
  if (add.code !== 0) die(`claude mcp add failed:\n${add.out}`);
  console.log('✓ mcp       registered in ~/.claude.json, local scope, for this path only');

  writeSettings(c, addHookAndPermission(readSettings(c)));
  console.log(`✓ hook      prompt hook + ${PERMISSION} in ${c.settingsFile}`);

  // Verify.
  const problems = [];
  const added = [...gitStatus(c.dir)].filter((line) => !before.has(line));
  if (added.length) problems.push(`git status gained:\n    ${added.join('\n    ')}`);
  const hooks = syncHookFiles(c);
  if (hooks.length) problems.push(`codegraph git hook found in: ${hooks.join(', ')}`);
  if (files?.nested) problems.push(`the index holds ${files.nested} file(s) under .claude/worktrees/ (another checkout's code)`);
  if (!mcpRegistered(c)) problems.push('claude mcp get codegraph does not find the server');
  if (problems.length) die(`enabled, but verification failed:\n  - ${problems.join('\n  - ')}`);
  console.log('✓ verified  git status unchanged · no git hooks · index holds no nested worktree · MCP visible here only');
  console.log('\nRestart Claude Code in this directory to pick it up.');
}

async function disable(c) {
  claude(c, 'mcp', 'remove', '--scope', 'local', 'codegraph');
  console.log('✓ mcp       removed (local scope, this path)');
  writeSettings(c, removeHookAndPermission(readSettings(c)));
  console.log(`✓ hook      prompt hook + ${PERMISSION} removed from ${c.settingsFile}`);
  if (fs.existsSync(path.join(c.dir, '.codegraph'))) {
    const r = codegraph(c, 'uninit', '--force', c.dir);
    if (r.code !== 0) die(`codegraph uninit failed:\n${r.out}`);
  }
  console.log('✓ index     .codegraph/ deleted');
  const left = [];
  if (mcpRegistered(c)) left.push('MCP server still registered');
  const s = readSettings(c);
  if (hasHook(s) || hasPermission(s)) left.push('hook or permission still in settings.local.json');
  if (fs.existsSync(path.join(c.dir, '.codegraph'))) left.push('.codegraph/ still exists');
  if (left.length) die(`disable incomplete: ${left.join('; ')}`);
  console.log(`\n(.git/info/exclude keeps its codegraph-lite block: it is shared by every worktree and ignores only files this script writes.)`);
}

async function status(c) {
  const files = await indexedFiles(c);
  const s = readSettings(c);
  const yes = (b) => (b ? 'yes' : 'no');
  console.log(`checkout     ${c.dir}`);
  console.log(`index        ${files ? `${files.total} files${files.nested ? ` (WARNING: ${files.nested} under .claude/worktrees/)` : ''}` : 'no'}`);
  console.log(`mcp          ${yes(mcpRegistered(c))} (local scope)`);
  console.log(`prompt hook  ${yes(hasHook(s))}`);
  console.log(`auto-allow   ${yes(hasPermission(s))}`);
  console.log(`ignore       ${yes(hasExcludeBlock(c))} (.git/info/exclude)`);
  const hooks = syncHookFiles(c);
  console.log(`git hooks    ${hooks.length ? `FOUND: ${hooks.join(', ')}` : 'none'}`);
}

const [command, target] = process.argv.slice(2);
const actions = { enable, disable, status };
if (!actions[command]) die('usage: codegraph-local.mjs <enable|disable|status> <path>');
await actions[command](checkout(target));
