/**
 * No network code outside the allowlist (privacy hardening, #7).
 *
 * The tripwire suite proves the commands it runs make no outbound connection;
 * this scan covers the code nothing runs yet — above all, network code an
 * upstream sync brings in. It reads the engine (`src/`) and the viewer
 * (`ui/src/`) for three shapes of network use:
 *
 *   - a runtime import of a network module or HTTP client package
 *     (`import type` is ignored: it emits no code);
 *   - a call that sends a request: `fetch(`, `globalThis.fetch`,
 *     `new WebSocket(`, `new EventSource(`, `new XMLHttpRequest(`, `sendBeacon(`;
 *   - a file that imports `child_process` and names a program that goes to the
 *     network by itself (curl, wget, npm, PowerShell, ...).
 *
 * Every use the build keeps is in ALLOWLIST with its reason; anything else
 * fails with file and line. The npm shim and the release scripts are outside
 * the scan: a source build never runs them.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SCANNED_DIRS = ['src', 'ui/src'];
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.svelte']);

const NETWORK_MODULES =
  'http|https|http2|net|tls|dgram|dns|undici|ws|axios|node-fetch|cross-fetch|isomorphic-fetch|got|superagent|request|needle';
const MODULE = `(?:node:)?(?:${NETWORK_MODULES})(?:/[\\w/-]+)?`;

interface Allowed {
  file: string;
  api: string;
  reason: string;
}

/** Every network use this build keeps. */
const ALLOWLIST: Allowed[] = [
  { file: 'src/mcp/daemon.ts', api: 'import net', reason: 'the MCP daemon listens on its owner-only Unix socket (a named pipe on Windows)' },
  { file: 'src/mcp/proxy.ts', api: 'import net', reason: 'the MCP proxy connects to the local daemon socket' },
  { file: 'src/mcp/daemon-paths.ts', api: 'import net', reason: 'probes whether the local daemon socket answers' },
  { file: 'src/ui-server/index.ts', api: 'import http', reason: 'the viewer server, bound to 127.0.0.1 only' },
  { file: 'ui/src/lib/adapter.ts', api: 'globalThis.fetch', reason: 'the viewer front end reads its own server, same origin only' },
  { file: 'ui/src/lib/adapter.ts', api: 'new EventSource', reason: "the viewer front end's live-update stream from its own server" },
  { file: 'src/mcp/process-identity.ts', api: 'spawn powershell', reason: "reads a local process's command line on Windows (Get-CimInstance)" },
];

interface Finding {
  file: string;
  line: number;
  api: string;
  code: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...sourceFiles(rel));
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The source with comment-only lines blanked, so line numbers still match. A
 * JSDoc line mentioning `import('node:http')` is prose, not a call. Comments
 * that share a line with code stay: stripping them needs a tokenizer, and a
 * leftover can only make the scan stricter.
 */
function withoutCommentLines(text: string): string {
  let inBlock = false;
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return '';
    }
    if (trimmed.startsWith('//')) return '';
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return '';
    }
    if (trimmed.startsWith('*')) return '';
    return line;
  }).join('\n');
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

