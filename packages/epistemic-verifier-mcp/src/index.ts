// Public surface of `@heretek-ai/epistemic-verifier-mcp`.
// MCP server types only (type-only import: importing this module must never
// start the stdio server as a side effect).

export type { AuditFailure, AuditResult } from "./auditor.ts";
export { auditResearchMarkdown } from "./auditor.ts";
export type {
	CachedSource,
	PutCachedSourceInput,
	PutCachedSourceResult,
} from "./cache.ts";
export {
	getCachedSource,
	putCachedSource,
	sha256Hex,
	TamperedSourceError,
} from "./cache.ts";
export type { ToolDef } from "./mcp-server.ts";
export {
	callTool,
	handleMessage,
	PROTOCOL_VERSION,
	resolveCacheDir,
	resolveStateDir,
	runMcpServer,
	SERVER_NAME,
	SERVER_VERSION,
	TOOLS,
} from "./mcp-server.ts";
export type { NormalizedMap, QuoteCheck, QuoteRange } from "./quote.ts";
export {
	locateQuote,
	MIN_QUOTE,
	normalizeForQuote,
	normalizeWithMap,
	verifyQuote,
} from "./quote.ts";
export {
	canonicalJson,
	ENGINE_KEY_FILE,
	engineKeyPath,
	ensureEngineKey,
	readEngineKey,
	sealMeta,
	verifyMetaSeal,
} from "./seal.ts";
