import encodedWasm from "protected-notes:wasm-bytes";

let compiled: WebAssembly.Module | undefined;
let preparing: Promise<void> | undefined;
let initialization: Promise<void> | undefined;
/** Electron prohibits synchronous WASM compilation above 8 MiB on its UI thread. */
export async function prepareSdkWasm(): Promise<void> {
	preparing ??= WebAssembly.compile(Buffer.from(encodedWasm, "base64")).then((module) => { compiled = module; }).catch(() => { preparing = undefined; throw new Error("Could not initialize the 1Password SDK."); });
	await preparing;
}
export function compiledSdkWasm(): WebAssembly.Module {
	if (!compiled) throw new Error("Initialize the 1Password SDK before importing its core.");
	return compiled;
}
export function registerSdkInitialization(promise: Promise<void>): void { initialization = promise; }
export async function finishSdkInitialization(): Promise<void> {
	if (!initialization) throw new Error("The 1Password SDK core was not initialized.");
	await initialization;
}
