import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { deriveKey, encrypt, newEnvelope, serializeEnvelope } from "../src/envelope.ts";
const bundled = await build({ entryPoints: ["src/host.ts"], bundle: true, write: false, platform: "node", format: "esm", plugins: [{ name: "obsidian", setup(builder) { builder.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));builder.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:"export class MarkdownView {}"})); } }] });
const { VaultWriteGuard } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const template = newEnvelope({ account: "QA", secretRef: "op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password" });
const key = await deriveKey("synthetic guard password", template);
const envelope = serializeEnvelope(encrypt("private", key, template)); key.fill(0);
function fixture() {
	let text = envelope; const backups=[];
	const vault={ cachedRead:async()=>text, modify:async(_file,next)=>{text=next},process:async(_file,fn)=>{text=fn(text)} };
	const original = vault.modify;
	const app={vault,fileManager:{storeTextFileBackup:async(path,body)=>backups.push({path,body})}};
	const guard=new VaultWriteGuard(app);guard.install();
	return { app, guard, original, backups, file:{path:"Private.md"}, get text(){return text} };
}
test("ordinary modify and atomic process cannot inject plaintext into a protected note", async()=>{
	const f=fixture();
	await assert.rejects(f.app.vault.modify(f.file,"plaintext"));
	await assert.rejects(f.app.vault.process(f.file,(current)=>"---\nnew: property\n---\n"+current));
	assert.equal(f.text,envelope);f.guard.destroy();assert.equal(f.app.vault.modify,f.original);
});
test("save-error fallback refuses plaintext recovery but preserves ciphertext backups",async()=>{
	const f=fixture();f.guard.protectedPaths.add(f.file.path);
	await f.app.fileManager.storeTextFileBackup(f.file.path,"PRIVATE EDITOR CONTENT");
	await f.app.fileManager.storeTextFileBackup(f.file.path,envelope);
	assert.deepEqual(f.backups,[{path:f.file.path,body:envelope}]);f.guard.destroy();
});
test("only an explicitly authorized exact plaintext replacement can remove protection",async()=>{
	const f=fixture();
	await f.guard.allowPlaintext(f.file.path,"deliberate plaintext",()=>f.app.vault.process(f.file,()=>"deliberate plaintext"));
	assert.equal(f.text,"deliberate plaintext");
	await assert.rejects(f.app.vault.modify(f.file,"different plaintext"));f.guard.destroy();
});
test("cleanup does not overwrite a newer wrapper installed by another plugin",()=>{
	const f=fixture();const replacement=async()=>{};f.app.vault.modify=replacement;f.guard.destroy();assert.equal(f.app.vault.modify,replacement);
});
