/**
 * Verify public session APIs with explicit agent directories and distinct flat overrides.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { getDefaultSessionDir, SessionManager } from "../../src/index.ts";

const roots: string[] = [];

/** Remove test directories and restore the process environment after each layout check. */
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Write a persisted session so it is eligible for discovery by both list APIs. */
function createPersistedSession(cwd: string, sessionDir: string): string {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return manager.getSessionFile()!;
}

describe("explicit Pi session layouts", () => {
	it("shares Pi's encoded cwd layout without changing the global agent directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-explicit-layout-"));
		roots.push(root);
		const globalAgentDir = join(root, "global-agent");
		const agentDir = join(root, "prepared-agent");
		const projectA = join(root, "project a");
		const projectB = join(root, "nested", "project-b");
		vi.stubEnv(ENV_AGENT_DIR, globalAgentDir);

		const dirA = getDefaultSessionDir(projectA, agentDir);
		const dirB = getDefaultSessionDir(projectB, agentDir);
		expect(dirA).toBe(join(agentDir, "sessions", `--${projectA.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`));
		expect(dirB).not.toBe(dirA);
		const pathA = createPersistedSession(projectA, dirA);
		const pathB = createPersistedSession(projectB, dirB);

		expect((await SessionManager.list(projectA, dirA)).map((session) => session.path)).toEqual([pathA]);
		expect(SessionManager.continueRecent(projectB, dirB).getSessionFile()).toBe(pathB);
		expect(new Set((await SessionManager.listAllInAgentDir(agentDir)).map((session) => session.path))).toEqual(
			new Set([pathA, pathB]),
		);
		const reopened = SessionManager.open(pathA);
		expect(reopened.getSessionDir()).toBe(dirA);
		expect(reopened.getCwd()).toBe(projectA);
		expect(reopened.getSessionFile()).toBe(pathA);
		expect(process.env[ENV_AGENT_DIR]).toBe(globalAgentDir);
		expect(existsSync(join(globalAgentDir, "sessions"))).toBe(false);
	});

	it("keeps an explicit flat override distinct from per-project enumeration", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-flat-layout-"));
		roots.push(root);
		const agentDir = join(root, "prepared-agent");
		const flatDir = join(root, "flat-sessions");
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		const pathA = createPersistedSession(projectA, flatDir);
		const pathB = createPersistedSession(projectB, flatDir);

		expect((await SessionManager.list(projectA, flatDir)).map((session) => session.path)).toEqual([pathA]);
		expect(SessionManager.continueRecent(projectB, flatDir).getSessionFile()).toBe(pathB);
		expect(new Set((await SessionManager.listAll(flatDir)).map((session) => session.path))).toEqual(
			new Set([pathA, pathB]),
		);
		expect(await SessionManager.listAllInAgentDir(agentDir)).toEqual([]);
		expect(existsSync(join(agentDir, "sessions"))).toBe(false);
	});
});
