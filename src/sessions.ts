import { decrypt, deriveKey, encrypt, newEnvelope, parseEnvelope, ProtectionError, serializeEnvelope, validateIdentity, type EncryptedNoteEnvelope, type SecretIdentity } from "./envelope.ts";
import { hash, type RecoveryRecord, type RecoveryStore } from "./recovery.ts";

export interface NoteStorage {
	read(path: string): Promise<string>;
	compareAndSwap(path: string, baseline: string, replacement: string): Promise<void>;
	createRecoveryNote(path: string, envelope: string): Promise<string>;
}
export interface NoteSession {
	path: string;
	key: Buffer;
	envelope: EncryptedNoteEnvelope;
	baseline: string;
	text: string;
	revision: number;
	savedRevision: number;
	queue: Promise<void>;
	writing?: string;
}
export class ConflictError extends ProtectionError {}
export class NoteSessionCoordinator {
	readonly sessions = new Map<string, NoteSession>();
	onChange: (path: string, text: string) => void = () => {};
	readonly storage: NoteStorage;
	readonly recovery: RecoveryStore;
	constructor(storage: NoteStorage, recovery: RecoveryStore) { this.storage = storage; this.recovery = recovery; }
	async open(path: string, password: string, expected: string, current: () => boolean = () => true): Promise<NoteSession> {
		const previous = this.sessions.get(path);
		if (previous) return previous;
		const envelope = parseEnvelope(expected);
		const key = await deriveKey(password, envelope);
		try {
			const text = decrypt(envelope, key);
			if (!current()) throw new ProtectionError("Unlock cancelled.");
			if (await this.storage.read(path) !== expected) throw new ConflictError("The encrypted file changed while unlocking. Reopen it to retry.");
			const other = this.sessions.get(path);
			if (other) { key.fill(0); return other; }
			const session: NoteSession = { path, key, envelope, baseline: expected, text, revision: 0, savedRevision: 0, queue: Promise.resolve() };
			this.sessions.set(path, session);
			return session;
		} catch (error) { key.fill(0); throw error; }
	}
	async protect(path: string, text: string, baseline: string, password: string, identity: SecretIdentity, current: () => boolean = () => true): Promise<void> {
		const template = newEnvelope(identity);
		const key = await deriveKey(password, template);
		try {
			if (!current()) throw new ProtectionError("Encryption cancelled because the note changed or closed.");
			const envelope = serializeEnvelope(encrypt(text, key, template));
			await this.storage.compareAndSwap(path, baseline, envelope);
		} finally { key.fill(0); }
	}
	update(path: string, text: string): void {
		const session = this.require(path);
		if (text === session.text) return;
		session.text = text; session.revision++;
		this.onChange(path, text);
	}
	require(path: string): NoteSession {
		const session = this.sessions.get(path);
		if (!session) throw new ProtectionError("This note is locked.");
		return session;
	}
	checkpoint(path: string): RecoveryRecord {
		const session = this.require(path);
		const record: RecoveryRecord = { version: 1, path, baselineHash: hash(session.baseline), envelope: serializeEnvelope(encrypt(session.text, session.key, session.envelope)) };
		this.recovery.write(record);
		return record;
	}
	save(path: string): Promise<void> {
		const session = this.require(path);
		const operation = session.queue.catch(() => {}).then(async () => {
			if (session.revision === session.savedRevision) return;
			const revision = session.revision;
			const record = this.checkpoint(path);
			session.writing = record.envelope;
			try { await this.storage.compareAndSwap(path, session.baseline, record.envelope); }
			finally { session.writing = undefined; }
			session.baseline = record.envelope; session.envelope = parseEnvelope(record.envelope); session.savedRevision = revision;
			if (session.revision === revision) this.recovery.remove(path);
			else this.checkpoint(path);
		});
		session.queue = operation;
		return operation;
	}
	async lock(path: string, discard = false): Promise<"saved" | "recovery"> {
		const session = this.sessions.get(path);
		if (!session) return "saved";
		let result: "saved" | "recovery" = "saved";
		if (!discard) {
			try { while (session.revision !== session.savedRevision) await this.save(path); }
			catch { this.checkpoint(path); result = "recovery"; }
		} else { await session.queue.catch(() => {}); this.recovery.remove(path); }
		this.dispose(path);
		return result;
	}
	dispose(path: string): void {
		const session = this.sessions.get(path);
		if (!session) return;
		session.key.fill(0); session.text = ""; this.sessions.delete(path);
	}
	shutdown(): void {
		// Called synchronously by Plugin.onunload. No asynchronous plaintext saves.
		for (const session of this.sessions.values()) {
			if (session.revision !== session.savedRevision) this.checkpoint(session.path);
		}
		for (const path of [...this.sessions.keys()]) this.dispose(path);
	}
	async restoreRecovery(path: string, password: string, separate: boolean): Promise<string> {
		const record = this.recovery.read(path);
		if (!record) throw new ProtectionError("No encrypted recovery copy exists.");
		const envelope = parseEnvelope(record.envelope);
		const key = await deriveKey(password, envelope);
		try {
			const text = decrypt(envelope, key);
			if (separate) { const destination = await this.storage.createRecoveryNote(path, record.envelope); this.recovery.remove(path); return destination; }
			const session = this.require(path);
			if (hash(session.baseline) !== record.baselineHash) throw new ConflictError("The original file changed. Recover as a separate encrypted note instead.");
			this.update(path, text); await this.save(path); this.recovery.remove(path); return path;
		} finally { key.fill(0); }
	}
	async removeProtection(path: string): Promise<void> {
		const session = this.require(path);
		await this.save(path);
		await this.storage.compareAndSwap(path, session.baseline, session.text);
		this.recovery.remove(path); this.dispose(path);
	}
	async rebind(path: string, identity: SecretIdentity): Promise<void> {
		validateIdentity(identity);
		const session = this.require(path);
		session.envelope = { ...session.envelope, ...identity };
		session.revision++;
		await this.save(path);
	}
	rename(oldPath: string, newPath: string): void {
		const session = this.sessions.get(oldPath);
		const recovery = this.recovery.read(oldPath);
		if (recovery) { this.recovery.write({ ...recovery, path: newPath }); this.recovery.remove(oldPath); }
		if (session) { this.sessions.delete(oldPath); session.path = newPath; this.sessions.set(newPath, session); }
	}
}
