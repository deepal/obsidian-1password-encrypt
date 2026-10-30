import { FileSystemAdapter, MarkdownView, Notice, Plugin, Setting, TFile, type WorkspaceLeaf } from "obsidian";
import { join } from "node:path";
import { hasProtectedMarker, parseEnvelope, ProtectionError } from "./envelope.ts";
import { VaultWriteGuard, native, requireNativeHost } from "./host.ts";
import { ActionModal, RecoveryModal, SetupModal, userMessage } from "./modals.ts";
import { ProtectedMarkdownView, PROTECTED_VIEW } from "./protected-view.ts";
import { FileRecoveryStore } from "./recovery.ts";
import { OnePasswordProvider, type SecretProvider } from "./secrets.ts";
import { DEFAULT_SETTINGS, isConfigured, normalizeSettings, type ProtectedNotesSettings } from "./settings-data.ts";
import { ProtectedNotesSettingTab } from "./settings.ts";
import { ConflictError, NoteSessionCoordinator } from "./sessions.ts";

export default class ProtectedNotesPlugin extends Plugin {
	settings: ProtectedNotesSettings = { ...DEFAULT_SETTINGS };
	provider: SecretProvider = new OnePasswordProvider();
	coordinator!: NoteSessionCoordinator;
	guard!: VaultWriteGuard;
	enabled = false;
	private ready = false;
	private routing = new Set<WorkspaceLeaf>();
	private transitioning = new Set<string>();
	private prompts = new Map<string, ActionModal>();
	private routeGeneration = 0;
	private activePath: string | null = null;
	private setup: Promise<ProtectedNotesSettings | null> | null = null;
	private departing = new Set<string>();
	private requestedPrompts = new Set<string>();
	private opening = new Set<string>();
	private messageTimes = new Map<string, number>();

