import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskManager, generateTaskId } from "../src/manager.ts";
import type { RunnerRequest, RunnerResult } from "../src/runner.ts";
import { emptyUsage, type TaskHost, type TaskNotification, type TaskRecord } from "../src/types.ts";
import { makeTempDir, delay } from "./helpers.ts";

/** Fake runner: honors abort, emits one progress update, finishes after durationMs. */
function makeFakeRunner(
	opts: { durationMs?: number; fail?: boolean; errorText?: string; output?: string } = {},
) {
	const requests: RunnerRequest[] = [];
	const runner = async (req: RunnerRequest): Promise<RunnerResult> => {
		requests.push(req);
		const base: RunnerResult = {
			ok: true,
			finalOutput: "",
			usage: emptyUsage(),
			exitCode: null,
			exitSignal: null,
			aborted: false,
			stderrTail: "",
		};
		await delay(20); // simulated startup
		if (req.signal.aborted) return { ...base, aborted: true, exitSignal: "SIGTERM" };
		req.onUpdate?.({
			finalOutput: opts.output ? `partial: ${opts.output}` : "partial",
			activity: "→ bash: ls",
			usage: { ...emptyUsage(), turns: 1 },
		});
		// Run until done or aborted, whichever comes first.
		const done = await new Promise<"done" | "aborted">((resolve) => {
			const onAbort = () => resolve("aborted");
			if (req.signal.aborted) return onAbort();
			req.signal.addEventListener("abort", onAbort, { once: true });
			setTimeout(() => {
				req.signal.removeEventListener("abort", onAbort);
				resolve("done");
			}, opts.durationMs ?? 40);
		});
		if (done === "aborted") return { ...base, aborted: true, exitSignal: "SIGTERM" };
		if (opts.fail) {
			return {
				...base,
				ok: false,
				exitCode: 1,
				finalOutput: opts.output ?? "",
				providerErrorMessage: opts.errorText ?? "boom",
			};
		}
		return {
			...base,
			finalOutput: opts.output ?? "done",
			usage: { ...emptyUsage(), turns: 2, input: 10, output: 5, cost: 0.001 },
		};
	};
	return { runner, requests };
}

/** Fake host capturing notifications and persistence. */
function makeFakeHost(opts: { throwOnNotify?: boolean } = {}) {
	const notifications: TaskNotification[] = [];
	const persisted: TaskRecord[] = [];
	const host: TaskHost = {
		notify: (n) => {
			if (opts.throwOnNotify) throw new Error("host notify exploded");
			notifications.push(n);
		},
		persist: (r) => {
			persisted.push(JSON.parse(JSON.stringify(r)));
		},
	};
	return { host, notifications, persisted };
}

function makeManager(
	overrides: { maxConcurrent?: number; maxRecords?: number; host?: TaskHost; runner?: (req: RunnerRequest) => Promise<RunnerResult> } = {},
) {
	return new TaskManager({
		maxConcurrent: overrides.maxConcurrent ?? 4,
		maxRecords: overrides.maxRecords ?? 100,
		host: overrides.host ?? makeFakeHost().host,
		runner: overrides.runner ?? makeFakeRunner().runner,
		tasksDir: makeTempDir("pi-task-manager-"),
	});
}

test("background task: queued -> running -> completed, exactly one completion callback", async () => {
	const { host, notifications, persisted } = makeFakeHost();
	const { runner } = makeFakeRunner({ durationMs: 50, output: "the result" });
	const manager = makeManager({ host, runner });

	const record = manager.run({ prompt: "do it", description: "The task" });
	assert.equal(record.status, "running"); // only task, slot free

	await manager.waitForCompletion(record.id);

	assert.equal(record.status, "completed");
	assert.equal(record.finalOutput, "the result");
	assert.ok(record.startedAt && record.finishedAt && record.finishedAt >= record.startedAt);
	assert.equal(notifications.length, 1, "exactly one notification");
	assert.equal(notifications[0].kind, "completed");
	assert.equal(notifications[0].record.id, record.id);
	assert.equal(record.notified, true);

	// Persisted on every transition: queued, running, completed.
	const statuses = persisted.map((r) => r.status);
	assert.deepEqual(statuses, ["queued", "running", "completed"]);
});

