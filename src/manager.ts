/**
 * TaskManager - the durable background task manager.
 *
 * Owns the registry of tasks, their lifecycle (queued -> running -> terminal),
 * a bounded runner pool, completion callbacks into the host (the main pi
 * agent thread), and persistence snapshots.
 *
 * Pure module: no pi imports. The host and runner are injected, which makes
 * the whole async behavior unit-testable with fakes.
 */

import { randomBytes } from "node:crypto";
import {
	isTerminalStatus,
	TERMINAL_STATUSES,
	type RunTaskRequest,
	type TaskHost,
	type TaskNotification,
	type TaskOutput,
	type TaskRecord,
	type TaskStatus,
} from "./types.ts";
import { runTask, type RunnerRequest, type RunnerResult } from "./runner.ts";

export interface TaskManagerOptions {
	/** Max concurrent child pi processes (default 4). */
	maxConcurrent?: number;
	/** Max tasks in the registry before the oldest terminal ones are pruned (default 200). */
	maxRecords?: number;
	/**
	 * Host adapter (pi binding). Called exactly once per background task that
	 * reaches a terminal state. Implementations should deliver a message into
	 * the main agent session (triggerTurn when idle) so orchestration resumes.
	 */
	host: TaskHost;
	/** Directory for per-task log files (default: provided by host? no - required). */
	tasksDir: string;
	/** Injectable for tests. Defaults to the real pi-subprocess runner. */
	runner?: (req: RunnerRequest) => Promise<RunnerResult>;
	/** Injectable clock for tests. */
	now?: () => number;
}

type Waiter = { resolve: (record: TaskRecord) => void; timer?: ReturnType<typeof setTimeout> };

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_RECORDS = 200;
const OUTPUT_DEFAULT_MAX_CHARS = 8_000;

export function generateTaskId(now: () => number = Date.now): string {
	const stamp = Math.floor(now()).toString(36);
	const rand = randomBytes(4).toString("hex").slice(0, 8);
	return `t_${stamp}_${rand}`;
}

export class TaskManager {
	private readonly maxConcurrent: number;
	private readonly maxRecords: number;
	private readonly host: TaskHost;
	private readonly tasksDir: string;
	private readonly runner: (req: RunnerRequest) => Promise<RunnerResult>;
	private readonly now: () => number;
	private readonly records = new Map<string, TaskRecord>();
	/** Live abort controllers, keyed by task id (kept out of the persisted record shape). */
	private readonly abortControllers = new Map<string, AbortController>();
	private readonly queue: string[] = []; // ids waiting for a runner slot
	private readonly waiters = new Map<string, Set<Waiter>>();
	private shuttingDown = false;

	constructor(options: TaskManagerOptions) {
		this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
		this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
		this.host = options.host;
		this.tasksDir = options.tasksDir;
		this.runner = options.runner ?? runTask;
		this.now = options.now ?? Date.now;
	}

	// ---------------------------------------------------------------- lifecycle

	/**
	 * Register a new task. Background tasks (default) return immediately with
	 * a queued/running record; waited tasks run the same way but never fire
	 * the completion callback (the caller receives the result via
	 * waitForCompletion instead).
	 */
	run(request: RunTaskRequest): TaskRecord {
		if (this.shuttingDown) {
			throw new Error("TaskManager is shutting down");
		}
		const id = generateTaskId(this.now);
		const record: TaskRecord = {
			id,
			prompt: request.prompt,
			description: request.description?.trim() || undefined,
			cwd: request.cwd ?? process.cwd(),
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			tools: request.tools,
			wait: request.wait ?? false,
			status: "queued",
			createdAt: this.now(),
			logFile: `${this.tasksDir}/${id}.jsonl`,
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		};
		this.records.set(id, record);
		this.queue.push(id);
		this.pruneIfNeeded();
		this.persist(record);
		this.pump();
		return record;
	}

	/**
	 * Kill running children and mark active tasks cancelled. Called from
	 * session shutdown. Safe to call multiple times.
	 */
	shutdown(): void {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		for (const record of this.records.values()) {
			const controller = this.abortControllers.get(record.id);
			if (record.status === "running") {
				controller?.abort();
			} else if (record.status === "queued") {
				this.finish(record, "cancelled", { finishedAt: this.now() });
			}
		}
		// Running tasks resolve through their runner promises; by the time the
		// host tears down, records still active are marked orphaned below.
		for (const record of this.records.values()) {
			if (!isTerminalStatus(record.status)) {
				this.abortControllers.get(record.id)?.abort();
				this.finish(record, "orphaned", { finishedAt: this.now() });
			}
		}
		this.queue.length = 0;
		this.rejectAllWaiters();
	}

