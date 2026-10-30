import { MarkdownView, type TFile, type WorkspaceLeaf } from "obsidian";
import { native, requireNativeHost } from "./host.ts";
import type ProtectedNotesPlugin from "./main.ts";

export const PROTECTED_VIEW = "protected-notes";
export class ProtectedMarkdownView extends MarkdownView {
	private locked = true;
	private synchronizing = false;
	private lockEl: HTMLElement;
	private generation = 0;
	constructor(leaf: WorkspaceLeaf, readonly owner: ProtectedNotesPlugin) {
		super(leaf);
		requireNativeHost(this);
		native(this).isPlaintext = false;
		this.lockEl = this.contentEl.createDiv("protected-notes-lock");
		this.showLocked();
	}
	getViewType(): string { return PROTECTED_VIEW; }
	getIcon(): string { return "lock-keyhole"; }
	isUnlocked(): boolean { return !this.locked; }
	// A different file must first use Obsidian's normal view routing. Otherwise
	// a protected tab would claim ordinary Markdown notes on navigation.
	canAcceptExtension(_extension: string): boolean { return false; }
	/** Replaces TextFileView's raw-file loader and ciphertext merge behaviour. */
	async loadFileInternal(file: TFile, clear: boolean): Promise<void> {
		const token = ++this.generation;
		const source = await this.app.vault.read(file);
		if (token !== this.generation || this.file !== file || !this.owner.enabled) return;
		this.owner.guard.protectedPaths.add(file.path);
		const session = this.owner.coordinator.sessions.get(file.path);
		if (session) {
			if (source !== session.baseline && source !== session.writing) { await this.owner.externalChange(file.path); return; }
			this.showUnlocked(session.text, clear);
		} else { this.showLocked(); }
	}
	/** Native source/preview modes stay intact. Global plaintext previews do not. */
	onInternalDataChange(): void {
		if (this.locked || this.synchronizing || !this.file || !this.owner.enabled) return;
		const text = super.getViewData();
		this.data = text;
		native(this).loadFrontmatter(text);
		this.owner.changed(this.file.path, text);
	}
	onExternalDataChange(_file: TFile, _text: string): void { /* Session coordinator owns synchronization. */ }
	async save(clear = false): Promise<void> {
		if (!this.locked && this.file && this.owner.enabled && this.owner.coordinator.sessions.has(this.file.path)) {
			this.owner.changed(this.file.path, super.getViewData());
			await this.owner.coordinator.save(this.file.path);
		}
		native(this).dirty = false;
		if (clear) {
			this.locked = true; this.synchronizing = true;
			try { this.clearNativeSecrets(); }
			finally { this.synchronizing = false; }
		}
	}
	getViewData(): string { return this.locked ? "" : super.getViewData(); }
	setViewData(text: string, clear: boolean): void {
		if (!this.locked) this.showUnlocked(text, clear);
	}
	showUnlocked(text: string, clear = false): void {
		if (!this.owner.enabled || !this.file || !this.owner.coordinator.sessions.has(this.file.path)) return;
		this.synchronizing = true;
		try {
			const wasLocked = this.locked; this.locked = false;
			if (wasLocked || clear || super.getViewData() !== text) super.setViewData(text, wasLocked || clear);
			this.data = text;
			for (const child of Array.from(this.contentEl.children)) child.classList.toggle("protected-notes-hidden", child === this.lockEl);
		} finally { this.synchronizing = false; }
	}
	showLocked(message = "This note is protected. Open it with 1Password to read or edit it."): void {
		this.locked = true; this.generation++;
		this.clearNativeSecrets();
		this.lockEl.empty();
		this.lockEl.createEl("h2", { text: "Protected note" });
		this.lockEl.createEl("p", { text: message, cls: "protected-notes-message" });
		const button = this.lockEl.createEl("button", { text: "Open with 1Password", cls: "mod-cta" });
		button.addEventListener("click", () => { if (this.file) void this.owner.unlockNote(this.file.path); });
		for (const child of Array.from(this.contentEl.children)) child.classList.toggle("protected-notes-hidden", child !== this.lockEl);
	}
	private clearNativeSecrets(): void {
		super.clear(); this.data = "";
		const host = native(this);
		host.lastSavedData = null; host.dirty = false;
		host.loadFrontmatter(""); host.metadataEditor.clear(); host.rawFrontmatter = null;
	}
	async onUnloadFile(file: TFile): Promise<void> {
		if (!this.locked && this.owner.coordinator.sessions.has(file.path)) {
			try { await this.save(true); }
			catch { this.owner.coordinator.checkpoint(file.path); this.showLocked("Unsaved edits were preserved in encrypted recovery."); }
		}
		this.generation++;
		await super.onUnloadFile(file);
	}
	async onClose(): Promise<void> {
		if (!this.locked && this.file && this.owner.enabled && this.owner.coordinator.sessions.has(this.file.path)) this.owner.changed(this.file.path, super.getViewData());
		this.locked = true; this.generation++; this.clearNativeSecrets(); await super.onClose();
	}
}
