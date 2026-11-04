/**
 * Preloaded with `--require` (through NODE_OPTIONS, so the CLI's own re-exec,
 * the daemon and every worker thread load it too) into the processes the
 * network-tripwire suite starts. Any attempt to reach a destination that isn't
 * loopback or a local socket is appended to CG_TEST_NETWORK_LOG and then
 * failed, so the run never touches the network. Covered: `fetch`, socket
 * connects (`net`, and `http`/`https`/`tls`, which all connect through
 * `net.Socket`), DNS lookups, and child processes that start a program that
 * goes to the network on its own (curl, wget, npm, ...).
 */
const childProcess = require('child_process');
const dns = require('dns');
const fs = require('fs');
const net = require('net');

const log = process.env.CG_TEST_NETWORK_LOG;
if (log) {
  const record = (kind, target) => {
    fs.appendFileSync(log, JSON.stringify({ pid: process.pid, kind, target: String(target) }) + '\n');
  };
  const refused = (target) => Object.assign(new Error(`network-tripwire: blocked ${target}`), { code: 'ECONNREFUSED' });

  const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']);
  const isLoopback = (host) => host === undefined || host === null || host === '' ||
    LOOPBACK_HOSTS.has(String(host).toLowerCase().replace(/^\[|\]$/g, '')) ||
    /^127\./.test(String(host));

  // `net.Socket#connect(options | path | port[, host])`. A `path` is a Unix
  // socket or a named pipe: local by construction.
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function tripwireConnect(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host;
    let port;
    let local = false;
    if (typeof first === 'string' && !/^\d+$/.test(first)) local = true;
    else if (first !== null && typeof first === 'object') {
      if (first.path) local = true;
      host = first.host;
      port = first.port;
    } else {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : undefined;
    }
    if (local || isLoopback(host)) return connect.apply(this, args);
    const target = `${host}:${port}`;
    record('connect', target);
    process.nextTick(() => this.destroy(refused(target)));
    return this;
  };

  const lookup = dns.lookup;
  dns.lookup = function tripwireLookup(hostname, ...rest) {
    if (isLoopback(hostname)) return lookup.call(this, hostname, ...rest);
    record('dns', hostname);
    const callback = rest.find((arg) => typeof arg === 'function');
    if (callback) process.nextTick(() => callback(Object.assign(refused(hostname), { code: 'ENOTFOUND' })));
    return undefined;
  };
  const lookupAsync = dns.promises.lookup;
  dns.promises.lookup = function tripwireLookupAsync(hostname, ...rest) {
    if (isLoopback(hostname)) return lookupAsync.call(this, hostname, ...rest);
    record('dns', hostname);
    return Promise.reject(Object.assign(refused(hostname), { code: 'ENOTFOUND' }));
  };

  if (typeof globalThis.fetch === 'function') {
    const realFetch = globalThis.fetch;
    globalThis.fetch = function tripwireFetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      let host;
      try { host = new URL(url).hostname; } catch { host = undefined; }
      if (host !== undefined && isLoopback(host)) return realFetch.call(this, input, init);
      record('fetch', url);
      return Promise.reject(new TypeError('fetch failed', { cause: refused(url) }));
    };
  }

  // A program that reaches the network by itself, started directly or through
  // a shell (`sh -c "curl ... | sh"`).
  const NETWORK_PROGRAMS = /(^|[\s/\\;|&('"`])(curl|wget|npm|npx|pnpm|yarn|Invoke-WebRequest|iwr|Start-BitsTransfer)(\.exe|\.cmd)?(?=$|[\s;|&)'"`])/i;
  const commandLine = (file, args) => [file, ...(Array.isArray(args) ? args : [])].map(String).join(' ');
  const isNetworkProgram = (file, args) => {
    const line = commandLine(file, args);
    if (NETWORK_PROGRAMS.test(line)) return true;
    // `powershell -EncodedCommand <base64 UTF-16LE>` hides the program name.
    const encoded = Array.isArray(args) ? args.findIndex((a) => /^-e(nc(odedcommand)?)?$/i.test(String(a))) : -1;
    if (encoded !== -1 && args[encoded + 1]) {
      const decoded = Buffer.from(String(args[encoded + 1]), 'base64').toString('utf16le');
      return NETWORK_PROGRAMS.test(decoded);
    }
    return false;
  };
  const guard = (name, fileArgsOf) => {
    const real = childProcess[name];
    childProcess[name] = function tripwireSpawn(...args) {
      const [file, fileArgs] = fileArgsOf(args);
      if (isNetworkProgram(file, fileArgs)) {
        const target = commandLine(file, fileArgs);
        record('spawn', target);
        throw refused(target);
      }
      return real.apply(this, args);
    };
  };
  const withArgs = (args) => [args[0], Array.isArray(args[1]) ? args[1] : []];
  const shellLine = (args) => [args[0], []];
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) guard(name, withArgs);
  for (const name of ['exec', 'execSync']) guard(name, shellLine);
}
