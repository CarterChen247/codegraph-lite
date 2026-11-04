#!/usr/bin/env bash
# Offline check for the privacy-hardened build (#9). macOS only (sandbox-exec).
#
# Runs the built CLI, an MCP session (daemon mode) and the viewer inside a
# sandbox that denies the network at the OS level, against a throwaway HOME,
# and fails if any command errors, hangs, reports a network error, or leaves
# telemetry / update-check state behind.
#
#   npm run build && bash docs/privacy/offline-check.sh [project-dir]
#
# With no project-dir it indexes a snapshot of this repo's own src/.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN="$REPO/dist/bin/codegraph.js"
[ -f "$BIN" ] || { echo "build first: npm run build" >&2; exit 1; }
command -v sandbox-exec >/dev/null || { echo "sandbox-exec not found (macOS only)" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/codegraph-offline.XXXXXX")
trap 'pkill -f "$WORK" 2>/dev/null || true; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/proj"
if [ $# -ge 1 ]; then
  cp -R "$1/." "$WORK/proj/"
  rm -rf "$WORK/proj/.codegraph"
else
  (cd "$REPO" && git archive HEAD src package.json tsconfig.json) | tar -x -C "$WORK/proj"
fi

# Deny every network operation. Local Unix sockets stay open (the MCP daemon),
# except mDNSResponder's: DNS lookups go through it, and a lookup leaks the name.
cat >"$WORK/offline.sb" <<'SB'
(version 1)
(allow default)
(deny network*)
(allow network* (local unix-socket))
(allow network* (remote unix-socket))
(deny network* (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
SB
# The viewer needs loopback TCP and nothing else.
cp "$WORK/offline.sb" "$WORK/loopback.sb"
cat >>"$WORK/loopback.sb" <<'SB'
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
SB

export HOME="$WORK/home"
unset CODEGRAPH_TELEMETRY DO_NOT_TRACK CODEGRAPH_NO_UPDATE_CHECK CODEGRAPH_NO_DAEMON CODEGRAPH_TELEMETRY_ENDPOINT
NET_ERRORS='ENOTFOUND|EPERM|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|getaddrinfo'
BUDGET_S=60
failures=0
now() { node -e 'process.stdout.write(String(Date.now()))'; }
fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }

echo "Project: $(find "$WORK/proj" -type f | wc -l | tr -d ' ') files    Sandbox: no network (Unix sockets only)"
echo
cd "$WORK/proj"
while IFS= read -r line; do
  read -r -a args <<<"$line"
  t0=$(now)
  set +e
  sandbox-exec -f "$WORK/offline.sb" node "$BIN" "${args[@]}" >"$WORK/out.txt" 2>&1
  code=$?
  set -e
  ms=$(( $(now) - t0 ))
  printf '  %-48s exit=%s %6s ms\n' "codegraph $line" "$code" "$ms"
  [ "$code" -eq 0 ] || fail "exit $code: $(tail -3 "$WORK/out.txt")"
  [ "$ms" -lt $((BUDGET_S * 1000)) ] || fail "took ${ms} ms"
  if grep -qiE "$NET_ERRORS" "$WORK/out.txt"; then fail "network error: $(grep -iE "$NET_ERRORS" "$WORK/out.txt" | head -1)"; fi
done <<'CMDS'
init -y .
index .
sync .
status .
query main
explore main
telemetry status
telemetry on
upgrade --check
upgrade
CMDS

# One MCP session in daemon mode (the default): initialize, a tool call, status.
cat >"$WORK/drive-mcp.cjs" <<'JS'
const { spawn } = require('child_process');
const [bin, cwd] = process.argv.slice(2);
const child = spawn(process.execPath, ['--liftoff-only', bin, 'serve', '--mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const find = (id) => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((m) => m.id === id);
const wait = (id) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    const m = find(id);
    if (m) { clearInterval(timer); resolve(m); } else if (Date.now() - started > 30000) { clearInterval(timer); reject(new Error(`no response to ${id}`)); }
  }, 20);
});
(async () => {
  let t = Date.now();
  send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-check', version: '0' }, rootUri: 'file://' + cwd } });
  const init = await wait(0);
  console.log(`  ${'serve --mcp: initialize'.padEnd(48)} ${Date.now() - t} ms`);
  if (/update available|codegraph upgrade/i.test(init.result.instructions)) throw new Error('update notice in instructions');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const [id, name, args] of [[1, 'codegraph_explore', { query: 'main' }], [2, 'codegraph_status', {}]]) {
    t = Date.now();
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const r = await wait(id);
    console.log(`  ${('serve --mcp: ' + name).padEnd(48)} ${Date.now() - t} ms`);
    if (r.result.isError) throw new Error(`${name} returned isError`);
    if (/Update available/.test(r.result.content[0].text)) throw new Error('update notice in status');
  }
  child.stdin.end();
})().catch((e) => { console.log(`  FAIL: ${e.message}`); process.exitCode = 1; child.kill(); });
child.on('exit', () => {
  if (new RegExp(process.env.NET_ERRORS, 'i').test(err)) { console.log('  FAIL: network error on server stderr'); process.exitCode = 1; }
});
JS
set +e
NET_ERRORS="$NET_ERRORS" CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=2000 sandbox-exec -f "$WORK/offline.sb" node "$WORK/drive-mcp.cjs" "$BIN" "$WORK/proj" 2>&1 | grep -v -iE 'ExperimentalWarning|trace-warnings'
mcp=${PIPESTATUS[0]}
set -e
[ "$mcp" -eq 0 ] || failures=$((failures + 1))
for _ in $(seq 1 50); do [ -f .codegraph/daemon.pid ] || break; sleep 0.2; done
if grep -qiE "$NET_ERRORS" .codegraph/daemon.log 2>/dev/null; then fail "network error in daemon.log"; fi

