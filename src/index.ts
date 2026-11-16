/**
 * pi-task - durable background tasks for pi.
 *
 * Installs a task manager + runner:
 *   - `task`        start a task (a full child pi agent) in the background
 *   - `task_output` inspect/wait for a task's output
 *   - `task_stop`   cancel a task
 *   - `/tasks`      human view of all tasks
 *
 * When a background task reaches a terminal state, the extension injects a
 * message into the main agent session (triggerTurn when idle), so the main
 * thread resumes as an orchestrator. Task state is persisted in session
 * custom entries and survives restarts (crashed runs are recovered as
 * orphaned with a pointer to the transcript log).
 */

import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { TaskManager, generateTaskId } from "./manager.ts";
import { createPiHost, TASK_ENTRY_CUSTOM_TYPE, formatDuration, formatUsage } from "./host.ts";
import {
	isTerminalStatus,
	type RunTaskRequest,
	type TaskOutput,
	type TaskRecord,
} from "./types.ts";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatReadLineRange } from "@earendil-works/pi-coding-agent";

const MAX_CONCURRENT_TASKS = 4;
const WAIT_TIMEOUT_CAP_MS = 300_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 16_000;

const ThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
	description: "Thinking level for the task agent. Default: inherit the current session level.",
});

// =============================================================================
// Tool schemas
// =============================================================================

const TaskParams = Type.Object({
	prompt: Type.String({ description: "The full task brief for the background agent: what to do, constraints, and what to report back." }),
	description: Type.Optional(Type.String({ description: "Short label for the task, e.g. 'Refactor auth module'." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the task. Default: the current session directory." })),
	model: Type.Optional(Type.String({ description: "Model override, 'provider/model'. Default: inherit the current session model." })),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: "Whitelist of tools for the task agent, e.g. ['read','grep','bash']. Default: all default tools." }),
	),
	wait: Type.Optional(
		Type.Boolean({
			description:
				"Block this call until the task finishes (no completion callback). Default: false — the task runs in the background and you are notified when it completes.",
		}),
	),
});
type TaskToolInput = Type.Static<typeof TaskParams>;

const TaskOutputParams = Type.Object({
	task_id: Type.Optional(Type.String({ description: "Task id (from the task tool). Omit to list all tasks." })),
	block: Type.Optional(
		Type.Boolean({ description: "Wait up to timeout_ms for the task to finish. Default: false (return current state)." }),
	),
	timeout_ms: Type.Optional(
		Type.Integer({ description: `Max wait in ms when block is true (default ${DEFAULT_WAIT_TIMEOUT_MS}, max ${WAIT_TIMEOUT_CAP_MS}).` }),
	),
	max_chars: Type.Optional(Type.Integer({ description: "Max characters of output to return (default 8000).", minimum: 200, maximum: OUTPUT_CAP })),
});
type TaskOutputToolInput = Type.Static<typeof TaskOutputParams>;

const TaskStopParams = Type.Object({
	task_id: Type.String({ description: "Id of the task to stop." }),
});
type TaskStopToolInput = Type.Static<typeof TaskStopParams>;

// =============================================================================
// Rendering
// =============================================================================

function statusIcon(status: TaskRecord["status"], fg: (c: any, t: string) => string): string {
	switch (status) {
		case "queued":
			return fg("muted", "◌ queued");
		case "running":
			return fg("warning", "⏳ running");
		case "completed":
			return fg("success", "✓ completed");
		case "failed":
			return fg("error", "✗ failed");
		case "cancelled":
			return fg("warning", "⊘ cancelled");
		case "orphaned":
			return fg("warning", "⚠ orphaned");
	}
}

