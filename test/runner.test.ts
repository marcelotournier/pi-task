import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { runTask, buildChildArgs, type RunnerProgress, type RunnerRequest } from "../src/runner.ts";
import {
	assistantMessage,
	toolCallMessage,
	toolResultMessage,
	createFakePi,
	makeTempDir,
	delay,
	type FakeEvent,
} from "./helpers.ts";

function makeRequest(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
	const dir = makeTempDir("pi-task-runner-");
	return {
		prompt: "do the thing",
		cwd: dir,
		logFile: `${dir}/log.jsonl`,
		signal: new AbortController().signal,
		...overrides,
	};
}

function withFakePi(bin: string, fn: () => Promise<void>): Promise<void> {
	process.env.PI_TASK_PI_BIN = bin;
	return fn().finally(() => delete process.env.PI_TASK_PI_BIN);
}

test("resolves with captured messages, usage, and final output (async completion)", async () => {
	const { dir, bin } = createFakePi({
		delayMs: 15,
		events: [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_end", message: { role: "user", content: "do the thing", timestamp: 1 } },
			{ type: "message_end", message: toolCallMessage("bash", { command: "ls" }) },
			{ type: "message_end", message: toolResultMessage("bash", "file.txt") },
			{ type: "message_end", message: assistantMessage("I did the thing") },
			{ type: "agent_settled" },
		],
	});

	await withFakePi(bin, async () => {
		const updates: RunnerProgress[] = [];
		const result = await runTask(
			makeRequest({
				logFile: `${dir}/task.jsonl`,
				onUpdate: (p) => updates.push(p),
			}),
		);

		assert.equal(result.ok, true);
		assert.equal(result.exitCode, 0);
		assert.equal(result.aborted, false);
		assert.equal(result.finalOutput, "I did the thing");
		assert.equal(result.usage.turns, 2); // two assistant messages
		assert.equal(result.usage.input, 20);
		assert.equal(result.usage.cost, 0.002);
		assert.equal(result.modelUsed, "test/model");

		// Async streaming: updates arrive progressively, output grows over time.
		assert.ok(updates.length >= 2, `expected progressive updates, got ${updates.length}`);
		const finals = updates.map((u) => u.finalOutput);
		assert.ok(!finals[0].includes("I did the thing"), "first update should predate the final answer");
		assert.equal(finals[finals.length - 1], "I did the thing");
	});
});

test("tees the raw JSONL stream to the log file", async () => {
	const { dir, bin } = createFakePi({
		delayMs: 5,
		events: [{ type: "message_end", message: assistantMessage("hello") }, { type: "agent_settled" }],
		noise: "not json\n",
	});

	await withFakePi(bin, async () => {
		const logFile = `${dir}/task.jsonl`;
		await runTask(makeRequest({ logFile }));

		const raw = fs.readFileSync(logFile, "utf8");
		assert.ok(raw.includes('"role":"assistant"'), "log should contain the assistant event");
		assert.ok(raw.includes("not json"), "log should tee even non-JSON lines");
		const lines = raw.split("\n").filter(Boolean);
		assert.equal(lines.length, 3); // 2 JSON events + noise line
	});
});

test("reports failure on nonzero exit with stderr", async () => {
	const { dir, bin } = createFakePi({
		delayMs: 5,
		exitCode: 1,
		stderr: "boom: something broke\n",
		events: [{ type: "message_end", message: assistantMessage("partial", { stopReason: "error", errorMessage: "provider exploded" }) }],
	});

	await withFakePi(bin, async () => {
		const result = await runTask(makeRequest({ logFile: `${dir}/t.jsonl` }));
		assert.equal(result.ok, false);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderrTail, /boom: something broke/);
		assert.equal(result.providerErrorMessage, "provider exploded");
		assert.equal(result.stopReason, "error");
		assert.equal(result.finalOutput, "partial");
	});
});

test("stopReason error without nonzero exit is a failure", async () => {
	const { bin } = createFakePi({
		delayMs: 5,
		exitCode: 0,
		events: [{ type: "message_end", message: assistantMessage("nope", { stopReason: "error", errorMessage: "quota" }) }],
	});
	await withFakePi(bin, async () => {
		const dir = makeTempDir("pi-task-runner-");
		const result = await runTask(makeRequest({ logFile: `${dir}/t.jsonl` }));
		assert.equal(result.ok, false);
		assert.equal(result.exitCode, 0);
	});
});

