import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { parseSessionEntries, SessionManager } from "./session-manager.ts";

/** A proposed destination; reservation callbacks run before any destination content is written. */
export interface ReplacementDestination {
	operation: "fork" | "import";
	sourcePath: string;
	destinationPath: string;
	destinationId: string;
	/** False for a root or lazy fork (or an import already stored at the destination path). */
	willWriteImmediately: boolean;
}

/** Acknowledgement of a reserved replacement; uncertain means teardown or commit may have partially completed. */
export interface ReplacementOutcome extends ReplacementDestination {
	status: "committed" | "aborted" | "uncertain";
}

/** Opt-in host callbacks for coordinating a session replacement with external resources. */
export interface ReplacementHooks {
	/** Return false to cancel before writing or tearing down the source. Must not mutate the destination file. */
	// biome-ignore lint/suspicious/noConfusingVoidType: A reservation callback may omit a return value.
	reserveDestination(destination: ReplacementDestination): boolean | void;
	/** Called only after the outgoing session has been fully torn down. */
	onSourceTeardown?(destination: ReplacementDestination): void;
	/** Called once if reservation was attempted, including if the callback throws. */
	onDestinationSettled?(outcome: ReplacementOutcome): void;
}

/** Internal signal for a reservation veto; not exposed to callers. */
class ReplacementVetoError extends Error {}

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		await this.session.abort();
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		await this.session.sessionManager.close();
		this.session.dispose();
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await this.session.runWithReplacedSessionContext(withSession);
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(
			sessionPath,
			undefined,
			options?.cwdOverride,
			this.session.sessionManager.getStorage(),
		);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir, {
					storage: this.session.sessionManager.getStorage(),
				})
			: SessionManager.inMemory(this.cwd, {
					storage: this.session.sessionManager.getStorage(),
				});
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: {
			position?: "before" | "at";
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			replacementHooks?: ReplacementHooks;
		},
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		const hooks = options?.replacementHooks;
		if (hooks && !this.session.sessionManager.isPersisted()) {
			throw new Error("Replacement hooks require a persisted fork destination");
		}
		let destination: ReplacementDestination | undefined;
		let status: ReplacementOutcome["status"] = "aborted";
		/** Reserve before writing; a veto is handled by the outer replacement boundary. */
		const reserve = (candidate: ReplacementDestination): void => {
			destination = candidate;
			status = "uncertain";
			if (hooks?.reserveDestination(candidate) === false) {
				status = "aborted";
				throw new ReplacementVetoError();
			}
		};
		try {
			if (this.session.sessionManager.isPersisted()) {
				const currentSessionFile = this.session.sessionFile;
				if (!currentSessionFile) {
					throw new Error("Persisted session is missing a session file");
				}
				const sessionDir = this.session.sessionManager.getSessionDir();
				if (!targetLeafId) {
					const sessionManager = SessionManager.create(this.cwd, sessionDir, {
						storage: this.session.sessionManager.getStorage(),
					});
					sessionManager.newSession({ parentSession: currentSessionFile });
					if (hooks) {
						const newSessionFile = sessionManager.getSessionFile();
						if (!newSessionFile) throw new Error("Persisted fork is missing a destination file");
						reserve({
							operation: "fork",
							sourcePath: currentSessionFile,
							destinationPath: newSessionFile,
							destinationId: sessionManager.getSessionId(),
							willWriteImmediately: false,
						});
					}
					await this.teardownCurrent("fork", sessionManager.getSessionFile());
					if (destination) hooks?.onSourceTeardown?.(destination);
					this.apply(
						await this.createRuntime({
							cwd: this.cwd,
							agentDir: this.services.agentDir,
							sessionManager,
							sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
						}),
					);
					await this.finishSessionReplacement(options?.withSession);
					status = "committed";
					return { cancelled: false, selectedText };
				}

				if (!this.session.sessionManager.getStorage().exists(currentSessionFile)) {
					throw new Error(
						"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
					);
				}
				const sessionManager = SessionManager.open(
					currentSessionFile,
					sessionDir,
					undefined,
					this.session.sessionManager.getStorage(),
				);
				const forkedSessionPath = sessionManager.createBranchedSession(
					targetLeafId,
					hooks
						? (candidate) =>
								reserve({
									operation: "fork",
									sourcePath: currentSessionFile,
									destinationPath: candidate.path,
									destinationId: candidate.id,
									willWriteImmediately: candidate.willWriteImmediately,
								})
						: undefined,
				);
				if (!forkedSessionPath) {
					throw new Error("Failed to create forked session");
				}
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				if (destination) hooks?.onSourceTeardown?.(destination);
				this.apply(
					await this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				status = "committed";
				return { cancelled: false, selectedText };
			}

			const sessionManager = this.session.sessionManager;
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			if (!targetLeafId) {
				sessionManager.newSession({ parentSession: previousSessionFile });
			} else {
				sessionManager.createBranchedSession(targetLeafId);
			}
			this.apply(
				await this.createRuntime({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		} catch (error) {
			if (error instanceof ReplacementVetoError) return { cancelled: true };
			throw error;
		} finally {
			if (destination) hooks?.onDestinationSettled?.({ ...destination, status });
		}
	}
	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(
		inputPath: string,
		cwdOverride?: string,
		replacementHooks?: ReplacementHooks,
	): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		let destinationPath = join(sessionDir, basename(resolvedPath));
		const sourceAlreadyStored = resolve(destinationPath) === resolvedPath;
		if (!sourceAlreadyStored) {
			const { name, ext } = parse(destinationPath);
			let suffix = 1;
			while (existsSync(destinationPath)) {
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		let destination: ReplacementDestination | undefined;
		let status: ReplacementOutcome["status"] = "aborted";
		try {
			if (replacementHooks) {
				const header = parseSessionEntries(readFileSync(resolvedPath, "utf8"))[0];
				if (header?.type !== "session" || typeof header.id !== "string") {
					throw new Error(`Cannot import: source session has no header: ${resolvedPath}`);
				}
				destination = {
					operation: "import",
					sourcePath: resolvedPath,
					destinationPath,
					destinationId: header.id,
					willWriteImmediately: !sourceAlreadyStored,
				};
				status = "uncertain";
				if (replacementHooks.reserveDestination(destination) === false) {
					status = "aborted";
					return { cancelled: true };
				}
			}
			status = "uncertain";
			if (!sourceAlreadyStored) {
				copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
			}

			const sessionManager = SessionManager.open(
				destinationPath,
				sessionDir,
				cwdOverride,
				this.session.sessionManager.getStorage(),
			);
			assertSessionCwdExists(sessionManager, this.cwd);
			if (destination && sessionManager.getSessionId() !== destination.destinationId) {
				throw new Error(`Imported session ID changed during copy: ${destinationPath}`);
			}
			await this.teardownCurrent("resume", sessionManager.getSessionFile());
			if (destination) replacementHooks?.onSourceTeardown?.(destination);
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement();
			status = "committed";
			return { cancelled: false };
		} finally {
			if (destination) replacementHooks?.onDestinationSettled?.({ ...destination, status });
		}
	}
	async dispose(): Promise<void> {
		await this.session.abort();
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
		await this.session.sessionManager.close();
		await this.session.sessionManager.closeStorage();
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
