import { PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
import type ProtectedNotesPlugin from "./main.ts";
export class ProtectedNotesSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ProtectedNotesPlugin) { super(app, plugin); }
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: "1Password account", desc: "Account name or ID. Existing notes retain their original account and reference.", control: { type: "text", key: "account" } },
			{ name: "Default secret reference", desc: "An op:// reference containing vault, item, and field IDs. Used only when encrypting new notes.", aliases: ["password", "secret URI", "recovery"], control: { type: "text", key: "secretRef", placeholder: "op://vault-id/item-id/password" } },
			{ name: "Set up protection", desc: "Create a password in 1Password or use an existing secret. The password is never saved in plugin settings.", render: (setting) => { setting.addButton((button) => button.setButtonText("Set up").onClick(() => { void this.plugin.configureSecret(); })); } },
		];
	}
}
