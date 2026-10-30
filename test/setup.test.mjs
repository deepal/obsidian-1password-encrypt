import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, button, input, checkbox, elements } from "./modal-host.mjs";
const { SetupModal }=await loadFixture("src/modals.ts");
const identity={account:"QA",secretRef:"op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password"};
const vaults=[{id:"abcdefghijklmnopqrstuvwxyz",title:"QA vault"}];
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
function fixture(overrides={},initial=identity){
 const calls={list:[],create:[],resolve:[],save:[]};
 const provider={listVaults:async account=>{calls.list.push(account);return vaults},createPassword:async(...args)=>{calls.create.push(args);return identity},resolve:async ref=>{calls.resolve.push(ref);return '  synthetic 🦉 password  '},...overrides};
 const modal=new SetupModal({},provider,initial,async ref=>{calls.save.push(ref)});const result=modal.wait();
 return {modal,result,calls};
}
async function connect(f){checkbox(f.modal).change(true);await button(f.modal,'Connect to 1Password').click();}
function createForm(f){input(f.modal,'Secret').change('create');input(f.modal,'1Password vault').change(vaults[0].id);input(f.modal,'Password').change('  synthetic 🦉 password  ');input(f.modal,'Confirm password').change('  synthetic 🦉 password  ');}
test('setup instructions precede the account; checkbox and account jointly gate connection',async()=>{
 const f=fixture({}, {account:'',secretRef:''});const m=f.modal;
 assert.equal(f.calls.list.length,0);assert.equal(checkbox(m).checked,false);assert.equal(button(m,'Connect to 1Password').disabled,true);
 assert.ok(m.contentEl.textContent.indexOf('Settings → Developer')<m.contentEl.textContent.indexOf('1Password account'));
 assert.equal(button(m,'Save and verify'),undefined);checkbox(m).change(true);assert.equal(button(m,'Connect to 1Password').disabled,true);
 input(m,'1Password account').change('  QA  ');assert.equal(button(m,'Connect to 1Password').disabled,false);
 checkbox(m).change(false);assert.equal(button(m,'Connect to 1Password').disabled,true);await button(m,'Connect to 1Password').click();assert.deepEqual(f.calls.list,[]);
 m.close();assert.equal(await f.result,null);
});
test('successful vault listing advances without persisting acknowledgement or settings',async()=>{
 const f=fixture();await connect(f);assert.equal(f.modal.title,'Choose a password');assert.deepEqual(f.calls.list,['QA']);assert.deepEqual(f.calls.save,[]);
 assert.ok(f.modal.contentEl.textContent.includes('Connected to 1Password — QA'));
 assert.equal(input(f.modal,'1Password vault').options[1].text,'QA vault');assert.equal(button(f.modal,'Load vaults'),undefined);
 assert.equal(f.modal.titleEl.focused,true);f.modal.close();await f.result;
 const fresh=fixture();assert.equal(checkbox(fresh.modal).checked,false);assert.equal(fresh.modal.title,'Connect to 1Password');fresh.modal.close();
});
test('pending connection disables account edits and duplicate requests but allows cancellation',async()=>{
 const d=deferred();let calls=0;const f=fixture({listVaults:async()=>{calls++;return await d.promise}});checkbox(f.modal).change(true);
 const pending=button(f.modal,'Connect to 1Password').click();assert.equal(button(f.modal,'Connecting…').disabled,true);
 assert.equal(input(f.modal,'1Password account').isDisabled(),true);input(f.modal,'1Password account').change('Other');
 await button(f.modal,'Connecting…').action();assert.equal(calls,1);
 await button(f.modal,'Cancel').click();assert.equal(await f.result,null);d.resolve(vaults);await pending;
 assert.equal(f.modal.contentEl.textContent,'');assert.deepEqual(f.calls.save,[]);assert.equal(f.modal.title,'Connect to 1Password');
});
test('connection failure is actionable and redacted; retry preserves input and clears old error',async()=>{
 let calls=0;const d=deferred();const f=fixture({listVaults:async()=>{if(++calls===1)throw Error('PRIVATE SDK DETAIL');return await d.promise}});
 await connect(f);assert.equal(checkbox(f.modal).checked,true);assert.equal(input(f.modal,'1Password account').value,'QA');
 const error=elements(f.modal.contentEl).find(el=>el.attributes.role==='alert');assert.ok(error.textContent.includes('Settings → Developer'));assert.ok(!error.textContent.includes('PRIVATE SDK DETAIL'));
 const retry=button(f.modal,'Try again').click();assert.equal(error.textContent,'');d.resolve(vaults);await retry;assert.equal(f.modal.title,'Choose a password');f.modal.close();
});
test('closing during a failed connection ignores its late error',async()=>{
 const d=deferred();const f=fixture({listVaults:()=>d.promise});checkbox(f.modal).change(true);const pending=button(f.modal,'Connect to 1Password').click();f.modal.close();d.reject(Error('late payload'));await pending;assert.equal(await f.result,null);assert.equal(f.modal.contentEl.children.length,0);
});
test('empty vault list permits existing reference verification and disables creation',async()=>{
 const f=fixture({listVaults:async()=>[]});await connect(f);assert.equal(input(f.modal,'Secret').options.find(o=>o.value==='create').disabled,true);
 assert.ok(f.modal.contentEl.textContent.includes('No vaults are available'));await button(f.modal,'Save and verify').click();assert.deepEqual(await f.result,identity);assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.save.length,1);
});
test('back clears password and vault drafts and requires a fresh check for the selected account',async()=>{
 const f=fixture();await connect(f);createForm(f);await button(f.modal,'Back').click();
 assert.equal(f.modal.password,'');assert.equal(f.modal.confirmation,'');assert.equal(f.modal.vaultId,'');assert.equal(f.modal.connectedAccount,null);assert.equal(checkbox(f.modal).checked,true);
 input(f.modal,'1Password account').change('Other account');await button(f.modal,'Connect to 1Password').click();assert.deepEqual(f.calls.list,['QA','Other account']);assert.equal(input(f.modal,'1Password vault').value,'');f.modal.close();
});
test('connection success does not bypass final secret retrieval; failed retrieval can retry',async()=>{
 let reads=0;const f=fixture({resolve:async()=>{if(++reads===1)throw Error('expired authorization');return 'synthetic'}});await connect(f);
 await button(f.modal,'Save and verify').click();assert.equal(f.calls.save.length,0);assert.equal(f.modal.closed,false);await button(f.modal,'Save and verify').click();assert.deepEqual(await f.result,identity);assert.equal(reads,2);
});
test('creation validates matching passwords, preserves characters, and reads back before saving',async()=>{
 const f=fixture();await connect(f);createForm(f);input(f.modal,'Confirm password').change('different');await button(f.modal,'Save and verify').click();assert.equal(f.calls.create.length,0);assert.equal(button(f.modal,'Back').disabled,false);
 input(f.modal,'Confirm password').change('  synthetic 🦉 password  ');await button(f.modal,'Save and verify').click();assert.deepEqual(await f.result,identity);assert.deepEqual(f.calls.create,[['QA',vaults[0].id,'  synthetic 🦉 password  ']]);assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.save.length,1);assert.equal(f.modal.password,'');
});
test('a created item with failed readback keeps its reference, fixes account, and never creates twice',async()=>{
 let reads=0;const f=fixture({resolve:async()=>{if(++reads===1)throw Error('lost connection');return '  synthetic 🦉 password  '}});await connect(f);createForm(f);
 await button(f.modal,'Save and verify').click();assert.equal(button(f.modal,'Back').disabled,true);assert.ok(f.modal.contentEl.textContent.includes(identity.secretRef));assert.equal(f.calls.save.length,0);
 await button(f.modal,'Save and verify').click();await f.result;assert.equal(f.calls.create.length,1);assert.equal(f.calls.save.length,1);
});
test('a mismatched created password is rejected before settings are saved',async()=>{
 const f=fixture({resolve:async()=> 'different synthetic password'});await connect(f);createForm(f);await button(f.modal,'Save and verify').click();
 assert.equal(f.calls.create.length,1);assert.equal(f.calls.save.length,0);assert.ok(f.modal.contentEl.textContent.includes('did not match'));assert.equal(button(f.modal,'Back').disabled,true);f.modal.close();assert.equal(await f.result,null);
});
test('uncertain creation cannot be replayed; an existing reference can complete recovery',async()=>{
 let creations=0;const f=fixture({createPassword:async()=>{creations++;throw Error('PRIVATE mutation payload')}});await connect(f);createForm(f);await button(f.modal,'Save and verify').click();
 assert.equal(button(f.modal,'Back').disabled,true);assert.ok(f.modal.contentEl.textContent.includes('Creation could not be confirmed'));assert.ok(!f.modal.contentEl.textContent.includes('PRIVATE mutation payload'));
 await button(f.modal,'Save and verify').click();assert.equal(creations,1);input(f.modal,'Secret').change('existing');await button(f.modal,'Save and verify').click();assert.deepEqual(await f.result,identity);assert.equal(creations,1);
});
test('cancelling secret verification or item creation never saves settings afterwards',async()=>{
 for(const stage of ['resolve','create']){
  const d=deferred();const f=fixture(stage==='resolve'?{resolve:()=>d.promise}:{createPassword:()=>d.promise});await connect(f);if(stage==='create')createForm(f);
  const pending=button(f.modal,'Save and verify').click();await button(f.modal,'Cancel').click();assert.equal(await f.result,null);d.resolve(stage==='resolve'?'synthetic':identity);await pending;
  assert.equal(f.calls.save.length,0);assert.equal(f.modal.password,'');assert.equal(f.modal.contentEl.textContent,'');
 }
});
test('settings indexing has no SDK side effects and setup help opens the shared wizard',async()=>{
 const {ProtectedNotesSettingTab}=await loadFixture('src/settings.ts');let opens=0;const tab=new ProtectedNotesSettingTab({}, {configureSecret:()=>{opens++}});const definitions=tab.getSettingDefinitions();assert.equal(opens,0);
 const help=definitions.find(d=>d.name==='1Password setup help');assert.ok(help.aliases.includes('SDK'));
 let action;help.render({addButton(build){build({setButtonText(){return this},onClick(callback){action=callback;return this}})}});assert.equal(opens,0);action();assert.equal(opens,1);
});
