import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({
	entryPoints: ["src/secrets.ts"], bundle: true, write: false, format: "esm", platform: "node",
	plugins: [{ name: "sdk-fixture", setup(builder) {
		builder.onResolve({ filter: /^@1password\/sdk$|sdk-wasm\.ts$/ }, ({ path }) => ({ path, namespace: "fixture" }));
		builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path.endsWith("sdk-wasm.ts") ? "export async function prepareSdkWasm(){} export async function finishSdkInitialization(){}" : "export class DesktopAuth {} export function createClient(){}" }));
	} }],
});
const { OnePasswordProvider } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const identity = { account: "QA", secretRef: "op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password" };
function fixture(factory) {
	let creations = 0;
	const sdk = { DesktopAuth: class { constructor(account) { this.account = account; } }, ItemCategory: { Password: "Password" }, ItemFieldType: { Concealed: "Concealed" }, createClient: async (configuration) => factory(++creations, configuration) };
	return { provider: new OnePasswordProvider("0.1.0", async () => sdk), get creations() { return creations; } };
}
const healthy = { secrets: { resolve: async () => "synthetic password" }, vaults: { list: async () => [{ id: "vault", title: "QA" }] }, items: { create: async () => ({ vaultId: "abcdefghijklmnopqrstuvwxyz", id: "abcdefghijklmnopqrstuvwxyz" }) } };
test("a successful connection is reused until a request fails", async () => {
	const f = fixture(() => healthy);
	assert.equal(await f.provider.resolve(identity), "synthetic password");
	await f.provider.resolve(identity); assert.equal(f.creations, 1);
});
test("quit/reopen 1Password retires the stale client and the next explicit unlock succeeds", async () => {
	let running = true;
	const f = fixture((attempt) => attempt === 1 ? { ...healthy, secrets: { resolve: async () => { if (!running) throw new Error("IPC operation failed: -3"); return "synthetic password"; } } } : healthy);
	await f.provider.resolve(identity);
	running = false;
	await assert.rejects(f.provider.resolve(identity), /1Password could not complete/);
	assert.equal(f.creations, 1, "failed requests do not automatically retry or re-prompt");
	running = true;
	assert.equal(await f.provider.resolve(identity), "synthetic password");
	assert.equal(f.creations, 2);
});
test("initialization failure is also recoverable on the next explicit attempt", async () => {
	const f = fixture((attempt) => { if (attempt === 1) throw new Error("app unavailable"); return healthy; });
	await assert.rejects(f.provider.authorize(identity.account));
	assert.equal(await f.provider.resolve(identity), "synthetic password"); assert.equal(f.creations, 2);
});
test("failure following biometric reauthorization also retires the broken session", async () => {
	const f = fixture((attempt) => attempt === 1 ? { ...healthy, secrets: { resolve: async () => { throw new Error("Desktop session expired after reauthorization"); } } } : healthy);
	await f.provider.authorize(identity.account);
	await assert.rejects(f.provider.resolve(identity));
	assert.equal(await f.provider.resolve(identity), "synthetic password"); assert.equal(f.creations, 2);
});
test("vault-list failures reconnect on retry", async () => {
	const f = fixture((attempt) => attempt === 1 ? { ...healthy, vaults: { list: async () => { throw new Error("connection closed"); } } } : healthy);
	await assert.rejects(f.provider.listVaults(identity.account));
	assert.deepEqual(await f.provider.listVaults(identity.account), [{ id: "vault", title: "QA" }]); assert.equal(f.creations, 2);
});
test("mutations are never automatically replayed and retire failed connections", async () => {
	let mutations = 0;
	const f = fixture((attempt) => attempt === 1 ? { ...healthy, items: { create: async () => { mutations++; throw new Error("response lost after creation"); } } } : healthy);
	await assert.rejects(f.provider.createPassword(identity.account, "vault", "synthetic password"));
	assert.equal(mutations, 1); assert.equal(f.creations, 1);
	await f.provider.resolve(identity); assert.equal(f.creations, 2);
});
test("a late failure from an old client does not remove a newer healthy connection", async () => {
	let rejectLate, calls = 0;
	const f = fixture((attempt) => attempt === 1 ? { ...healthy, secrets: { resolve: async () => { if (++calls === 1) return await new Promise((_, reject) => { rejectLate = reject; }); throw new Error("restart"); } } } : healthy);
	const late = f.provider.resolve(identity);
	await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(f.provider.resolve(identity));
	await f.provider.resolve(identity);
	rejectLate(new Error("old request completed late")); await assert.rejects(late);
	await f.provider.resolve(identity); assert.equal(f.creations, 2);
});
test("SDK errors remain redacted and disposal does not permit reconnection", async () => {
	const f = fixture(() => ({ ...healthy, secrets: { resolve: async () => { throw new Error("sensitive SDK payload"); } } }));
	await assert.rejects(f.provider.resolve(identity), (error) => !error.message.includes("sensitive SDK payload"));
	f.provider.dispose(); await assert.rejects(f.provider.resolve(identity)); assert.equal(f.creations, 1);
});
