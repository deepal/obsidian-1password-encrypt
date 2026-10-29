import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const host = `
class Element {
 constructor(){this.children=[];this.classList={toggle(){}};}
 createDiv(){const child=new Element();this.children.push(child);return child;}
 createEl(){return this.createDiv();} addEventListener(){} empty(){this.children=[];}
}
export class MarkdownView {
 constructor(leaf){this.leaf=leaf;this.app={vault:{read:async()=>''}};this.contentEl=new Element();this.file={path:'Private.md'};this.value='';this.lastSavedData='';this.dirty=false;this.saving=false;this.rawSaves=[];this.metadataEditor={clear:()=>{this.metadataCleared=true}};this.rawFrontmatter=null;}
 clear(){this.value='';this.onInternalDataChange();}
 getViewData(){return this.value;}
 setViewData(value){this.value=value;this.onInternalDataChange();}
 onInternalDataChange(){} onExternalDataChange(){} loadFrontmatter(text){this.rawFrontmatter=text;} loadFileInternal(){}
 async save(){this.rawSaves.push(this.value);}
 async onUnloadFile(){await this.save(true);}
 async onClose(){this.clear();}
}
`;
const bundled = await build({ entryPoints: ["src/protected-view.ts"], write: false, bundle: true, platform: "node", format: "esm", plugins: [{ name: "native-host", setup(builder) { builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" })); builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: host })); } }] });
const { ProtectedMarkdownView } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
function fixture() {
	const updates = [], saves = [];
	const session = { text: "secret note" };
	const owner = { enabled: true, guard: { protectedPaths: new Set() }, coordinator: { sessions: new Map([["Private.md", session]]), save: async () => { saves.push(session.text); }, checkpoint(){} }, changed(_path, text) { updates.push(text); session.text = text; } };
	const view = new ProtectedMarkdownView({}, owner);
	view.showUnlocked(session.text, true);
	return { owner, view, updates, saves, session };
}
test("native clear on unload is not an edit and repeated saves cannot encrypt an empty buffer", async () => {
	const f = fixture();
	await f.view.onUnloadFile(f.view.file);
	await f.view.save(true); await f.view.onClose();
	assert.equal(f.session.text, "secret note");
	assert.ok(f.updates.every((text) => text === "secret note"));
	assert.ok(f.saves.every((text) => text === "secret note"));
	assert.deepEqual(f.view.rawSaves, []);
});
test("locking clears readable data without changing shared session text", () => {
	const f = fixture(); f.view.showLocked();
	assert.equal(f.view.getViewData(), ""); assert.equal(f.session.text, "secret note"); assert.deepEqual(f.updates, []);
});
test("locking removes native property widgets and cached frontmatter", () => {
	const f=fixture();f.view.rawFrontmatter="private frontmatter";f.view.metadataCleared=false;
	f.view.showLocked();assert.equal(f.view.rawFrontmatter,null);assert.equal(f.view.metadataCleared,true);
});
test("a failed protected save never calls native plaintext recovery", async () => {
	const f = fixture(); f.owner.coordinator.save = async () => { throw Error("disk error"); };
	await assert.rejects(f.view.save(), /disk error/);
	assert.deepEqual(f.view.rawSaves, []); assert.equal(f.view.getViewData(), "secret note");
});
test("global quick-preview events cannot push plaintext into protected buffers", () => {
	const f = fixture(); f.view.onExternalDataChange(f.view.file, "foreign text");
	assert.equal(f.view.getViewData(), "secret note"); assert.deepEqual(f.updates, []);
});
test("protected tabs cannot claim unrelated ordinary Markdown files", () => {
	const f = fixture(); assert.equal(f.view.canAcceptExtension("md"), false);
});
test("unsupported native host methods fail closed", () => {
	const prototype = Object.getPrototypeOf(ProtectedMarkdownView.prototype), previous = prototype.loadFrontmatter;
	prototype.loadFrontmatter = undefined;
	try { assert.throws(() => fixture(), /unsupported editor lifecycle/); } finally { prototype.loadFrontmatter = previous; }
});