test("waited task never fires the completion callback", async () => {
	const { host, notifications } = makeFakeHost();
	const { runner } = makeFakeRunner();
	const manager = makeManager({ host, runner });

	const record = manager.run({ prompt: "do it", wait: true });
	await manager.waitForCompletion(record.id);

	assert.equal(record.status, "completed");
	assert.equal(notifications.length, 0, "waited tasks deliver via the tool result, not a callback");
	assert.ok(!record.notified, "no completion callback for waited tasks");
});

test("concurrency cap: at most maxConcurrent run at once, queue drains", async () => {
	const { host } = makeFakeHost();
	const { runner, requests } = makeFakeRunner({ durationMs: 60 });
	let peak = 0;
	const manager = makeManager({ maxConcurrent: 2, host, runner });

	const records = [1, 2, 3, 4, 5].map((i) => manager.run({ prompt: `task ${i}` }));
	records.forEach((r) => manager.waitForCompletion(r.id));

	const observe = async () => {
		const deadline = Date.now() + 10_000;
		while (manager.listActive().length > 0) {
			if (Date.now() > deadline) throw new Error(`tasks still active after 10s: ${JSON.stringify(manager.list().map((r) => [r.id, r.status]))}`);
			const running = manager.runningCount();
			peak = Math.max(peak, running);
			await delay(10);
		}
	};
	await Promise.all([
		observe(),
		Promise.all(records.map((r) => manager.waitForCompletion(r.id))),
	]);

	assert.ok(peak <= 2, `peak concurrent was ${peak}`);
	assert.ok(peak >= 2, `expected the cap to actually be used, peak was ${peak}`);
	assert.equal(requests.length, 5, "all tasks eventually launched");
	assert.equal(manager.list().filter((r) => r.status === "completed").length, 5);
});

test("stop() a running task cancels it and notifies", async () => {
	const { host, notifications } = makeFakeHost();
	const { runner, requests } = makeFakeRunner({ durationMs: 500 });
	const manager = makeManager({ host, runner });

	const record = manager.run({ prompt: "long task" });
	await delay(30); // let it launch
	manager.stop(record.id);
	const settled = await manager.waitForCompletion(record.id);

	assert.equal(settled.status, "cancelled");
	assert.equal(requests[0].signal.aborted, true, "runner must receive the abort");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].record.status, "cancelled");
});

test("stop() a queued task cancels it without launching", async () => {
	const { host, notifications } = makeFakeHost();
	const { runner, requests } = makeFakeRunner({ durationMs: 500 });
	const manager = makeManager({ maxConcurrent: 1, host, runner });

	const first = manager.run({ prompt: "blocks the slot" });
	const second = manager.run({ prompt: "queued" });
	assert.equal(second.status, "queued");

	manager.stop(second.id);
	assert.equal(second.status, "cancelled");
	assert.equal(notifications.length, 1);
	assert.equal(requests.length, 1, "the queued task never launched");
	await manager.waitForCompletion(first.id);
});

test("waitForCompletion with timeout resolves with the still-running record", async () => {
	const { host } = makeFakeHost();
	const { runner } = makeFakeRunner({ durationMs: 500 });
	const manager = makeManager({ host, runner });

	const record = manager.run({ prompt: "slow" });
	const started = Date.now();
	const result = await manager.waitForCompletion(record.id, 50);
	assert.ok(Date.now() - started < 400, "must not wait for the full run");
	assert.equal(result.id, record.id);
	assert.equal(result.status, "running");

	// Later waiters still get the real terminal state.
	const settled = await manager.waitForCompletion(record.id, 2000);
	assert.equal(settled.status, "completed");
});

test("partial output is visible while running", async () => {
	const { host } = makeFakeHost();
	const { runner } = makeFakeRunner({ durationMs: 200, output: "final text" });
	const manager = makeManager({ host, runner });

	const record = manager.run({ prompt: "streamy" });
	await delay(50);
	const partial = manager.output(record.id);
	assert.equal(partial?.status, "running");
	assert.equal(partial?.output, "partial: final text");
	assert.equal(partial?.activity, "→ bash: ls");
	await manager.waitForCompletion(record.id);
	assert.equal(manager.output(record.id)?.output, "final text");
});

