# Code Review — Findings & Fix Plan (2026-06-09)

**Status: all workstreams implemented and verified** (backend tsc clean,
frontend tsc clean, backend vitest 321 passing, electron bundles build).
Items in "Deferred" are documented decisions, not omissions.

Full-codebase review (backend, frontend, electron). Each item lists the finding
and the fix applied.

## Workstream 1 — TaskService (backend/src/services/taskService.ts)

**1a. Mission-progress bridge breaks when Redis falls over to standalone.**
`server.ts` attaches `progress`/`completed`/`failed` listeners to the real
`QueueEvents` at startup (Redis hasn't errored yet). When the connection later
fails and standalone mode activates, local jobs emit on brand-new
`MockQueueEvents` instances that have no listeners — mission progress silently
stops reaching the UI.
*Fix:* `getQueueEvents()` returns a stable per-queue `EventEmitter` facade.
In Redis mode the real `QueueEvents` is piped into the facade; in standalone
mode local jobs emit into the same facade. Listeners survive the transition.

**1b. `localJobs` map grows without bound in standalone mode.**
*Fix:* prune oldest finished entries past a cap (200).

**1c. Close hygiene.** `close()` never closes the `Queue` instances (each holds
a duplicated Redis connection); `activateStandaloneMode()` clears
`queueEvents` without closing them.
*Fix:* close both.

**1d. `taskService.standalone.test.ts` fails `tsc`** (BullMQ `JobProgress` vs
`number`) and the first test waits a fixed 150 ms (flaky).
*Fix:* type against the facade; poll for standalone activation.

## Workstream 2 — Server shutdown (backend/src/server.ts)

`gracefulShutdown()` calls `process.exit(0)` inside the `httpServer.close()`
callback. With no open connections that callback fires immediately, so the
process can exit before the indexer stop / embedding-cache flush / sidecar stop
complete. Also `vectorService.shutdown()` (HNSW flush) and `taskService.close()`
are never called.
*Fix:* re-entry guard → stop listener → await all cleanup steps (each
individually try/caught) → `process.exit(0)`. The 10 s force-exit timer stays.

## Workstream 3 — toolService (backend/src/services/toolService.ts)

**3a. Stage-splitting misses newline and single `&`.** Commands route through
`bash -c` (Windows/git-bash) or `/bin/sh -c`, where `cmd1\ncmd2` and
`cmd1 & cmd2` run both stages — but only the first token was validated against
the allowlist.
*Fix:* `PIPELINE_SEPARATOR` and `hasShellMetacharacters` include `&` and
newlines, so every stage is validated.

**3b. `node -e` is blocked but `python -c` is not** (arbitrary code execution
on an allowlisted binary). *Fix:* extend `rejectDangerousArgv`.

**3c. `run_tests` accepts an arbitrary `command` and spawns it with
`shell: true` on Windows** — a complete bypass of the run_shell allowlist.
*Fix:* extract the allowlist/dangerous-pattern/argv validation into a shared
helper and apply it to `run_tests` commands too.

**3d. `run_tests` / `install_package` `cwd` is joined unchecked**
(`path.join(root, cwd)` escapes with `..`). *Fix:* `validatePath`.

**3e. `install_package` package names unvalidated** (flag injection such as
`--registry=…`, and arbitrary args via `shell: true` joining).
*Fix:* validate against npm-name charset, reject leading `-`.

**3f. `replace_in_files` matches as regex but replaces literally** (grep -r
pattern vs `split(pattern).join(replacement)`). *Fix:* literal search mode
(`grep -F` / `findstr /l`) for the replace path; `grep_files` keeps regex.

**3g. `read_file` auto-embeds the first 5 KB of every read into vector memory**
— reading `.env` (inside PROJECT_ROOT) persists secrets into
`.solvent_memory.sqlite`. *Fix:* skip embedding for sensitive paths
(`.env*`, `*.pem/key/p12/pfx`, `id_rsa*`, credentials/secrets).

**3h. `fetch_web_content` calls `.slice()` on `response.data`** which is an
object for JSON responses. *Fix:* `responseType: 'text'` + string guard.

## Workstream 4 — vectorService (backend/src/services/vectorService.ts)

**4a. Mangled formatting** (lines ~805–1355: exploded indentation from a bad
edit) across `indexProject`, `findReferenceTargets`, `search`, etc.
*Fix:* reformat, logic unchanged.

**4b. Startup race:** `loadMemory()` is fired un-awaited in the constructor;
early searches/adds see empty memory (the embedding cache already has a
`loaded` promise — memory doesn't). *Fix:* `memoryLoaded` promise awaited at
the top of async entry points.

**4c. Gemini embedding circuit breaker is permanent** for the process
lifetime. *Fix:* 5-minute cooldown, reset on success.

**4d. Eviction never removes entries from the HNSW index** (`saveMemory`
rebuilds the other indices but not HNSW), so dead ids consume search budget.
*Fix:* `markDeleted` for each evicted id.

**4e. Backup/recovery pipeline is dead.** `BackupManager` snapshots
`.solvent_memory.json`, which nothing writes anymore (storage moved to SQLite
in V4) — backups rotate a stale file; recovery restores it into RAM only.
*Fix:* write a JSON snapshot of current memory before each rotation, and on
recovery re-insert restored entries into SQLite so the heal persists.

**4f. `findReferenceTargets` is O(symbols × text) with a regex compile per
symbol.** *Fix:* tokenize the chunk once into a Set; regex only on hits.

## Workstream 5 — sqliteService (backend/src/services/db/sqliteService.ts)

WAL mode + `synchronous=NORMAL` (the `.gitignore` already anticipates
`-wal`/`-shm` files); cache prepared statements instead of re-preparing
`insertMemory`/`upsertEmbedding` on every call.

## Workstream 6 — Electron (electron/main.ts, frontend api-client)

**6a. Hardcoded fallback secret** `'solvent_default_secure_pass_2026'` becomes
the real backend secret in any packaged install without the env var — publicly
known, identical across installs, and it bypasses the strength checks
`config.ts` enforces (Electron injects it via env before the backend starts).
*Fix:* env var wins if set; packaged builds generate a random 64-hex secret on
first run, persisted under `userData`; dev returns `null` and the renderer
falls back to `/dev-secret` (which is also the only correct behavior today —
in dev the hardcoded constant never matched the backend's `.env` secret, so
desktop-dev auth only worked by accident or not at all).

**6b. `setWindowOpenHandler` uses `url.includes('localhost:5173')`** — a
substring check; `https://evil.com/?localhost:5173` would open as a child
window with the preload (and `get-session-secret`) attached. Non-http URLs
fall through to `allow`. *Fix:* parse the URL, exact-origin allowlist, deny
everything else; add a `will-navigate` guard.

**6c. All IPC handlers, the telemetry loop, and `fs.watch` are registered
inside `createWindow()`** — macOS `activate` re-runs it: `ipcMain.handle`
throws on double registration, and loops/watchers duplicate. Also `fs.watch`
on a missing file throws uncaught at startup in packaged builds, and
`NOTES_FILE` resolves inside `resources/` when packaged. *Fix:* one-time
module-scope registration; notes path under `userData` when packaged; watch
wrapped in try/catch.

**6d. `openDevTools()` unconditional** — gate on `!app.isPackaged`.

**6e. Packaged backend spawns `'node'` from PATH** — fails on machines
without Node. *Fix:* `process.execPath` + `ELECTRON_RUN_AS_NODE=1`.

**6f. `globalHistory` / mission `actions` grow without bound.** *Fix:* cap.

## Workstream 7 — frontend/src/lib/api-client.ts

**7a. `subscribeToOptimizationRun` uses `EventSource`,** which cannot send the
`X-Solvent-Secret` header; the stream route sits behind the secret middleware,
so the subscription always gets 401 and the optimizer panel never streams.
*Fix:* fetch-based SSE reader with the auth header (server wire format
unchanged: `data: <json>\n\n` + literal `[DONE]`).

**7b. `getSecret` caches a falsy Electron result** instead of falling through
to dev fallbacks. *Fix:* fall through on falsy (required for 6a dev flow).

**7c. Dead code:** unreachable duplicate `throw` in `fetchWithRetry`.

## Deferred (deliberate, not implemented)

- **Embedding-space mixing:** after a Gemini failure, new embeddings come from
  Ollama while old vectors are Gemini-truncated — cosine scores across the two
  spaces are not comparable. Proper fix is tagging vectors with their provider
  and re-embedding on mismatch; needs a product decision on cost. The 5-minute
  breaker cooldown (4c) reduces exposure.
- **Deep allowlist lockdown** (`npx <pkg>`, `docker run`, `git -c alias.…`,
  redirect targets outside the project): each is still arbitrary-code-adjacent
  for a prompt-injected agent, but blocking them outright breaks legitimate
  agent workflows. Revisit with a permission-prompt UX instead of a static
  list. `SOLVENT_ALLOW_SHELL=false` remains the kill switch.
- **POST retries in `fetchWithRetry`** re-send non-idempotent requests on 5xx;
  acceptable for a local single-user app.
- **Rate limiter skips localhost** — by design; the app is localhost-only.
- **Zero-vector entries** (both embed providers down) persist permanently and
  never re-embed; candidate for the memory-maintenance job.
