#!/usr/bin/env node
// MCP stdio JSON-RPC 2.0 server (no external SDK — node builtins only).
//
// Transport: newline-delimited JSON-RPC over stdio (one message per line on
// stdin, one response line per request on stdout). Methods served:
// `initialize`, `ping`, `tools/list`, `tools/call`. Notifications (messages
// without an `id`) get no response. Tools exposed: `cache_source`,
// `verify_quote`, `locate_quote`, `audit_markdown`.
//
// Directories resolve per call: explicit `cacheDir`/`stateDir` arguments win,
// then `EPISTEMIC_CACHE_DIR` / `EPISTEMIC_STATE_DIR`, then `./.epistemic-cache`
// and `./.epistemic-state` under the server's working directory.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditResearchMarkdown } from "./auditor.ts";
import { putCachedSource } from "./cache.ts";
import { locateQuote, verifyQuote } from "./quote.ts";

export const SERVER_NAME = "epistemic-verifier";
export const SERVER_VERSION = "3.0.0";
export const PROTOCOL_VERSION = "2024-11-05";

export interface ToolDef {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

export const TOOLS: readonly ToolDef[] = [
	{
		name: "cache_source",
		description:
			"Store a research source under its sha256 with an engine-key HMAC seal. Returns { sha256, seal, metaPath, contentPath }.",
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Where the source was fetched from.",
				},
				title: { type: "string", description: "Human-readable source title." },
				content: {
					type: "string",
					description: "Exact source text future quotes verify against.",
				},
				fetchedAt: {
					type: "string",
					description: "ISO timestamp; defaults to now.",
				},
				cacheDir: { type: "string", description: "Cache dir override." },
				stateDir: {
					type: "string",
					description: "State dir holding engine.key (override).",
				},
			},
			required: ["url", "title", "content"],
			additionalProperties: false,
		},
	},
	{
		name: "verify_quote",
		description:
			"Check a prose quote against a source verbatim after NFKC + typography-folded normalisation. Ellipsis (... or …) splits the quote into fragments that must each be >= 12 chars and appear in strict sequential order.",
		inputSchema: {
			type: "object",
			properties: {
				source: { type: "string", description: "Full source text." },
				quote: {
					type: "string",
					description: "Claimed verbatim quote (may use ... / … ellipses).",
				},
			},
			required: ["source", "quote"],
			additionalProperties: false,
		},
	},
	{
		name: "locate_quote",
		description:
			"Map a verified quote's ellipsis fragments back to exact [start, end] character offsets in the original source. Returns null when the quote does not verify.",
		inputSchema: {
			type: "object",
			properties: {
				source: { type: "string", description: "Full source text." },
				quote: {
					type: "string",
					description: "Claimed verbatim quote (may use ... / … ellipses).",
				},
			},
			required: ["source", "quote"],
			additionalProperties: false,
		},
	},
	{
		name: "audit_markdown",
		description:
			'Audit research markdown: every [VERIFIED: sha256:<hash> "quote"] tag must quote its sealed cached source verbatim. Failing lines are pruned into a ## Pruned claims section. [INFERRED]/[HYPOTHESIS]/[NEGATIVE_KNOWLEDGE] pass through.',
		inputSchema: {
			type: "object",
			properties: {
				markdown: {
					type: "string",
					description: "Research markdown to audit.",
				},
				cacheDir: { type: "string", description: "Cache dir override." },
				stateDir: {
					type: "string",
					description: "State dir holding engine.key (override).",
				},
			},
			required: ["markdown"],
			additionalProperties: false,
		},
	},
];

export function resolveCacheDir(args: Record<string, unknown>): string {
	const fromArgs = args.cacheDir;
	if (typeof fromArgs === "string" && fromArgs.length > 0)
		return path.resolve(fromArgs);
	const fromEnv = process.env.EPISTEMIC_CACHE_DIR;
	if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv);
	return path.resolve(".epistemic-cache");
}

export function resolveStateDir(args: Record<string, unknown>): string {
	const fromArgs = args.stateDir;
	if (typeof fromArgs === "string" && fromArgs.length > 0)
		return path.resolve(fromArgs);
	const fromEnv = process.env.EPISTEMIC_STATE_DIR;
	if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv);
	return path.resolve(".epistemic-state");
}

function textResult(value: unknown): Record<string, unknown> {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): Record<string, unknown> {
	return { content: [{ type: "text", text: message }], isError: true };
}

function requireString(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== "string")
		throw new Error(`tool argument "${name}" must be a string`);
	return value;
}

