import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession system prompt snapshot", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reads live resources and active tools without dispatching events or changing session state", async () => {
		let customPrompt = "First base prompt";
		let contextFiles = [{ path: "/virtual/AGENTS.md", content: "First rule" }];
		let append = ["First append"];
		const skill = {
			name: "review",
			description: "Review code",
			filePath: "/virtual/review/SKILL.md",
			baseDir: "/virtual/review",
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo("/virtual/review/SKILL.md", { source: "test" }),
		};
		let handlerCalls = 0;
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("before_agent_start", (event) => {
					handlerCalls++;
					return { systemPrompt: `${event.systemPrompt}\nExtension suffix` };
				});
			},
		]);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getSystemPrompt: () => customPrompt,
			getAgentsFiles: () => ({ agentsFiles: contextFiles }),
			getAppendSystemPrompt: () => append,
			getSkills: () => ({ skills: [skill], diagnostics: [] }),
		};
		const harness = await createHarness({
			resourceLoader,
			customTools: [
				{
					name: "preview_tool",
					label: "Preview tool",
					description: "Example tool",
					promptSnippet: "Inspect preview inputs",
					promptGuidelines: ["Use preview_tool for previews."],
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: "ok" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		const originalPrompt = harness.session.systemPrompt;
		const originalTools = harness.session.getActiveToolNames();
		const originalMessages = harness.session.messages.slice();
		const originalEntries = harness.sessionManager.getEntries();
		const originalEvents = harness.events.slice();

		customPrompt = "Second base prompt";
		contextFiles = [{ path: "/virtual/AGENTS.md", content: "Second rule" }];
		append = ["Second append"];
		harness.session.setActiveToolsByName(["read", "preview_tool"]);
		const activePrompt = harness.session.systemPrompt;
		// Resource changes after the active prompt is built must be observed on demand.
		customPrompt = "Third base prompt";
		contextFiles = [{ path: "/virtual/AGENTS.md", content: "Third rule" }];
		append = ["Third append"];
		const snapshot = harness.session.getSystemPromptSnapshot();
		expect(snapshot.options).toMatchObject({
			customPrompt: "Third base prompt",
			appendSystemPrompt: "Third append",
			selectedTools: ["read", "preview_tool"],
			toolSnippets: { preview_tool: "Inspect preview inputs" },
			promptGuidelines: ["Use read to examine files instead of cat or sed.", "Use preview_tool for previews."],
			contextFiles: [{ path: "/virtual/AGENTS.md", content: "Third rule" }],
			skills: [{ name: "review", filePath: "/virtual/review/SKILL.md" }],
			cwd: harness.tempDir,
		});
		expect(snapshot.systemPrompt).toBe(buildSystemPrompt(snapshot.options));
		expect(snapshot.systemPrompt).toContain("Third rule");
		expect(snapshot.systemPrompt).not.toBe(activePrompt);
		expect(harness.session.systemPrompt).toBe(activePrompt);
		expect(harness.session.messages).toEqual(originalMessages);
		expect(harness.sessionManager.getEntries()).toEqual(originalEntries);
		expect(harness.events).toEqual(originalEvents);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(handlerCalls).toBe(0);

		snapshot.options.contextFiles![0]!.content = "Edited by caller";
		snapshot.options.selectedTools!.push("nonexistent");
		snapshot.options.promptGuidelines!.push("Edited by caller");
		snapshot.options.toolSnippets!.preview_tool = "Edited by caller";
		snapshot.options.skills![0]!.sourceInfo.path = "Edited by caller";
		expect(skill.sourceInfo.path).toBe("/virtual/review/SKILL.md");
		expect(harness.session.getSystemPromptSnapshot().options.contextFiles![0]!.content).toBe("Third rule");
		expect(harness.session.getSystemPromptSnapshot().options.selectedTools).toEqual(["read", "preview_tool"]);
		expect(harness.session.getSystemPromptSnapshot().systemPrompt).not.toContain("Edited by caller");

		// A later turn still uses Pi's normal base and extension handler path.
		const baseForTurn = harness.session.getSystemPromptSnapshot().systemPrompt;
		harness.setResponses([
			(context) => {
				expect(context.systemPrompt).toBe(`${baseForTurn}\nExtension suffix`);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("next");
		expect(handlerCalls).toBe(1);
		expect(harness.session.systemPrompt).not.toContain("Edited by caller");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "preview_tool"]);
		expect(originalPrompt).not.toBe(baseForTurn);
		expect(originalTools).not.toEqual(harness.session.getActiveToolNames());
	});
});
