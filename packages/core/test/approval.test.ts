import { describe, expect, it } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SignedApprovalRecord } from "../src/approval/ed25519.ts";
import {
	sealHumanKey,
	signStageApproval,
	verifyStageApproval,
} from "../src/approval/ed25519.ts";

async function freshKeyDir(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "es-approval-"));
	return path.join(root, "keys");
}

const PAYLOAD = {
	runId: "run-001",
	stage: "GRILL" as const,
	subjectHash: "a".repeat(64),
	timestamp: "2026-10-15T00:00:00.000Z",
};

describe("sealHumanKey", () => {
	it("seals a keypair and reports publicKeyHex + fingerprint", async () => {
		const sealed = await sealHumanKey(await freshKeyDir(), "correct horse");
		expect(sealed.publicKeyHex).toMatch(/^[0-9a-f]+$/);
		expect(sealed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	it("writes human.key.enc with mode 0600", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "s3cret-passphrase");
		const mode = (await stat(path.join(keyDir, "human.key.enc"))).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("refuses an empty passphrase", async () => {
		await expect(sealHumanKey(await freshKeyDir(), "")).rejects.toThrow(
			/passphrase/,
		);
	});
});

describe("signStageApproval / verifyStageApproval", () => {
	it("round-trips seal -> sign -> verify", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "human-pass");
		const record = await signStageApproval(keyDir, "human-pass", PAYLOAD);
		expect(record.publicKeyHex).toMatch(/^[0-9a-f]+$/);
		expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(record.signatureHex).toMatch(/^[0-9a-f]+$/);
		expect(
			await verifyStageApproval(keyDir, record, "GRILL", PAYLOAD.subjectHash),
		).toBe(true);
	});

	it("fails with a wrong passphrase at sign time", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "right-pass");
		await expect(
			signStageApproval(keyDir, "wrong-pass", PAYLOAD),
		).rejects.toThrow(/unseal/);
	});

	it("fails on a tampered subjectHash", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "p");
		const record = await signStageApproval(keyDir, "p", PAYLOAD);
		const tampered: SignedApprovalRecord = {
			...record,
			subjectHash: "b".repeat(64),
		};
		expect(
			await verifyStageApproval(
				keyDir,
				tampered,
				"GRILL",
				tampered.subjectHash,
			),
		).toBe(false);
		expect(
			await verifyStageApproval(keyDir, record, "GRILL", "b".repeat(64)),
		).toBe(false);
	});

	it("fails on a wrong expected stage", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "p");
		const record = await signStageApproval(keyDir, "p", PAYLOAD);
		expect(
			await verifyStageApproval(keyDir, record, "SPEC", PAYLOAD.subjectHash),
		).toBe(false);
	});

	it("fails on a tampered signature", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "p");
		const record = await signStageApproval(keyDir, "p", PAYLOAD);
		const last = record.signatureHex.slice(-1) === "0" ? "1" : "0";
		const forged: SignedApprovalRecord = {
			...record,
			signatureHex: `${record.signatureHex.slice(0, -1)}${last}`,
		};
		expect(
			await verifyStageApproval(keyDir, forged, "GRILL", PAYLOAD.subjectHash),
		).toBe(false);
	});

	it("fails when the record identity does not match human.pub", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "p");
		const record = await signStageApproval(keyDir, "p", PAYLOAD);
		// Re-seal: human.pub now belongs to a different keypair.
		await sealHumanKey(keyDir, "p");
		expect(
			await verifyStageApproval(keyDir, record, "GRILL", PAYLOAD.subjectHash),
		).toBe(false);
	});

	it("fails closed (false, never throws) with a missing key dir", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "p");
		const record = await signStageApproval(keyDir, "p", PAYLOAD);
		const missing = path.join(keyDir, "no-such-dir");
		expect(
			await verifyStageApproval(missing, record, "GRILL", PAYLOAD.subjectHash),
		).toBe(false);
	});

	it("rejects signing for an unknown stage", async () => {
		const keyDir = await freshKeyDir();
		await sealHumanKey(keyDir, "p");
		await expect(
			signStageApproval(keyDir, "p", {
				...PAYLOAD,
				stage: "DEPLOY" as unknown as "GRILL",
			}),
		).rejects.toThrow(/stage/);
	});
});
