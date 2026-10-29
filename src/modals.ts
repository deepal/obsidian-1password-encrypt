import { Modal, Setting, type App } from "obsidian";
import { ProtectionError, validateIdentity, type SecretIdentity } from "./envelope.ts";
import type { SecretProvider } from "./secrets.ts";
import type { RecoveryRecord } from "./recovery.ts";
import { hash } from "./recovery.ts";

/** Rejects errors containing host/SDK payloads: UI messages are deliberately fixed. */
export function userMessage(error: unknown): string {
	return error instanceof ProtectionError ? error.message : "The operation could not complete. Your note was not replaced with plaintext.";
}
export class ActionModal extends Modal {
	private done = false;
	private resolve!: (value: boolean) => void;
	private errorEl!: HTMLElement;
	private busy = false;
	constructor(app: App, private title: string, private description: string, private action: () => Promise<void>, private button = "Unlock with 1Password", private extra?: (container: HTMLElement) => void) { super(app); }
	wait(): Promise<boolean> { const result = new Promise<boolean>((resolve) => { this.resolve = resolve; }); this.open(); return result; }
	onOpen(): void {
		this.setTitle(this.title);
		this.contentEl.createEl("p", { text: this.description });
		this.extra?.(this.contentEl);
		this.errorEl = this.contentEl.createDiv("protected-notes-error");
		new Setting(this.contentEl).addButton((button) => button.setButtonText(this.button).setCta().onClick(async () => {
			if (this.busy) return; this.busy = true; button.setDisabled(true);
			this.errorEl.setText("");
			try { await this.action(); if (!this.done) { this.done = true; this.resolve(true); this.close(); } }
			catch (error) { this.errorEl.setText(userMessage(error)); }
			finally { this.busy = false; button.setDisabled(false); }
		})).addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
	}
	onClose(): void { if (!this.done) { this.done = true; this.resolve(false); } this.contentEl.empty(); }
}
export class SetupModal extends Modal {
	private resolve!: (identity: SecretIdentity | null) => void;
	private done = false;
	private busy = false;
	private password = "";
	private confirmation = "";
	private created: SecretIdentity | null = null;
	private createAttempted = false;
	constructor(app: App, private provider: SecretProvider, private initial: SecretIdentity, private save: (identity: SecretIdentity) => Promise<void>) { super(app); }
	wait(): Promise<SecretIdentity | null> { const result = new Promise<SecretIdentity | null>((resolve) => { this.resolve = resolve; }); this.open(); return result; }
	onOpen(): void {
		this.setTitle("Set up encryption");
		let account = this.initial.account, secretRef = this.initial.secretRef, mode = "existing", vaultId = "";
		new Setting(this.contentEl).setName("1Password account").setDesc("Enter the account name or ID shown in 1Password.").addText((text) => text.setValue(account).onChange((value) => { account = value.trim(); }));
		new Setting(this.contentEl).setName("Secret").addDropdown((dropdown) => dropdown.addOption("existing", "Use an existing secret").addOption("create", "Create a password").onChange((value) => { mode = value; existing.settingEl.toggleClass("protected-notes-hidden", mode !== "existing"); createGroup.toggleClass("protected-notes-hidden", mode !== "create"); }));
		const existing = new Setting(this.contentEl).setName("Secret reference").setDesc("Copy a reference containing vault, item, and field identifiers.").addText((text) => text.setValue(secretRef).onChange((value) => { secretRef = value.trim(); }));
		const createGroup = this.contentEl.createDiv("protected-notes-hidden");
		const vault = new Setting(createGroup).setName("1Password vault");
		vault.addDropdown((dropdown) => {
			dropdown.addOption("", "Choose a vault").onChange((value) => { vaultId = value; });
			vault.addButton((button) => button.setButtonText("Load vaults").onClick(async () => {
				button.setDisabled(true);
				errorEl.setText("");
				try { for (const item of await this.provider.listVaults(account)) dropdown.addOption(item.id, item.title); }
				catch (error) { errorEl.setText(userMessage(error)); } finally { button.setDisabled(false); }
			}));
		});
		new Setting(createGroup).setName("Password").setDesc("Use a long, unique passphrase. This is separate from your 1Password account password.").addText((text) => { text.inputEl.type = "password"; text.inputEl.autocomplete = "new-password"; text.onChange((value) => { this.password = value; }); });
		new Setting(createGroup).setName("Confirm password").addText((text) => { text.inputEl.type = "password"; text.inputEl.autocomplete = "new-password"; text.onChange((value) => { this.confirmation = value; }); });
		const errorEl = this.contentEl.createDiv("protected-notes-error");
		const referenceEl = this.contentEl.createDiv("protected-notes-reference");
		new Setting(this.contentEl).addButton((button) => button.setButtonText("Save and verify").setCta().onClick(async () => {
			if (this.busy) return; this.busy = true; button.setDisabled(true);
			errorEl.setText("");
			try {
				if (mode === "create" && !this.created) {
					if (!vaultId || !this.password || this.password !== this.confirmation) throw new ProtectionError("Choose a vault and enter matching, nonempty passwords.");
					if (this.createAttempted) throw new ProtectionError("Creation could not be confirmed. Check 1Password for the new item and use its existing reference; another item will not be created automatically.");
					this.createAttempted = true;
					this.created = await this.provider.createPassword(account, vaultId, this.password);
					referenceEl.setText(`Created secret reference: ${this.created.secretRef}. Keep this reference if verification fails. Do not create another item on retry.`);
				}
				const identity = this.created ?? { account, secretRef }; validateIdentity(identity);
				let value = await this.provider.resolve(identity);
				if (this.created && value !== this.password) throw new ProtectionError("The saved password did not match. No note was encrypted.");
				value = "";
				if (this.done) return;
				await this.save(identity);
				this.done = true; this.resolve(identity); this.close();
			} catch (error) { errorEl.setText(userMessage(error)); }
			finally { this.busy = false; button.setDisabled(false); }
		})).addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
	}
	onClose(): void { this.password = ""; this.confirmation = ""; this.contentEl.empty(); if (!this.done) { this.done = true; this.resolve(null); } }
}
export type RecoveryChoice = "restore" | "separate" | "discard" | "cancel";
export class RecoveryModal extends Modal {
	private resolve!: (choice: RecoveryChoice) => void;
	private done = false;
	constructor(app: App, private record: RecoveryRecord, private baseline: string) { super(app); }
	wait(): Promise<RecoveryChoice> { const promise = new Promise<RecoveryChoice>((resolve) => { this.resolve = resolve; }); this.open(); return promise; }
	onOpen(): void {
		this.setTitle("Encrypted recovery found");
		this.contentEl.createEl("p", { text: "There are unsaved encrypted edits for this note. Choose how to recover them." });
		const settings = new Setting(this.contentEl);
		for (const [choice, label] of [["restore", "Restore edits"], ["separate", "Recover as separate note"], ["discard", "Discard recovery"], ["cancel", "Cancel"]] as const) settings.addButton((button) => button.setButtonText(label).setDisabled(choice === "restore" && this.record.baselineHash !== hash(this.baseline)).onClick(() => { this.done = true; this.resolve(choice); this.close(); }));
	}
	onClose(): void { if (!this.done) this.resolve("cancel"); this.contentEl.empty(); }
}
