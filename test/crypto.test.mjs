import { test } from "node:test";
import assert from "node:assert/strict";
import { decrypt, deriveKey, encrypt, newEnvelope, parseEnvelope, serializeEnvelope, hasProtectedMarker } from "../src/envelope.ts";

export const identity = { account: 'Test & "personal"', secretRef: "op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password" };
const password = "  Synthetic test passphrase 🦉  ";
const template = newEnvelope(identity);
const key = await deriveKey(password, template);
test.after(() => key.fill(0));
for (const text of ["", "hello", "---\nsecret: true\n---\n# Private\n\n日本語 🦉\n", "\r\n\t untouched whitespace \r\n"] ) {
	test(`authenticated exact round trip (${text.length} characters)`, () => {
		const file = serializeEnvelope(encrypt(text, key, template));
		assert.equal(decrypt(parseEnvelope(file), key), text);
		assert.ok(file.startsWith("<protected-note"));
		assert.ok(!file.includes(password));
		assert.deepEqual(parseEnvelope(file).account, identity.account);
	});
}
test("each save generates a fresh nonce and independent notes have different salts", () => {
	assert.notEqual(encrypt("same", key, template).nonce, encrypt("same", key, template).nonce);
	assert.notEqual(newEnvelope(identity).kdf.salt, template.kdf.salt);
});
test("wrong password and changed account, reference, nonce, ciphertext, salt or tag fail authentication", async () => {
	const e = encrypt("SENSITIVE AFTER ENCRYPTION", key, template);
	const wrong = await deriveKey("wrong", template);
	assert.throws(() => decrypt(e, wrong), /Could not decrypt/); wrong.fill(0);
	for (const change of [{ account: "someone else" }, { secretRef: identity.secretRef.replace("password", "another") }, { nonce: Buffer.alloc(12).toString("base64") }, { ciphertext: Buffer.from("changed").toString("base64") }, { tag: Buffer.alloc(16).toString("base64") }, { kdf: { ...e.kdf, salt: Buffer.alloc(16).toString("base64") } }]) assert.throws(() => decrypt({ ...e, ...change }, key), /Could not decrypt/);
});
test("strict envelope rejects surrounding plaintext, malformed base64 and unsupported parameters", () => {
	const file = serializeEnvelope(encrypt("private", key, template));
	for (const candidate of ["plaintext\n" + file, file + "plaintext", file.replace('version="1"', 'version="2"'), file.replace("</protected-note>", ""), file.replace(/>\n[^<]+/, ">\n!invalid!")]) assert.throws(() => parseEnvelope(candidate));
	const e = encrypt("private", key, template);
	for (const N of [1, 262144, 2 ** 40]) assert.throws(() => parseEnvelope(serializeEnvelope({ ...e, kdf: { ...e.kdf, N } })), /Unsupported/);
});
test("only a leading marker claims the entire note", () => {
	assert.equal(hasProtectedMarker("  <protected-note broken"), true);
	assert.equal(hasProtectedMarker("# Documentation\n```xml\n<protected-note>"), false);
});
