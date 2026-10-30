import { Modal, Setting, type App, type TextComponent } from "obsidian";
import { ProtectionError, validateIdentity, type SecretIdentity } from "./envelope.ts";
import type { SecretProvider, SecretVault } from "./secrets.ts";
import type { RecoveryRecord } from "./recovery.ts";
import { hash } from "./recovery.ts";

const SDK_SETTING_NAME = "Integrate with 1Password SDKs";
const SDK_SETTINGS_PATH = "Settings → Developer";

/** Rejects errors containing host/SDK payloads: UI messages are deliberately fixed. */
export function userMessage(error: unknown): string {
	return error instanceof ProtectionError ? error.message : "The operation could not complete. Your note was not replaced with plaintext.";
}
export class ActionModal extends Modal {
	private done = false;
	private resolve!: (value: boolean) => void;
	private errorEl!: HTMLElement;
	private busy = false;
	constructor(app: App, private title: string, private description: string, private action: () => Promise<void>, private button = "Open with 1Password", private extra?: (container: HTMLElement) => void) { super(app); }
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
	private account: string;
	private secretRef: string;
	private acknowledged = false;
	private vaults: SecretVault[] = [];
	private connectedAccount: string | null = null;
	private mode = "existing";
	private vaultId = "";
	private password = "";
	private confirmation = "";
	private created: SecretIdentity | null = null;
	private createAttempted = false;
	constructor(app: App, private provider: SecretProvider, initial: SecretIdentity, private save: (identity: SecretIdentity) => Promise<void>) {
		super(app); this.account = initial.account.trim(); this.secretRef = initial.secretRef.trim();
	}
	wait(): Promise<SecretIdentity | null> { const result = new Promise<SecretIdentity | null>((resolve) => { this.resolve = resolve; }); this.open(); return result; }
	onOpen(): void {
		this.modalEl.addClass("protected-notes-setup-modal");
		this.contentEl.addClass("protected-notes-setup");
		this.renderConnection();
	}
	private message(role: "status" | "alert", cls = ""): HTMLDivElement {
		return this.contentEl.createDiv({ cls, attr: { role, "aria-live": role === "alert" ? "assertive" : "polite", "aria-atomic": "true" } });
	}
	private renderConnection(): void {
		this.contentEl.empty(); this.setTitle("Connect to 1Password");
		this.contentEl.createEl("p", { text: "Step 1 of 2", cls: "protected-notes-step" });
		const instructions = this.contentEl.createDiv("protected-notes-instructions");
		instructions.createEl("h3", { text: "Enable access in 1Password" });
		const steps = instructions.createEl("ol");
		for (const text of ["Open the 1Password desktop app.", `Go to ${SDK_SETTINGS_PATH}.`, `Enable ${SDK_SETTING_NAME}.`, "Keep 1Password running and return to Obsidian."]) steps.createEl("li", { text });
		instructions.createEl("a", { text: "1Password SDK integration documentation", href: "https://www.1password.dev/sdks/desktop-app-integrations" });
		this.contentEl.createEl("p", { text: "Approve access in the 1Password app. Its prompt may identify the requesting application as Obsidian." });
		const fields = this.contentEl.createEl("fieldset", { cls: "protected-notes-fields" });
		const label = fields.createEl("label", { cls: "protected-notes-acknowledgement" });
		const checkbox = label.createEl("input", { type: "checkbox" }); checkbox.checked = this.acknowledged;
		label.createSpan({ text: `I’ve enabled “${SDK_SETTING_NAME}”` });
		let update = () => {};
		let accountInput!: TextComponent;
		new Setting(fields).setName("1Password account").setDesc("Enter the account name or ID shown in 1Password.").addText((text) => {
			accountInput = text; text.setValue(this.account).onChange((value) => { if (!this.busy && !this.done) { this.account = value.trim(); update(); } });
		});
		const status = this.message("status"), errorEl = this.message("alert", "protected-notes-error");
		let failed = false;
		const buttons = new Setting(this.contentEl);
		buttons.addButton((button) => {
			const refresh = () => { button.setDisabled(this.busy || !this.acknowledged || !this.account).setButtonText(this.busy ? "Connecting…" : failed ? "Try again" : "Connect to 1Password"); };
			update = refresh; refresh();
			button.setCta().onClick(async () => {
				if (this.done || this.busy || !this.acknowledged || !this.account) return;
				this.busy = true; fields.disabled = true; refresh(); errorEl.setText(""); status.setText("Connecting to 1Password…");
				const account = this.account;
				try {
					const vaults = await this.provider.listVaults(account);
					if (this.done) return;
					this.connectedAccount = account; this.vaults = vaults; this.busy = false;
					this.renderSecret(); this.titleEl.focus();
				} catch {
					if (this.done) return;
					failed = true; status.setText("");
					errorEl.setText(`Could not connect to 1Password. Keep the desktop app open and signed in, enable “${SDK_SETTING_NAME}” in ${SDK_SETTINGS_PATH}, check the account name or ID, and approve the request in 1Password. Then try again.`);
				} finally { if (!this.done) { this.busy = false; fields.disabled = false; refresh(); } }
			});
		}).addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
		checkbox.addEventListener("change", () => { if (!this.busy && !this.done) { this.acknowledged = checkbox.checked; update(); } });
		accountInput.inputEl.focus();
	}
	private renderSecret(): void {
		const account = this.connectedAccount;
		if (!account || this.done) return;
		this.contentEl.empty(); this.setTitle("Choose a password"); this.titleEl.tabIndex = -1;
		this.contentEl.createEl("p", { text: "Step 2 of 2", cls: "protected-notes-step" });
		this.message("status", "protected-notes-connected").setText(`Connected to 1Password — ${this.connectedAccount}`);
		this.contentEl.createEl("p", { text: "Your secret will be verified again before settings are saved." });
		const fields = this.contentEl.createEl("fieldset", { cls: "protected-notes-fields" });
		let changeMode = () => {};
		new Setting(fields).setName("Secret").addDropdown((dropdown) => {
			dropdown.addOption("existing", "Use an existing secret").addOption("create", "Create a password").setValue(this.mode).onChange((value) => { if (!this.busy && !this.done) { this.mode = value; changeMode(); } });
			for (const option of Array.from(dropdown.selectEl.options)) if (option.value === "create") option.disabled = this.vaults.length === 0;
		});
		if (!this.vaults.length) fields.createEl("p", { text: "No vaults are available for creating a password in this account. You can still enter an existing secret reference and verify access to it." });
		const existing = new Setting(fields).setName("Secret reference").setDesc("Copy a reference containing vault, item, and field identifiers.").addText((text) => text.setValue(this.secretRef).onChange((value) => { this.secretRef = value.trim(); }));
		const createGroup = fields.createDiv();
		const vault = new Setting(createGroup).setName("1Password vault");
		vault.addDropdown((dropdown) => {
			dropdown.addOption("", "Choose a vault").onChange((value) => { this.vaultId = value; });
			for (const item of this.vaults) dropdown.addOption(item.id, item.title);
			dropdown.setValue(this.vaultId);
		});
		new Setting(createGroup).setName("Password").setDesc("Use a long, unique passphrase. This is separate from your 1Password account password.").addText((text) => { text.inputEl.type = "password"; text.inputEl.autocomplete = "new-password"; text.onChange((value) => { this.password = value; }); });
		new Setting(createGroup).setName("Confirm password").addText((text) => { text.inputEl.type = "password"; text.inputEl.autocomplete = "new-password"; text.onChange((value) => { this.confirmation = value; }); });
		changeMode = () => { existing.settingEl.toggleClass("protected-notes-hidden", this.mode !== "existing"); createGroup.toggleClass("protected-notes-hidden", this.mode !== "create"); }; changeMode();
		const errorEl = this.message("alert", "protected-notes-error");
		const status = this.message("status");
		const referenceEl = this.contentEl.createDiv("protected-notes-reference");
		let disableBack = (_disabled: boolean) => {};
		new Setting(this.contentEl).addButton((button) => button.setButtonText("Save and verify").setCta().onClick(async () => {
			if (this.done || this.busy) return; this.busy = true; button.setDisabled(true); fields.disabled = true; disableBack(true);
			errorEl.setText(""); status.setText("Verifying the secret in 1Password…");
			try {
				if (this.mode === "create" && !this.created) {
					if (!this.vaultId || !this.password || this.password !== this.confirmation) throw new ProtectionError("Choose a vault and enter matching, nonempty passwords.");
					if (this.createAttempted) throw new ProtectionError("Creation could not be confirmed. Check 1Password for the new item and use its existing reference; another item will not be created automatically.");
					this.createAttempted = true;
					const created = await this.provider.createPassword(account, this.vaultId, this.password);
					if (this.done) return;
					this.created = created;
					referenceEl.setText(`Created secret reference: ${this.created.secretRef}. Keep this reference if verification fails. Do not create another item on retry.`);
				}
				const identity = this.created ?? { account, secretRef: this.secretRef }; validateIdentity(identity);
				let value = await this.provider.resolve(identity);
				try {
					if (this.done) return;
					if (this.created && value !== this.password) throw new ProtectionError("The saved password did not match. No note was encrypted.");
					await this.save(identity);
					if (!this.done) { this.done = true; this.resolve(identity); this.close(); }
				} finally { value = ""; }
			} catch (error) { if (!this.done) errorEl.setText(this.createAttempted && !this.created ? "Creation could not be confirmed. Check 1Password for “1password Encrypt password” and use its existing reference; another item will not be created automatically." : userMessage(error)); }
			finally { if (!this.done) { this.busy = false; button.setDisabled(false); fields.disabled = Boolean(this.created); disableBack(this.createAttempted); status.setText(""); } }
		})).addButton((button) => {
			disableBack = (disabled) => { button.setDisabled(disabled); };
			button.setButtonText("Back").onClick(() => {
				if (this.done || this.busy || this.createAttempted) return;
				this.password = ""; this.confirmation = ""; this.vaultId = ""; this.vaults = []; this.connectedAccount = null;
				this.mode = "existing"; this.renderConnection();
			});
		}).addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
	}
	onClose(): void { this.password = ""; this.confirmation = ""; this.vaults = []; this.connectedAccount = null; this.created = null; this.contentEl.empty(); if (!this.done) { this.done = true; this.resolve(null); } }
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
