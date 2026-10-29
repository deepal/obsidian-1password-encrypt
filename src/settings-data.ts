import { validateIdentity, type SecretIdentity } from "./envelope.ts";
export type ProtectedNotesSettings = SecretIdentity;
export const DEFAULT_SETTINGS: ProtectedNotesSettings = { account: "", secretRef: "" };
export function normalizeSettings(raw: unknown): ProtectedNotesSettings {
	const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	return { account: typeof data.account === "string" ? data.account.trim() : "", secretRef: typeof data.secretRef === "string" ? data.secretRef.trim() : "" };
}
export function isConfigured(settings: ProtectedNotesSettings): boolean {
	try { validateIdentity(settings); return true; } catch { return false; }
}
