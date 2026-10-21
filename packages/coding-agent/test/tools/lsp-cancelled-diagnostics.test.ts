import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { Diagnostic, LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { LspToolDetails } from "@oh-my-pi/pi-tui/tools/lsp";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const realImmediate = globalThis.setImmediate;
const CLEAN = "pub fn value() -> u32 { 1 }\n";
const BROKEN = 'pub fn value() -> u32 { "wrong" }\n';
const MISMATCH: Diagnostic = {
	message: "mismatched types: expected `u32`, found `&str`",
	code: "E0308",
	severity: 1,
	source: "rust-analyzer",
	range: { start: { line: 0, character: 24 }, end: { line: 0, character: 31 } },
};

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: {
		textDocument?: { uri: string; text?: string };
		token?: string;
		value?: { kind: string };
		uri?: string;
		diagnostics?: Diagnostic[];
	};
	result?: unknown;
	error?: { code: number; message: string; data?: { retriggerRequest: boolean } };
}

class DiagnosticClock {
	now = 1_000_000;
	#sleepers = 0;

	install(): void {
		vi.useFakeTimers();
		vi.spyOn(Date, "now").mockImplementation(() => this.now);
		vi.spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
			this.#sleepers++;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(() => {
				this.#sleepers--;
				resolve();
			}, ms);
			return promise;
		}) as typeof Bun.sleep);
	}

	async drive<T>(operation: Promise<T>, caller: AbortController, budgetMs: number): Promise<T> {
		const deadline = this.now + budgetMs;
		let done = false;
		const settled = operation.finally(() => {
			done = true;
		});
		const pump = async () => {
			while (!done) {
				// Drain filesystem I/O and framed RPC before advancing virtual analysis time.
				const { promise, resolve } = Promise.withResolvers<void>();
				realImmediate(resolve);
				await promise;
				if (done) return;
				if (this.#sleepers > 0 || caller.signal.aborted) {
					this.now += 25;
					vi.advanceTimersByTime(25);
					if (this.now >= deadline) caller.abort(new ToolAbortError());
				}
			}
		};
		const pumping = pump();
		try {
			return await Promise.race([settled, pumping.then(() => settled)]);
		} finally {
			done = true;
			caller.abort();
			await pumping;
		}
	}
}

/** Framed JSON-RPC peer using the real client's in-memory subprocess transport. */
class CancellingRustServer {
	cancellationsRemaining = 0;
	cancellationData: { retriggerRequest: boolean } | undefined;
	publishOnCancellation: Diagnostic[] | undefined;
	cancelledPulls = 0;
	#documents = new Map<string, string>();

