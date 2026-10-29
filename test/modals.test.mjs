import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, button } from "./modal-host.mjs";
const { ActionModal } = await loadFixture("src/modals.ts");
test("the previous error clears immediately while retry authorization is pending", async () => {
	let attempts = 0, finish;
	const modal = new ActionModal({}, "Unlock", "Description", async () => { if (++attempts === 1) throw new Error("app closed"); await new Promise((resolve) => { finish = resolve; }); });
	const completed = modal.wait();
	const unlock = button(modal);
	await unlock.click(); assert.ok(modal.errorEl.textContent.length > 0);
	const retry = unlock.click();
	assert.equal(modal.errorEl.textContent, ""); assert.equal(unlock.disabled, true);
	finish(); await retry; assert.equal(await completed, true); assert.equal(modal.closed, true);
});
test("a failed retry shows the current error without replaying the request", async () => {
	let attempts = 0;
	const modal = new ActionModal({}, "Unlock", "Description", async () => { attempts++; throw new Error("private SDK detail"); });
	const completed = modal.wait();
	await button(modal).click(); await button(modal).click();
	assert.equal(attempts, 2); assert.ok(modal.errorEl.textContent.length > 0);
	assert.ok(!modal.errorEl.textContent.includes("private SDK detail"));
	modal.close(); assert.equal(await completed, false);
});
test("repeated clicks during authorization do not start multiple requests", async () => {
	let attempts = 0, finish;
	const modal = new ActionModal({}, "Unlock", "Description", async () => { attempts++; await new Promise((resolve) => { finish = resolve; }); });
	const completed = modal.wait(); const unlock = button(modal);
	const pending = unlock.click(); await unlock.click(); assert.equal(attempts, 1);
	finish(); await pending; assert.equal(await completed, true);
});
test("cancelling during a retry keeps the modal cancelled when authorization finishes", async () => {
	let finish;
	const modal = new ActionModal({}, "Unlock", "Description", async () => { await new Promise((resolve) => { finish = resolve; }); });
	const completed = modal.wait(); const pending = button(modal).click();
	modal.close(); assert.equal(await completed, false); finish(); await pending;
	assert.equal(modal.closed, true);
});
