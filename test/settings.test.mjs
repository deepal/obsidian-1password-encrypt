import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, isConfigured, DEFAULT_SETTINGS } from "../src/settings-data.ts";
test("settings accept only account and reference, never password/token/key fields", () => {
	for (const raw of [null, undefined, [], 42, "text"]) assert.deepEqual(normalizeSettings(raw), DEFAULT_SETTINGS);
	assert.deepEqual(normalizeSettings({ account: " Personal ", secretRef: " reference ", password: "secret", key: "key", token: "token" }), { account: "Personal", secretRef: "reference" });
	assert.equal(isConfigured(DEFAULT_SETTINGS), false);
	assert.equal(isConfigured({ account: "Personal", secretRef: "op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password" }), true);
});
