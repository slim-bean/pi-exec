# AGENTS.md

pi-exec is a project-local pi extension: a session-scoped background process
manager. See `README.md` for user-facing docs.

## Invariants (do not break)

- **Jobs never outlive the session.** Every process is spawned `detached`
  (own process group) and killed via `process.kill(-pid, signal)` so the whole
  tree dies. Cleanup paths: `stopAll()` (async, from `session_shutdown`) and
  `killAllSync()` (sync, from a `process.on("exit")` net). Keep both working.
- Do **not** start processes, timers, or watchers in the extension factory.
  `ProcManager` construction is side-effect free (temp dir is created lazily on
  first `start()`). Session-scoped wiring happens in `session_start`.
- Log files go in a private OS temp dir, removed on shutdown. Never write into
  the repo or cwd.

## Structure

- `manager.ts` — `ProcManager` (safety-critical). Spawn, track, kill groups,
  ring-buffer + file logs, `wait()`.
- `tools.ts` / `commands.ts` — thin adapters over `ProcManager` for the LLM and
  for `/proc`.
- `format.ts`, `types.ts` — display helpers and shared types.
- `index.ts` — lifecycle wiring, TUI widget, shutdown/exit safety net.

## Verify changes

```bash
node scripts/smoke.mjs   # spawn, capture, group-kill, killAllSync, cleanup
npx tsc --noEmit         # types (uses node_modules symlinks to global pi)
```

Always run `scripts/smoke.mjs` after touching `manager.ts` and confirm no
stray processes remain (`pgrep -fl sleep`) and no `pi-proc-*` temp dirs leak.
