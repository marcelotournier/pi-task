/**
 * Shared types for the pi-task durable background task system.
 *
 * This module must stay dependency-free (no pi imports, no node imports)
 * so it can be used from the extension, the tests, and anything else.
 */

/** Lifecycle of a durable task. */
export type TaskStatus =
	| "queued" // accepted, waiting for a runner slot
	| "running" // child pi process is alive
	| "completed" // child finished successfully
	| "failed" // child errored / nonzero exit / crashed
	| "cancelled" // stopped by request (task_stop, wait-abort, session shutdown)
	| "orphaned"; // was still running when the host session died

/** Terminal statuses. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
	"completed",
	"failed",
	"cancelled",
	"orphaned",
] as const;

export function isTerminalStatus(status: TaskStatus): boolean {
	return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Accumulated usage of the child agent (mirrors pi-ai Usage fields we track). */
export interface TaskUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
}

export function emptyUsage(): TaskUsage {
	return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function isZeroUsage(usage: TaskUsage): boolean {
	return (
		usage.turns === 0 &&
		usage.input === 0 &&
		usage.output === 0 &&
		usage.cacheRead === 0 &&
		usage.cacheWrite === 0 &&
		usage.cost === 0
	);
}

/**
 * A durable task record. This is the single source of truth for a task and is
 * the shape persisted in session custom entries (JSON-serializable by design).
 */
export interface TaskRecord {
	id: string;
	/** The full prompt sent to the child agent. */
	prompt: string;
	/** Short human/LLM-friendly label, e.g. "Refactor auth module". */
	description?: string;
	/** Working directory the child agent runs in. */
	cwd: string;
	/** Model override, "provider/model" (inherits parent model when omitted). */
	model?: string;
	/** Thinking level override for the child agent. */
	thinkingLevel?: string;
	/** Tool whitelist for the child agent (all default tools when omitted). */
	tools?: string[];
	/**
	 * Whether the caller blocked on this task (task { wait: true }).
	 * Waited tasks deliver their result via the tool result and never
	 * trigger a completion callback.
	 */
	wait: boolean;
	status: TaskStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Path of the raw JSONL transcript captured from the child. */
	logFile: string;
	exitCode?: number | null;
	exitSignal?: string | null;
	/** Final assistant text (truncated to a cap). */
	finalOutput?: string;
	/** Latest activity line, e.g. "→ bash: ls -la". */
	activity?: string;
	errorMessage?: string;
	/** Capped stderr tail. */
	stderrTail?: string;
	usage: TaskUsage;
	/** Model the child actually used, when reported. */
	modelUsed?: string;
	/** True once the completion callback has been dispatched. */
	notified?: boolean;
}

/** Statuses that are active (not terminal) and may still change. */
export function isActiveStatus(status: TaskStatus): boolean {
	return status === "queued" || status === "running";
}

/** Request to run a new task (input to TaskManager.run). */
export interface RunTaskRequest {
	prompt: string;
	description?: string;
	/** Defaults to the host session cwd. */
	cwd?: string;
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	/**
	 * Block the caller until the task finishes. Default: false (background:
	 * the caller gets the task id immediately and the host is notified when
	 * the task reaches a terminal state).
	 */
	wait?: boolean;
}

/** A task's output as reported to a reader (task_output tool). */
export interface TaskOutput {
	id: string;
	status: TaskStatus;
	description?: string;
	/** Latest assistant text so far (or final text when terminal). */
	output: string;
	activity?: string;
	usage: TaskUsage;
	logFile: string;
	durationMs?: number;
	errorMessage?: string;
	stderrTail?: string;
}

/** One-shot notification payload handed to the host on completion. */
export interface TaskNotification {
	record: TaskRecord;
	/** Why we are notifying: normal completion, or recovery of a crashed run. */
	kind: "completed" | "orphaned";
}

/**
 * The host the TaskManager is bound to (the main pi agent session, in the
 * real binding). Implemented in host.ts and faked in tests.
 */
export interface TaskHost {
	/**
	 * Called exactly once when a background task reaches a terminal state.
	 * Implementations deliver a message into the main agent session so the
	 * orchestrator can resume (e.g. pi.sendMessage with triggerTurn).
	 */
	notify(notification: TaskNotification): void;
	/** Persist a record snapshot (pi.appendEntry) so tasks survive restarts. */
	persist(record: TaskRecord): void;
	/** Called when the host itself fails while handling a task event. */
	onError?(error: Error, record: TaskRecord): void;
}