	async onload(): Promise<void> {
		this.provider = new OnePasswordProvider(this.manifest.version);
		this.settings = normalizeSettings(await this.loadData());
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new ProtectionError("Protected notes require a desktop filesystem vault.");
		this.guard = new VaultWriteGuard(this.app);
		this.register(() => this.guard.destroy());
		this.guard.install();
		this.coordinator = new NoteSessionCoordinator({
			read: (path) => this.app.vault.read(this.note(path)),
			compareAndSwap: async (path, baseline, replacement) => {
				await this.app.vault.process(this.note(path), (current) => {
					if (current !== baseline) throw new ConflictError("The file changed outside this editor. Local edits remain in encrypted recovery.");
					return replacement;
				});
			},
			createRecoveryNote: async (path, envelope) => {
				const stem = path.replace(/\.md$/i, "") + " (recovered)";
				let file = `${stem}.md`, number = 1;
				while (this.app.vault.getAbstractFileByPath(file)) file = `${stem} ${number++}.md`;
				await this.app.vault.create(file, envelope); this.guard.protectedPaths.add(file); return file;
			},
		}, new FileRecoveryStore(join(adapter.getBasePath(), this.app.vault.configDir, "plugins", this.manifest.id, "recovery")));
		this.coordinator.onChange = (path, text) => { for (const view of this.views(path)) view.showUnlocked(text); };
		this.enabled = true;
		this.registerView(PROTECTED_VIEW, (leaf) => new ProtectedMarkdownView(leaf, this));
		this.addSettingTab(new ProtectedNotesSettingTab(this.app, this));
		this.registerCommands();
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			if (this.ready) { void this.routeAll(false); void Promise.resolve().then(() => this.lockClosedNotes()); }
		}));
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (!this.ready) return;
			// Sidebar focus and temporary native mode changes can emit null while
			// the most-recent note is still open. Only another note changes focus.
			if (file) {
				this.activePath = file.path;
				for (const [path, modal] of this.prompts) if (path !== file.path) modal.close();
				for (const path of this.coordinator.sessions.keys()) if (path !== file.path && !this.transitioning.has(path)) void this.run(() => this.lockNote(path));
			}
			void this.routeAll(Boolean(file));
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile && file.extension === "md" && !this.transitioning.has(file.path)) void this.routeAll(false);
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			try { this.coordinator.rename(oldPath, file.path); }
			catch (error) { this.report(error); }
			if (this.guard.protectedPaths.delete(oldPath)) this.guard.protectedPaths.add(file.path);
			if (this.activePath === oldPath) this.activePath = file.path;
		}));
		this.app.workspace.onLayoutReady(() => {
			this.ready = true; this.activePath = this.app.workspace.getActiveFile()?.path ?? null;
			void this.routeAll(false);
		});
	}
	private lockClosedNotes(): void {
		if (!this.enabled) return;
		const open = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => { if (leaf.view instanceof MarkdownView && leaf.view.file) open.add(leaf.view.file.path); });
		for (const path of this.coordinator.sessions.keys()) if (!open.has(path) && !this.transitioning.has(path)) void this.run(() => this.lockNote(path));
		for (const [path, modal] of this.prompts) if (!open.has(path)) modal.close();
	}
	note(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.extension !== "md") throw new ProtectionError("Open a Markdown note first.");
		return file;
	}
	/** Palette/settings focus must not lose the current document or revive a
	 * closed note from activePath. This also follows the most recent popout pane.
	 */
	private currentNote(): TFile | null {
		const view = this.app.workspace.getMostRecentLeaf()?.view;
		if (!(view instanceof MarkdownView) || !(view.file instanceof TFile) || view.file.extension !== "md") return null;
		return this.app.vault.getAbstractFileByPath(view.file.path) === view.file ? view.file : null;
	}
	private currentPath(): string {
		const file = this.currentNote();
		if (!file) throw new ProtectionError("Open a Markdown note first.");
		return file.path;
	}
	private registerCommands(): void {
		const canUseNote = (protectedNote: boolean) => {
			const file = this.currentNote();
			if (!file || this.transitioning.has(file.path) || this.departing.has(file.path)) return false;
			const protectedFile = this.app.workspace.getMostRecentLeaf()?.view instanceof ProtectedMarkdownView || this.guard.protectedPaths.has(file.path) || this.coordinator.sessions.has(file.path);
			return protectedFile === protectedNote;
		};
		for (const [id, name, available, run] of [
			["encrypt-note", "Protect this note", () => canUseNote(false), () => this.encryptNote()],
			["remove-protection", "Remove protection", () => canUseNote(true), () => this.removeProtection()],
			["lock-all-notes", "Lock all protected notes now", () => this.coordinator.sessions.size > 0 || this.prompts.size > 0 || this.opening.size > 0, () => this.lockAll()],
			["configure-secret", "Set up 1Password", () => true, () => this.configureSecret()],
		] as const) this.addCommand({ id, name, checkCallback: (checking) => {
			if (!this.enabled || !available()) return false;
			if (!checking) void this.run(run);
			return true;
		} });
	}
	views(path?: string): ProtectedMarkdownView[] {
		const result: ProtectedMarkdownView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => { if (leaf.view instanceof ProtectedMarkdownView && (!path || leaf.view.file?.path === path)) result.push(leaf.view); });
		return result;
	}
	private async routeAll(prompt: boolean): Promise<void> {
		if (!this.enabled) return;
		if (prompt && this.activePath) this.requestedPrompts.add(this.activePath);
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => { if (leaf.view instanceof MarkdownView && !(leaf.view instanceof ProtectedMarkdownView)) leaves.push(leaf); });
		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file || view.file.extension !== "md" || this.routing.has(leaf) || this.transitioning.has(view.file.path)) continue;
			const file = view.file;
			this.routing.add(leaf);
			try {
				const contents = await this.app.vault.read(file);
				if (!this.enabled || leaf.view !== view || view.file !== file || !hasProtectedMarker(contents)) continue;
				this.guard.protectedPaths.add(file.path);
				const state = view.getState();
				// Make stale native debounce callbacks inert before changing view type.
				native(view).lastSavedData = null; native(view).dirty = false; view.clear();
				await leaf.setViewState({ type: PROTECTED_VIEW, state: { ...state, file: file.path } });
			} catch (error) { this.report(error); }
			finally { this.routing.delete(leaf); }
		}
		const path = this.activePath;
		if (path && this.requestedPrompts.has(path) && this.views(path).length && !this.transitioning.has(path)) {
			this.requestedPrompts.delete(path);
			void this.run(() => this.unlockNote(path));
		}
	}
	async configureSecret(): Promise<ProtectedNotesSettings | null> {
		if (!this.setup) this.setup = new SetupModal(this.app, this.provider, this.settings, async (identity) => { this.settings = normalizeSettings(identity); await this.saveData(this.settings); }).wait().finally(() => { this.setup = null; });
		return this.setup;
	}
	async encryptNote(): Promise<void> {
		const path = this.currentPath();
		if (this.transitioning.has(path)) return;
		const originalFile = this.note(path);
		if (hasProtectedMarker(await this.app.vault.read(originalFile))) throw new ProtectionError("This note is already protected.");
		if (!isConfigured(this.settings) && !await this.configureSecret()) return;
		let password = await this.provider.resolve(this.settings);
		if (!this.enabled || this.currentNote()?.path !== path) { password = ""; return; }
		this.transitioning.add(path);
		const ordinary: Array<{ leaf: WorkspaceLeaf; view: MarkdownView; state: Record<string, unknown> }> = [];
		try {
			this.app.workspace.iterateAllLeaves((leaf) => { if (leaf.view instanceof MarkdownView && !(leaf.view instanceof ProtectedMarkdownView) && leaf.view.file === originalFile) ordinary.push({ leaf, view: leaf.view, state: leaf.view.getState() }); });
			const buffers = ordinary.map(({ view }) => view.getViewData());
			for (const { view } of ordinary) requireNativeHost(view);
			if (new Set(buffers).size > 1) throw new ConflictError("Open panes contain conflicting edits. Reconcile them before encrypting.");
			const text = buffers[0] ?? await this.app.vault.read(originalFile);
			for (const { view } of ordinary) view.contentEl.inert = true;
			// Freeze native writers first; no outstanding plaintext save may outlive
			// the transition. A pending native save is allowed to finish beforehand.
			for (const { view } of ordinary) {
				await view.save();
				for (let attempts = 0; native(view).saving; attempts++) {
					if (attempts > 100) throw new ProtectionError("A note save is still pending. Retry encryption when it completes.");
					await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
				}
			}
			const baseline = await this.app.vault.read(originalFile);
			if (baseline !== text || ordinary.some(({ view }) => view.file !== originalFile || view.getViewData() !== text)) throw new ConflictError("The note changed while preparing encryption. Retry after its saves complete.");
			for (const { view } of ordinary) { native(view).lastSavedData = null; native(view).dirty = false; }
			this.guard.protectedPaths.add(path);
			await this.coordinator.protect(path, text, baseline, password, { ...this.settings }, () => this.enabled && ordinary.every(({ view, leaf }) => leaf.view === view && view.file === originalFile));
			for (const { leaf, view, state } of ordinary) {
				view.clear();
				await leaf.setViewState({ type: PROTECTED_VIEW, state: { ...state, file: path } });
			}
			new Notice("Note protected. Open it with 1Password whenever you need it.");
		} catch (error) {
			if (!hasProtectedMarker(await this.app.vault.read(originalFile))) {
				this.guard.protectedPaths.delete(path);
				for (const { view } of ordinary) if (view.file === originalFile) native(view).lastSavedData = await this.app.vault.read(originalFile);
			}
			throw error;
		} finally { password = ""; for (const { view } of ordinary) view.contentEl.inert = false; this.transitioning.delete(path); }
	}
	async unlockNote(path: string): Promise<void> {
		if (!this.enabled || this.prompts.has(path) || this.opening.has(path)) return;
		this.opening.add(path);
		try { await this.openUnlockModal(path, this.routeGeneration); }
		finally { this.opening.delete(path); }
	}
	private async openUnlockModal(path: string, token: number): Promise<void> {
		if (this.coordinator.sessions.has(path)) { for (const view of this.views(path)) view.showUnlocked(this.coordinator.require(path).text); return; }
		const source = await this.app.vault.read(this.note(path));
		if (!this.enabled || token !== this.routeGeneration || this.currentNote()?.path !== path || !this.views(path).length) return;
		let identity;
		try { identity = parseEnvelope(source); } catch (error) { this.report(error); return; }
		const selected = { account: identity.account, secretRef: identity.secretRef };
		let modal: ActionModal;
		modal = new ActionModal(this.app, "Open protected note", "Approve access in 1Password to read or edit this note. It stays protected while you work.", async () => {
			const current = () => this.enabled && token === this.routeGeneration && this.prompts.get(path) === modal && this.currentNote()?.path === path && this.views(path).length > 0;
			let password = await this.provider.resolve(selected);
			try {
				if (!current()) throw new ProtectionError("Unlock cancelled.");
				await this.coordinator.open(path, password, source, current);
				const recovery = this.coordinator.recovery.read(path);
				if (recovery) {
					const choice = await new RecoveryModal(this.app, recovery, source).wait();
					if (!current() || choice === "cancel") { this.coordinator.dispose(path); throw new ProtectionError("Unlock cancelled. Encrypted recovery was preserved."); }
					if (choice === "discard") this.coordinator.recovery.remove(path);
					else await this.coordinator.restoreRecovery(path, password, choice === "separate");
				}
				if (!current()) { await this.coordinator.lock(path); throw new ProtectionError("Unlock cancelled."); }
				if (selected.account !== identity.account || selected.secretRef !== identity.secretRef) await this.coordinator.rebind(path, selected);
				if (!current()) { await this.coordinator.lock(path); throw new ProtectionError("Unlock cancelled."); }
				for (const view of this.views(path)) view.showUnlocked(this.coordinator.require(path).text, true);
			} catch (error) { if (!this.views(path).some((view) => view.getViewData())) this.coordinator.dispose(path); throw error; }
			finally { password = ""; }
		}, "Open with 1Password", (container) => {
			const details = container.createEl("details");
			details.createEl("summary", { text: "Locate an existing secret" });
			new Setting(details).setName("1Password account").addText((text) => text.setValue(selected.account).onChange((value) => { selected.account = value.trim(); }));
			new Setting(details).setName("Secret reference").setDesc("The same password value must still be available. The reference changes only after successful decryption.").addText((text) => text.setValue(selected.secretRef).onChange((value) => { selected.secretRef = value.trim(); }));
		});
		this.prompts.set(path, modal);
		try { await modal.wait(); }
		finally { if (this.prompts.get(path) === modal) this.prompts.delete(path); }
	}
	changed(path: string, text: string): void {
		try { this.coordinator.update(path, text); const session = this.coordinator.require(path); if (session.revision !== session.savedRevision) this.coordinator.checkpoint(path); }
		catch (error) { this.report(error); }
	}
	async lockNote(path: string): Promise<void> {
		if (this.departing.has(path)) return;
		this.departing.add(path);
		const views = this.views(path);
		try {
			this.prompts.get(path)?.close();
			this.captureEdits(path);
			for (const view of views) view.contentEl.inert = true;
			const result = await this.coordinator.lock(path);
			for (const view of this.views(path)) view.showLocked();
			if (result === "recovery") new Notice("Note locked. Unsaved edits are preserved in encrypted recovery.");
		} catch (error) {
			void new ActionModal(this.app, "Could not lock note", "Neither the note nor its encrypted recovery could be saved. Keep it open and retry, or explicitly discard unsaved edits.", async () => {
				await this.coordinator.lock(path, true); for (const view of this.views(path)) view.showLocked();
			}, "Discard unsaved edits and lock").wait();
			throw error;
		} finally { for (const view of views) view.contentEl.inert = false; this.departing.delete(path); }
	}
	private captureEdits(path: string): void {
		const session = this.coordinator.sessions.get(path);
		if (!session) return;
		const changed = new Set(this.views(path).filter((view) => view.isUnlocked()).map((view) => view.getViewData()).filter((text) => text !== session.text));
		if (changed.size > 1) throw new ConflictError("Open panes contain conflicting edits. Reconcile them before locking.");
		const text = changed.values().next().value;
		if (text !== undefined) this.changed(path, text);
	}
	async lockAll(): Promise<void> {
		this.routeGeneration++;
		this.requestedPrompts.clear();
		for (const modal of this.prompts.values()) modal.close();
		for (const path of [...this.coordinator.sessions.keys()]) await this.lockNote(path);
	}
	async externalChange(path: string): Promise<void> { await this.lockNote(path); this.report(new ProtectionError("The encrypted file changed outside this editor. Open it again with 1Password to read it or recover local edits.")); }
	async removeProtection(): Promise<void> {
		const path = this.currentPath();
		if (!this.coordinator.sessions.has(path)) await this.unlockNote(path);
		if (!this.coordinator.sessions.has(path)) return;
		await new ActionModal(this.app, "Remove note protection?", "This writes the entire note back as ordinary plaintext Markdown. Search, sync, backups, and other plugins will be able to read it. The 1Password item will be preserved.", async () => {
			const session = this.coordinator.require(path);
			this.transitioning.add(path);
			try {
				await this.guard.allowPlaintext(path, session.text, () => this.coordinator.removeProtection(path));
				this.guard.protectedPaths.delete(path);
				for (const view of this.views(path)) await view.leaf.setViewState({ type: "markdown", state: { ...view.getState(), file: path } });
			} finally { this.transitioning.delete(path); }
		}, "Remove protection").wait();
	}
	private async run(action: () => unknown): Promise<void> { try { await action(); } catch (error) { this.report(error); } }
	report(error: unknown): void {
		const message = userMessage(error), now = Date.now();
		if (now - (this.messageTimes.get(message) ?? 0) > 3000) { new Notice(message, 8000); this.messageTimes.set(message, now); }
	}
	onunload(): void {
		this.routeGeneration++;
		for (const modal of this.prompts.values()) modal.close(); this.prompts.clear();
		try {
			if (this.coordinator) for (const path of this.coordinator.sessions.keys()) this.captureEdits(path);
			this.coordinator?.shutdown();
		} catch (error) { this.report(error); }
		this.enabled = false;
		for (const view of this.views()) view.showLocked("The plugin is disabled. Re-enable 1password Encrypt to unlock this note.");
		this.provider.dispose();
	}
}
