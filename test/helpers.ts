/**
 * Test helpers: a fake `pi` binary that emits a scripted JSON event stream.
 *
 * The shim is a real node script so the runner's subprocess handling (spawn,
 * stdout parsing, kill, exit codes) is exercised for real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FakePiBehavior {
	/** ms to wait before emitting each scripted event. */
	delayMs?: number;
	/** Events emitted in order. */
	events?: FakeEvent[];
	/** Exit code after the script finishes (default 0). */
	exitCode?: number;
	/** If set, ignore SIGTERM for this many ms (to test escalation). */
	ignoreSigtermMs?: number;
	/** Write raw non-JSON noise to stdout. */
	noise?: string;
	/** Text written to stderr. */
	stderr?: string;
	/** If set, the shim exits (via process.exit) before emitting events. */
	crash?: boolean;
	/** If set, write the received argv to this file for assertions. */
	recordArgsTo?: string;
}

export type FakeEvent =
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "message_end"; message: any }
	| { type: "agent_settled"; aborted?: boolean }
	| Record<string, any>;

export function assistantMessage(
	text: string,
	extra: Partial<any> = {},
): FakeEvent["message"] & any {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { total: 0.001 },
			totalTokens: 15,
		},
		model: "test/model",
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

export function toolCallMessage(toolName: string, args: any, extra: Partial<any> = {}): any {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${Math.random().toString(36).slice(2, 8)}`, name: toolName, arguments: args }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 }, totalTokens: 15 },
		model: "test/model",
		stopReason: "toolUse",
		timestamp: Date.now(),
		...extra,
	};
}

export function toolResultMessage(toolName: string, text: string, isError = false): any {
	return {
		role: "toolResult",
		toolCallId: "call_x",
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

/** Create a temp dir with a fake pi script implementing `behavior`. Returns { dir, bin }. */
export function createFakePi(behavior: FakePiBehavior = {}): { dir: string; bin: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-test-"));
	const { delayMs = 20, events = [], exitCode = 0, ignoreSigtermMs, noise, stderr, crash, recordArgsTo } = behavior;

	const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
${recordArgsTo ? `require("node:fs").writeFileSync(${JSON.stringify(recordArgsTo)}, JSON.stringify(args));` : ""}
${crash ? `process.exit(${exitCode ?? 3});` : ""}
${ignoreSigtermMs ? `
let termIgnored = false;
process.on("SIGTERM", () => {
  if (termIgnored) process.exit(143);
  termIgnored = true;
  setTimeout(() => process.exit(143), ${ignoreSigtermMs});
});` : ""}
const events = ${JSON.stringify(events)};
const delay = ${delayMs};
${noise ? `process.stdout.write(${JSON.stringify(noise)});` : ""}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ""}
let i = 0;
function next() {
  if (i >= events.length) {
    process.exit(${exitCode});
    return;
  }
  process.stdout.write(JSON.stringify(events[i]) + "\\n");
  i++;
  setTimeout(next, delay);
}
next();
`;

	const bin = path.join(dir, "fake-pi");
	fs.writeFileSync(bin, script, { mode: 0o755 });
	return { dir, bin };
}

/** Create a scratch working directory for a test run. */
export function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