test("failed task records the error and notifies", async () => {
	const { host, notifications } = makeFakeHost();
	const { runner } = makeFakeRunner({ fail: true, errorText: "model quota exceeded" });
	const manager = makeManager({ host, runner });

	const record = manager.run({ prompt: "doomed" });
	await manager.waitForCompletion(record.id);

	assert.equal(record.status, "failed");
	assert.match(record.errorMessage ?? "", /quota/);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].record.status, "failed");
});

test("restore: running records become orphaned and re-notify; terminal ones do not", () => {
	const { host, notifications } = makeFakeHost();
	const manager = makeManager({ host, runner: makeFakeRunner().runner });

	const snapshot = (status: TaskRecord["status"], id: string, notified?: boolean): TaskRecord => ({
		id,
		prompt: "p",
		cwd: "/tmp",
		wait: false,
		status,
		createdAt: 1,
		logFile: "/tmp/x.jsonl",
		usage: emptyUsage(),
		notified,
	});

	manager.restore([
		snapshot("completed", "t_done", true),
		snapshot("running", "t_stuck"), // crashed mid-flight last time
		snapshot("queued", "t_queued_stuck"),
	]);

	const stuck = manager.get("t_stuck")!;
	assert.equal(stuck.status, "orphaned");
	assert.match(stuck.errorMessage ?? "", /restarted/);
	const queued = manager.get("t_queued_stuck")!;
	assert.equal(queued.status, "orphaned");
	assert.equal(manager.get("t_done")?.status, "completed");

	const notifiedIds = notifications.map((n) => n.record.id).sort();
	assert.deepEqual(notifiedIds, ["t_queued_stuck", "t_stuck"]);
	assert.ok(notifications.every((n) => n.kind === "orphaned"));
});

test("restore with a live running record keeps the live record", () => {
	const { host, notifications } = makeFakeHost();
	const { runner } = makeFakeRunner({ durationMs: 1000 });
	const manager = makeManager({ host, runner });

	const live = manager.run({ prompt: "live task" });
	assert.equal(live.status, "running");

	// A stale snapshot of the same id must not replace the live record.
	manager.restore([{ ...live, status: "completed", finalOutput: "stale" }]);
	assert.equal(manager.get(live.id)?.status, "running");
	assert.equal(notifications.length, 0);
	manager.stop(live.id);
});

test("shutdown: running tasks are orphaned without notifying, waiters settle", async () => {
	const { host, notifications } = makeFakeHost();
	const { runner } = makeFakeRunner({ durationMs: 1000 });
	const manager = makeManager({ host, runner });

	const record = manager.run({ prompt: "long" });
	const wait = manager.waitForCompletion(record.id, 5000);
	await delay(30);
	manager.shutdown();
	const settled = await wait;
	assert.equal(settled.status, "orphaned");
	assert.equal(notifications.length, 0, "no callbacks once the host is gone");
	assert.throws(() => manager.run({ prompt: "nope" }), /shutting down/);
});

test("a throwing host does not wedge the pipeline", async () => {
	const errors: Error[] = [];
	const { host } = makeFakeHost({ throwOnNotify: true });
	host.onError = (e) => errors.push(e);
	const { runner } = makeFakeRunner();
	const manager = makeManager({ host, runner });

	const a = manager.run({ prompt: "a" });
	const b = manager.run({ prompt: "b" });
	await manager.waitForCompletion(a.id);
	await manager.waitForCompletion(b.id);

	assert.equal(errors.length, 2);
	assert.equal(a.status, "completed");
	assert.equal(b.status, "completed", "pipeline continues after host failure");
	assert.equal(a.notified, false, "not retried after a failed notify (avoids duplicates)");
});

test("registry prunes oldest terminal records past maxRecords", async () => {
	const { host } = makeFakeHost();
	const { runner } = makeFakeRunner({ durationMs: 10 });
	const manager = makeManager({ maxRecords: 3, host, runner });

	const ids = [1, 2, 3, 4, 5].map((i) => manager.run({ prompt: `t${i}` }).id);
	await Promise.all(ids.map((id) => manager.waitForCompletion(id)));
	assert.ok(manager.list().length <= 3, `pruned to ${manager.list().length}`);
});

test("task ids are unique", () => {
	const seen = new Set<string>();
	for (let i = 0; i < 1000; i++) seen.add(generateTaskId(() => 1234)); // same clock tick
	assert.ok(seen.size > 900, `expected unique ids, got ${seen.size}`);
});