function taskRecordText(record: TaskRecord, fg: (c: any, t: string) => string): string {
	const label = record.description ? ` ${record.description}` : "";
	const duration = record.startedAt && record.finishedAt ? ` ${formatDuration(record.finishedAt - record.startedAt)}` : "";
	const usage = formatUsage(record.usage);
	let text = `${statusIcon(record.status, fg)} ${fg("accent", record.id)}${fg("dim", label)}${fg("muted", duration)}`;
	if (usage) text += fg("dim", ` ${usage}`);
	if (record.errorMessage) text += `\n  ${fg("error", record.errorMessage)}`;
	else if (record.activity) text += `\n  ${fg("muted", record.activity)}`;
	return text;
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	const tasksDir = path.join(getAgentDir(), "tasks");
	let alive = false;
	let lastCtx: ExtensionContext | undefined;

	const host = createPiHost(pi, {
		isAlive: () => alive,
		onNotify: (record) => refreshStatus(),
	});

	const manager = new TaskManager({
		maxConcurrent: MAX_CONCURRENT_TASKS,
		host,
		tasksDir,
	});

	// ------------------------------------------------------------------ status

	function refreshStatus() {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return;
		const running = manager.list().filter((r) => r.status === "running");
		const queued = manager.list().filter((r) => r.status === "queued");
		if (running.length === 0 && queued.length === 0) {
			ctx.ui.setStatus("pi-task", undefined);
			return;
		}
		const parts: string[] = [];
		if (running.length) parts.push(`⏳ ${running.length} task${running.length === 1 ? "" : "s"} running`);
		if (queued.length) parts.push(`◌ ${queued.length} queued`);
		ctx.ui.setStatus("pi-task", parts.join(" · "));
	}

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		alive = true;
		lastCtx = ctx;
		try {
			// Rebuild the registry from persisted task entries on this branch.
			const snapshots: TaskRecord[] = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === TASK_ENTRY_CUSTOM_TYPE) {
					const data = entry.data as TaskRecord | undefined;
					if (data && typeof data.id === "string") snapshots.push(data);
				}
			}
			if (snapshots.length) manager.restore(snapshots);
		} finally {
			refreshStatus();
		}
	});

	pi.on("session_shutdown", async () => {
		alive = false;
		manager.shutdown();
		lastCtx?.ui.setStatus("pi-task", undefined);
		lastCtx = undefined;
	});

	pi.on("agent_settled", async () => refreshStatus());

	// -------------------------------------------------------------------- task

	const inheritedModel = (ctx: ExtensionContext): string | undefined =>
		ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Run a task as a background pi agent (full tools, isolated context).",
			"Returns immediately with a task id; you are notified automatically when it finishes, so continue with other work.",
			"Use wait:true to block until completion instead (no callback).",
			"Use task_output to inspect progress and task_stop to cancel.",
		].join(" "),
		promptSnippet: "Start long-running work as a background task; you will be notified when it completes",
		promptGuidelines: [
			"Use task for long-running or independent work (implementation, research, refactors, tests). The call returns immediately with a task id; a completion message arrives automatically, so do not busy-poll.",
			"After starting background tasks, continue with other useful work or answer the user; when the completion message arrives, process its output and continue the plan.",
			"Use task_output with block:true only when you genuinely cannot proceed without a specific task's result.",
			"Give each task prompt enough context to run autonomously: the task agent cannot ask the user questions.",
		],
		parameters: TaskParams,

		async execute(_toolCallId, params: TaskToolInput, signal, _onUpdate, ctx) {
			const request: RunTaskRequest = {
				prompt: params.prompt,
				description: params.description,
				cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
				model: params.model ?? inheritedModel(ctx),
				thinkingLevel: params.thinkingLevel as string | undefined,
				tools: params.tools,
				wait: params.wait ?? false,
			};

			const record = manager.run(request);

			if (!request.wait) {
				return {
					content: [
						{
							type: "text",
							text: [
								`Task ${record.id} started in the background.`,
								"Continue with other work; you will be notified when it completes.",
								`Use task_output { task_id: "${record.id}" } to check progress, task_stop to cancel.`,
							].join("\n"),
						},
					],
					details: { ...record },
				};
			}

			// Waited: block until the task settles (or the turn is aborted).
			const onAbort = () => manager.stop(record.id);
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const settled = await manager.waitForCompletion(record.id);
				const output = truncateHead(settled.finalOutput ?? "", {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				}).content;
				if (settled.status === "completed") {
					return {
						content: [{ type: "text", text: output || "(task finished with no output)" }],
						details: { ...settled },
					};
				}
				const reason =
					settled.status === "cancelled"
						? `Task ${settled.id} was cancelled${signal?.aborted ? " (current turn aborted)" : ""}.`
						: `Task ${settled.id} ${settled.status}${settled.errorMessage ? `: ${settled.errorMessage}` : ""}.`;
				return {
					content: [{ type: "text", text: `${reason}\nTranscript: ${settled.logFile}` }],
					details: { ...settled },
					isError: settled.status !== "cancelled",
				};
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},

		renderCall(args: TaskToolInput, theme, _context) {
			const preview = (args.description || args.prompt || "").replace(/\s+/g, " ").slice(0, 70);
			const text =
				theme.fg("toolTitle", theme.bold("task ")) +
				theme.fg("accent", preview || "...") +
				(args.wait ? theme.fg("warning", " [wait]") : theme.fg("muted", " [background]"));
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const record = result.details as TaskRecord | undefined;
			if (!record) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			if (isPartial && !isTerminalStatus(record.status)) {
				return new Text(taskRecordText(record, theme.fg.bind(theme)), 0, 0);
			}
			if (!expanded) return new Text(taskRecordText(record, theme.fg.bind(theme)), 0, 0);
			const container = new Container();
			container.addChild(new Text(taskRecordText(record, theme.fg.bind(theme)), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Prompt ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", record.prompt.slice(0, 4000)), 0, 0));
			if (record.finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
				container.addChild(new Markdown(record.finalOutput.slice(0, 20_000), 0, 0, getMarkdownTheme()));
			}
			container.addChild(new Text(theme.fg("dim", `Transcript: ${record.logFile}`), 0, 0));
			return container;
		},
	});

	// --------------------------------------------------------------- task_output

	pi.registerTool({
		name: "task_output",
		label: "Task Output",
		description:
			"Inspect a background task: current status, output so far, usage. With block:true, wait for completion. Without task_id, lists all tasks.",
		parameters: TaskOutputParams,

		async execute(_toolCallId, params: TaskOutputToolInput, signal, onUpdate, _ctx) {
			if (!params.task_id) {
				const tasks = manager.list();
				if (tasks.length === 0) {
					return {
						content: [{ type: "text", text: "No tasks." }],
						details: { tasks: [] as TaskRecord[] },
					};
				}
				const lines = tasks.map((t) => taskRecordText(t, () => "" as string));
				return {
					content: [
						{
							type: "text",
							text: [
								`${tasks.length} task(s):`,
								...lines,
								"Use task_output with task_id for details; completion messages arrive automatically.",
							].join("\n"),
						},
					],
					details: { tasks },
				};
			}

			const maxChars = params.max_chars ?? 8_000;
			const timeout = Math.min(params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS, WAIT_TIMEOUT_CAP_MS);

			let record = manager.get(params.task_id) ?? ({} as TaskRecord);
			if (!record.id) {
				return {
					content: [{ type: "text", text: `Unknown task: ${params.task_id}. List tasks with task_output (no id).` }],
					isError: true,
					details: { tasks: [] as TaskRecord[] },
				};
			}

			if (params.block && !isTerminalStatus(record.status)) {
				onUpdate?.({ content: [{ type: "text", text: `Waiting for task ${record.id}...` }], details: { ...record } });
				const onAbort = () => manager.stop(record.id);
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					record = await manager.waitForCompletion(record.id, timeout);
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			}

			const output = manager.output(record.id, maxChars) as TaskOutput | undefined;
			if (!output) {
				return {
					content: [{ type: "text", text: `Unknown task: ${params.task_id}` }],
					isError: true,
					details: { tasks: [] as TaskRecord[] },
				};
			}

			const lines: string[] = [
				`${output.id} [${output.status}]${output.description ? ` ${output.description}` : ""}`,
			];
			if (output.status === "running" && params.block) {
				lines.push(`(still running after ${Math.round(timeout / 1000)}s; it will notify on completion)`);
			}
			if (output.activity) lines.push(`last activity: ${output.activity}`);
			if (output.errorMessage) lines.push(`error: ${output.errorMessage}`);
			if (output.stderrTail) lines.push(`stderr: ${output.stderrTail.slice(-2_000)}`);
			const usage = formatUsage(output.usage);
			if (usage) lines.push(usage);
			lines.push(`output: ${output.output || "(none yet)"}`);
			lines.push(`transcript: ${output.logFile}`);
			if (output.status === "running") {
				lines.push("task still running — a completion message will arrive automatically; no need to poll.");
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { ...output },
			};
		},

		renderCall(args: TaskOutputToolInput, theme) {
			const text = theme.fg("toolTitle", theme.bold("task_output ")) + (args.task_id ? theme.fg("accent", args.task_id) : theme.fg("muted", "(list)")) + (args.block ? theme.fg("warning", " [block]") : "");
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const text = result.content[0];
			let rendered = text?.type === "text" ? text.text : "(no output)";
			if (isPartial) rendered = rendered.split("\n").slice(0, 6).join("\n");
			return new Text(theme.fg("toolOutput", rendered), 0, 0);
		},
	});

	// ----------------------------------------------------------------- task_stop

	pi.registerTool({
		name: "task_stop",
		label: "Task Stop",
		description: "Stop a running or queued background task (SIGTERM to its agent process).",
		parameters: TaskStopParams,

		async execute(_toolCallId, params: TaskStopToolInput) {
			const record = manager.stop(params.task_id);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown task: ${params.task_id}` }],
					isError: true,
					details: { task: undefined as TaskRecord | undefined },
				};
			}
			if (isTerminalStatus(record.status) && record.status !== "cancelled") {
				return {
					content: [{ type: "text", text: `Task ${record.id} is already ${record.status}.` }],
					details: { task: record },
				};
			}
			return {
				content: [{ type: "text", text: `Task ${record.id} stopped (status: ${record.status}). A completion notification will follow.` }],
				details: { task: record },
			};
		},

		renderCall(args: TaskStopToolInput, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_stop ")) + theme.fg("accent", args.task_id), 0, 0);
		},
	});

	// ------------------------------------------------------------------- /tasks

	pi.registerCommand("tasks", {
		description: "List durable background tasks",
		handler: async (_args, ctx) => {
			alive = true;
			lastCtx = ctx;
			const tasks = manager.list();
			if (tasks.length === 0) {
				ctx.ui.notify("No tasks.", "info");
				return;
			}
			const lines = [
				`${tasks.length} task(s):`,
				...tasks.map((t) => taskRecordText(t, ctx.ui.theme.fg.bind(ctx.ui.theme))),
			];
			ctx.ui.notify(lines.join("\n").slice(0, 1000), "info");
			refreshStatus();
		},
	});
}
