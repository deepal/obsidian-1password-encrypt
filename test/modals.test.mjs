import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const mockHost = `
class Element {
 constructor(){this.children=[];this.textContent='';}
 createDiv(){const child=new Element();this.children.push(child);return child;}
 createEl(){return this.createDiv();}
 setText(text){this.textContent=text;}
 empty(){this.children=[];this.textContent='';}
}
export class Modal {
 constructor(app){this.app=app;this.contentEl=new Element();this.closed=false;this.buttons=[];}
 open(){this.onOpen();} setTitle(){} close(){this.closed=true;this.onClose();}
}
export class Setting {
 constructor(container){this.container=container;}
 addButton(build){const button={label:'',disabled:false,setButtonText(text){this.label=text;return this},setCta(){return this},setDisabled(value){this.disabled=value;return this},onClick(action){this.click=action;return this}};this.container.children.push(button);build(button);return this;}
}
`;
const result = await build({ entryPoints: ["src/modals.ts"], bundle: true, write: false, format: "esm", platform: "node", plugins: [{ name: "modal-host", setup(builder) {
	builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
	builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: mockHost }));
} }] });
const { ActionModal } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
function button(modal, label = "Unlock with 1Password") { return modal.contentEl.children.find((element) => element.label === label); }
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
