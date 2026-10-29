import { build } from "esbuild";
export const mockHost = `
class Element {
 constructor(tag='div', options={}) { this.tag=tag;this.children=[];this.attributes={...options.attr};this.type=options.type;this.href=options.href;this._text=options.text??'';this.disabled=false;this.value='';this.checked=false;this.listeners={};this.classes=new Set(); }
 get textContent(){return this._text+this.children.map(c=>c.textContent??'').join('');}
 set textContent(value){this._text=value;}
 createEl(tag, options={}){const child=new Element(tag,options);child.parent=this;this.children.push(child);return child;}
 createDiv(options={}){return this.createEl('div',options);}
 createSpan(options={}){return this.createEl('span',options);}
 setText(text){this._text=text;return this;}
 empty(){this.children=[];this._text='';}
 addClass(name){this.classes.add(name);}
 toggleClass(name, value){if(value)this.classes.add(name);else this.classes.delete(name);}
 addEventListener(name,action){this.listeners[name]=action;}
 focus(){this.focused=true;}
 change(value){if(this.disabled || this.parent?.isDisabled())return;if(this.type==='checkbox')this.checked=value;else this.value=value;return this.listeners.change?.();}
 isDisabled(){return this.disabled||this.parent?.isDisabled()||false;}
}
export class Modal {
 constructor(app){this.app=app;this.contentEl=new Element();this.modalEl=new Element();this.titleEl=new Element();this.closed=false;}
 open(){this.onOpen();} setTitle(text){this.title=text;} close(){this.closed=true;this.onClose();}
}
export class PluginSettingTab { constructor(app,plugin){this.app=app;this.plugin=plugin;} }
export class Setting {
 constructor(container){this.settingEl=container.createDiv();}
 setName(name){this.name=name;this.settingEl.createSpan({text:name});return this;}
 setDesc(text){this.settingEl.createSpan({text});return this;}
 addText(build){const input=this.settingEl.createEl('input',{type:'text'});input.settingName=this.name;const text={inputEl:input,setValue(value){input.value=value;return this},onChange(action){input.addEventListener('change',()=>action(input.value));return this}};build(text);return this;}
 addDropdown(build){const select=this.settingEl.createEl('select');select.options=[];select.settingName=this.name;const dropdown={selectEl:select,addOption(value,text){select.options.push({value,text,disabled:false});return this},setValue(value){select.value=value;return this},onChange(action){select.addEventListener('change',()=>action(select.value));return this}};build(dropdown);return this;}
 addButton(build){const button=this.settingEl.createEl('button');Object.assign(button,{label:'',setButtonText(text){this.label=text;this.setText(text);return this},setCta(){return this},setDisabled(value){this.disabled=value;return this},onClick(action){this.action=action;this.click=async()=>{if(!this.isDisabled())return await action()};return this}});build(button);return this;}
}
`;
export async function loadFixture(entry) {
 const result=await build({entryPoints:[entry],bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"modal-host",setup(builder){
  builder.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"host"}));
  builder.onLoad({filter:/.*/,namespace:"host"},()=>({contents:mockHost}));
 }}]});
 return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
export function elements(root){return [root,...root.children.flatMap(elements)];}
export function button(modal,label="Unlock with 1Password"){return elements(modal.contentEl).find(el=>el.label===label);}
export function input(modal,name){return elements(modal.contentEl).find(el=>el.settingName===name);}
export function checkbox(modal){return elements(modal.contentEl).find(el=>el.type==='checkbox');}
