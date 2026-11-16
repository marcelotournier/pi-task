# pi-task

Durable background tasks for [pi](https://github.com/badlogic/pi-mono). A pi
extension that lets the agent run work as **real, autonomous pi instances** —
each with its own context window, tools, and model — while the main agent
continues, gets **notified when each task finishes**, and resumes as an
orchestrator.

Tasks are **durable**: their state is persisted in the session, transcripts
are logged to disk, and tasks that outlive a crash are recovered and reported
after a restart.

## Why another subagent tool?

- **Full pi children, not prompt-embedded agents.** Each task spawns a real
  `pi --mode json` process: same robustness, tools, auth, and extensions as
  the main session — with a clean context window so long jobs can't pollute
  the orchestrator's context.
- **True async + callback.** The `task` tool returns immediately. When a task
  reaches a terminal state, pi-task injects a message into the main session
  (`pi.sendMessage`, `deliverAs: "steer"`, `triggerTurn: true`): the agent is
  woken when idle, or the result is queued mid-turn. The orchestrator resumes
  exactly when work lands — no polling, no busy-wait.
- **Durable across restarts.** Task records are appended as session entries;
  on restart, in-flight tasks are recovered as `orphaned` (with a pointer to
  the transcript log so progress is recoverable) instead of silently lost.

## Install

```bash
pi install github:marcelotournier/pi-task
# or for local development:
pi -e /path/to/pi-task/src/index.ts
```

## Usage (for the agent)

| Tool | Purpose |
| --- | --- |
| `task` | Start a task. `wait:false` (default): returns a task id immediately — you are notified on completion. `wait:true`: blocks until the task settles. |
| `task_output` | Inspect a task (status, output so far, usage, last activity). `block:true` waits up to `timeout_ms`. No id lists all tasks. |
| `task_stop` | Cancel a running/queued task (SIGTERM → SIGKILL escalation). |
| `/tasks` | Human-facing listing of all tasks. |

Typical orchestration flow the agent follows (guided by the tool's prompt
guidelines):

1. Decompose a big job, start 1–N background `task`s.
2. Keep working on other steps (or answer the user).
3. Completion messages arrive automatically → the agent processes each
   result and continues the plan.

Each task's full transcript is teed to `~/.pi/agent/tasks/<id>.jsonl` (the
raw `pi --mode json` stream) and referenced in the completion message, so
anything not summarized in the final output can be inspected with `read`.

## Behavior details

- **Concurrency:** up to 4 tasks run at once (bounded pool); extras queue.
- **Non-interactive (`pi -p`) caveat:** the session ends when the agent's turn
  ends, and in-flight tasks are then orphaned (state + transcript persist and
  are recoverable in a later session). For scripted fan-out, start tasks with
  `wait:true` or collect results with `task_output block:true` before the turn
  ends. In interactive sessions, completion messages wake the agent in a new
  turn automatically.
- **Isolation:** children run with `--no-session` (in-memory) in the task's
  working directory; model/thinking/tools can be overridden per task,
  otherwise they inherit the main session's.
- **Statuses:** `queued → running → completed | failed | cancelled | orphaned`.
- **Recovery:** after a host restart, records that were `queued`/`running`
  become `orphaned` and re-notify once, so orchestration can resume from the
  transcript.
- **Accounting:** token usage + cost per task is aggregated from the child's
  `message` events and shown in results, the footer, and `/tasks`.
- **Escaping the process group:** children are spawned detached and killed by
  pid (not process group) so `task_stop` never takes down the parent.

### Environment

| Variable | Effect |
| --- | --- |
| `PI_TASK_PI_BIN` | Which `pi` binary children use (default: auto-detected from the running pi / `pi` on PATH). |

## Development

```bash
npm install
npm test          # 26 tests: runner (fake pi), manager (fake host),
                  # and end-to-end against the real pi binary
                  # (auto-skips when no pi available; PI_TASK_E2E=0 to force-skip)
npm run typecheck
```

### Architecture

```
src/
  types.ts    shared dep-free types (TaskRecord, statuses, usage, host iface)
  runner.ts   TaskRunner: spawn `pi --mode json`, parse JSONL, tee log, abort
  manager.ts  TaskManager: registry, queue, bounded pool, callbacks, pruning
  host.ts     pi binding: pi.sendMessage callback + appendEntry persistence
  index.ts    extension entry: tools, /tasks, renderers, lifecycle, status
test/
  runner.test.ts   10 tests vs a fake pi shim (async, abort, logs, argv)
  manager.test.ts  14 tests vs fake host/runner (lifecycle, pool, recovery)
  e2e.test.ts      real pi child process, full stack (opt-out: PI_TASK_E2E=0)
```

The runner and manager have **no pi dependencies**, which is what makes them
unit-testable; the pi surface is isolated in `host.ts` (and `index.ts`).
