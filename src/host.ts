import { MarkdownView, type App, type TFile } from "obsidian";
import { hasProtectedMarker, parseEnvelope, ProtectionError } from "./envelope.ts";

/** Private host surface: inspect and test against the declared Obsidian version. */
export interface NativeMarkdownInternals {
	lastSavedData: string | null;
	dirty: boolean;
	saving: boolean;
	isPlaintext: boolean;
	rawFrontmatter: string | null;
	metadataEditor: { clear(): void };
	loadFileInternal(file: TFile, clear: boolean): Promise<void>;
	onInternalDataChange(): void;
	onExternalDataChange(file: TFile, text: string): void;
	loadFrontmatter(text: string): void;
}
export function native(view: MarkdownView): MarkdownView & NativeMarkdownInternals { return view as MarkdownView & NativeMarkdownInternals; }
export function requireNativeHost(view: MarkdownView): void {
	const host = native(view);
	const base = native(MarkdownView.prototype);
	for (const name of ["loadFileInternal", "onInternalDataChange", "onExternalDataChange", "loadFrontmatter"] as const) {
		if (typeof base[name] !== "function" || typeof host[name] !== "function") throw new ProtectionError("This Obsidian version has an unsupported editor lifecycle. Protected notes remain locked.");
	}
	if (!("lastSavedData" in view) || !("saving" in view)) throw new ProtectionError("This Obsidian version has an unsupported save lifecycle. Protected notes remain locked.");
	if (typeof host.metadataEditor?.clear !== "function") throw new ProtectionError("This Obsidian version has an unsupported property lifecycle. Protected notes remain locked.");
}

/** Reject accidental plaintext writes by core commands and ordinary plugins.
 * Direct filesystem access and malicious plugins are outside the trust boundary.
 */
export class VaultWriteGuard {
	readonly protectedPaths = new Set<string>();
	private plaintextWrites = new Map<string, string>();
	private restores: Array<() => void> = [];
	constructor(private app: App) {}
	install(): void {
		const vault = this.app.vault;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the exact original method, invoking it with its owning vault.
		const originalModify = vault.modify;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the exact original method, invoking it with its owning vault.
		const originalProcess = vault.process;
		const modify: typeof vault.modify = async (file, text, options) => {
			const current = await vault.cachedRead(file);
			this.check(file.path, current, text);
			return originalModify.call(vault, file, text, options);
		};
		const process: typeof vault.process = async (file, callback, options) => {
			return originalProcess.call(vault, file, (current) => { const next = callback(current); this.check(file.path, current, next); return next; }, options);
		};
		vault.modify = modify; vault.process = process;
		this.restores.push(() => { if (vault.modify === modify) vault.modify = originalModify; if (vault.process === process) vault.process = originalProcess; });
		const manager = this.app.fileManager as unknown as { storeTextFileBackup?: (path: string, content: string) => Promise<void> };
		const originalBackup = manager.storeTextFileBackup;
		if (!originalBackup) throw new ProtectionError("Obsidian's recovery lifecycle is unsupported.");
		const backup = async (path: string, text: string): Promise<void> => {
			if (this.protectedPaths.has(path)) {
				try { parseEnvelope(text); } catch { return; }
			}
			await originalBackup.call(manager, path, text);
		};
		manager.storeTextFileBackup = backup;
		this.restores.push(() => { if (manager.storeTextFileBackup === backup) manager.storeTextFileBackup = originalBackup; });
	}
	private check(path: string, current: string, next: string): void {
		if (hasProtectedMarker(current)) this.protectedPaths.add(path);
		if (!this.protectedPaths.has(path) || this.plaintextWrites.get(path) === next) return;
		try { parseEnvelope(next); }
		catch { throw new ProtectionError("This operation would write plaintext into a protected note and was blocked."); }
	}
	async allowPlaintext<T>(path: string, text: string, operation: () => Promise<T>): Promise<T> {
		this.plaintextWrites.set(path, text);
		try { return await operation(); } finally { this.plaintextWrites.delete(path); }
	}
	destroy(): void { for (const restore of this.restores.reverse()) restore(); this.restores = []; }
}
