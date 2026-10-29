import { ProtectionError, validateIdentity, type SecretIdentity } from "./envelope.ts";
import type { Client } from "@1password/sdk";
import { prepareSdkWasm, finishSdkInitialization } from "./sdk-wasm.ts";

export interface SecretVault { id: string; title: string }
export interface SecretProvider {
	authorize(account: string): Promise<void>;
	listVaults(account: string): Promise<SecretVault[]>;
	createPassword(account: string, vaultId: string, password: string): Promise<SecretIdentity>;
	resolve(identity: SecretIdentity): Promise<string>;
	dispose(): void;
}
export const secretError = () => new ProtectionError("1Password could not complete the request. Check that the desktop app is installed, signed in, and has SDK integrations enabled, then authorize access and retry.");
async function loadSdk(): Promise<typeof import("@1password/sdk")> {
	await prepareSdkWasm();
	const imported = await import("@1password/sdk");
	await finishSdkInitialization();
	// The SDK ships CommonJS. Electron and Node expose its namespace differently;
	// use the actual CommonJS exports instead of relying on synthesized getters.
	return (imported as unknown as { default?: typeof imported }).default ?? imported;
}
export class OnePasswordProvider implements SecretProvider {
	constructor(private integrationVersion = "0.1.0", private sdkLoader: () => Promise<typeof import("@1password/sdk")> = loadSdk) {}
	private clients = new Map<string, Promise<Client>>();
	private disposed = false;
	private client(account: string): Promise<Client> {
		if (this.disposed || !account.trim()) throw secretError();
		let pending = this.clients.get(account);
		if (!pending) {
			pending = this.sdkLoader().then((sdk) => {
				if (this.disposed) throw secretError();
				return sdk.createClient({ auth: new sdk.DesktopAuth(account), integrationName: "1password Encrypt", integrationVersion: this.integrationVersion });
			});
			this.clients.set(account, pending);
		}
		return pending;
	}
	/** A desktop client belongs to one 1Password process/session. Any failed SDK
	 * operation must retire it so the next explicit attempt can reconnect. Never
	 * retry mutations here: creation might already have succeeded remotely.
	 */
	private async request<T>(account: string, operation: (client: Client) => Promise<T>): Promise<T> {
		let pending: Promise<Client> | undefined;
		try {
			pending = this.client(account);
			const client = await pending;
			if (this.disposed) throw secretError();
			return await operation(client);
		} catch {
			// An older request may fail after another request already replaced its
			// connection. Do not evict that newer connection.
			if (pending && this.clients.get(account) === pending) this.clients.delete(account);
			throw secretError();
		}
	}
	async authorize(account: string): Promise<void> { await this.request(account, () => Promise.resolve()); }
	async listVaults(account: string): Promise<SecretVault[]> {
		return await this.request(account, async (client) => (await client.vaults.list({ decryptDetails: true })).map((vault) => ({ id: vault.id, title: vault.title ?? vault.id })));
	}
	async createPassword(account: string, vaultId: string, password: string): Promise<SecretIdentity> {
		try {
			const sdk = await this.sdkLoader();
			return await this.request(account, async (client) => {
				const item = await client.items.create({ title: "1password Encrypt password", category: sdk.ItemCategory.Password, vaultId, fields: [{ id: "password", title: "password", fieldType: sdk.ItemFieldType.Concealed, value: password }] });
				return { account, secretRef: `op://${item.vaultId}/${item.id}/password` };
			});
		} catch { throw secretError(); }
	}
	async resolve(identity: SecretIdentity): Promise<string> {
		validateIdentity(identity);
		return await this.request(identity.account, async (client) => {
			const value = await client.secrets.resolve(identity.secretRef);
			if (!value) throw secretError();
			return value;
		});
	}
	dispose(): void { this.disposed = true; this.clients.clear(); }
}
