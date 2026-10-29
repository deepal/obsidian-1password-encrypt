import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnvelope, ProtectionError } from "./envelope.ts";

export interface RecoveryRecord { version: 1; path: string; baselineHash: string; envelope: string }
export interface RecoveryStore {
	read(path: string): RecoveryRecord | null;
	write(record: RecoveryRecord): void;
	remove(path: string): void;
}
export function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
/** Only authenticated ciphertext and non-secret routing metadata reach disk. */
export class FileRecoveryStore implements RecoveryStore {
	private directory: string;
	constructor(directory: string) { this.directory = directory; }
	private location(path: string): string { return join(this.directory, `${hash(path)}.json`); }
	read(path: string): RecoveryRecord | null {
		const file = this.location(path);
		if (!existsSync(file)) return null;
		try {
			const record = JSON.parse(readFileSync(file, "utf8")) as RecoveryRecord;
			if (record.version !== 1 || record.path !== path || !/^[a-f0-9]{64}$/.test(record.baselineHash)) throw new Error();
			parseEnvelope(record.envelope);
			return record;
		} catch { throw new ProtectionError("The encrypted recovery copy is damaged. It has been left unchanged."); }
	}
	write(record: RecoveryRecord): void {
		parseEnvelope(record.envelope);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const destination = this.location(record.path);
		const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
		try { writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" }); renameSync(temporary, destination); }
		catch { if (existsSync(temporary)) unlinkSync(temporary); throw new ProtectionError("Could not save encrypted recovery. Keep this note open and retry saving."); }
	}
	remove(path: string): void { const location = this.location(path); if (existsSync(location)) unlinkSync(location); }
}
