// Sealed human approval keys (Ed25519) for factory stage gates.
//
// A human operator seals an Ed25519 keypair under a passphrase (`scrypt` +
// `aes-256-gcm`): the encrypted private key lands in `human.key.enc` (mode
// `0o600`) and the public half in `human.pub`. Stage approvals
// (`GRILL`, `SPEC`, `WAIVER`, `TRUST`) are Ed25519 signatures over the
// canonical JSON of `{ runId, stage, subjectHash, timestamp }`, where
// `subjectHash` is `sha256` of the gated artefact (`frontier.json`,
// `spec.md`). Verification is fail-closed: any mismatch (wrong stage, wrong
// subject hash, unknown key, bad signature) returns `false`, never throws.
//
// Agents may request approvals; they must never grant or self-sign them —
// signing requires the human passphrase, which agents do not hold.
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	scryptSync,
	sign,
	verify,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Stages a human may approve. Kept in sync with the factory gate names. */
export type StageName = "GRILL" | "SPEC" | "WAIVER" | "TRUST";

/** Payload covered by a stage-approval signature. */
export interface ApprovalPayload {
	readonly runId: string;
	readonly stage: StageName;
	readonly subjectHash: string;
	readonly timestamp: string;
}

/** Signed approval record: the payload plus the signing identity and signature. */
export interface SignedApprovalRecord {
	readonly runId: string;
	readonly stage: StageName;
	readonly subjectHash: string;
	readonly timestamp: string;
	readonly publicKeyHex: string;
	readonly fingerprint: string;
	readonly signatureHex: string;
}

const STAGE_NAMES: readonly StageName[] = ["GRILL", "SPEC", "WAIVER", "TRUST"];

const ENVELOPE_VERSION = 1;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

interface KeyEnvelope {
	readonly version: number;
	readonly kdf: string;
	readonly n: number;
	readonly r: number;
	readonly p: number;
	readonly salt: string;
	readonly iv: string;
	readonly tag: string;
	readonly data: string;
}

interface PublicKeyFile {
	readonly publicKeyHex: string;
	readonly fingerprint: string;
}

/** Canonical JSON: recursively lexicographically sorted keys, no whitespace. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	);
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(",")}}`;
}

/** SHA-256 hex fingerprint of an SPKI DER public key. */
export function fingerprintForPublicKey(publicKeyDer: Buffer): string {
	return createHash("sha256").update(publicKeyDer).digest("hex");
}

function keyPaths(keyDir: string): { enc: string; pub: string } {
	return {
		enc: path.join(keyDir, "human.key.enc"),
		pub: path.join(keyDir, "human.pub"),
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isHex(value: unknown, length: number): value is string {
	return (
		typeof value === "string" &&
		value.length === length &&
		/^[0-9a-f]+$/.test(value)
	);
}

/**
 * Generate an Ed25519 human keypair and seal the private key under
 * `passphrase` (`scrypt` key derivation + `aes-256-gcm`). Writes
 * `human.key.enc` (mode `0o600`, enforced with `chmod` even when the file
 * already exists) and `human.pub` (`{ publicKeyHex, fingerprint }` JSON).
 * Throws on an empty passphrase (fail closed: never seal under nothing).
 */
export async function sealHumanKey(
	keyDir: string,
	passphrase: string,
): Promise<{ publicKeyHex: string; fingerprint: string }> {
	if (!isNonEmptyString(passphrase)) {
		throw new Error(
			"sealHumanKey: passphrase must be a non-empty string (refusing to seal a human key under an empty passphrase)",
		);
	}
	const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "der" },
	});
	const publicKeyDer = Buffer.from(publicKey);
	const privateKeyDer = Buffer.from(privateKey);
	try {
		const publicKeyHex = publicKeyDer.toString("hex");
		const fingerprint = fingerprintForPublicKey(publicKeyDer);
		const salt = randomBytes(SALT_LEN);
		const iv = randomBytes(IV_LEN);
		const key = scryptSync(passphrase, salt, KEY_LEN, {
			N: SCRYPT_N,
			r: SCRYPT_R,
			p: SCRYPT_P,
		});
		try {
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const ciphertext = Buffer.concat([
				cipher.update(privateKeyDer),
				cipher.final(),
			]);
			const envelope: KeyEnvelope = {
				version: ENVELOPE_VERSION,
				kdf: "scrypt",
				n: SCRYPT_N,
				r: SCRYPT_R,
				p: SCRYPT_P,
				salt: salt.toString("hex"),
				iv: iv.toString("hex"),
				tag: cipher.getAuthTag().toString("hex"),
				data: ciphertext.toString("hex"),
			};
			const paths = keyPaths(keyDir);
			await mkdir(keyDir, { recursive: true });
			await writeFile(paths.enc, `${JSON.stringify(envelope, null, 2)}\n`, {
				mode: 0o600,
			});
			// `mode` only applies on creation; enforce 0600 even over an old file.
			await chmod(paths.enc, 0o600);
			const pubFile: PublicKeyFile = { publicKeyHex, fingerprint };
			await writeFile(paths.pub, `${JSON.stringify(pubFile, null, 2)}\n`);
			return { publicKeyHex, fingerprint };
		} finally {
			key.fill(0);
		}
	} finally {
		privateKeyDer.fill(0);
	}
}

