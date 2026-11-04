# Dependency network audit

Privacy hardening #8 (part of #1). This audit checks whether any third-party code that this build runs can open a network connection.

- **Scope:** the engine's runtime dependencies, and the viewer bundle as built.
- **Not in scope:** dev dependencies and `npm ci`'s own registry traffic.
- **Audited:** 2026-11-04, on `main` at `e4d8756a`, with the versions installed by `npm ci` from the lockfile.

**Result: no reachable network code.** Two dependencies contain network-capable code, and CodeGraph never reaches it. Nothing was patched.

## Engine runtime dependencies

These are the production dependency tree of the root package. The viewer's packages are covered below through the bundle they are compiled into.

| Package | Version | Finding |
|---|---|---|
| `@clack/prompts` | 1.3.0 | No network code |
| `@clack/core` | 1.3.0 | No network code |
| `commander` | 14.0.3 | Network-capable code, unreachable (1) |
| `fast-string-width` | 3.0.2 | No network code |
| `fast-string-truncated-width` | 3.0.3 | No network code |
| `fast-wrap-ansi` | 0.2.0 | No network code |
| `ignore` | 7.0.14 | No network code |
| `jsonc-parser` | 3.3.1 | No network code |
| `picomatch` | 4.0.7 | No network code |
| `sisteransi` | 1.0.5 | No network code |
| `tree-sitter-wasms` | 0.1.13 | No network code (grammar `.wasm` files only, no JavaScript) |
| `web-tree-sitter` | 0.25.10 | Network code, unreachable (2) |

1. **`commander`** imports `child_process` and calls `spawn` for *executable subcommands*: `program.command('name', 'description')` runs a separate `<program>-name` file. That starts a local program, not a network one. CodeGraph defines every subcommand with `.action()`, so the path never runs.
2. **`web-tree-sitter`** has `fetch` and `XMLHttpRequest` for loading `.wasm` files in a browser:
   - **Runtime loader:** the calls sit in the `ENVIRONMENT_IS_WEB` / `ENVIRONMENT_IS_WORKER` branch, or behind `!ENVIRONMENT_IS_NODE`. Under Node the loader reads files with `fs`.
   - **`Language.load(input)`:** a `Uint8Array` is used as is. Otherwise, when `process.versions.node` exists, the file is read with `fs/promises.readFile`, and only a browser falls through to `fetch`.
   - **CodeGraph's call:** it passes either the grammar bytes or a local path from its own `dist/extraction/wasm/`.

## Viewer bundle (`dist/viewer/`)

svelte, `@xyflow/svelte`, d3 and the viewer's own code are compiled into one bundle, `dist/viewer/assets/index-*.js`. Fonts are local `.woff`/`.woff2` files. `index.html` loads only `./assets/*`.

| Found in bundle | What it is | Reachable network use? |
|---|---|---|
| `fetch(s.href, …)` | Vite's modulepreload polyfill, preloading the page's own `./assets/*.js` | No, same origin only |
| `globalThis.fetch(…)` | the viewer adapter: `baseUrl` + a relative `api/…` path | No, same origin only (allowlisted in the static scan) |
| `new EventSource(…)` | the adapter's live-update stream at `api/events` | No, same origin only (allowlisted) |
| `new Image` | rasterizes a locally built image for export | No, local data |
| `https://svelteflow.dev?utm_source=attribution` | `@xyflow/svelte`'s attribution `<a>` link | Only if the user clicks it, which opens a browser tab |
| `https://svelte.dev/e/…` | URLs inside Svelte's error-message strings | No, text only |
| `http://www.w3.org/…` | SVG/XML namespace strings | No, text only |

- **Not found:** `XMLHttpRequest`, `WebSocket`, `sendBeacon`, service workers, `importScripts`.
- **CSS:** no external `url()` or `@import`.
- **Second layer:** the viewer server also sends `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:`. The browser blocks any request to another origin even if one appeared.

## Re-running after an upstream sync

Run these after `npm ci && npm run build`. Then compare the output with the tables above, and update them in the same change if anything is new.

**1. The production dependency tree:**

```bash
npm ls --omit=dev --all --parseable | sed "s#^$PWD/##" | sort -u
```

**2. Network APIs in each engine dependency.** Edit the package list if step 1 changed:

```bash
for p in @clack/core @clack/prompts commander fast-string-truncated-width fast-string-width \
         fast-wrap-ansi ignore jsonc-parser picomatch sisteransi tree-sitter-wasms web-tree-sitter; do
  echo "$p: $(grep -rlE "require\(['\"](node:)?(http|https|http2|net|tls|dgram|dns|undici|child_process)['\"]\)|from ['\"](node:)?(http|https|http2|net|tls|dgram|dns|undici|child_process)['\"]|(^|[^.A-Za-z0-9_\$])fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon" \
    node_modules/$p --include='*.js' --include='*.cjs' --include='*.mjs' | tr '\n' ' ')"
done
```

**3. Network APIs and external hosts in the viewer bundle:**

```bash
F=$(ls dist/viewer/assets/index-*.js)
for pat in 'fetch(' XMLHttpRequest WebSocket EventSource sendBeacon serviceWorker importScripts; do
  echo "$pat: $(grep -o "$pat" "$F" | wc -l)"
done
grep -oE "https?://[A-Za-z0-9.-]+" "$F" | sort | uniq -c
grep -oE "https?://[A-Za-z0-9./-]+" dist/viewer/assets/*.css
```

A new hit needs the same decision as above: can CodeGraph reach that code from a Node CLI/MCP run, or from the loopback viewer? Document unreachable code here. Reachable code is a finding to raise before changing anything.