	install(): void {
		const encoder = new TextEncoder();
		let controller: ReadableStreamDefaultController<Uint8Array>;
		let exitCode: number | null = null;
		const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
		const stdout = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const send = (message: RpcMessage) => {
			if (exitCode !== null) return;
			const content = JSON.stringify(message);
			controller.enqueue(encoder.encode(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`));
		};
		const exit = () => {
			if (exitCode !== null) return;
			exitCode = 0;
			controller.close();
			resolveExited(0);
		};
		const handle = (message: RpcMessage) => {
			if (message.method === "initialize") {
				send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { diagnosticProvider: true } } });
				for (const kind of ["begin", "end"]) {
					send({ jsonrpc: "2.0", method: "$/progress", params: { token: "workspace", value: { kind } } });
				}
			} else if (message.method === "rust-analyzer/analyzerStatus") {
				send({ jsonrpc: "2.0", id: message.id, result: "Workspace loaded: 1 crate" });
			} else if (message.method === "textDocument/didOpen") {
				this.#documents.set(message.params!.textDocument!.uri, message.params!.textDocument!.text!);
			} else if (message.method === "textDocument/diagnostic") {
				if (this.cancellationsRemaining > 0) {
					this.cancellationsRemaining--;
					this.cancelledPulls++;
					send({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32802, message: "server cancelled the request", data: this.cancellationData },
					});
					const diagnostics = this.publishOnCancellation;
					if (diagnostics) {
						setTimeout(
							() =>
								send({
									jsonrpc: "2.0",
									method: "textDocument/publishDiagnostics",
									params: { uri: message.params!.textDocument!.uri, diagnostics },
								}),
							250,
						);
					}
					return;
				}
				const content = this.#documents.get(message.params!.textDocument!.uri) ?? "";
				setTimeout(() => {
					send({
						jsonrpc: "2.0",
						id: message.id,
						result: { kind: "full", items: content.includes('"wrong"') ? [MISMATCH] : [] },
					});
				}, 75);
			} else if (message.method === "shutdown") {
				send({ jsonrpc: "2.0", id: message.id, result: null });
			} else if (message.method === "exit") {
				exit();
			}
		};
		let bytes = Buffer.alloc(0);
		let chain = Promise.resolve();
		const feed = (raw: string | Uint8Array) => {
			bytes = Buffer.concat([bytes, typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw)]);
			chain = chain.then(() => {
				while (true) {
					const headerEnd = bytes.indexOf("\r\n\r\n");
					if (headerEnd < 0) return;
					const length = /Content-Length: (\d+)/i.exec(bytes.toString("utf-8", 0, headerEnd))!;
					const start = headerEnd + 4;
					const end = start + Number(length[1]);
					if (bytes.length < end) return;
					const message = JSON.parse(bytes.toString("utf-8", start, end)) as RpcMessage;
					bytes = bytes.subarray(end);
					handle(message);
				}
			});
		};
		const proc = {
			exited,
			get exitCode() {
				return exitCode;
			},
			stdin: {
				write(chunk: string | Uint8Array) {
					feed(chunk);
					return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.byteLength;
				},
				flush: async () => 0,
				end: async () => 0,
			},
			stdout,
			peekStderr: () => "",
			kill: exit,
		} as unknown as LspClient["proc"];
		const spawn = (() => proc) as unknown as typeof ptree.spawn;
		vi.spyOn(ptree, "spawn").mockImplementation(spawn);
	}
}

function textResult(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

describe("Server-cancelled document diagnostics", () => {
	let tempDir: TempDir;
	let clock: DiagnosticClock;
	let server: CancellingRustServer;
	let tool: LspTool;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-lsp-cancelled-diagnostics-");
		await initTheme();
		await Bun.write(
			path.join(tempDir.path(), "Cargo.toml"),
			'[package]\nname = "cancelled_diagnostics"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		await Bun.write(path.join(tempDir.path(), "src", "lib.rs"), CLEAN);
		const config: ServerConfig = {
			command: "rust-analyzer",
			fileTypes: ["rs"],
			rootMarkers: ["Cargo.toml"],
			workspaceReadyTimings: { settleMs: 0 },
		};
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "rust-analyzer": config },
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", config]]);
		clock = new DiagnosticClock();
		clock.install();
		server = new CancellingRustServer();
		server.install();
		tool = new LspTool({
			cwd: tempDir.path(),
			settings: Settings.isolated({ "lsp.requestTimeout": 5 }),
		} as ToolSession);
	});

	afterEach(async () => {
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		vi.useRealTimers();
		tempDir.removeSync();
	});

	async function diagnostics(callerBudgetMs = 6_000) {
		const caller = new AbortController();
		return clock.drive(
			tool.execute("cancelled-diagnostics", { action: "diagnostics", file: "src/lib.rs" }, caller.signal),
			caller,
			callerBudgetMs,
		);
	}

	it("returns E0308 after the server cancels the first document pull", async () => {
		server.cancellationsRemaining = 1;
		await Bun.write(path.join(tempDir.path(), "src", "lib.rs"), BROKEN);
		const result = await diagnostics();
		expect(result.details?.success).toBe(true);
		expect(textResult(result)).toContain("E0308");
	});

	it("honors caller cancellation while the server repeatedly cancels document pulls", async () => {
		server.cancellationsRemaining = Infinity;
		const started = clock.now;
		await expect(diagnostics(300)).rejects.toBeInstanceOf(ToolAbortError);
		expect(server.cancelledPulls).toBeGreaterThan(1);
		expect(clock.now - started).toBeLessThanOrEqual(500);
	});

	it("keeps repeated server cancellations within the original diagnostics deadline", async () => {
		server.cancellationsRemaining = Infinity;
		const started = clock.now;
		const result = await diagnostics();
		expect(result.details?.success).toBe(false);
		expect(server.cancelledPulls).toBeGreaterThan(1);
		expect(clock.now - started).toBeLessThanOrEqual(5_250);
	});

	it("preserves a later published E0308 when retriggerRequest is false", async () => {
		server.cancellationsRemaining = 1;
		server.cancellationData = { retriggerRequest: false };
		server.publishOnCancellation = [MISMATCH];
		const result = await diagnostics();
		expect(result.details?.success).toBe(true);
		expect(textResult(result)).toContain("E0308");
	});
});