/** Decrypt the sealed private key (PKCS#8 DER). Throws on any failure. */
async function unsealPrivateKey(
	keyDir: string,
	passphrase: string,
): Promise<Buffer> {
	if (!isNonEmptyString(passphrase)) {
		throw new Error(
			"signStageApproval: passphrase must be a non-empty string (refusing to unseal with an empty passphrase)",
		);
	}
	const paths = keyPaths(keyDir);
	let raw: string;
	try {
		raw = await readFile(paths.enc, "utf8");
	} catch {
		throw new Error(
			`signStageApproval: sealed human key not found at ${paths.enc} (run sealHumanKey first)`,
		);
	}
	let envelope: KeyEnvelope;
	try {
		envelope = JSON.parse(raw) as KeyEnvelope;
	} catch {
		throw new Error(
			"signStageApproval: sealed human key envelope is not valid JSON (tampered envelope refused)",
		);
	}
	if (
		envelope.version !== ENVELOPE_VERSION ||
		envelope.kdf !== "scrypt" ||
		!Number.isInteger(envelope.n) ||
		!Number.isInteger(envelope.r) ||
		!Number.isInteger(envelope.p) ||
		!isHex(envelope.salt, SALT_LEN * 2) ||
		!isHex(envelope.iv, IV_LEN * 2) ||
		!isHex(envelope.tag, 32) ||
		!isNonEmptyString(envelope.data)
	) {
		throw new Error(
			"signStageApproval: sealed human key envelope is malformed (tampered envelope refused)",
		);
	}
	const key = scryptSync(
		passphrase,
		Buffer.from(envelope.salt, "hex"),
		KEY_LEN,
		{ N: envelope.n, r: envelope.r, p: envelope.p },
	);
	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			key,
			Buffer.from(envelope.iv, "hex"),
		);
		decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
		return Buffer.concat([
			decipher.update(Buffer.from(envelope.data, "hex")),
			decipher.final(),
		]);
	} catch {
		throw new Error(
			"signStageApproval: failed to unseal human key (wrong passphrase or tampered envelope)",
		);
	} finally {
		key.fill(0);
	}
}

function canonicalPayload(payload: ApprovalPayload): string {
	return canonicalJson({
		runId: payload.runId,
		stage: payload.stage,
		subjectHash: payload.subjectHash,
		timestamp: payload.timestamp,
	});
}

/**
 * Sign a stage approval with the sealed human key. The Ed25519 signature
 * covers the canonical JSON of `{ runId, stage, subjectHash, timestamp }`
 * only — identity fields are bound at verification time against `human.pub`.
 * Throws on bad payloads, missing keys, or wrong passphrases (fail closed).
 */
