// `@heretek-ai/es-cli` public surface: `es` command functions plus the
// `.worktreeinclude` secret syncer. Importing this module never runs the CLI
// (execution happens only through `bin.ts`'s `isMain()` entrypoint guard).

export type { ParsedArgs } from "./bin.ts";
export {
	APPROVABLE_STAGES,
	APPROVALS_DIR,
	cmdApprove,
	cmdAuditResearch,
	cmdGateMutation,
	cmdInit,
	cmdKeySeal,
	cmdStatus,
	DEFAULT_WORKTREE_INCLUDE,
	FACTORY_DIR,
	FRONTIER_FILE,
	main,
	parseArgs,
	STOP_FILE,
	USAGE,
} from "./bin.ts";
export * from "./worktree-include.ts";