	/**
	 * Rebuild the registry from persisted snapshots (session restore).
	 * Snapshots come in session order; later entries for the same id win.
	 * Records still active at the time of the previous process death become
	 * orphaned and fire their completion callback so the orchestrator can
	 * resume using the log file.
	 */
	restore(snapshots: TaskRecord[]): void {
		const preExisting = new Set(this.records.keys());
		for (const snapshot of snapshots) {
			if (this.records.has(snapshot.id)) continue; // a live record from this process always wins over a stale snapshot
			this.records.set(snapshot.id, { ...snapshot });
		}
		for (const record of this.records.values()) {
			if (preExisting.has(record.id)) continue; // live: still owned by this process
			if (record.status === "queued" || record.status === "running") {
				// The child process cannot have survived the parent restart.
				this.finish(record, "orphaned", {
					finishedAt: record.finishedAt ?? this.now(),
					errorMessage: record.errorMessage ?? "Host session restarted before the task finished; read the transcript log for partial output.",
				});
			}
		}
		this.pruneIfNeeded();
	}

	// ---------------------------------------------------------------- queries

	get(id: string): TaskRecord | undefined {
		return this.records.get(id);
	}

	list(): TaskRecord[] {
		return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	listActive(): TaskRecord[] {
		return this.list().filter((r) => !isTerminalStatus(r.status));
	}

	runningCount(): number {
		return [...this.records.values()].filter((r) => r.status === "running").length;
	}

	queuedCount(): number {
		return this.queue.length;
	}

	/** Snapshot a task's current output (for the task_output tool). */
	output(id: string, maxChars = OUTPUT_DEFAULT_MAX_CHARS): TaskOutput | undefined {
		const record = this.records.get(id);
		if (!record) return undefined;
		const output = (record.finalOutput ?? "").slice(0, maxChars);
		return {
			id: record.id,
			status: record.status,
			description: record.description,
			output,
			activity: record.activity,
			usage: { ...record.usage },
			logFile: record.logFile,
			durationMs: record.finishedAt && record.startedAt ? record.finishedAt - record.startedAt : undefined,
			errorMessage: record.errorMessage,
			stderrTail: record.stderrTail,
		};
	}

	/**
	 * Resolve when the task reaches a terminal state, or immediately with the
	 * current record after timeoutMs (if given). Never rejects.
	 */
	waitForCompletion(id: string, timeoutMs?: number): Promise<TaskRecord> {
		const record = this.records.get(id);
		if (!record) {
			return Promise.resolve({
				id,
				prompt: "",
				cwd: "",
				wait: false,
				status: "failed",
				createdAt: this.now(),
				logFile: "",
				usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				errorMessage: `Unknown task: ${id}`,
			} as TaskRecord);
		}
		if (isTerminalStatus(record.status)) return Promise.resolve(record);
		return new Promise((resolve) => {
			const waiter: Waiter = { resolve };
			if (timeoutMs !== undefined) {
				waiter.timer = setTimeout(() => this.removeWaiter(id, waiter, resolve), timeoutMs);
			}
			let set = this.waiters.get(id);
			if (!set) {
				set = new Set();
				this.waiters.set(id, set);
			}
			set.add(waiter);
		});
	}

	/** Stop a task by id. Returns the (terminal or still-dying) record. */
	stop(id: string): TaskRecord | undefined {
		const record = this.records.get(id);
		if (!record) return undefined;
		if (isTerminalStatus(record.status)) return record;
		if (record.status === "running") {
			this.abortControllers.get(record.id)?.abort();
			// Terminal transition happens when the runner promise settles.
		} else if (record.status === "queued") {
			const index = this.queue.indexOf(id);
			if (index !== -1) this.queue.splice(index, 1);
			this.finish(record, "cancelled", { finishedAt: this.now() });
		}
		return record;
	}

	// ---------------------------------------------------------------- internals

	private pump(): void {
		if (this.shuttingDown) return;
		let running = this.runningCount();
		while (running < this.maxConcurrent && this.queue.length > 0) {
			const id = this.queue.shift()!;
			const record = this.records.get(id);
			if (!record || record.status !== "queued") continue;
			this.launch(record);
			running = this.runningCount();
		}
	}

	private launch(record: TaskRecord): void {
		record.status = "running";
		record.startedAt = this.now();
		this.persist(record);

		const controller = new AbortController();
		this.abortControllers.set(record.id, controller);

		const req: RunnerRequest = {
			prompt: record.prompt,
			cwd: record.cwd,
			model: record.model,
			thinkingLevel: record.thinkingLevel,
			tools: record.tools,
			logFile: record.logFile,
			signal: controller.signal,
			onUpdate: (progress) => {
				if (record.status !== "running") return;
				record.finalOutput = progress.finalOutput;
				record.activity = progress.activity;
				record.usage = { ...progress.usage };
			},
		};

		this.runner(req).then((result) => this.settle(record, result));
		// The runner promise never rejects; settle() always runs.
	}

	private settle(record: TaskRecord, result: RunnerResult): void {
		if (isTerminalStatus(record.status)) return; // e.g. already cancelled/orphaned via shutdown
		record.exitCode = result.exitCode;
		record.exitSignal = result.exitSignal;
		record.finalOutput = result.finalOutput || record.finalOutput;
		record.activity = result.activity ?? record.activity;
		record.usage = result.usage;
		record.modelUsed = result.modelUsed;

		let status: TaskStatus;
		if (result.aborted) {
			status = "cancelled";
		} else if (result.ok) {
			status = "completed";
		} else {
			status = "failed";
		}
		if (status === "failed") {
			record.errorMessage =
				result.spawnError ??
				result.providerErrorMessage ??
				(result.exitSignal ? `Task process terminated by ${result.exitSignal}` : `Task process exited with code ${result.exitCode}`) ??
				"Task failed";
			record.stderrTail = result.stderrTail || undefined;
		}
		this.finish(record, status, { finishedAt: this.now() });
		this.abortControllers.delete(record.id);
		this.pump();
	}

	private finish(record: TaskRecord, status: TaskStatus, extra: Partial<TaskRecord> = {}): void {
		const previous = record.status;
		record.status = status;
		Object.assign(record, extra);
		if (previous !== status) {
			const queueIndex = this.queue.indexOf(record.id);
			if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
		}
		this.persist(record);
		this.resolveWaiters(record);

		if (!record.wait && !record.notified && !this.shuttingDown) {
			record.notified = true;
			const notification: TaskNotification = { record, kind: status === "orphaned" ? "orphaned" : "completed" };
			try {
				this.host.notify(notification);
			} catch (error) {
				// A broken host must not wedge the task pipeline.
				record.notified = false;
				this.host.onError?.(error instanceof Error ? error : new Error(String(error)), record);
			}
		}
		this.pruneIfNeeded();
	}

	private resolveWaiters(record: TaskRecord): void {
		if (!isTerminalStatus(record.status)) return;
		const set = this.waiters.get(record.id);
		if (!set || set.size === 0) return;
		this.waiters.delete(record.id);
		for (const waiter of set) {
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.resolve(record);
		}
	}

	private removeWaiter(id: string, waiter: Waiter, resolve: (r: TaskRecord) => void): void {
		const set = this.waiters.get(id);
		if (set) {
			set.delete(waiter);
			if (set.size === 0) this.waiters.delete(id);
		}
		const record = this.records.get(id);
		resolve(record ?? { id, status: "failed", errorMessage: "Task vanished" } as TaskRecord);
	}

	private rejectAllWaiters(): void {
		for (const [id, set] of this.waiters) {
			const record = this.records.get(id);
			for (const waiter of set) {
				if (waiter.timer) clearTimeout(waiter.timer);
				waiter.resolve(record ?? ({ id, status: "orphaned" } as TaskRecord));
			}
		}
		this.waiters.clear();
	}

	private persist(record: TaskRecord): void {
		try {
			this.host.persist(record);
		} catch {
			// Persistence is best-effort; the live registry stays authoritative.
		}
	}

	private pruneIfNeeded(): void {
		if (this.records.size <= this.maxRecords) return;
		const terminal = [...this.records.values()]
			.filter((r) => isTerminalStatus(r.status))
			.sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
		for (const record of terminal) {
			if (this.records.size <= this.maxRecords) break;
			this.records.delete(record.id);
		}
	}
}

export { TERMINAL_STATUSES };