export async function signStageApproval(
	keyDir: string,
	passphrase: string,
	payload: ApprovalPayload,
): Promise<SignedApprovalRecord> {
	if (!isNonEmptyString(payload.runId)) {
		throw new Error("signStageApproval: runId must be a non-empty string");
	}
	if (!STAGE_NAMES.includes(payload.stage)) {
		throw new Error(
			`signStageApproval: stage must be one of ${STAGE_NAMES.join(", ")}`,
		);
	}
	if (!isNonEmptyString(payload.subjectHash)) {
		throw new Error(
			"signStageApproval: subjectHash must be a non-empty string (approvals bind to sha256 of the gated artefact)",
		);
	}
	if (!isNonEmptyString(payload.timestamp)) {
		throw new Error("signStageApproval: timestamp must be a non-empty string");
	}
	const privateDer = await unsealPrivateKey(keyDir, passphrase);
	try {
		const privateKey = createPrivateKey({
			key: privateDer,
			format: "der",
			type: "pkcs8",
		});
		const publicDer = Buffer.from(
			createPublicKey(privateKey).export({ type: "spki", format: "der" }),
		);
		const publicKeyHex = publicDer.toString("hex");
		const signature = sign(
			null,
			Buffer.from(canonicalPayload(payload), "utf8"),
			privateKey,
		);
		return {
			runId: payload.runId,
			stage: payload.stage,
			subjectHash: payload.subjectHash,
			timestamp: payload.timestamp,
			publicKeyHex,
			fingerprint: fingerprintForPublicKey(publicDer),
			signatureHex: signature.toString("hex"),
		};
	} finally {
		privateDer.fill(0);
	}
}

/**
 * Verify a stage approval against `human.pub`. Checks `stage ===
 * expectedStage` AND `subjectHash === expectedSubjectHash`, binds the
 * record's identity to the sealed `human.pub`, recomputes the fingerprint,
 * and verifies the Ed25519 signature. Returns `false` on ANY mismatch or
 * error (fail closed) — it never throws.
 */
export async function verifyStageApproval(
	keyDir: string,
	record: SignedApprovalRecord,
	expectedStage: string,
	expectedSubjectHash: string,
): Promise<boolean> {
	try {
		if (record === null || typeof record !== "object") return false;
		const {
			runId,
			stage,
			subjectHash,
			timestamp,
			publicKeyHex,
			fingerprint,
			signatureHex,
		} = record;
		if (
			!isNonEmptyString(runId) ||
			!isNonEmptyString(stage) ||
			!isNonEmptyString(subjectHash) ||
			!isNonEmptyString(timestamp) ||
			!isNonEmptyString(publicKeyHex) ||
			!isNonEmptyString(fingerprint) ||
			!isNonEmptyString(signatureHex)
		) {
			return false;
		}
		if (stage !== expectedStage || subjectHash !== expectedSubjectHash) {
			return false;
		}
		if (!STAGE_NAMES.includes(stage as StageName)) return false;
		const paths = keyPaths(keyDir);
		const stored = JSON.parse(
			await readFile(paths.pub, "utf8"),
		) as PublicKeyFile;
		if (
			stored.publicKeyHex !== publicKeyHex ||
			stored.fingerprint !== fingerprint
		) {
			return false;
		}
		const publicDer = Buffer.from(publicKeyHex, "hex");
		if (fingerprintForPublicKey(publicDer) !== fingerprint) return false;
		const publicKey = createPublicKey({
			key: publicDer,
			format: "der",
			type: "spki",
		});
		const payload: ApprovalPayload = {
			runId,
			stage: stage as StageName,
			subjectHash,
			timestamp,
		};
		return verify(
			null,
			Buffer.from(canonicalPayload(payload), "utf8"),
			publicKey,
			Buffer.from(signatureHex, "hex"),
		);
	} catch {
		return false;
	}
}