/** Execute one tool call. Pure (no stdio) so it is unit-testable. */
export async function callTool(
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	switch (name) {
		case "cache_source": {
			const url = requireString(args, "url");
			const title = requireString(args, "title");
			const content = requireString(args, "content");
			const fetchedAt =
				args.fetchedAt === undefined
					? undefined
					: requireString(args, "fetchedAt");
			const result = await putCachedSource(
				resolveCacheDir(args),
				resolveStateDir(args),
				{
					url,
					title,
					content,
					...(fetchedAt === undefined ? {} : { fetchedAt }),
				},
			);
			return textResult(result);
		}
		case "verify_quote": {
			const source = requireString(args, "source");
			const quote = requireString(args, "quote");
			return textResult(verifyQuote(source, quote));
		}
		case "locate_quote": {
			const source = requireString(args, "source");
			const quote = requireString(args, "quote");
			return textResult({ ranges: locateQuote(source, quote) ?? null });
		}
		case "audit_markdown": {
			const markdown = requireString(args, "markdown");
			const result = await auditResearchMarkdown(
				markdown,
				resolveCacheDir(args),
				resolveStateDir(args),
			);
			return textResult(result);
		}
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

/** Handle one decoded JSON-RPC message. Returns the response object, or undefined for notifications. */
export async function handleMessage(
	message: unknown,
): Promise<Record<string, unknown> | undefined> {
	if (
		message === null ||
		typeof message !== "object" ||
		Array.isArray(message)
	) {
		return {
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32600,
				message: "Invalid Request: message must be an object",
			},
		};
	}
	const { jsonrpc, id, method, params } = message as JsonRpcMessage;
	const hasId = id !== undefined;
	const fail = (
		code: number,
		msg: string,
		data?: unknown,
	): Record<string, unknown> => ({
		jsonrpc: "2.0",
		...(hasId ? { id: id as unknown } : { id: null }),
		error: { code, message: msg, ...(data === undefined ? {} : { data }) },
	});
	if (jsonrpc !== "2.0") {
		if (!hasId) return undefined;
		return fail(-32600, "Invalid Request: jsonrpc must be 2.0");
	}
	if (typeof method !== "string") {
		if (!hasId) return undefined;
		return fail(-32600, "Invalid Request: method must be a string");
	}
	const args = (params ?? {}) as Record<string, unknown>;

	try {
		switch (method) {
			case "initialize": {
				const result = {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				};
				return hasId
					? { jsonrpc: "2.0", id: id as unknown, result }
					: undefined;
			}
			case "ping":
				return hasId
					? { jsonrpc: "2.0", id: id as unknown, result: {} }
					: undefined;
			case "tools/list":
				return hasId
					? { jsonrpc: "2.0", id: id as unknown, result: { tools: TOOLS } }
					: undefined;
			case "tools/call": {
				if (!hasId) return undefined;
				const toolArgs = args as { name?: unknown; arguments?: unknown };
				if (typeof toolArgs.name !== "string")
					return fail(
						-32602,
						"Invalid params: tools/call needs { name, arguments }",
					);
				const toolArguments =
					toolArgs.arguments === undefined
						? {}
						: toolArgs.arguments !== null &&
								typeof toolArgs.arguments === "object" &&
								!Array.isArray(toolArgs.arguments)
							? (toolArgs.arguments as Record<string, unknown>)
							: undefined;
				if (toolArguments === undefined)
					return fail(-32602, "Invalid params: arguments must be an object");
				if (!TOOLS.some((tool) => tool.name === toolArgs.name))
					return fail(
						-32602,
						`Invalid params: unknown tool ${(toolArgs.name as string).slice(0, 80)}`,
					);
				try {
					const result = await callTool(toolArgs.name, toolArguments);
					return { jsonrpc: "2.0", id: id as unknown, result };
				} catch (error: unknown) {
					const result = errorResult(
						(error as Error)?.message ?? String(error),
					);
					return { jsonrpc: "2.0", id: id as unknown, result };
				}
			}
			default:
				if (!hasId) return undefined; // Unknown notification: ignore.
				return fail(-32601, `Method not found: ${method.slice(0, 80)}`);
		}
	} catch (error: unknown) {
		if (!hasId) return undefined;
		return fail(
			-32603,
			`Internal error: ${(error as Error)?.message ?? error}`,
		);
	}
}

/** Run the stdio server: read newline-delimited JSON-RPC, write responses. Resolves on EOF. */
export async function runMcpServer(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
	input.setEncoding("utf8");
	let buffer = "";
	const pending: Array<Promise<void>> = [];
	const closed = new Promise<void>((resolve) => {
		input.on("end", () => resolve());
		input.on("close", () => resolve());
	});
	input.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length === 0) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				const response = {
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				};
				output.write(`${JSON.stringify(response)}\n`);
				continue;
			}
			pending.push(
				handleMessage(message).then((response) => {
					if (response !== undefined)
						output.write(`${JSON.stringify(response)}\n`);
				}),
			);
			newline = buffer.indexOf("\n");
		}
	});
	await closed;
	await Promise.all(pending);
}

// Executable entrypoint (`bun src/mcp-server.ts` or `node dist/mcp-server.js`):
// stdio JSON-RPC server. `import.meta.main` covers bun; on plain Node.js the
// flag is absent, so compare the resolved `node <script>` argv entry against
// this module's URL (fail-closed: never serve on a bare library import).
function isMain(): boolean {
	const bunMain = (import.meta as ImportMeta & { main?: unknown }).main;
	if (typeof bunMain === "boolean") return bunMain;
	try {
		const entry = process.argv[1];
		if (typeof entry !== "string" || entry.length === 0) return false;
		return realpathSync(entry) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isMain()) {
	await runMcpServer();
}
