// Requires a disposable Obsidian profile with remote debugging enabled.
// Never targets a personal vault. All passwords/content below are synthetic.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const port = process.env.OBSIDIAN_QA_PORT ?? "9376";
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = pages.find((page) => page.type === "page" && page.url.startsWith("app://obsidian.md/"));
if (!target) throw new Error("No disposable Obsidian page found.");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); if (!message.id) return; const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); if (message.error) handler.reject(new Error(JSON.stringify(message.error))); else handler.resolve(message.result); });
async function rpc(method, params = {}) { const id = ++sequence; const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject })); socket.send(JSON.stringify({ id, method, params })); return promise; }
async function evaluate(code) {
	const result = await rpc("Runtime.evaluate", { expression: `(async()=>{${code}})()`, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result.result.value;
}
async function until(code) { for (let i = 0; i < 100; i++) { if (await evaluate(`return Boolean(${code});`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${code}`); }
async function click(label) { await until(`qaModalButtons().some(b=>b.textContent===${JSON.stringify(label)})`); await evaluate(`qaModalButtons().reverse().find(b=>b.textContent===${JSON.stringify(label)}).click();`); }
async function unlockLiveNote() {
	await evaluate("if(!qaPlugin.views('1Password integration.md').some(v=>v.isUnlocked())) void qaPlugin.unlockNote('1Password integration.md');");
	await until("qaPlugin.views('1Password integration.md').some(v=>v.isUnlocked()) || [...document.querySelectorAll('.modal button')].some(b=>b.textContent==='Open with 1Password')");
	if (!await evaluate("return qaPlugin.views('1Password integration.md').some(v=>v.isUnlocked());")) await click("Open with 1Password");
	await until("qaPlugin.views('1Password integration.md').some(v=>v.isUnlocked())");
}
const passed = [];
function pass(name) { passed.push(name); console.log(`PASS ${name}`); }
try {
	assert.match(await evaluate("return app.vault.getName();"), /^Protected Notes QA/);
	await evaluate("globalThis.qaModalButtons=()=>{const docs=new Set([document]);app.workspace.iterateAllLeaves(leaf=>{if(leaf.view.containerEl?.ownerDocument)docs.add(leaf.view.containerEl.ownerDocument)});for(const modal of app.plugins.plugins['1password-encrypt']?.prompts.values()??[])docs.add(modal.contentEl.ownerDocument);return [...docs].flatMap(doc=>[...doc.querySelectorAll('.modal button')]);};");
	// A restored floating Settings window otherwise receives native modals even
	// though this CDP connection targets the main note window.
	if (process.argv[2] !== "eval") for (const page of pages) {
		if (page.type === "page" && page.url === "about:blank" && page.title.startsWith("Settings - Protected Notes QA")) await rpc('Target.closeTarget', { targetId: page.id });
	}
	await rpc('Page.bringToFront');
	if (process.argv[2] === "eval") { console.log(JSON.stringify(await evaluate(process.argv[3]))); process.exitCode = 0; }
	else if (process.argv[2] === "setup") {
		await evaluate(`
			globalThis.qaPlugin=app.plugins.plugins['1password-encrypt'];
			globalThis.qaSetupOriginal={provider:qaPlugin.provider,settings:{...qaPlugin.settings}};
			globalThis.qaSetupState={calls:0,fail:false,vaults:[{id:'abcdefghijklmnopqrstuvwxyz',title:'QA vault'}]};
			qaPlugin.settings={account:'QA',secretRef:'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password'};
			qaPlugin.provider={listVaults:async()=>{qaSetupState.calls++;if(qaSetupState.fail)throw Error('synthetic SDK detail');return qaSetupState.vaults},dispose(){}};
			void qaPlugin.configureSecret();
		`);
		try {
			await until("document.querySelector('.modal-title')?.textContent==='Connect to 1Password'");
			assert.equal(await evaluate("return qaSetupState.calls===0 && !document.querySelector('.modal input[type=checkbox]').checked && [...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Connect to 1Password').disabled;"),true);
			pass("setup starts unchecked and performs no SDK call before explicit connection");
			// Exercise Chromium's real keyboard defaults on the actual Obsidian controls.
			await evaluate("document.querySelector('.modal input[type=text]').focus();");
			for(const type of ['keyDown','keyUp'])await rpc('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
			assert.equal(await evaluate("return document.activeElement.type==='checkbox';"),true);
			for(const type of ['keyDown','keyUp'])await rpc('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
			assert.equal(await evaluate("return document.querySelector('.modal input[type=checkbox]').checked;"),true);
			pass("keyboard focus reaches the acknowledgement and Space checks it");
			await click('Connect to 1Password');
			await until("document.querySelector('.modal-title')?.textContent==='Choose a password'");
			assert.deepEqual(await evaluate("return {calls:qaSetupState.calls,headingFocused:document.activeElement===document.querySelector('.modal-title'),accountVisible:document.querySelector('.protected-notes-connected').textContent.includes('QA')};"),{calls:1,headingFocused:true,accountVisible:true});
			pass("successful listing advances and announces the connected account");
			await evaluate("const selects=document.querySelectorAll('.modal select');selects[0].value='create';selects[0].dispatchEvent(new Event('change'));selects[1].value='abcdefghijklmnopqrstuvwxyz';selects[1].dispatchEvent(new Event('change'));for(const field of document.querySelectorAll('.modal input[type=password]')){field.value='synthetic setup draft';field.dispatchEvent(new Event('input'));}");
			await click('Back');
			assert.equal(await evaluate("return document.querySelector('.modal-title').textContent==='Connect to 1Password' && document.querySelector('.modal input[type=checkbox]').checked && document.querySelector('.modal input[type=text]').value==='QA' && !document.querySelector('.modal input[type=password]');"),true);
			await evaluate("qaSetupState.fail=true;");await click('Connect to 1Password');
			await until("[...document.querySelectorAll('.modal button')].some(b=>b.textContent==='Try again')");
			assert.equal(await evaluate("return document.querySelector('.modal [role=alert]').textContent.includes('Settings → Developer') && !document.querySelector('.modal [role=alert]').textContent.includes('synthetic SDK detail');"),true);
			pass("Back requires reconnection; failed requests retain actionable, redacted instructions");
			await evaluate("qaSetupState.fail=false;qaSetupState.vaults=[];");await click('Try again');
			await until("document.querySelector('.modal-title')?.textContent==='Choose a password'");
			assert.equal(await evaluate("return document.querySelector('.modal select option[value=create]').disabled && ![...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Save and verify').disabled;"),true);
			pass("empty vault results preserve the existing-reference path");
			await click('Back');
			await rpc('Emulation.setDeviceMetricsOverride',{width:430,height:780,deviceScaleFactor:1,mobile:false});
			assert.equal(await evaluate("const modal=document.querySelector('.modal').getBoundingClientRect();return modal.left>=0 && modal.right<=innerWidth && [...document.querySelectorAll('.modal input,.modal button')].filter(el=>el.getClientRects().length).every(el=>{const rect=el.getBoundingClientRect();return rect.right<=innerWidth && rect.bottom<=modal.bottom;});"),true);
			if(process.env.OBSIDIAN_QA_SCREENSHOT){const shot=await rpc('Page.captureScreenshot',{format:'png'});await writeFile(process.env.OBSIDIAN_QA_SCREENSHOT,Buffer.from(shot.data,'base64'));}
			pass("instructions and controls fit a narrow viewport");
			await evaluate("qaPlugin.provider.listVaults=()=>new Promise(resolve=>{globalThis.qaFinishSetupConnection=resolve});");
			await click('Connect to 1Password');
			assert.equal(await evaluate("return document.querySelector('.modal input[type=text]').matches(':disabled') && [...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Connecting…').disabled;"),true);
			await click('Cancel');await evaluate("qaFinishSetupConnection([]);");
			await until("qaPlugin.setup===null");
			assert.equal(await evaluate("return !document.querySelector('.protected-notes-setup');"),true);
			pass("cancelling a pending connection ignores its late result");
		} finally {
			await rpc('Emulation.clearDeviceMetricsOverride');
			await evaluate("[...document.querySelectorAll('.modal button')].reverse().find(b=>b.textContent==='Cancel')?.click();qaPlugin.provider=qaSetupOriginal.provider;qaPlugin.settings=qaSetupOriginal.settings;");
		}
		console.log(JSON.stringify({passed:passed.length,tests:passed},null,2));
	}
	else if (process.argv[2] === "workflow") {
		await evaluate(`
			globalThis.qaPlugin=app.plugins.plugins['1password-encrypt'];
			globalThis.qaWorkflowOriginal={provider:qaPlugin.provider,settings:{...qaPlugin.settings}};
			const suffix=require('node:crypto').randomBytes(6).toString('hex');
			globalThis.qaWorkflowPath='Workflow '+suffix+'.md';globalThis.qaWorkflowOther='Other '+suffix+'.md';
			await app.vault.create(qaWorkflowPath,'# Synthetic workflow note');await app.vault.create(qaWorkflowOther,'# Ordinary synthetic note');
			qaPlugin.settings={account:'QA',secretRef:'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password'};
			globalThis.qaWorkflowReads=0;qaPlugin.provider={resolve:async()=>{qaWorkflowReads++;return 'Synthetic workflow password'},dispose(){}};
			globalThis.qaAvailableCommands=()=>Object.values(app.commands.commands).filter(c=>c.id.startsWith('1password-encrypt:')&&c.checkCallback(true)).map(c=>c.id.split(':')[1]).sort();
			await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath(qaWorkflowPath));
		`);
		try {
			assert.deepEqual(await evaluate("return Object.keys(app.commands.commands).filter(id=>id.startsWith('1password-encrypt:')).sort();"),['configure-secret','encrypt-note','lock-all-notes','remove-protection'].map(id=>'1password-encrypt:'+id));
			assert.deepEqual(await evaluate("return qaAvailableCommands();"),['configure-secret','encrypt-note']);
			assert.equal(await evaluate("return qaWorkflowReads;"),0);
			pass('four stable command IDs replace the individual Lock/Unlock commands without authorizing during checks');
			await evaluate("app.commands.executeCommandById('1password-encrypt:encrypt-note');");
			await until("qaPlugin.views(qaWorkflowPath).length>0 && !qaPlugin.transitioning.has(qaWorkflowPath)");
			if (await evaluate("return qaPlugin.prompts.size>0;")) {
				assert.deepEqual(await evaluate("return qaAvailableCommands();"),['configure-secret','lock-all-notes','remove-protection']);
				await click('Cancel');await until("qaPlugin.opening.size===0");
			}
			assert.deepEqual(await evaluate("return qaAvailableCommands();"),['configure-secret','remove-protection']);
			assert.equal(await evaluate("return qaPlugin.views(qaWorkflowPath)[0].contentEl.textContent.includes('Open with 1Password') && [...document.querySelectorAll('.notice')].some(el=>el.textContent.includes('Note protected. Open it with 1Password whenever you need it.'));"),true);
			await evaluate("void qaPlugin.unlockNote(qaWorkflowPath);");await until("document.querySelector('.modal-title')?.textContent==='Open protected note'");await click('Cancel');
			assert.equal(await evaluate("return qaWorkflowReads===1 && !qaPlugin.coordinator.sessions.has(qaWorkflowPath);"),true);
			pass('Protect commits ciphertext and Open/Cancel keeps the protected note unreadable');
			await evaluate("qaPlugin.views(qaWorkflowPath)[0].contentEl.querySelector('.protected-notes-lock button').click();");await click('Open with 1Password');await until("qaPlugin.coordinator.sessions.has(qaWorkflowPath)");
			for(const state of [{mode:'source',source:true},{mode:'source',source:false},{mode:'preview'}]) {
				await evaluate(`const view=qaPlugin.views(qaWorkflowPath)[0];await view.leaf.setViewState({type:'protected-notes',state:{file:qaWorkflowPath,...${JSON.stringify(state)}}});`);
				assert.deepEqual(await evaluate("return qaAvailableCommands();"),['configure-secret','lock-all-notes','remove-protection']);
			}
			await evaluate("app.commands.executeCommandById('command-palette:open');");await until("document.querySelector('.prompt-input')");
			assert.deepEqual(await evaluate("return qaAvailableCommands();"),['configure-secret','lock-all-notes','remove-protection']);
			for(const type of ['keyDown','keyUp'])await rpc('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
			await until("!document.querySelector('.prompt-input')");
			pass('Source, Live Preview, Reading and palette focus preserve the current protected-note commands');
			await evaluate("const view=qaPlugin.views(qaWorkflowPath)[0];await view.leaf.setViewState({type:'protected-notes',state:{file:qaWorkflowPath,mode:'source',source:false}});globalThis.qaWorkflowMarker='QA_WORKFLOW_'+require('node:crypto').randomBytes(8).toString('hex');view.editor.setValue('# Synthetic edit\\n'+qaWorkflowMarker);await view.save();globalThis.qaWorkflowMain=view.leaf;globalThis.qaWorkflowPopout=app.workspace.openPopoutLeaf();await qaWorkflowPopout.openFile(app.vault.getAbstractFileByPath(qaWorkflowPath));");
			await until("qaPlugin.views(qaWorkflowPath).length===2 && qaPlugin.views(qaWorkflowPath).every(v=>v.isUnlocked())");
			assert.equal(await evaluate("return qaPlugin.currentPath()===qaWorkflowPath && !(await app.vault.read(app.vault.getAbstractFileByPath(qaWorkflowPath))).includes(qaWorkflowMarker);"),true);
			assert.deepEqual(await evaluate("return qaAvailableCommands();"),['configure-secret','lock-all-notes','remove-protection']);
			pass('popout context targets the protected note and editing leaves disk encrypted');
			await evaluate("qaWorkflowMain.view.containerEl.win.focus();app.workspace.setActiveLeaf(qaWorkflowMain,{focus:true});");
			await until("app.workspace.getMostRecentLeaf()===qaWorkflowMain");
			await evaluate("await qaWorkflowMain.openFile(app.vault.getAbstractFileByPath(qaWorkflowOther));");
			await until("qaPlugin.coordinator.sessions.size===0 && qaPlugin.views(qaWorkflowPath).every(v=>v.getViewData()==='')");
			pass('leaving the protected note automatically clears its other panes');
			await evaluate("await qaWorkflowMain.openFile(app.vault.getAbstractFileByPath(qaWorkflowPath));");await click('Open with 1Password');await until("qaPlugin.views(qaWorkflowPath).every(v=>v.isUnlocked())");
			await evaluate("app.commands.executeCommandById('1password-encrypt:lock-all-notes');");
			await until("qaPlugin.coordinator.sessions.size===0 && qaPlugin.views(qaWorkflowPath).every(v=>v.getViewData()==='')");
			pass('the single global privacy command clears readable content in every pane');
			await evaluate("qaWorkflowPopout.detach();app.workspace.setActiveLeaf(qaWorkflowMain,{focus:true});qaPlugin.provider.resolve=()=>new Promise(resolve=>{globalThis.qaWorkflowFinish=resolve});void qaPlugin.unlockNote(qaWorkflowPath);");await click('Open with 1Password');
			await until("typeof qaWorkflowFinish==='function'");await evaluate("app.commands.executeCommandById('1password-encrypt:lock-all-notes');qaWorkflowFinish('Synthetic workflow password');");
			await until("qaPlugin.opening.size===0");
			assert.equal(await evaluate("return !qaPlugin.coordinator.sessions.has(qaWorkflowPath) && !document.querySelector('.modal');"),true);
			pass('global locking cancels pending authorization and ignores its late response');
			await evaluate("qaPlugin.provider.resolve=async()=> 'Synthetic workflow password';void qaPlugin.unlockNote(qaWorkflowPath);");await click('Open with 1Password');await until("qaPlugin.coordinator.sessions.has(qaWorkflowPath)");
			await evaluate("qaPlugin.views(qaWorkflowPath)[0].editor.replaceRange('\\nQA_CLOSE_LAST_PANE',qaPlugin.views(qaWorkflowPath)[0].editor.offsetToPos(qaPlugin.views(qaWorkflowPath)[0].editor.getValue().length));qaWorkflowMain.detach();");await until("qaPlugin.coordinator.sessions.size===0");
			await evaluate("await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath(qaWorkflowPath));");await click('Open with 1Password');await until("qaPlugin.coordinator.sessions.has(qaWorkflowPath)");
			assert.equal(await evaluate("return qaPlugin.views(qaWorkflowPath)[0].getViewData().includes('QA_CLOSE_LAST_PANE') && !(await app.vault.read(app.vault.getAbstractFileByPath(qaWorkflowPath))).includes('QA_CLOSE_LAST_PANE');"),true);
			pass('closing the last pane preserves its latest edit encrypted');
			await evaluate("app.commands.executeCommandById('1password-encrypt:remove-protection');");await click('Cancel');
			assert.equal(await evaluate("return (await app.vault.read(app.vault.getAbstractFileByPath(qaWorkflowPath))).startsWith('<protected-note');"),true);
			await evaluate("app.commands.executeCommandById('1password-encrypt:remove-protection');");await click('Remove protection');await until("!qaPlugin.coordinator.sessions.has(qaWorkflowPath)");
			assert.equal(await evaluate("return (await app.vault.read(app.vault.getAbstractFileByPath(qaWorkflowPath))).includes('QA_CLOSE_LAST_PANE');"),true);
			pass('only explicit removal confirmation restores ordinary Markdown');
		} finally {
			await evaluate("await qaPlugin.lockAll();if(globalThis.qaWorkflowPopout?.parent)qaWorkflowPopout.detach();qaPlugin.provider=qaWorkflowOriginal.provider;qaPlugin.settings=qaWorkflowOriginal.settings;");
		}
		console.log(JSON.stringify({passed:passed.length,tests:passed},null,2));
	}
	else if (process.argv[2] === "live") {
		await evaluate("globalThis.qaPlugin=app.plugins.plugins['1password-encrypt'];");
		await unlockLiveNote();
		await until("qaPlugin.coordinator.sessions.has('1Password integration.md') && qaPlugin.views('1Password integration.md').some(v=>v.isUnlocked())");
		pass("real 1Password secret unlocks the native editor");
		await evaluate("const suffix=require('node:crypto').randomBytes(8).toString('hex');globalThis.qaMarkers={body:'QA_BODY_'+suffix,firstKey:'qa_private_key_'+suffix,firstValue:'QA_VALUE_'+suffix,secondKey:'qa_second_key_'+suffix,secondValue:'QA_SECOND_'+suffix};const v=qaPlugin.views('1Password integration.md')[0];v.editor.setValue('---\\n'+qaMarkers.firstKey+': '+qaMarkers.firstValue+'\\n---\\n# Verified integration\\n\\n'+qaMarkers.body+'\\n\\n| A | B |\\n| --- | --- |\\n| 1 | 2 |\\n');");
		await until("qaPlugin.coordinator.require('1Password integration.md').text.includes(qaMarkers.body)");
		await evaluate("const v=qaPlugin.views('1Password integration.md')[0];v.saveFrontmatter({[qaMarkers.firstKey]:qaMarkers.firstValue,[qaMarkers.secondKey]:qaMarkers.secondValue});await v.save();");
		assert.equal(await evaluate("return qaPlugin.coordinator.require('1Password integration.md').text.includes(qaMarkers.secondValue) && !(await app.vault.read(app.vault.getAbstractFileByPath('1Password integration.md'))).includes(qaMarkers.secondValue);"),true);
		pass("native in-document properties save through encryption");
		// Inspect persistence before putting the sentinel into search history.
		const leaks=await evaluate(`const fs=require('node:fs'),path=require('node:path');const root=app.vault.adapter.getBasePath();const markers=Object.values(qaMarkers);const hits=[];function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())scan(p);else if(e.isFile()&&fs.statSync(p).size<25000000){const s=fs.readFileSync(p).toString();if(markers.some(m=>s.includes(m)))hits.push(path.relative(root,p));}}}scan(root);return hits;`);
		assert.deepEqual(leaks,[]);pass("vault and plugin recovery contain no post-encryption plaintext markers");
		await evaluate("app.internalPlugins.getEnabledPluginById('global-search').openGlobalSearch(qaMarkers.body);");
		await until("document.querySelector('.search-result-container')");
		await new Promise((resolve)=>setTimeout(resolve,1000));
		assert.equal(await evaluate("return document.querySelectorAll('.search-result-file-title').length;"),0);
		assert.equal(await evaluate("return qaPlugin.coordinator.sessions.has('1Password integration.md');"),true);
		pass("global content search does not find unlocked note contents");
		await evaluate("await qaPlugin.lockNote('1Password integration.md');qaPlugin.settings={account:'',secretRef:''};await qaPlugin.saveData(qaPlugin.settings);await app.plugins.disablePlugin('1password-encrypt');await app.plugins.enablePlugin('1password-encrypt');globalThis.qaPlugin=app.plugins.plugins['1password-encrypt'];");
		await until("qaPlugin.views('1Password integration.md').length>0");
		await unlockLiveNote();
		await until("qaPlugin.views('1Password integration.md').some(v=>v.getViewData().includes(qaMarkers.body))");
		pass("real 1Password recovery works after plugin reload with empty settings");
		await evaluate("const view=qaPlugin.views('1Password integration.md')[0];view.editor.replaceRange('\\nQA_IMMEDIATE_CLOSE_EDIT',view.editor.offsetToPos(view.editor.getValue().length));view.leaf.detach();");
		await until("qaPlugin.coordinator.sessions.size===0");
		await evaluate("await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('1Password integration.md'));");
		await until("qaPlugin.views('1Password integration.md').length>0");await unlockLiveNote();
		assert.equal(await evaluate("return qaPlugin.coordinator.require('1Password integration.md').text.includes('QA_IMMEDIATE_CLOSE_EDIT');"),true);
		pass("closing immediately after an edit preserves the last edit encrypted");
		await evaluate("qaPlugin.settings={...qaLiveIdentity};await qaPlugin.saveData(qaPlugin.settings);await qaPlugin.lockAll();app.internalPlugins.getEnabledPluginById('global-search').openGlobalSearch('file:\"1Password integration\"');");
		assert.equal(await evaluate("return qaPlugin.views('1Password integration.md').every(v=>v.rawFrontmatter===null && Object.values(qaMarkers).every(marker=>!v.contentEl.textContent.includes(marker)));"),true);
		pass("locking clears hidden native property values and frontmatter caches");
		pass("final state is locked with only the 1Password reference configured");
		console.log(JSON.stringify({passed:passed.length,tests:passed},null,2));
	}
	else {
		await evaluate(`
			globalThis.qaPlugin=app.plugins.plugins['1password-encrypt'];
			globalThis.qaRealProvider=qaPlugin.provider;
			globalThis.qaIdentity={account:'QA',secretRef:'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password'};
			qaPlugin.settings={...qaIdentity};
			qaPlugin.provider={resolve:async()=> 'Synthetic QA passphrase only',dispose(){},authorize:async()=>{},listVaults:async()=>[]};
			await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Private.md'));
			await qaPlugin.encryptNote();
		`);
		await until("qaPlugin.views('Private.md').length===1");
		assert.equal(await evaluate("return (await app.vault.read(app.vault.getAbstractFileByPath('Private.md'))).startsWith('<protected-note');"), true);
		pass("encrypt existing .md in place and load native protected view");
		await evaluate("void qaPlugin.unlockNote('Private.md');"); await click("Open with 1Password");
		await until("qaPlugin.coordinator.sessions.has('Private.md') && qaPlugin.views('Private.md')[0]?.getViewData().includes('Sample note')");
		pass("unlock through injected provider into native editor");
		await evaluate("qaPlugin.views('Private.md')[0].editor.setValue('---\\nkind: secret\\n---\\n# After unlock\\n\\nAFTER_UNLOCK_UNIQUE_MARKER\\n\\n| A | B |\\n| --- | --- |\\n| 1 | 2 |\\n');");
		await until("qaPlugin.coordinator.require('Private.md').text.includes('AFTER_UNLOCK_UNIQUE_MARKER')");
		await evaluate("await qaPlugin.views('Private.md')[0].save();");
		assert.equal(await evaluate("return !(await app.vault.read(app.vault.getAbstractFileByPath('Private.md'))).includes('AFTER_UNLOCK_UNIQUE_MARKER');"), true);
		pass("native editing and save leave disk encrypted");
		await evaluate("const view=qaPlugin.views('Private.md')[0]; await view.leaf.setViewState({type:'protected-notes',state:{file:'Private.md',mode:'preview'}});");
		assert.equal(await evaluate("return qaPlugin.views('Private.md')[0].getMode();"), "preview");
		await until("document.querySelector('.markdown-preview-view')?.textContent.includes('AFTER_UNLOCK_UNIQUE_MARKER')");
		await evaluate("const view=qaPlugin.views('Private.md')[0]; await view.leaf.setViewState({type:'protected-notes',state:{file:'Private.md',mode:'source',source:true}});");
		assert.equal(await evaluate("return qaPlugin.views('Private.md')[0].getMode();"), "source");
		pass("native Reading and Source mode switches preserve unlocked session");
		await evaluate("await app.workspace.getLeaf('split').setViewState({type:'protected-notes',state:{file:'Private.md',mode:'source'}});");
		await until("qaPlugin.views('Private.md').length===2 && qaPlugin.views('Private.md').every(v=>v.getViewData().includes('AFTER_UNLOCK_UNIQUE_MARKER'))");
		await evaluate("await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Other.md'));");
		await until("qaPlugin.coordinator.sessions.size===0 && qaPlugin.views('Private.md').every(v=>v.getViewData()==='')");
		pass("leaving note locks all panes and clears readable content");
		assert.equal(await evaluate("try { await app.vault.modify(app.vault.getAbstractFileByPath('Private.md'),'UNSAFE_PLAINTEXT'); return false; } catch { return true; }"), true);
		pass("vault guard rejects plaintext writes by ordinary commands");
		await evaluate("await app.vault.rename(app.vault.getAbstractFileByPath('Private.md'),'Renamed.md'); qaPlugin.settings={account:'',secretRef:''}; await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Renamed.md')); ");
		await click("Open with 1Password");
		await until("qaPlugin.coordinator.sessions.has('Renamed.md')");
		assert.equal(await evaluate("return qaPlugin.coordinator.require('Renamed.md').text.includes('AFTER_UNLOCK_UNIQUE_MARKER');"), true);
		pass("rename and missing settings retain embedded-reference recovery");
		await evaluate("globalThis.qaOriginalCAS=qaPlugin.coordinator.storage.compareAndSwap; qaPlugin.coordinator.storage.compareAndSwap=async()=>{throw Error('simulated disk failure')}; qaPlugin.views('Renamed.md')[0].editor.setValue('# Unsaved\\nQA_ENCRYPTED_RECOVERY_MARKER'); await qaPlugin.lockNote('Renamed.md'); qaPlugin.coordinator.storage.compareAndSwap=qaOriginalCAS;");
		assert.equal(await evaluate("return qaPlugin.coordinator.recovery.read('Renamed.md')!==null && !qaPlugin.coordinator.sessions.has('Renamed.md');"), true);
		pass("failed save preserves encrypted recovery and locks safely");
		await evaluate("void qaPlugin.unlockNote('Renamed.md');"); await click("Open with 1Password"); await click("Restore edits");
		await until("qaPlugin.views('Renamed.md').some(v=>v.getViewData().includes('QA_ENCRYPTED_RECOVERY_MARKER'))");
		pass("recover unsaved encrypted edits through authorization flow");
		await evaluate("void qaPlugin.removeProtection();"); await click("Remove protection");
		await until("app.workspace.getActiveFile()?.path==='Renamed.md' && app.workspace.activeLeaf.view.getViewType()==='markdown'");
		assert.equal(await evaluate("return (await app.vault.read(app.vault.getAbstractFileByPath('Renamed.md'))).includes('QA_ENCRYPTED_RECOVERY_MARKER');"), true);
		pass("explicit remove-protection command restores ordinary Markdown");
		await evaluate("qaPlugin.provider=qaRealProvider; qaPlugin.settings={account:'',secretRef:''};");
		console.log(JSON.stringify({ passed: passed.length, tests: passed }, null, 2));
	}
	if (process.env.OBSIDIAN_QA_SCREENSHOT && process.argv[2] !== "setup") { const shot = await rpc("Page.captureScreenshot", { format: "png" }); await writeFile(process.env.OBSIDIAN_QA_SCREENSHOT, Buffer.from(shot.data, "base64")); }
} finally { socket.close(); }
