import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteSessionCoordinator, ConflictError } from "../src/sessions.ts";
import { FileRecoveryStore } from "../src/recovery.ts";
import { decrypt, deriveKey, parseEnvelope } from "../src/envelope.ts";
const identity = { account: "Test", secretRef: "op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password" };
const password = "test-only password 文字";
async function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "protected-notes-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const files = new Map([["Private.md", "Initial note"]]);
	const writes = [];
	const storage = {
		read: async (path) => files.get(path),
		compareAndSwap: async (path, before, next) => { if (files.get(path) !== before) throw new ConflictError("conflict"); files.set(path, next); writes.push(next); },
		createRecoveryNote: async (path, text) => { const next = path + ".recovered.md"; files.set(next, text); return next; },
	};
	const coordinator = new NoteSessionCoordinator(storage, new FileRecoveryStore(directory));
	await coordinator.protect("Private.md", "Initial note", "Initial note", password, identity);
	return { coordinator, files, storage, writes, directory };
}
test("encrypts in place and all subsequent normal writes remain encrypted", async (t) => {
	const f = await fixture(t), session = await f.coordinator.open("Private.md", password, f.files.get("Private.md"));
	f.coordinator.update("Private.md", "AFTER_UNLOCK_PLAINTEXT");
	await f.coordinator.save("Private.md");
	assert.equal(decrypt(parseEnvelope(f.files.get("Private.md")), session.key), "AFTER_UNLOCK_PLAINTEXT");
	assert.ok(f.writes.every((write) => !write.includes(password) && !write.includes("AFTER_UNLOCK_PLAINTEXT")));
	assert.equal(f.coordinator.recovery.read("Private.md"), null);
	await f.coordinator.lock("Private.md");
	assert.ok(session.key.every((byte) => byte === 0)); assert.equal(session.text, "");
});
test("reinstall recovers entirely from the note's embedded identity and unchanged secret", async (t) => {
	const f = await fixture(t);
	const fresh = new NoteSessionCoordinator(f.storage, new FileRecoveryStore(f.directory));
	assert.equal((await fresh.open("Private.md", password, f.files.get("Private.md"))).text, "Initial note");
	fresh.shutdown();
});
test("changed disk and failing writes preserve only encrypted recovery and do not overwrite", async (t) => {
	const f = await fixture(t);
	const session = await f.coordinator.open("Private.md", password, f.files.get("Private.md"));
	f.coordinator.update("Private.md", "PRIVATE RECOVERY TEXT");
	const changed = f.files.get("Private.md") + "\n";
	f.files.set("Private.md", changed);
	assert.equal(await f.coordinator.lock("Private.md"), "recovery");
	assert.equal(f.files.get("Private.md"), changed);
	const record = f.coordinator.recovery.read("Private.md");
	const written = readdirSync(f.directory).map((file) => readFileSync(join(f.directory, file), "utf8")).join();
	assert.ok(!written.includes("PRIVATE RECOVERY TEXT") && !written.includes(password));
	const recoveryKey = await deriveKey(password, parseEnvelope(record.envelope));
	assert.equal(decrypt(parseEnvelope(record.envelope), recoveryKey), "PRIVATE RECOVERY TEXT");
	recoveryKey.fill(0); assert.ok(session.key.every((value) => value === 0));
});
test("if both save and recovery fail the session and edits remain available", async (t) => {
	const f = await fixture(t);
	await f.coordinator.open("Private.md", password, f.files.get("Private.md"));
	f.coordinator.update("Private.md", "unsaved");
	f.coordinator.recovery.write = () => { throw new Error("read-only"); };
	await assert.rejects(f.coordinator.lock("Private.md"));
	assert.equal(f.coordinator.require("Private.md").text, "unsaved");
	f.coordinator.dispose("Private.md");
});
test("shutdown journals unsaved edits and releases keys", async (t) => {
	const f = await fixture(t), session = await f.coordinator.open("Private.md", password, f.files.get("Private.md"));
	f.coordinator.update("Private.md", "last edit before unload"); f.coordinator.shutdown();
	assert.equal(f.coordinator.sessions.size, 0); assert.ok(session.key.every((value) => value === 0));
	assert.ok(f.coordinator.recovery.read("Private.md"));
	const fresh = new NoteSessionCoordinator(f.storage, f.coordinator.recovery);
	await fresh.open("Private.md", password, f.files.get("Private.md"));
	await fresh.restoreRecovery("Private.md", password, false);
	assert.equal(fresh.require("Private.md").text, "last edit before unload"); fresh.shutdown();
});
test("conflicting recovery can become a separate encrypted note", async (t) => {
	const f = await fixture(t);
	await f.coordinator.open("Private.md", password, f.files.get("Private.md"));
	f.coordinator.update("Private.md", "recovered"); f.coordinator.checkpoint("Private.md");
	f.coordinator.dispose("Private.md"); f.files.set("Private.md", f.files.get("Private.md") + "\n");
	await f.coordinator.open("Private.md", password, f.files.get("Private.md"));
	await assert.rejects(f.coordinator.restoreRecovery("Private.md", password, false), /separate/);
	const next = await f.coordinator.restoreRecovery("Private.md", password, true);
	assert.ok(f.files.get(next).startsWith("<protected-note")); f.coordinator.shutdown();
});
test("edits during an in-flight save are serialized without losing the later edit", async (t) => {
	const f = await fixture(t);
	await f.coordinator.open("Private.md", password, f.files.get("Private.md"));
	let resume; const original = f.storage.compareAndSwap;
	f.storage.compareAndSwap = async (...args) => { await new Promise((resolve) => { resume = resolve; }); return original(...args); };
	f.coordinator.update("Private.md", "first"); const save = f.coordinator.save("Private.md");
	await new Promise((resolve) => setImmediate(resolve));
	f.coordinator.update("Private.md", "second"); resume(); await save;
	assert.equal(f.coordinator.require("Private.md").text, "second");
	assert.ok(f.coordinator.recovery.read("Private.md"));
	f.storage.compareAndSwap = original; await f.coordinator.lock("Private.md");
	assert.equal((await f.coordinator.open("Private.md", password, f.files.get("Private.md"))).text, "second"); f.coordinator.shutdown();
});
test("rename preserves encryption and encrypted recovery, permanent removal alone writes plaintext", async (t) => {
	const f = await fixture(t);
	await f.coordinator.open("Private.md", password, f.files.get("Private.md"));
	f.coordinator.update("Private.md", "restored ordinary text"); f.coordinator.checkpoint("Private.md");
	f.files.set("Renamed.md", f.files.get("Private.md")); f.files.delete("Private.md"); f.coordinator.rename("Private.md", "Renamed.md");
	assert.ok(f.coordinator.recovery.read("Renamed.md"));
	await f.coordinator.removeProtection("Renamed.md");
	assert.equal(f.files.get("Renamed.md"), "restored ordinary text"); assert.equal(f.coordinator.sessions.size, 0);
});
test("cancelled unlocks/encryption do not create sessions or alter files", async (t) => {
	const f = await fixture(t), original = f.files.get("Private.md");
	await assert.rejects(f.coordinator.open("Private.md", password, original, () => false), /cancelled/);
	assert.equal(f.coordinator.sessions.size, 0); assert.equal(f.files.get("Private.md"), original);
	await assert.rejects(f.coordinator.protect("Other.md", "other", "", password, identity, () => false), /cancelled/);
	assert.equal(f.files.has("Other.md"), false);
});
test("after authenticated decryption a corrected reference is stored with fresh authentication", async (t) => {
	const f=await fixture(t), original=f.files.get("Private.md");
	await assert.rejects(f.coordinator.open("Private.md","incorrect",original));
	assert.equal(f.files.get("Private.md"),original);
	await f.coordinator.open("Private.md",password,original);
	const corrected={account:"Renamed account",secretRef:identity.secretRef.replace("password","replacement")};
	await f.coordinator.rebind("Private.md",corrected);
	const updated=parseEnvelope(f.files.get("Private.md"));
	assert.equal(updated.account,corrected.account);assert.equal(updated.secretRef,corrected.secretRef);
	assert.equal(decrypt(updated,f.coordinator.require("Private.md").key),"Initial note");f.coordinator.shutdown();
});
