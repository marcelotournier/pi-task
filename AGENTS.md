# Pi Durable Task

- [x] **Done (v1):** async task manager + runner as a pi extension.
  - Each task = a full child `pi --mode json -p --no-session` process (as robust as pi: own context, tools, auth).
  - `task` / `task_output` / `task_stop` tools + `/tasks` command + status footer.
  - **Completion callback into the main agent thread** via `pi.sendMessage({deliverAs:"steer", triggerTurn:true})` — verified live: a fresh `pi -e src/index.ts` ran a background task and resumed on the notification (`ORCHESTRATION-WORKS`).
  - Durable: records persisted as session custom entries (`durable-task`), transcripts teed to `~/.pi/agent/tasks/<id>.jsonl`, orphan recovery on restart.
  - Bounded pool (4) + queue; per-task usage/cost accounting; abort escalation SIGTERM→SIGKILL.
  - Tests: 26 green (runner vs fake pi, manager vs fake host, E2E vs real `pi`).
  - Public repo: https://github.com/marcelotournier/pi-task

## Architecture

```
index.ts (extension: tools, /tasks, renderers, lifecycle)
  └─ host.ts (TaskHost: pi.sendMessage callback, appendEntry persistence)
       └─ manager.ts (registry, queue, bounded pool, callbacks, pruning)
            └─ runner.ts (spawn child pi, JSONL parse, tee log, abort)
types.ts (dep-free shared types)
```

`runner.ts`/`manager.ts` are pi-free (node builtins only) → fully unit-testable.

## Key decisions

- **Child = real pi, not an embedded agent loop** — satisfies "as robust as pi" and inherits the ecosystem (extensions, auth, models). JSON mode gives structured usage + final message; `--no-session` keeps children in-memory.
- **Callback, not return, is the async primitive** — the tool returns an id; a host notification message resumes the orchestrator (triggerTurn when idle, steer when busy). `wait:true` and `task_output block:true` are the explicit-blocking escape hatches.
- **Escalating kill** — detached spawn; `task_stop` SIGTERMs the child pid, SIGKILL after 5s; aborting the parent turn propagates to waited tasks.
- **Persistence via session entries** (not a side DB) — tasks belong to the session that started them; branch-aware restore; terminal records pruned past 200.

## Ideas / next steps

- [ ] `pi install` from the registry (npm publish) so `pi install pi-task` works; needs `files`/exports polish.
- [ ] Nested-task hygiene: child pi sessions also load this extension (when globally installed) — consider a `PI_TASK_NESTED=0` guard or a "no task tool" profile for leaves.
- [ ] Parallel batch in one call (`task` with `prompts: [...]`) + `wait_all` for fan-out/fan-in.
- [ ] Stream task output into a live per-task TUI pane (component) — currently footer count + expandable result.
- [ ] Budget guardrails: max tokens/cost per task → auto-cancel.
- [ ] Reuse `getTasksDir`-style env overrides for the transcript dir.
- [ ] Windows: process-group kill semantics + `pi.exe` resolution.