test("abort kills the child (SIGTERM) and resolves promptly", async () => {
	const { bin } = createFakePi({ delayMs: 500, events: [] as FakeEvent[] }); // never settles on its own

	await withFakePi(bin, async () => {
		const dir = makeTempDir("pi-task-runner-");
		const controller = new AbortController();
		const started = Date.now();
		const resultPromise = runTask(makeRequest({ logFile: `${dir}/t.jsonl`, signal: controller.signal }));
		await delay(80); // let the child start and emit its scripted events
		controller.abort();

		const result = await resultPromise;
		const elapsed = Date.now() - started;
		assert.equal(result.aborted, true);
		assert.equal(result.ok, false);
		assert.ok(result.exitSignal === "SIGTERM" || result.exitCode !== 0, `killed child, got ${result.exitCode}/${result.exitSignal}`);
		assert.ok(elapsed < 3000, `abort should resolve quickly, took ${elapsed}ms`);
	});
});

test("abort escalates to SIGKILL when SIGTERM is ignored", async () => {
	const { bin } = createFakePi({
		delayMs: 500,
		ignoreSigtermMs: 5000,
		events: [{ type: "message_end", message: { role: "user", content: "x", timestamp: 0 } }],
	});
	await withFakePi(bin, async () => {
		const dir = makeTempDir("pi-task-runner-");
		const controller = new AbortController();
		let sawFirstEvent = false;
		const promise = runTask(
			makeRequest({
				logFile: `${dir}/t.jsonl`,
				signal: controller.signal,
				escalationMs: 200,
				onUpdate: () => {
					// The scripted agent_start only flows after the script's startup
					// (and SIGTERM handler registration) has completed.
					sawFirstEvent = true;
				},
			}),
		);
		while (!sawFirstEvent) await delay(5);
		controller.abort();
		const result = await promise;
		assert.equal(result.aborted, true);
		assert.equal(result.exitSignal, "SIGKILL");
	});
});

test("spawn failure resolves with spawnError", async () => {
	const dir = makeTempDir("pi-task-runner-");
	process.env.PI_TASK_PI_BIN = "/nonexistent/fake-pi-binary";
	try {
		const result = await runTask(makeRequest({ logFile: `${dir}/t.jsonl` }));
		assert.equal(result.ok, false);
		assert.ok(result.spawnError, "expected a spawn error");
	} finally {
		delete process.env.PI_TASK_PI_BIN;
	}
});

test("buildChildArgs includes model, thinking, tools, and prompt", () => {
	const args = buildChildArgs({
		model: "anthropic/claude-x",
		thinkingLevel: "low",
		tools: ["read", "bash"],
		prompt: "Task: refactor auth",
	});
	assert.deepEqual(args, [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"anthropic/claude-x",
		"--thinking",
		"low",
		"--tools",
		"read,bash",
		"Task: refactor auth",
	]);
});

test("child receives the configured argv", async () => {
	const dir = makeTempDir("pi-task-runner-");
	const argsFile = `${dir}/args.json`;
	const { bin } = createFakePi({
		events: [],
		recordArgsTo: argsFile,
	});
	await withFakePi(bin, async () => {
		await runTask(
			makeRequest({
				logFile: `${dir}/t.jsonl`,
				model: "openai/gpt-x",
				tools: ["ls"],
				prompt: "the prompt",
			}),
		);
		const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
		assert.deepEqual(args, ["--mode", "json", "-p", "--no-session", "--model", "openai/gpt-x", "--tools", "ls", "the prompt"]);
	});
});

test("two tasks run concurrently as independent processes", async () => {
	const { bin } = createFakePi({ delayMs: 100, events: [{ type: "message_end", message: assistantMessage("done") }] });
	await withFakePi(bin, async () => {
		const dir = makeTempDir("pi-task-runner-");
		const startedAt: number[] = [];
		const run = (name: string) =>
			runTask({
				prompt: name,
				cwd: dir,
				logFile: `${dir}/${name}.jsonl`,
				signal: new AbortController().signal,
				onUpdate: () => startedAt.push(Date.now()),
			});
		const [a, b] = await Promise.all([run("a"), run("b")]);
		assert.equal(a.ok, true);
		assert.equal(b.ok, true);
		assert.equal(a.finalOutput, "done");
		assert.equal(b.finalOutput, "done");
	});
});
