/**
 * `codegraph install --location private` / `uninstall --location private` (#24).
 *
 * Drives the built CLI against scratch repos: a main checkout, a sibling
 * `git worktree add` worktree and a nested `.claude/worktrees/<name>`. A
 * stand-in `claude` on PATH records every call (arguments, working directory,
 * the non-essential-traffic switch) and keeps a per-path registry, so `mcp
 * add` / `remove` / `get` behave like the real CLI's local scope. The real
 * CLI's file format is checked by hand, not here: it is Claude Code's to own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

let root: string;
let fakeBin: string;
let callLog: string;
let registry: string;
let main: string;
let sibling: string;
let nested: string;

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cwd = fs.realpathSync(process.cwd());
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  args, cwd, nonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
}) + '\\n');
let state = {};
try { state = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STATE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(process.env.FAKE_CLAUDE_STATE, JSON.stringify(state));
if (args[0] === 'mcp' && args[1] === 'add') { state[cwd] = args.slice(args.indexOf('--') + 1); save(); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'remove') { const had = cwd in state; delete state[cwd]; save(); process.exit(had ? 0 : 1); }
if (args[0] === 'mcp' && args[1] === 'get') process.exit(cwd in state ? 0 : 1);
process.exit(2);
`;

function cli(cwd: string, args: string[], opts: { withClaude?: boolean } = {}) {
  const PATH = opts.withClaude === false
    ? [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter)
    : [fakeBin, process.env.PATH].join(path.delimiter);
  const r = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PATH, FAKE_CLAUDE_LOG: callLog, FAKE_CLAUDE_STATE: registry },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const install = (cwd: string, ...extra: string[]) => cli(cwd, ['install', '--location', 'private', ...extra]);
const uninstall = (cwd: string) => cli(cwd, ['uninstall', '--location', 'private']);

function calls(): Array<{ args: string[]; cwd: string; nonessential?: string }> {
  try { return fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function registered(): Record<string, string[]> {
  try { return JSON.parse(fs.readFileSync(registry, 'utf8')); } catch { return {}; }
}
const settingsOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
const status = (dir: string) => spawnSync('git', ['-C', dir, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).stdout;
const exclude = () => fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8');
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-private-')));
  fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  callLog = path.join(root, 'claude-calls.jsonl');
  registry = path.join(root, 'claude-registry.json');

  main = path.join(root, 'main');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  sibling = path.join(root, 'sibling');
  git(main, 'worktree', 'add', '-q', '-b', 'feat-a', sibling);
  fs.mkdirSync(path.join(main, '.claude'));
  nested = path.join(main, '.claude', 'worktrees', 'feat');
  git(main, 'worktree', 'add', '-q', '-b', 'feat-b', nested);
  fs.writeFileSync(path.join(nested, 'src', 'feat.ts'), 'export function onlyInFeat(): number {\n  return 1;\n}\n');
  // The user's own personal settings, which an install must keep.
  fs.writeFileSync(path.join(main, '.claude', 'settings.local.json'), '{\n  "env": { "FOO": "bar" }\n}\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('codegraph install --location private', () => {
  it('refuses, writing nothing, when claude is not on PATH', () => {
    const before = status(main);
    const r = cli(main, ['install', '--location', 'private'], { withClaude: false });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/needs Claude Code's `claude` command on PATH/);
    expect(fs.existsSync(path.join(main, '.git', 'info', 'exclude')) ? exclude() : '').not.toMatch(/codegraph-lite/);
    expect(status(main)).toBe(before);
    expect(calls()).toEqual([]);
  });

  it('refuses a directory inside a checkout, a non-checkout, and a non-Claude target', () => {
    expect(install(path.join(main, 'src')).out).toMatch(/is inside the checkout .* Run this at the checkout's root/);
    const plain = fs.mkdtempSync(path.join(root, 'plain-'));
    expect(install(plain).out).toMatch(/is not a git checkout/);
    const cursor = install(main, '--target', 'cursor');
    expect(cursor.status).toBe(1);
    expect(cursor.out).toMatch(/supports Claude Code only/);
    expect(calls()).toEqual([]);
  });

  it('enables the main checkout: ignore rules, local-scope MCP, merged hook + auto-allow, its own index', () => {
    const before = status(main);
    const r = install(main, '--init');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Verified: git status unchanged/);

    // The exact claude calls, all in the checkout, all with non-essential traffic off.
    const made = calls();
    expect(made.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['mcp remove', 'mcp add', 'mcp get']);
    expect(made.every((c) => c.cwd === main && c.nonessential === '1')).toBe(true);
    const add = made[1]!.args;
    expect(add.slice(0, add.indexOf('--'))).toEqual(['mcp', 'add', '--scope', 'local', 'codegraph']);
    expect(registered()[main]).toEqual([expect.stringMatching(/node(\.exe)?$/), BIN, 'serve', '--mcp']);

    const settings = settingsOf(main);
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: expect.stringMatching(new RegExp(`'${BIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' prompt-hook$`)) }] },
    ]);
    expect(settings.permissions.allow).toEqual(['mcp__codegraph__*']);

    expect(exclude()).toMatch(/# >>> codegraph-lite private install >>>\n\.claude\/settings\.local\.json\n\.codegraph\/\n/);
    expect(fs.existsSync(path.join(main, '.codegraph', 'codegraph.db'))).toBe(true);
    // The pre-existing settings.local.json is now ignored too; nothing new shows up.
    expect(status(main).split('\n').filter((l) => l && !before.includes(l))).toEqual([]);
  });

  it('gives each worktree its own entry and index, and keeps the nested one out of the main index', () => {
    for (const dir of [sibling, nested]) {
      const r = install(dir, '--init');
      expect(r.status, r.out).toBe(0);
      expect(fs.existsSync(path.join(dir, '.codegraph', 'codegraph.db'))).toBe(true);
      expect(settingsOf(dir).hooks.UserPromptSubmit).toHaveLength(1);
    }
    expect(Object.keys(registered()).sort()).toEqual([main, nested, sibling].sort());
    // One shared exclude block for all three.
    expect(exclude().match(/>>> codegraph-lite private install >>>/g)).toHaveLength(1);
    // Re-verifying main after the nested worktree was indexed still passes (no nested files in its index).
    expect(install(main).out).toMatch(/Verified/);
  });

  it('is idempotent: a re-run adds no second hook, permission, exclude block or entry', () => {
    const r = install(main, '--init');
    expect(r.status, r.out).toBe(0);
    const settings = settingsOf(main);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.permissions.allow).toEqual(['mcp__codegraph__*']);
    expect(exclude().match(/>>> codegraph-lite private install >>>/g)).toHaveLength(1);
    expect(Object.keys(registered()).filter((p) => p === main)).toHaveLength(1);
  });

  it('refuses a settings.local.json that is not JSON, without writing anything', () => {
    const file = path.join(sibling, '.claude', 'settings.local.json');
    const kept = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{ not json');
    const before = calls().length;
    const r = install(sibling);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/is not a JSON object/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
    expect(calls()).toHaveLength(before);
    fs.writeFileSync(file, kept);
  });
});

describe('codegraph uninstall --location private', () => {
  it('removes the entry, hook and permission, keeps the user\'s own settings and the index', () => {
    const r = uninstall(main);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/codegraph uninit/);
    expect(registered()[main]).toBeUndefined();
    expect(settingsOf(main)).toEqual({ env: { FOO: 'bar' } });
    expect(fs.existsSync(path.join(main, '.codegraph'))).toBe(true);
  });

  it('deletes a settings.local.json it alone created, and the empty .claude/ around it', () => {
    const r = uninstall(sibling);
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(path.join(sibling, '.claude'))).toBe(false);
    expect(registered()[sibling]).toBeUndefined();
    // The nested worktree is untouched by the others' uninstalls.
    expect(registered()[nested]).toBeDefined();
  });

  it('install without --permissions writes the hook but no auto-allow', () => {
    const r = install(sibling, '--no-permissions');
    expect(r.status, r.out).toBe(0);
    expect(settingsOf(sibling).permissions).toBeUndefined();
    expect(settingsOf(sibling).hooks.UserPromptSubmit).toHaveLength(1);
  });
});
