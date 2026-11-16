/**
 * Host binding - connects the TaskManager to a live pi session.
 *
 * This is the callback path that makes orchestration work: when a background
 * task reaches a terminal state, the host injects a custom message into the
 * main agent session via pi.sendMessage() with triggerTurn, so the main
 * agent thread wakes up (if idle) or receives the result mid-run (if busy)
 * and can continue.
 *
 * The `pi` object is used only through the small structural TaskHostApi
 * surface, which keeps this module testable with a fake.
 */

import type { TaskHost, TaskNotification, TaskRecord, TaskUsage } from "./types.ts";

/** The only ExtensionAPI surface this module needs (pi structurally satisfies it). */
export interface TaskHostApi {
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	appendEntry(customType: string, data?: unknown): void;
}

export const TASK_ENTRY_CUSTOM_TYPE = "durable-task";
export const TASK_MESSAGE_CUSTOM_TYPE = "durable-task";

/** Cap for the final output embedded in the completion message. */
const NOTIFICATION_OUTPUT_CAP = 16_000;

export function formatDuration(ms?: number): string {
	if (ms === undefined || ms < 0) return "";
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: TaskUsage): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input || usage.output) parts.push(`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

/**
 * Build the text of the completion notification that is injected into the
 * main agent session. Pure function (exported for tests).
 */
export function buildTaskNotificationContent(notification: TaskNotification): string {
	const { record, kind } = notification;
	const label = record.description ? ` (${record.description})` : "";
	const lines: string[] = [];

	if (kind === "orphaned") {
		lines.push(`⚠ Background task ${record.id}${label} did not finish: the session was restarted while it was ${record.status === "orphaned" ? "running" : "pending"}.`);
	} else {
		const duration =
			record.startedAt && record.finishedAt ? ` in ${formatDuration(record.finishedAt - record.startedAt)}` : "";
		const usage = formatUsage(record.usage);
		const stats = [usage, record.modelUsed ? record.modelUsed : ""].filter(Boolean).join(" · ");
		lines.push(
			`⏫ Background task ${record.id}${label} ${record.status}${duration}${stats ? ` (${stats})` : ""}.`,
		);
	}

	if (record.status === "failed" || record.status === "orphaned") {
		if (record.errorMessage) lines.push(`Error: ${record.errorMessage}`);
		if (record.stderrTail) lines.push(`stderr: ${record.stderrTail.slice(-2_000)}`);
	}
	if (record.finalOutput) {
		lines.push("Output:");
		lines.push(
			record.finalOutput.length > NOTIFICATION_OUTPUT_CAP
				? record.finalOutput.slice(0, NOTIFICATION_OUTPUT_CAP) + "\n[output truncated]"
				: record.finalOutput,
		);
	}
	lines.push(`Full transcript: ${record.logFile} (use the read tool to inspect)`);
	return lines.join("\n");
}

export interface PiTaskHostOptions {
	/** When false (session torn down), notifications are dropped. */
	isAlive?: () => boolean;
	/** Non-blocking UI feedback hook (e.g. footer status). */
	onNotify?: (record: TaskRecord) => void;
}

/** Create the pi-backed TaskHost. */
export function createPiHost(api: TaskHostApi, options: PiTaskHostOptions = {}): TaskHost {
	const isAlive = options.isAlive ?? (() => true);
	return {
		notify(notification) {
			if (!isAlive()) return;
			api.sendMessage(
				{
					customType: TASK_MESSAGE_CUSTOM_TYPE,
					content: buildTaskNotificationContent(notification),
					display: true,
					details: { ...notification.record, kind: notification.kind },
				},
				// steer: delivered before the next LLM call when the agent is
				// busy; triggerTurn: starts a run when the agent is idle — so
				// the orchestrator resumes exactly when a task completes.
				{ deliverAs: "steer", triggerTurn: true },
			);
			options.onNotify?.(notification.record);
		},
		persist(record) {
			if (!isAlive()) return;
			api.appendEntry(TASK_ENTRY_CUSTOM_TYPE, { ...record });
		},
		onError(error, record) {
			options.onNotify?.(record);
			console.error(`[pi-task] failed to notify about task ${record.id}: ${error.message}`);
		},
	};
}
