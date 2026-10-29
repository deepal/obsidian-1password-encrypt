import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

export const KDF = Object.freeze({ name: "scrypt", N: 131072, r: 8, p: 1, keyLength: 32 });
export interface SecretIdentity { account: string; secretRef: string }
export interface EncryptedNoteEnvelope extends SecretIdentity {
	version: 1;
	kdf: typeof KDF & { salt: string };
	cipher: "aes-256-gcm";
	nonce: string;
	tag: string;
	ciphertext: string;
}
export class ProtectionError extends Error {}
const marker = /^\s*<protected-note\b/i;
const reference = /^op:\/\/[a-z0-9]{26}\/[a-z0-9]{26}\/(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/;
export function validateIdentity(value: SecretIdentity): void {
	if (!value.account.trim() || value.account.length > 256 || !reference.test(value.secretRef)) {
		throw new ProtectionError("Enter a 1Password account and an op:// reference using vault and item IDs.");
	}
}
export function hasProtectedMarker(text: string): boolean { return marker.test(text); }
function base64(value: unknown, length?: number): Buffer {
	if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ProtectionError("Invalid encrypted data.");
	const bytes = Buffer.from(value, "base64");
	if (length !== undefined && bytes.length !== length) throw new ProtectionError("Invalid encryption parameter length.");
	return bytes;
}
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export function parseEnvelope(text: string): EncryptedNoteEnvelope {
	const match = /^\s*<protected-note version="(\d+)" account="([^"<>]*)" secret-ref="([^"<>]*)">\s*([A-Za-z0-9+/=\s]*)\s*<\/protected-note>\s*$/.exec(text);
	if (!match) throw new ProtectionError("Malformed protected note. Its encrypted contents were left unchanged.");
	if (match[1] !== "1") throw new ProtectionError("This protected-note version is not supported.");
	let payload: unknown;
	try { payload = JSON.parse(base64(match[4].replace(/\s/g, "")).toString("utf8")); }
	catch { throw new ProtectionError("Invalid encrypted envelope."); }
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ProtectionError("Invalid encrypted envelope.");
	const data = payload as Record<string, unknown>;
	const kdf = data.kdf as Record<string, unknown> | undefined;
	if (!kdf || Object.entries(KDF).some(([key, value]) => kdf[key] !== value) || data.cipher !== "aes-256-gcm") throw new ProtectionError("Unsupported encryption parameters.");
	base64(kdf.salt, 16); base64(data.nonce, 12); base64(data.tag, 16); base64(data.ciphertext);
	const identity = { account: unescape(match[2]), secretRef: unescape(match[3]) };
	validateIdentity(identity);
	return { version: 1, ...identity, kdf: { ...KDF, salt: kdf.salt as string }, cipher: "aes-256-gcm", nonce: data.nonce as string, tag: data.tag as string, ciphertext: data.ciphertext as string };
}
export function serializeEnvelope(envelope: EncryptedNoteEnvelope): string {
	const { account, secretRef, version, ...payload } = envelope;
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
	return `<protected-note version="${version}" account="${escape(account)}" secret-ref="${escape(secretRef)}">\n${body}\n</protected-note>\n`;
}
function aad(e: EncryptedNoteEnvelope): Buffer {
	return Buffer.from(JSON.stringify(["protected-notes", e.version, e.account, e.secretRef, e.kdf.name, e.kdf.N, e.kdf.r, e.kdf.p, e.kdf.keyLength, e.kdf.salt, e.cipher]));
}
export function newEnvelope(identity: SecretIdentity): EncryptedNoteEnvelope {
	validateIdentity(identity);
	return { version: 1, ...identity, kdf: { ...KDF, salt: randomBytes(16).toString("base64") }, cipher: "aes-256-gcm", nonce: "", tag: "", ciphertext: "" };
}
export async function deriveKey(password: string, envelope: EncryptedNoteEnvelope): Promise<Buffer> {
	if (!password) throw new ProtectionError("The 1Password field is empty.");
	const bytes = Buffer.from(password, "utf8");
	try {
		return await new Promise<Buffer>((resolve, reject) => scrypt(bytes, base64(envelope.kdf.salt, 16), 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(new ProtectionError("Could not derive the encryption key.")) : resolve(key)));
	} finally { bytes.fill(0); }
}
export function encrypt(plaintext: string, key: Buffer, template: EncryptedNoteEnvelope): EncryptedNoteEnvelope {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
	cipher.setAAD(aad(template));
	const input = Buffer.from(plaintext, "utf8");
	try {
		const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
		return { ...template, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") };
	} finally { input.fill(0); }
}
export function decrypt(envelope: EncryptedNoteEnvelope, key: Buffer): string {
	try {
		const cipher = createDecipheriv("aes-256-gcm", key, base64(envelope.nonce, 12), { authTagLength: 16 });
		cipher.setAAD(aad(envelope)); cipher.setAuthTag(base64(envelope.tag, 16));
		// Do not expose any unauthenticated plaintext before final() succeeds.
		const first = cipher.update(base64(envelope.ciphertext));
		try { const last = cipher.final(); const result = Buffer.concat([first, last]); try { return result.toString("utf8"); } finally { result.fill(0); last.fill(0); } }
		finally { first.fill(0); }
	} catch { throw new ProtectionError("Could not decrypt this note. The secret is incorrect or the encrypted data has changed."); }
}
