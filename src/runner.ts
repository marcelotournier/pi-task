/**
 * TaskRunner - executes one durable task as a child `pi` process.
 *
 * Each task runs a full, independent pi agent instance (its own context
 * window, tools, and credentials) with `--mode json -p --no-session`, so a
 * task is as robust as pi itself. The child's JSON event stream is:
 *   - parsed to track progress (turns, usage, final output, activity)
 *   - teed verbatim to a log file, so the transcript survives even a crash
 *
 * This module only uses node builtins so it can be unit-tested with a fake
 * "pi" binary.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyUsage, type TaskUsage } from "./types.ts";

/** Cap for the in-memory stderr capture. */
const STDERR_CAP = 32 * 1024;
/** Cap for the in-memory final output. */
const FINAL_OUTPUT_CAP = 100 * 1024;
/** SIGTERM -> SIGKILL escalation delay when aborting. */
const KILL_ESCALATION_MS = 5000;

export interface RunnerRequest {
	prompt: string;
	cwd: string;
	/** "provider/model" model override; omit to inherit the parent's model. */
	model?: string;
	thinkingLevel?: string;
	/** Tool whitelist for the child (e.g. ["read", "bash"]). */
	tools?: string[];
	/** Append-only JSONL transcript log path (created by the runner). */
	logFile: string;
	/** Aborting kills the child (SIGTERM, then SIGKILL). */
	signal: AbortSignal;
	/** SIGTERM→SIGKILL escalation window (default 5s; tests shorten it). */
	escalationMs?: number;
	/** Receives incremental progress while the task runs. */
	onUpdate?: (progress: RunnerProgress) => void;
}

export interface RunnerProgress {
	finalOutput: string;
	activity?: string;
	usage: TaskUsage;
}

export interface RunnerResult extends RunnerProgress {
	ok: boolean;
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
	/** True when we aborted the child (our request, not a crash). */
	aborted: boolean;
	spawnError?: string;
	stderrTail: string;
	stopReason?: string;
	providerErrorMessage?: string;
	modelUsed?: string;
}

export interface RunnerInvocation {
	command: string;
	args: string[];
}

/**
 * Resolve how to launch a `pi` instance from the current process.
 *
 * Handles: real pi CLIs (node/bun scripts), bun-compiled binaries (virtual
 * $bunfs paths), and a plain `pi` on PATH. Override with $PI_TASK_PI_BIN.
 */
export function resolvePiInvocation(extraArgs: string[]): RunnerInvocation {
	const override = process.env.PI_TASK_PI_BIN;
	if (override) {
		return { command: override, args: extraArgs };
	}

	const currentScript = process.argv[1];
	// Bun-compiled binaries report an embedded entry like /$bunfs/root/...
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: "pi", args: extraArgs };
	}
	return { command: process.execPath, args: extraArgs };
}

/** Build the CLI args for a child task run. Exported for tests. */
export function buildChildArgs(req: Pick<RunnerRequest, "model" | "thinkingLevel" | "tools" | "prompt">): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (req.model) args.push("--model", req.model);
	if (req.thinkingLevel) args.push("--thinking", req.thinkingLevel);
	if (req.tools && req.tools.length > 0) args.push("--tools", req.tools.join(","));
	args.push(req.prompt);
	return args;
}

interface MutableState {
	usage: TaskUsage;
	finalOutput: string;
	activity?: string;
	stderr: string;
}

function assistantText(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	let text = "";
	for (const part of message.content) {
		if (part?.type === "text" && typeof part.text === "string") text += part.text;
	}
	return text;
}

function toolCallLabel(part: any): string | undefined {
	if (part?.type !== "toolCall") return undefined;
	const name = String(part.name ?? "tool");
	let preview = "";
	try {
		const args = JSON.stringify(part.arguments ?? {});
		preview = args.length > 60 ? `${args.slice(0, 60)}…` : args;
	} catch {
		preview = "";
	}
	return `→ ${name}${preview ? ` ${preview}` : ""}`;
}

/**
 * Run one task to completion. Resolves exactly once, after the child exits,
 * is killed, or fails to spawn. Never rejects.
 */
