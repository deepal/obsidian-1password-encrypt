import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mockHost, button } from './modal-host.mjs';
import { encrypt, newEnvelope, serializeEnvelope } from '../src/envelope.ts';
const identity={account:'QA',secretRef:'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password'};
const ciphertext=serializeEnvelope(encrypt('synthetic protected text',Buffer.alloc(32,1),newEnvelope(identity)));
const host=mockHost+`
export const notices=[];
export class Notice { constructor(text){notices.push(text);} }
export class FileSystemAdapter {}
export class TFile { constructor(path){this.path=path;this.extension=path.split('.').pop();} }
export class Plugin { constructor(app){this.app=app;this.manifest={id:'password-protected-notes',version:'0.1.0'};this.commands=[];} addCommand(command){this.commands.push(command);return command;} }
export class MarkdownView {
 constructor(){this.contentEl=new Element();this.value='ordinary text';this.lastSavedData='';this.saving=false;this.dirty=false;this.metadataEditor={clear(){}};}
 clear(){this.value='';} getViewData(){return this.value;} setViewData(text){this.value=text;}
 getState(){return {file:this.file?.path,mode:this.mode??'source'};}
 async save(){} loadFileInternal(){} onInternalDataChange(){} onExternalDataChange(){} loadFrontmatter(){}
}
`;
const result=await build({stdin:{contents:"export {default as ProtectedNotesPlugin} from './src/main.ts';export {ProtectedMarkdownView} from './src/protected-view.ts';export {MarkdownView,TFile,Modal,notices} from 'obsidian';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'command-fixture',setup(builder){
 builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'fixture'}));
 builder.onResolve({filter:/^\.\/secrets\.ts$/},()=>({path:'secrets',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='obsidian'?host:'export class OnePasswordProvider {}'}));
}}]});
const {ProtectedNotesPlugin,ProtectedMarkdownView,MarkdownView,TFile,Modal,notices}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const opened=[];const nativeOpen=Modal.prototype.open;Modal.prototype.open=function(){opened.push(this);nativeOpen.call(this)};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes});return {promise,resolve}};
function fixture(protectedNote=false){
 notices.length=0;opened.length=0;
 const files=new Map(),data=new Map(),effects={reads:0,secrets:0,protects:0,plainWrites:0};let recent=null;const leaves=[];
 const app={workspace:{getMostRecentLeaf:()=>recent,getActiveFile:()=>null,iterateAllLeaves:callback=>leaves.forEach(callback)},vault:{getAbstractFileByPath:path=>files.get(path),read:async file=>{effects.reads++;return data.get(file.path)}}};
 Object.defineProperty(app,'hotkeyManager',{get(){throw Error('do not edit user hotkeys')}});
 const plugin=new ProtectedNotesPlugin(app);plugin.enabled=true;plugin.guard={protectedPaths:new Set(),allowPlaintext:async(_path,_text,operation)=>{effects.plainWrites++;return await operation()}};
 plugin.provider={resolve:async()=>{effects.secrets++;return 'synthetic password'}};
 plugin.coordinator={sessions:new Map(),protect:async(path)=>{effects.protects++;data.set(path,ciphertext)},lock:async(path)=>{plugin.coordinator.sessions.delete(path);return 'saved'},dispose(path){this.sessions.delete(path)},require(path){return this.sessions.get(path)},recovery:{read:()=>null}};
 function addNote(path,protectedFile=false){
  const file=new TFile(path),view=new MarkdownView();view.file=file;view.locked=protectedFile;
  if(protectedFile){Object.setPrototypeOf(view,ProtectedMarkdownView.prototype);plugin.guard.protectedPaths.add(path);view.getViewData=()=>view.locked?'':view.value;view.showLocked=()=>{view.locked=true;view.value=''};view.showUnlocked=text=>{view.locked=false;view.value=text};}
  const leaf={view,setViewState:async state=>{leaf.state=state}};view.leaf=leaf;leaves.push(leaf);files.set(path,file);data.set(path,protectedFile?ciphertext:'ordinary text');return leaf;
 }
 recent=addNote('Current.md',protectedNote);plugin.registerCommands();
 return {plugin,app,files,data,effects,leaves,get leaf(){return recent},select(leaf){recent=leaf},addNote,command:id=>plugin.commands.find(c=>c.id===id),available:()=>plugin.commands.filter(c=>c.checkCallback(true)).map(c=>c.id)};
}
function readable(f,path=f.leaf.view.file.path){const text='synthetic protected text';f.plugin.coordinator.sessions.set(path,{text});const view=f.leaves.find(l=>l.view.file.path===path)?.view;if(view){view.locked=false;view.value=text;}}
test('only the four simplified commands are registered with their existing IDs and no default hotkeys',()=>{
 const f=fixture();assert.deepEqual(f.plugin.commands.map(c=>[c.id,c.name]),[['encrypt-note','Protect this note'],['remove-protection','Remove protection'],['lock-all-notes','Lock all protected notes now'],['configure-secret','Set up 1Password']]);assert.equal(f.command('lock-note'),undefined);assert.equal(f.command('unlock-note'),undefined);assert.ok(f.plugin.commands.every(c=>c.hotkeys===undefined));
});
test('availability follows ordinary, protected and readable states without SDK calls, I/O or modals',()=>{
 const f=fixture();assert.deepEqual(f.available(),['encrypt-note','configure-secret']);f.plugin.guard.protectedPaths.add('Current.md');assert.deepEqual(f.available(),['remove-protection','configure-secret']);readable(f);assert.deepEqual(f.available(),['remove-protection','lock-all-notes','configure-secret']);assert.deepEqual(f.effects,{reads:0,secrets:0,protects:0,plainWrites:0});assert.equal(opened.length,0);assert.deepEqual(notices,[]);
});
test('protected view and session identity each independently prevent offering protection again',()=>{
 const f=fixture(true);f.plugin.guard.protectedPaths.clear();assert.equal(f.command('encrypt-note').checkCallback(true),false);assert.equal(f.command('remove-protection').checkCallback(true),true);
 const ordinary=fixture();readable(ordinary);assert.equal(ordinary.command('encrypt-note').checkCallback(true),false);assert.equal(ordinary.command('remove-protection').checkCallback(true),true);
});
test('palette/settings focus preserves the most recent Markdown target including Reading and popout panes',()=>{
 const f=fixture();f.leaf.view.mode='preview';f.plugin.activePath='Old.md';assert.equal(f.app.workspace.getActiveFile(),null);assert.equal(f.command('encrypt-note').checkCallback(true),true);assert.equal(f.plugin.currentPath(),'Current.md');const popout=f.addNote('Popout.md');f.select(popout);assert.equal(f.plugin.currentPath(),'Popout.md');
});
test('closed, deleted or non-Markdown documents do not resurrect a remembered note',()=>{
 const f=fixture();f.plugin.activePath='Current.md';f.select(null);assert.deepEqual(f.available(),['configure-secret']);f.select({view:{file:f.files.get('Current.md')}});assert.deepEqual(f.available(),['configure-secret']);const pdf=f.addNote('Document.pdf');f.select(pdf);assert.deepEqual(f.available(),['configure-secret']);const note=f.addNote('Deleted.md');f.select(note);f.files.delete('Deleted.md');assert.deepEqual(f.available(),['configure-secret']);
});
test('the global privacy command follows sessions and opening requests across panes, not the current file',()=>{
 const f=fixture();const other=f.addNote('Other.md',true);readable(f,'Other.md');assert.deepEqual(f.available(),['encrypt-note','lock-all-notes','configure-secret']);f.select(null);assert.deepEqual(f.available(),['lock-all-notes','configure-secret']);f.plugin.coordinator.sessions.clear();f.plugin.opening.add(other.view.file.path);assert.equal(f.command('lock-all-notes').checkCallback(true),true);f.plugin.opening.clear();f.plugin.prompts.set('Other.md',{});assert.equal(f.command('lock-all-notes').checkCallback(true),true);
});
test('transitions and disabled plugins suppress unavailable actions',()=>{
 const f=fixture();f.plugin.transitioning.add('Current.md');assert.equal(f.command('encrypt-note').checkCallback(false),false);f.plugin.transitioning.clear();f.plugin.departing.add('Current.md');assert.equal(f.command('encrypt-note').checkCallback(true),false);f.plugin.enabled=false;assert.deepEqual(f.available(),[]);
});
test('command execution checks availability again and resolves the then-current note',async()=>{
 const f=fixture();const calls=[];f.plugin.encryptNote=async()=>calls.push(f.plugin.currentPath());assert.equal(f.command('encrypt-note').checkCallback(true),true);const protectedLeaf=f.addNote('Protected.md',true);f.select(protectedLeaf);assert.equal(f.command('encrypt-note').checkCallback(false),false);assert.deepEqual(calls,[]);f.select(f.addNote('Next.md'));assert.equal(f.command('encrypt-note').checkCallback(false),true);await flush();assert.deepEqual(calls,['Next.md']);
});
test('a successful protection notifies only after the encrypted replacement is committed',async()=>{
 const f=fixture();f.plugin.settings=identity;await f.plugin.encryptNote();assert.equal(f.effects.protects,1);assert.equal(f.data.get('Current.md'),ciphertext);assert.deepEqual(notices,['Note protected. Open it with 1Password whenever you need it.']);
});
test('failed protection preserves the ordinary file and never reports success',async()=>{
 const f=fixture();f.plugin.settings=identity;f.plugin.coordinator.protect=async()=>{throw Error('synthetic disk failure')};await assert.rejects(f.plugin.encryptNote());assert.equal(f.data.get('Current.md'),'ordinary text');assert.deepEqual(notices,[]);assert.equal(f.plugin.guard.protectedPaths.has('Current.md'),false);
});
test('moving to another note during authorization aborts protection without changing either file',async()=>{
 const f=fixture();f.plugin.settings=identity;const d=deferred();f.plugin.provider.resolve=()=>d.promise;const pending=f.plugin.encryptNote();await flush();f.select(f.addNote('Other.md'));d.resolve('synthetic password');await pending;assert.equal(f.effects.protects,0);assert.equal(f.data.get('Current.md'),'ordinary text');assert.equal(f.data.get('Other.md'),'ordinary text');assert.deepEqual(notices,[]);
});
test('lock all cancels a pending file read and queued automatic prompts before any authorization dialog appears',async()=>{
 const f=fixture(true),d=deferred();f.app.vault.read=()=>d.promise;f.plugin.requestedPrompts.add('Current.md');const pending=f.plugin.unlockNote('Current.md');assert.equal(f.command('lock-all-notes').checkCallback(true),true);await f.plugin.lockAll();d.resolve(ciphertext);await pending;assert.equal(opened.length,0);assert.equal(f.effects.secrets,0);assert.equal(f.plugin.requestedPrompts.size,0);assert.equal(f.plugin.opening.size,0);
});
test('opening uses the new labels and Cancel leaves the note protected without resolving a secret',async()=>{
 const f=fixture(true);const pending=f.plugin.unlockNote('Current.md');await flush();const modal=opened[0];assert.equal(modal.title,'Open protected note');assert.ok(modal.contentEl.textContent.includes('It stays protected while you work.'));assert.ok(button(modal,'Open with 1Password'));await button(modal,'Cancel').click();await pending;assert.equal(f.effects.secrets,0);assert.equal(f.leaf.view.isUnlocked(),false);assert.equal(f.data.get('Current.md'),ciphertext);
});
test('lock all cancels in-flight authorization and its late reply cannot reopen readable content',async()=>{
 const f=fixture(true),d=deferred();f.plugin.provider.resolve=()=>d.promise;let opens=0;f.plugin.coordinator.open=async()=>{opens++};const pending=f.plugin.unlockNote('Current.md');await flush();const action=button(opened[0],'Open with 1Password').click();await f.plugin.lockAll();d.resolve('synthetic password');await action;await pending;assert.equal(opens,0);assert.equal(f.leaf.view.isUnlocked(),false);assert.equal(f.plugin.coordinator.sessions.size,0);assert.equal(f.data.get('Current.md'),ciphertext);
});
test('remove protection still requires an explicit plaintext confirmation',async()=>{
 const f=fixture(true);readable(f);f.plugin.coordinator.removeProtection=async path=>{f.data.set(path,f.plugin.coordinator.require(path).text);f.plugin.coordinator.sessions.delete(path)};
 const cancelled=f.plugin.removeProtection();assert.ok(opened[0].contentEl.textContent.includes('ordinary plaintext Markdown'));assert.equal(f.effects.plainWrites,0);await button(opened[0],'Cancel').click();await cancelled;assert.equal(f.data.get('Current.md'),ciphertext);
 const confirmed=f.plugin.removeProtection();await button(opened[1],'Remove protection').click();await confirmed;assert.equal(f.effects.plainWrites,1);assert.equal(f.data.get('Current.md'),'synthetic protected text');assert.equal(f.leaf.state.type,'markdown');
});
test('a global save/recovery failure keeps readable edits and never reports successful locking',async()=>{
 const f=fixture(true);readable(f);f.plugin.coordinator.lock=async()=>{throw Error('synthetic save and recovery failure')};assert.equal(f.command('lock-all-notes').checkCallback(false),true);await flush();assert.equal(f.plugin.coordinator.sessions.size,1);assert.equal(f.leaf.view.isUnlocked(),true);assert.equal(f.leaf.view.value,'synthetic protected text');assert.equal(opened[0].title,'Could not lock note');assert.ok(!notices.some(text=>text==='Note protected. Open it with 1Password whenever you need it.'));await button(opened[0],'Cancel').click();
});
