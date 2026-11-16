/**
 * End-to-end test against the REAL pi binary.
 *
 * Verifies the full stack: TaskManager -> TaskRunner -> child `pi --mode json`
 * process, including async completion, usage accounting, and the transcript
 * log. Skipped automatically when no pi binary is available (or opt out with
 * PI_TASK_E2E=0).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { test } from "node:test";
import { TaskManager, generateTaskId } from "../src/manager.ts";
import { runTask } from "../src/runner.ts";
import type { RunnerRequest, RunnerResult } from "../src/runner.ts";
import { emptyUsage, type TaskHost, type TaskNotification, type TaskRecord } from "../src/types.ts";
import { makeTempDir, delay } from "./helpers.ts";

function findRealPi(): string | null {
	if (process.env.PI_TASK_PI_BIN) return process.env.PI_TASK_PI_BIN;
	try {
		return execSync("which pi", { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

const realPi = findRealPi();
const skip = !realPi || process.env.PI_TASK_E2E === "0";

const E2E_TIMEOUT_MS = 180_000;

test(
	"e2e: a real pi child process runs a durable task asynchronously to completion",
	{ skip: skip ? "no real pi binary (or PI_TASK_E2E=0)" : false, timeout: E2E_TIMEOUT_MS },
	async () => {
		// Point the runner at the real pi (resolvePiInvocation honors this first).
		const prev = process.env.PI_TASK_PI_BIN;
		process.env.PI_TASK_PI_BIN = realPi!;
		try {
			const notifications: TaskNotification[] = [];
			const host: TaskHost = {
				notify: (n) => notifications.push(n),
				persist: () => {},
			};

			const cwd = makeTempDir("pi-task-e2e-cwd-");
			const manager = new TaskManager({
				maxConcurrent: 2,
				host,
				tasksDir: makeTempDir("pi-task-e2e-"),
				runner: (req: RunnerRequest) => runTask(req),
			});

			const record = manager.run({
				prompt: "Reply with exactly one word: PONG. Do not use any tools.",
				description: "E2E ping",
				cwd,
				wait: false,
			});

			// Async: a freshly started task must not be finished yet
			// (pi startup alone takes well over 300ms).
			await delay(300);
			assert.equal(
				record.status,
				"running",
				`expected still-running at t+300ms, got ${record.status}: ${record.errorMessage}`,
			);

			// Wait for the callback (no polling on our side: also assert via
			// waitForCompletion so both paths agree).
			const settled = await manager.waitForCompletion(record.id, E2E_TIMEOUT_MS);

			assert.equal(settled.status, "completed", `failed: ${settled.errorMessage} | stderr: ${settled.stderrTail}`);
			assert.match(settled.finalOutput ?? "", /PONG/);
			assert.ok(settled.usage.turns > 0, "usage must be reported");
			assert.ok(settled.modelUsed, "model must be reported");
			assert.equal(notifications.length, 1, "exactly one completion callback");
			assert.equal(notifications[0].record.id, record.id);

			// Transcript log was written with the raw pi JSON stream.
			assert.ok(existsSync(record.logFile), "log file must exist");
			const log = readFileSync(record.logFile, "utf8");
			assert.match(log, /"type":\s*"agent_start"/);
			assert.match(log, /PONG/);

			// task_output-style retrieval
			const output = manager.output(record.id, 8000);
			assert.match(output!.output, /PONG/);
		} finally {
			if (prev === undefined) delete process.env.PI_TASK_PI_BIN;
			else process.env.PI_TASK_PI_BIN = prev;
		}
	},
);

test(
	"e2e: a failing real pi child (bad model) is reported as failed, not hung",
	{ skip: skip ? "no real pi binary (or PI_TASK_E2E=0)" : false, timeout: E2E_TIMEOUT_MS },
	async () => {
		const prev = process.env.PI_TASK_PI_BIN;
		process.env.PI_TASK_PI_BIN = realPi!;
		try {
			const host: TaskHost = { notify: () => {}, persist: () => {} };
			const cwd = makeTempDir("pi-task-e2e-fail-");
			const manager = new TaskManager({
				maxConcurrent: 1,
				host,
				tasksDir: makeTempDir("pi-task-e2e-fail-"),
				runner: (req: RunnerRequest) => runTask(req),
			});

			const record = manager.run({
				prompt: "say hi",
				cwd,
				// A model that cannot exist: the child must fail cleanly.
				model: "no-such-provider/no-such-model",
				wait: true,
			});

			const settled = await manager.waitForCompletion(record.id, E2E_TIMEOUT_MS);
			assert.equal(settled.status, "failed");
			assert.ok(settled.errorMessage, "must explain the failure");
			assert.ok(!settled.notified, "waited tasks do not notify");
		} finally {
			if (prev === undefined) delete process.env.PI_TASK_PI_BIN;
			else process.env.PI_TASK_PI_BIN = prev;
		}
	},
);
