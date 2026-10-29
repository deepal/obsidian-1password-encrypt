import { readFile, writeFile } from "node:fs/promises";
const version = process.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Expected a stable semantic version, for example: 1.2.3");
const files = ["package.json", "package-lock.json", "manifest.json", "versions.json"];
const [pkg, lock, manifest, versions] = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
pkg.version = lock.version = lock.packages[""].version = manifest.version = version;
versions[version] = manifest.minAppVersion;
await Promise.all([pkg, lock, manifest, versions].map((data, index) => writeFile(files[index], JSON.stringify(data, null, "\t") + "\n")));
