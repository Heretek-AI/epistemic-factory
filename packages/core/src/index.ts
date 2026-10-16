// `@heretek-ai/es-core`: gated-build factory state machine, Ed25519 human
// approvals, RED-first test lock, mutation gate, and sandboxed gate runner.
export * from "./approval/ed25519.ts";
export * from "./factory/frontier.ts";
export * from "./factory/machine.ts";
export * from "./factory/runner.ts";
export * from "./gates/engine.ts";
export * from "./gates/mutation.ts";
export type {
	ManifestDiff,
	TestFileEntry,
	TestManifest,
} from "./gates/test-lock.ts";
export {
	assertTestManifestUnchanged,
	lockTestManifest,
	verifyTestManifestUnchanged,
} from "./gates/test-lock.ts";