export function runTask(req: RunnerRequest): Promise<RunnerResult> {
	return new Promise((resolve) => {
		const state: MutableState = { usage: emptyUsage(), finalOutput: "", stderr: "" };
		let settled = false;
		let wasAborted = false;
		let stopReason: string | undefined;
		let providerErrorMessage: string | undefined;
		let modelUsed: string | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let logStream: fs.WriteStream | null = null;
		let buffer = "";

		try {
			fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
			logStream = fs.createWriteStream(req.logFile, { flags: "a" });
		} catch {
			logStream = null; // Logging is best-effort; the task still runs.
		}

		const emitUpdate = () => {
			req.onUpdate?.({
				finalOutput: state.finalOutput,
				activity: state.activity,
				usage: { ...state.usage },
			});
		};

		const handleLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			logStream?.write(line + "\n");
			let event: any;
			try {
				event = JSON.parse(trimmed);
			} catch {
				return; // Non-JSON noise: keep it in the log, ignore it.
			}
			if (event?.type !== "message_end" || !event.message) return;
			const message = event.message;

			if (message.role === "assistant") {
				state.usage.turns += 1;
				const usage = message.usage ?? {};
				state.usage.input += usage.input ?? 0;
				state.usage.output += usage.output ?? 0;
				state.usage.cacheRead += usage.cacheRead ?? 0;
				state.usage.cacheWrite += usage.cacheWrite ?? 0;
				state.usage.cost += usage.cost?.total ?? 0;
				if (typeof usage.totalTokens === "number") state.usage.contextTokens = usage.totalTokens;
				if (typeof message.model === "string" && message.model) modelUsed = message.model;
				stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
				providerErrorMessage =
					typeof message.errorMessage === "string" && message.errorMessage
						? message.errorMessage
						: undefined;

				let sawToolCall = false;
				if (Array.isArray(message.content)) {
					for (const part of message.content) {
						if (part?.type === "toolCall") {
							const label = toolCallLabel(part);
							if (label) {
								state.activity = label;
								sawToolCall = true;
							}
						}
					}
				}
				const text = assistantText(message).trim();
				if (text) {
					state.finalOutput = text.slice(0, FINAL_OUTPUT_CAP);
				} else if (!sawToolCall && !state.activity) {
					state.activity = `turn ${state.usage.turns}`;
				}
			} else if (message.role === "toolResult") {
				// Keep the last tool result name as activity context.
				if (typeof message.toolName === "string" && message.toolName) {
					const isError = message.isError ? " (error)" : "";
					state.activity = `← ${message.toolName}${isError}`;
				}
			}
			emitUpdate();
		};

		const finish = (result: Omit<RunnerResult, "stderrTail">) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			req.signal?.removeEventListener("abort", onAbort);
			try {
				logStream?.end();
			} catch {
				/* ignore */
			}
			resolve({ ...result, stderrTail: state.stderr.slice(-STDERR_CAP) });
		};

		const onAbort = () => {
			wasAborted = true;
			if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
			if (!proc.kill("SIGTERM")) return;
			killTimer = setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}, req.escalationMs ?? KILL_ESCALATION_MS);
		};

		if (req.signal?.aborted) {
			wasAborted = true;
			finish({
				ok: false,
				finalOutput: state.finalOutput,
				activity: state.activity,
				usage: state.usage,
				exitCode: null,
				exitSignal: null,
				aborted: true,
			});
			return;
		}

		const invocation = resolvePiInvocation(buildChildArgs(req));

		let proc: ChildProcess;
		try {
			proc = spawn(invocation.command, invocation.args, {
				cwd: req.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({
				ok: false,
				finalOutput: state.finalOutput,
				activity: state.activity,
				usage: state.usage,
				exitCode: null,
				exitSignal: null,
				aborted: wasAborted,
				spawnError: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		if (req.signal && !req.signal.aborted) {
			req.signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				handleLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
		});
		proc.stderr?.on("data", (data: Buffer) => {
			if (state.stderr.length < STDERR_CAP * 4) state.stderr += data.toString();
		});

		proc.on("error", (error) => {
			finish({
				ok: false,
				finalOutput: state.finalOutput,
				activity: state.activity,
				usage: state.usage,
				exitCode: null,
				exitSignal: null,
				aborted: wasAborted,
				spawnError: error.message,
			});
		});

		proc.on("close", (code, signal) => {
			if (buffer.trim()) handleLine(buffer);
			buffer = "";

			let ok: boolean;
			if (wasAborted) {
				ok = false;
			} else if (code === 0 && stopReason !== "error" && stopReason !== "aborted") {
				ok = true;
			} else {
				ok = false;
			}

			finish({
				ok,
				finalOutput: state.finalOutput,
				activity: state.activity,
				usage: state.usage,
				exitCode: code,
				exitSignal: signal,
				aborted: wasAborted,
				stopReason,
				providerErrorMessage,
				modelUsed,
			});
		});
	});
}
