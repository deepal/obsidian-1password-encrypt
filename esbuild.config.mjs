import esbuild from "esbuild";
import { builtinModules, createRequire } from "node:module";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const production = process.argv[2] === "production";
// Obsidian installs only main.js, manifest.json and styles.css. Embed the SDK's
// pinned WASM at build time rather than downloading/extracting executable assets.
const inlineSdkWasm = {
	name: "inline-1password-wasm",
	setup(build) {
		build.onResolve({ filter: /^protected-notes:wasm-bytes$/ }, () => ({ path: join(dirname(require.resolve("@1password/sdk-core")), "core_bg.wasm") }));
		build.onResolve({ filter: /^protected-notes:compiled-sdk-wasm$/ }, () => ({ path: join(import.meta.dirname, "src/sdk-wasm.ts") }));
		build.onLoad({ filter: /core_bg\.wasm$/ }, async ({ path }) => ({ contents: `export default ${JSON.stringify((await readFile(path)).toString("base64"))};`, loader: "js" }));
		build.onLoad({ filter: /sdk-core[/\\]nodejs[/\\]core\.js$/ }, async ({ path }) => {
			let contents = await readFile(path, "utf8");
			const loader = /const path = require\('path'\)\.join\(__dirname, 'core_bg\.wasm'\);\s*const bytes = require\('fs'\)\.readFileSync\(path\);\s*const wasmModule = new WebAssembly\.Module\(bytes\);/g;
			if ([...contents.matchAll(loader)].length !== 1) throw new Error("The pinned 1Password WASM loader changed; review the bundler.");
			contents = contents.replace(loader, `const wasmModule = require('protected-notes:compiled-sdk-wasm').compiledSdkWasm();`);
			const instance = /const wasmInstance = new WebAssembly\.Instance\(wasmModule, imports\);\s*wasm = wasmInstance\.exports;\s*module\.exports\.__wasm = wasm;\s*wasm\.__wbindgen_start\(\);/g;
			if ([...contents.matchAll(instance)].length !== 1) throw new Error("The pinned 1Password WASM initialization changed; review the bundler.");
			contents = contents.replace(instance, `require('protected-notes:compiled-sdk-wasm').registerSdkInitialization(WebAssembly.instantiate(wasmModule, imports).then(instance => { wasm = instance.exports; module.exports.__wasm = wasm; wasm.__wbindgen_start(); }));`);
			return { contents, loader: "js" };
		});
	},
};
const deployment = {
	name: "explicit-vault-deployment",
	setup(build) {
		build.onEnd(async ({ errors }) => {
			if (errors.length) return;
			const destination = process.env.OBSIDIAN_PLUGIN_DIR || (process.env.OBSIDIAN_VAULT_DIR && join(process.env.OBSIDIAN_VAULT_DIR, ".obsidian/plugins/password-protected-notes"));
			if (!destination) return;
			await mkdir(destination, { recursive: true });
			await Promise.all(["main.js", "manifest.json", "styles.css"].map((file) => copyFile(file, join(destination, file))));
		});
	},
};
const context = await esbuild.context({
	entryPoints: ["src/main.ts"], bundle: true, platform: "node", format: "cjs",
	target: "es2020", outfile: "main.js", sourcemap: production ? false : "inline",
	minify: production,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, "node:*"],
	plugins: [inlineSdkWasm, deployment],
	banner: { js: "/* Generated bundle. Source: obsidian-password-protected-notes.\n" + await readFile("THIRD_PARTY_NOTICES.md", "utf8") + "\n*/" },
});
if (production) { await context.rebuild(); await context.dispose(); }
else await context.watch();
