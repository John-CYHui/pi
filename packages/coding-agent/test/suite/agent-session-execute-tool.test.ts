import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../test-harness.ts";
import { createHarnessWithExtensions } from "../test-harness.ts";

describe("AgentSession.executeTool", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("uses extension tool context and hooks, emits lifecycle events, and persists a non-context audit entry", async () => {
		const order: string[] = [];
		let extensionSignal: AbortSignal | undefined;
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event, ctx) => {
						order.push(`call:${"value" in event.input ? event.input.value : undefined}`);
						extensionSignal = ctx.signal;
						return undefined;
					});
					pi.on("tool_result", async (event) => {
						order.push(`result:${event.isError}`);
						return { content: [{ type: "text", text: "filtered" }] };
					});
					pi.registerTool({
						name: "programmatic_double",
						label: "Programmatic Double",
						description: "Doubles a number",
						parameters: Type.Object({ value: Type.Number() }),
						execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
							order.push(`execute:${params.value}`);
							expect(ctx.signal).toBe(signal);
							onUpdate?.({
								content: [{ type: "text", text: "working" }],
								details: { value: params.value },
							});
							return {
								content: [{ type: "text", text: String(params.value * 2) }],
								details: { value: params.value * 2 },
							};
						},
					});
				},
			],
		});
		const beforeMessages = harness.session.messages;
		const beforeEntries = harness.sessionManager.getEntries();

		const executed = await harness.session.executeTool("programmatic_double", { value: 4 });

		expect(executed.isError).toBe(false);
		expect(executed.result.content).toEqual([{ type: "text", text: "filtered" }]);
		expect(executed.result.details).toEqual({ value: 8 });
		expect(extensionSignal).toBeInstanceOf(AbortSignal);
		expect(order).toEqual(["call:4", "execute:4", "result:false"]);
		expect(harness.events.map((event) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
		expect(harness.session.messages).toEqual(beforeMessages);
		const appendedEntries = harness.sessionManager.getEntries().slice(beforeEntries.length);
		expect(appendedEntries).toHaveLength(1);
		expect(appendedEntries[0]).toMatchObject({
			type: "custom",
			customType: "pi.programmatic_tool_execution",
			data: {
				toolCallId: executed.toolCallId,
				toolName: "programmatic_double",
				isError: false,
			},
		});
		expect(JSON.stringify(appendedEntries[0])).not.toContain("filtered");
		expect(JSON.stringify(appendedEntries[0])).not.toContain('"value"');
		expect(harness.session.isIdle).toBe(true);
	});

	it("rejects conflicting session mutations while a programmatic tool owns the agent", async () => {
		let releaseTool = () => {};
		let signalStarted = () => {};
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "blocking_programmatic_tool",
						label: "Blocking Programmatic Tool",
						description: "Blocks until released",
						parameters: Type.Object({}),
						execute: async () => {
							signalStarted();
							await release;
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					});
				},
			],
		});
		const execution = harness.session.executeTool("blocking_programmatic_tool", {});
		await started;

		await expect(harness.session.prompt("must reject")).rejects.toThrow("programmatic tool is running");
		await expect(
			harness.session.sendCustomMessage({
				customType: "blocked",
				content: "must reject",
				display: false,
			}),
		).rejects.toThrow("programmatic tool is running");
		await expect(harness.session.steer("must reject")).rejects.toThrow("programmatic tool is running");
		await expect(harness.session.followUp("must reject")).rejects.toThrow("programmatic tool is running");
		await expect(harness.session.navigateTree("missing")).rejects.toThrow("programmatic tool is running");
		expect(() =>
			harness?.session.recordBashResult("echo bypass", {
				output: "must reject",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			}),
		).toThrow("programmatic tool is running");
		expect(harness.session.isIdle).toBe(false);

		releaseTool();
		await execution;
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.messages).toEqual([]);
	});

	it("rejects tool admission while asynchronous prompt preflight owns the session", async () => {
		let signalInputStarted = () => {};
		let releaseInput = () => {};
		const inputStarted = new Promise<void>((resolve) => {
			signalInputStarted = resolve;
		});
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						signalInputStarted();
						await inputRelease;
						return { action: "continue" };
					});
					pi.registerTool({
						name: "preflight_race_tool",
						label: "Preflight Race Tool",
						description: "Must not overlap prompt preflight",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "unexpected" }], details: {} }),
					});
				},
			],
		});
		const prompt = harness.session.prompt("start prompt preflight");
		await inputStarted;

		await expect(harness.session.executeTool("preflight_race_tool", {})).rejects.toThrow(
			"Session is already processing",
		);

		releaseInput();
		await prompt;
	});

	it("returns a completed tool result when best-effort audit persistence fails", async () => {
		let executions = 0;
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "completed_effect",
						label: "Completed Effect",
						description: "Completes before audit persistence",
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							return { content: [{ type: "text", text: "complete" }], details: {} };
						},
					});
				},
			],
		});
		Object.defineProperty(harness.sessionManager, "appendCustomEntry", {
			configurable: true,
			value: () => {
				throw new Error("audit storage failed");
			},
		});

		const result = await harness.session.executeTool("completed_effect", {});

		expect(executions).toBe(1);
		expect(result.isError).toBe(false);
		expect(result.result.content).toEqual([{ type: "text", text: "complete" }]);
	});

	it("rejects calls after disposal and lets an in-flight aborted tool emit its terminal event", async () => {
		let signalStarted = () => {};
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "abort_on_dispose",
						label: "Abort On Dispose",
						description: "Waits for its execution signal",
						parameters: Type.Object({}),
						execute: async (_toolCallId, _params, signal) => {
							signalStarted();
							await new Promise<void>((_resolve, reject) => {
								if (signal?.aborted) {
									reject(new Error("aborted by disposal"));
									return;
								}
								signal?.addEventListener("abort", () => reject(new Error("aborted by disposal")), {
									once: true,
								});
							});
							return { content: [], details: {} };
						},
					});
				},
			],
		});
		const entriesBefore = harness.sessionManager.getEntries().length;
		const execution = harness.session.executeTool("abort_on_dispose", {});
		await started;

		harness.session.dispose();
		const result = await execution;

		expect(result.isError).toBe(true);
		expect(harness.events.map((event) => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		await expect(harness.session.executeTool("abort_on_dispose", {})).rejects.toThrow("Session is disposed");
	});

	it("honors active-tool filtering", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "disabled_programmatic_tool",
						label: "Disabled Programmatic Tool",
						description: "Must not execute while inactive",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "unexpected" }], details: {} }),
					});
				},
			],
		});
		harness.session.setActiveToolsByName([]);

		const result = await harness.session.executeTool("disabled_programmatic_tool", {});

		expect(result.isError).toBe(true);
		expect(result.result.content).toEqual([{ type: "text", text: "Tool disabled_programmatic_tool not found" }]);
	});
});
