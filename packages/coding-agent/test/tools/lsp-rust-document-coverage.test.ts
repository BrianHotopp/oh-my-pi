import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: {
		textDocument?: { uri: string };
		token?: string;
		value?: { kind: string };
	};
	result?: unknown;
	error?: { code: number; message: string };
}

const WORKSPACE_STATUS = "Workspaces:\nLoaded 1 package across 1 workspace.";
const ATTACHED_STATUS = `${WORKSPACE_STATUS}\nCrates for file: coverage_fixture`;
const UNATTACHED_STATUS = `${WORKSPACE_STATUS}\nDoes not belong to any crate`;

// Replace only the subprocess, retaining the JSON-RPC client and diagnostics collector.
function installRustAnalyzer(unattachedUri: string): void {
	const encoder = new TextEncoder();
	let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutController = controller;
		},
	});
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let pendingBytes = Buffer.alloc(0);
	const send = (message: RpcMessage): void => {
		const body = JSON.stringify(message);
		stdoutController.enqueue(encoder.encode(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
	};
	const exit = (): void => {
		if (exitCode !== null) return;
		exitCode = 0;
		stdoutController.close();
		resolveExited(0);
	};
	const handle = (message: RpcMessage): void => {
		if (message.method === "initialize") {
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { diagnosticProvider: true } } });
			send({
				jsonrpc: "2.0",
				method: "$/progress",
				params: { token: "workspace", value: { kind: "begin" } },
			});
			send({
				jsonrpc: "2.0",
				method: "$/progress",
				params: { token: "workspace", value: { kind: "end" } },
			});
		} else if (message.method === "rust-analyzer/analyzerStatus") {
			const uri = message.params?.textDocument?.uri;
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: uri === undefined ? WORKSPACE_STATUS : uri === unattachedUri ? UNATTACHED_STATUS : ATTACHED_STATUS,
			});
		} else if (message.method === "textDocument/diagnostic") {
			send({ jsonrpc: "2.0", id: message.id, result: { kind: "full", items: [] } });
		} else if (message.method === "shutdown") {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			exit();
		} else if (message.id !== undefined) {
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
		}
	};
	const proc = {
		get exited() {
			return exited;
		},
		get exitCode() {
			return exitCode;
		},
		stdout,
		stdin: {
			write(raw: string | Uint8Array) {
				const chunk = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
				pendingBytes = pendingBytes.length === 0 ? chunk : Buffer.concat([pendingBytes, chunk]);
				while (true) {
					const headerEnd = pendingBytes.indexOf("\r\n\r\n");
					if (headerEnd === -1) break;
					const length = /Content-Length: (\d+)/i.exec(pendingBytes.toString("utf-8", 0, headerEnd));
					if (!length) throw new Error("Missing LSP Content-Length");
					const start = headerEnd + 4;
					const end = start + Number(length[1]);
					if (pendingBytes.length < end) break;
					const message = JSON.parse(pendingBytes.toString("utf-8", start, end)) as RpcMessage;
					pendingBytes = pendingBytes.subarray(end);
					handle(message);
				}
				return chunk.byteLength;
			},
			flush: async () => 0,
			end: async () => 0,
		},
		peekStderr: () => "",
		kill: exit,
	} as unknown as LspClient["proc"];
	const spawn = (() => proc) as unknown as typeof piUtils.ptree.spawn;
	vi.spyOn(piUtils.ptree, "spawn").mockImplementation(spawn);
}

describe("Rust explicit diagnostics document coverage", () => {
	let tempDir: TempDir;
	let workspace: string;
	let attachedFile: string;
	let unattachedFile: string;
	let tool: LspTool;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-lsp-rust-coverage-");
		workspace = path.join(tempDir.path(), "workspace");
		attachedFile = path.join(workspace, "src", "main.rs");
		unattachedFile = path.join(tempDir.path(), "external", "detached.rs");
		await Bun.write(path.join(workspace, "Cargo.toml"), '[package]\nname = "coverage_fixture"\nversion = "0.0.0"\n');
		await Bun.write(attachedFile, "fn main() {}\n");
		await Bun.write(unattachedFile, 'const BAD: u32 = "wrong";\n');
		await initTheme();
		const serverConfig: ServerConfig = {
			command: "rust-analyzer",
			resolvedCommand: process.execPath,
			fileTypes: ["rs"],
			rootMarkers: ["Cargo.toml"],
			workspaceReadyTimings: { settleMs: 0 },
		};
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "rust-analyzer": serverConfig },
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", serverConfig]]);
		tool = new LspTool({ cwd: workspace, settings: Settings.isolated() } as ToolSession);
	});

	afterEach(async () => {
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("reports analysis unavailable for an unattached file despite a usable workspace and full-empty report", async () => {
		installRustAnalyzer(fileToUri(unattachedFile));
		const attached = await tool.execute("attached-before-external", {
			action: "diagnostics",
			file: attachedFile,
			timeout: 5,
		});
		expect(attached.details?.success).toBe(true);

		const result = await tool.execute("unattached-rust", {
			action: "diagnostics",
			file: unattachedFile,
			timeout: 5,
		});

		expect(result.details?.success).toBe(false);
		expect(result.content.some(content => content.type === "text" && /unavailable/i.test(content.text))).toBe(true);
		expect(result.content.some(content => content.type === "text" && /crate/i.test(content.text))).toBe(true);
	});

	it("accepts a full-empty report for an attached crate root", async () => {
		installRustAnalyzer(fileToUri(unattachedFile));
		const result = await tool.execute("attached-clean-rust", {
			action: "diagnostics",
			file: attachedFile,
			timeout: 5,
		});

		expect(result.details?.success).toBe(true);
	});
});