# The viewer, with loopback TCP allowed and nothing else.
PORT=$((40000 + RANDOM % 20000))
CODEGRAPH_UI=1 sandbox-exec -f "$WORK/loopback.sb" node "$BIN" ui --no-open --port "$PORT" . >"$WORK/ui.log" 2>&1 &
UI_PID=$!
for _ in $(seq 1 75); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done
page=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
csp=$(curl -sI "http://127.0.0.1:$PORT/" | grep -i '^content-security-policy' || true)
# By port, not pid: the CLI re-execs itself, so the listener is a child of UI_PID.
listen=$( (lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true) | awk 'NR > 1 {print $9}' | sort -u | tr '\n' ' ')
pkill -f -- "--port $PORT" 2>/dev/null || true
wait "$UI_PID" 2>/dev/null || true
printf '  %-48s page=%s listen=%s\n' "ui (viewer, loopback only)" "$page" "${listen:-?}"
[ "$page" = 200 ] || fail "viewer page returned $page"
case "$csp" in *"connect-src 'self'"*) ;; *) fail "viewer CSP missing connect-src 'self'";; esac
case "$listen" in *0.0.0.0*|*'*:'*) fail "viewer listens beyond loopback: $listen";; esac

# Nothing that phones home may have left state behind.
leftovers=$(find "$HOME/.codegraph" -maxdepth 1 \( -name 'telemetry*' -o -name 'update-check*' -o -name 'beta-signup*' \) 2>/dev/null | tr '\n' ' ')
echo
echo "  ~/.codegraph afterwards: $(ls -A "$HOME/.codegraph" 2>/dev/null | tr '\n' ' ' || true)"
[ -z "$leftovers" ] || fail "left behind: $leftovers"

echo
if [ "$failures" -eq 0 ]; then echo "OFFLINE CHECK PASSED"; else echo "OFFLINE CHECK FAILED ($failures)"; exit 1; fi
