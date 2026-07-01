# pi-exec

A **session-scoped background process manager** for [pi](https://github.com/earendil-works/pi-coding-agent),
packaged as a project-local extension.

It lets the agent (and you) run long-lived commands — dev servers, watchers,
`tail -f`, test runners — in the background instead of blocking a turn on the
built-in `bash` tool. Output is captured and inspectable, and **every process
is killed when the pi session ends**.

## Install / run

The extension lives at `.pi/extensions/proc-manager/` and is auto-discovered
when you run `pi` from this project (after the project is trusted). To try it
from anywhere:

```bash
pi -e ./.pi/extensions/proc-manager/index.ts
```

## Agent tools

| Tool | Purpose |
|------|---------|
| `proc_start`   | Start a shell command in the background; returns a job id (`p1`, `p2`, …). Pass `watch: true` to be told if it dies unexpectedly. |
| `proc_list`    | List jobs with status, pid, and uptime. |
| `proc_logs`    | Fetch captured stdout/stderr (`tail`, `grep` options). |
| `proc_stop`    | SIGTERM the job's process group, escalating to SIGKILL. |
| `proc_restart` | Restart a job under the same id, reusing command/cwd/env/watch. |
| `proc_wait`    | Block until exit, an output line matches a pattern, or a timeout. |

### Watched jobs

When a job started with `watch: true` exits unexpectedly (non-zero code or a
signal we didn't send), the extension notifies the agent, naming the job and
suggesting `proc_logs` / `proc_restart`. Intentional stops via `proc_stop` do
not trigger this.

Delivery is controlled by `/proc notify` (session-scoped, default `interrupt`):

- `interrupt` — wake the agent immediately (delivers a follow-up, triggers a turn)
- `next` — attach the note to your next prompt (no unprompted turn / token spend)
- `off` — don't notify the agent

## Manual command

`/proc` drives the same manager by hand:

```
/proc list                    list background jobs
/proc start <command>         start a background job
/proc logs <id> [tail]        show job output (default last 40 lines)
/proc stop <id> [signal]      stop a job
/proc restart <id>            restart a job with the same command
/proc stopall                 stop every job
/proc wait <id> [pattern]     wait for exit or a matching line (2m timeout)
/proc notify [mode]           get/set crash notifications: interrupt|next|off
```

Running jobs are also shown in a widget above the editor, and you get a
notification when a job exits.

## Lifetime & safety

Jobs live **only as long as the pi session**, by design:

- Each process is spawned **detached** (its own process group) so the manager
  can signal the entire tree — no orphaned grandchildren.
- Cleanup runs from the `session_shutdown` event (graceful SIGTERM → SIGKILL).
- A synchronous `process.on("exit")` handler is a last-resort SIGKILL net.
- The only uncovered case is `kill -9` of pi itself, where no process can run
  cleanup.

Output is streamed to per-job log files in a temporary directory that is
removed on shutdown; nothing is written into the repo.

## Development

```bash
node scripts/smoke.mjs   # runtime test (spawn, capture, group-kill, cleanup)
npx tsc --noEmit         # type check
```

The `node_modules/` symlinks and `scripts/` exist only for local type-checking
and testing; the extension itself uses only Node built-ins plus `typebox`.

### Layout

```
.pi/extensions/proc-manager/
  index.ts      # wiring: manager lifecycle, widget, shutdown safety net
  manager.ts    # ProcManager: spawn/track/kill, logs, wait (safety-critical)
  tools.ts      # LLM-callable tools
  commands.ts   # /proc slash command
  format.ts     # display helpers
  types.ts      # shared types
```