const CALLS: Array<{ api: string; re: RegExp }> = [
  { api: 'fetch', re: /(^|[^.\w$])fetch\s*\(/g },
  { api: 'globalThis.fetch', re: /\bglobalThis\.fetch\b/g },
  { api: 'new WebSocket', re: /\bnew\s+WebSocket\s*\(/g },
  { api: 'new EventSource', re: /\bnew\s+EventSource\s*\(/g },
  { api: 'new XMLHttpRequest', re: /\bnew\s+XMLHttpRequest\s*\(/g },
  { api: 'sendBeacon', re: /\.sendBeacon\s*\(/g },
];
const NETWORK_PROGRAM = /['"`](curl|wget|npm|npx|pnpm|yarn|bun|powershell|pwsh|Invoke-WebRequest|Start-BitsTransfer)(?:\.exe|\.cmd)?(?=['"`\s])/gi;
const CHILD_PROCESS_IMPORT = /\b(?:import\s+(?!type\b)[^;'"]*?\bfrom\s*|require\s*\(\s*|import\s*\(\s*)['"](?:node:)?child_process['"]/;

function scanFile(file: string): Finding[] {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const text = withoutCommentLines(raw);
  const lines = text.split('\n');
  const findings: Finding[] = [];
  const add = (api: string, index: number) => {
    const line = lineAt(text, index);
    findings.push({ file, line, api, code: (lines[line - 1] ?? '').trim().slice(0, 160) });
  };

  // Static imports and re-exports, possibly over several lines; `import type` emits nothing.
  const staticImport = new RegExp(`\\b(import|export)\\s+(type\\s+)?[^;'"]*?\\bfrom\\s*['"](${MODULE})['"]`, 'g');
  for (const m of text.matchAll(staticImport)) {
    if (!m[2]) add(`import ${m[3]!.replace(/^node:/, '').split('/')[0]}`, m.index!);
  }
  const sideEffectImport = new RegExp(`\\bimport\\s*['"](${MODULE})['"]`, 'g');
  for (const m of text.matchAll(sideEffectImport)) add(`import ${m[1]!.replace(/^node:/, '').split('/')[0]}`, m.index!);
  const dynamic = new RegExp(`\\b(?:require|import)\\s*\\(\\s*['"](${MODULE})['"]\\s*\\)`, 'g');
  for (const m of text.matchAll(dynamic)) add(`import ${m[1]!.replace(/^node:/, '').split('/')[0]}`, m.index!);

  for (const { api, re } of CALLS) {
    for (const m of text.matchAll(re)) add(api, m.index! + (m[1]?.length ?? 0));
  }

  if (CHILD_PROCESS_IMPORT.test(text)) {
    for (const m of text.matchAll(NETWORK_PROGRAM)) add(`spawn ${m[1]!.toLowerCase()}`, m.index!);
  }
  return findings;
}

function scanAll(): Finding[] {
  return SCANNED_DIRS.flatMap(sourceFiles).flatMap(scanFile);
}

const isAllowed = (f: Finding) => ALLOWLIST.some((a) => a.file === f.file && a.api === f.api);

describe('network static scan', () => {
  const findings = scanAll();

  it('finds no network use outside the allowlist', () => {
    const unexpected = findings.filter((f) => !isAllowed(f)).map((f) => `${f.file}:${f.line}  ${f.api}  —  ${f.code}`);
    expect(unexpected, `network code outside the allowlist:\n${unexpected.join('\n')}`).toEqual([]);
  });

  it('every allowlist entry still matches something (no stale permissions)', () => {
    const stale = ALLOWLIST.filter((a) => !findings.some((f) => f.file === a.file && f.api === a.api))
      .map((a) => `${a.file}  ${a.api}`);
    expect(stale, `allowlist entries that match nothing — remove them:\n${stale.join('\n')}`).toEqual([]);
  });

  it('every allowlist entry names a file, an API and a reason', () => {
    for (const entry of ALLOWLIST) {
      expect(fs.existsSync(path.join(ROOT, entry.file)), entry.file).toBe(true);
      expect(entry.api.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it('the scanner itself sees each shape of network use', () => {
    const probe = path.join(ROOT, 'src', `__network-scan-probe-${process.pid}.ts`);
    fs.writeFileSync(probe, [
      "import * as https from 'node:https';",
      'import {',
      '  request,',
      "} from 'http';",
      "import type { Socket } from 'net';",
      "import { spawnSync } from 'child_process';",
      "const dns = require('dns');",
      "export async function leak() { await fetch('https://example.invalid/'); }",
      "const ws = new WebSocket('wss://example.invalid/');",
      "spawnSync('curl', ['https://example.invalid/']);",
      '// a comment line naming fetch( is prose, not a call',
    ].join('\n'));
    try {
      const rel = path.relative(ROOT, probe).split(path.sep).join('/');
      const seen = scanFile(rel).map((f) => `${f.line} ${f.api}`);
      expect(seen.sort()).toEqual(['1 import https', '2 import http', '7 import dns', '8 fetch', '9 new WebSocket', '10 spawn curl'].sort());
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });
});
