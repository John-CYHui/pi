import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool, type ToolDefinition } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function tool(name: string, result = name): ToolDefinition {
	return defineTool({
		name,
		label: name,
		description: `Description for ${name}`,
		promptSnippet: `Snippet for ${name}`,
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_id, params) => ({ content: [{ type: "text", text: `${result}:${params.value}` }], details: {} }),
	});
}

describe("AgentSession.replaceCustomToolsScope", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("adds, replaces, and removes definitions through the validated tool lifecycle", async () => {
		const hooks: string[] = [];
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						hooks.push(`call:${event.toolName}`);
					});
					pi.on("tool_result", (event) => {
						hooks.push(`result:${event.toolName}`);
					});
				},
			],
		});
		const session = harness.session;
		session.replaceCustomToolsScope("pwui", [tool("scoped_a")]);
		expect(session.getToolDefinition("scoped_a")?.name).toBe("scoped_a");
		expect(session.getActiveToolNames()).toContain("scoped_a");
		expect(session.systemPrompt).toContain("Snippet for scoped_a");
		const valid = await session.executeTool("scoped_a", { value: "ok" });
		expect(valid.result.content).toEqual([{ type: "text", text: "scoped_a:ok" }]);
		expect(hooks).toEqual(["call:scoped_a", "result:scoped_a"]);

		session.replaceCustomToolsScope("pwui", [tool("scoped_a", "updated"), tool("scoped_b")]);
		expect(session.getActiveToolNames().filter((name) => name === "scoped_a")).toHaveLength(1);
		expect(session.getActiveToolNames()).toContain("scoped_b");
		expect((await session.executeTool("scoped_a", { value: "ok" })).result.content).toEqual([
			{ type: "text", text: "updated:ok" },
		]);
		session.replaceCustomToolsScope("pwui", [tool("scoped_b")]);
		expect(session.getToolDefinition("scoped_a")).toBeUndefined();
		expect(session.getAllTools().some((entry) => entry.name === "scoped_a")).toBe(false);
		expect(session.getActiveToolNames()).not.toContain("scoped_a");
		expect(session.systemPrompt).not.toContain("scoped_a");
		session.replaceCustomToolsScope("pwui", []);
		expect(session.getToolDefinition("scoped_b")).toBeUndefined();
		expect(session.getActiveToolNames()).not.toContain("scoped_b");
		expect(session.systemPrompt).not.toContain("scoped_b");
	});

	it("preserves inactive retained tools and leaves the scope unchanged on collisions", async () => {
		harness = await createHarness({
			extensionFactories: [(pi) => pi.registerTool(tool("extension_owned"))],
			customTools: [tool("initial_sdk_owned")],
			tools: [{ ...tool("prepared_owned"), execute: async () => ({ content: [], details: {} }) }],
		});
		const session = harness.session;
		session.replaceCustomToolsScope("first", [tool("retained"), tool("other")]);
		session.replaceCustomToolsScope("second", [tool("second_owned")]);
		session.setActiveToolsByName(["retained"]);
		for (const conflict of [
			"read",
			"prepared_owned",
			"extension_owned",
			"initial_sdk_owned",
			"second_owned",
			"retained",
		]) {
			if (conflict === "retained") {
				expect(() => session.replaceCustomToolsScope("first", [tool(conflict), tool(conflict)])).toThrow(
					/conflicts/,
				);
			} else {
				expect(() => session.replaceCustomToolsScope("first", [tool("new_one"), tool(conflict)])).toThrow(
					/conflicts/,
				);
			}
			expect(session.getToolDefinition("new_one")).toBeUndefined();
			expect(session.getToolDefinition("other")).toBeDefined();
			expect(session.getActiveToolNames()).toEqual(["retained"]);
		}
		session.replaceCustomToolsScope("first", [tool("retained", "replacement"), tool("other")]);
		expect(session.getActiveToolNames()).toEqual(["retained"]);
	});

	it("keeps retained names inactive under an allowlist and honors filters for new names", async () => {
		harness = await createHarness({ allowedToolNames: ["allowed", "retained"] });
		const session = harness.session;
		session.replaceCustomToolsScope("pwui", [tool("retained")]);
		session.setActiveToolsByName([]);
		session.replaceCustomToolsScope("pwui", [tool("retained", "updated"), tool("allowed"), tool("blocked")]);
		expect(session.getActiveToolNames()).toEqual(["allowed"]);
		expect(session.getToolDefinition("blocked")).toBeUndefined();
		expect(session.getToolDefinition("retained")).toBeDefined();
		expect(session.systemPrompt).not.toContain("Snippet for retained");
	});

	it("rejects replacement during an in-flight model run without changing registered tools", async () => {
		let release = () => {};
		let started = () => {};
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness = await createHarness();
		harness.session.replaceCustomToolsScope("pwui", [tool("before")]);
		harness.setResponses([
			async () => {
				started();
				await barrier;
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = harness.session.prompt("wait");
		await entered;
		expect(() => harness?.session.replaceCustomToolsScope("pwui", [tool("after")])).toThrow(/busy/);
		expect(harness.session.getToolDefinition("before")).toBeDefined();
		release();
		await prompt;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("before", { value: "run" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run");
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(true);
	});

	it("rejects replacement during a standalone tool call and prompt preflight", async () => {
		let startTool = () => {};
		let releaseTool = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			startTool = resolve;
		});
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let startInput = () => {};
		let releaseInput = () => {};
		const inputStarted = new Promise<void>((resolve) => {
			startInput = resolve;
		});
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		harness = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.on("input", async () => {
						startInput();
						await inputRelease;
						return { action: "continue" };
					}),
			],
		});
		const session = harness.session;
		session.replaceCustomToolsScope("pwui", [
			{
				...tool("blocking"),
				execute: async () => {
					startTool();
					await toolRelease;
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			},
		]);
		const execution = session.executeTool("blocking", { value: "ok" });
		await toolStarted;
		expect(() => session.replaceCustomToolsScope("pwui", [])).toThrow(/busy/);
		releaseTool();
		await execution;

		const prompt = session.prompt("wait");
		await inputStarted;
		expect(() => session.replaceCustomToolsScope("pwui", [])).toThrow(/busy/);
		releaseInput();
		await prompt;
		expect(session.getToolDefinition("blocking")).toBeDefined();
	});
});
