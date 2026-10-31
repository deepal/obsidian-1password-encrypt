import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Writable } from "node:stream";
import semanticRelease from "semantic-release";
import config from "../release.config.mjs";

const exec = promisify(execFile), project = fileURLToPath(new URL("..", import.meta.url));
const metadata = ["package.json", "package-lock.json", "manifest.json", "versions.json"];

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "1password-encrypt-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "checkout"), remote = path.join(root, "remote.git");
  await mkdir(path.join(cwd, "scripts"), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|^GIT_|^GITHUB_|^CI$|^OBSIDIAN_/.test(key)));
  Object.assign(env, { GIT_AUTHOR_NAME: "Release test", GIT_AUTHOR_EMAIL: "release@example.test", GIT_COMMITTER_NAME: "Release test", GIT_COMMITTER_EMAIL: "release@example.test", OBSIDIAN_PLUGIN_DIR: path.join(root, "must-not-deploy"), OBSIDIAN_VAULT_DIR: path.join(root, "must-not-touch") });
  const git = (...args) => exec("git", args, { cwd, env });
  await exec("git", ["init", "--bare", "--initial-branch=main", remote], { env });
  await git("init", "--initial-branch=main");
  // Keep a genuine URL for the notes generator, with Git confined to a local
  // bare repository. No credential or network access is needed by these tests.
  const repositoryUrl = "https://example.test/1password-encrypt.git";
  await git("config", `url.${pathToFileURL(remote).href}.insteadOf`, repositoryUrl);
  await git("remote", "add", "origin", repositoryUrl);
  const files = {
    "package.json": JSON.stringify({ name: "1password-encrypt-release-test", version: "0.1.0", private: true, type: "module", scripts: { build: "node build.mjs" } }),
    "package-lock.json": JSON.stringify({ version: "0.1.0", lockfileVersion: 3, packages: { "": { version: "0.1.0" } } }),
    "manifest.json": JSON.stringify({ id: "1password-encrypt", version: "0.1.0", minAppVersion: "1.14.5", isDesktopOnly: true }),
    "versions.json": JSON.stringify({ "0.1.0": "1.14.5" }),
    ".gitignore": "node_modules\nmain.js\n",
    "styles.css": ".1password-encrypt-review {}\n",
    "build.mjs": `import fs from 'node:fs';
if(process.env.OBSIDIAN_PLUGIN_DIR || process.env.OBSIDIAN_VAULT_DIR) throw Error('Release must disable deployment');
if(process.env.FAIL_RELEASE_BUILD) throw Error('intentional build failure');
fs.writeFileSync('main.js', '/* build '+JSON.parse(fs.readFileSync('manifest.json')).version+' */'+' '.repeat(10_000_001));\n`,
  };
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(cwd, name), contents + "\n");
  for (const script of ["prepare-release.mjs", "check-artifacts.mjs"]) await copyFile(path.join(project, "scripts", script), path.join(cwd, "scripts", script));
  await symlink(path.join(project, "node_modules"), path.join(cwd, "node_modules"), "dir");
  const commit = async message => { await git("add", "--", ...Object.keys(files), "scripts/prepare-release.mjs", "scripts/check-artifacts.mjs"); await git("commit", "--allow-empty", "-m", message); await git("push", "-u", "origin", "main"); };
  const run = (options = {}) => semanticRelease({ ...config, repositoryUrl, plugins: config.plugins.filter(([name]) => name !== "@semantic-release/github"), ci: false, dryRun: false, ...options }, { cwd, env: { ...env }, stdout: new Writable({ write(_data, _encoding, done) { done(); } }), stderr: new Writable({ write(_data, _encoding, done) { done(); } }) });
  const json = async name => JSON.parse(await readFile(path.join(cwd, name), "utf8"));
  return { cwd, env, git, commit, run, json };
}

test("real release lifecycle covers first, patch, minor, major, and no-op releases", async t => {
  const f = await fixture(t);
  for (const [message, version] of [["feat: add note encryption", "1.0.0"], ["fix: fix note locking", "1.0.1"], ["feat: add recovery options", "1.1.0"], ["feat!: change encrypted format", "2.0.0"]]) {
    await f.commit(message);
    const result = await f.run();
    assert.equal(result.nextRelease.version, version);
    assert.equal(result.nextRelease.gitTag, version);
    for (const file of metadata.slice(0, 3)) assert.equal((await f.json(file)).version, version);
    assert.equal((await f.json("package-lock.json")).packages[""].version, version);
    assert.equal((await f.json("versions.json"))[version], "1.14.5");
    assert.equal((await f.json("versions.json"))["0.1.0"], "1.14.5");
    assert.match(await readFile(path.join(f.cwd, "main.js"), "utf8"), new RegExp(version.replaceAll(".", "\\.")));
    assert.equal((await f.git("rev-parse", "HEAD")).stdout, (await f.git("rev-list", "-n", "1", version)).stdout);
    assert.match((await f.git("ls-remote", "--tags", "origin", version)).stdout, new RegExp(`refs/tags/${version}`));
    assert.equal((await f.git("status", "--porcelain")).stdout, "");
  }
  await f.commit("docs: clarify setup instructions");
  assert.equal(await f.run(), false);
});

test("dry runs predict the version without writing metadata, changelog, or tags", async t => {
  const f = await fixture(t);
  await f.commit("feat: add note encryption");
  const before = await Promise.all(metadata.map(name => readFile(path.join(f.cwd, name), "utf8")));
  const result = await f.run({ dryRun: true });
  assert.equal(result.nextRelease.version, "1.0.0");
  assert.deepEqual(await Promise.all(metadata.map(name => readFile(path.join(f.cwd, name), "utf8"))), before);
  assert.equal((await f.git("tag", "--list")).stdout, "");
  await assert.rejects(readFile(path.join(f.cwd, "CHANGELOG.md")), { code: "ENOENT" });
});

test("a failed release build cannot create or push a release commit or tag", async t => {
  const f = await fixture(t);
  await f.commit("feat: add note encryption");
  const head = (await f.git("rev-parse", "HEAD")).stdout;
  f.env.FAIL_RELEASE_BUILD = "1";
  await assert.rejects(f.run(), /intentional build failure/);
  assert.equal((await f.git("rev-parse", "HEAD")).stdout, head);
  assert.equal((await f.git("tag", "--list")).stdout, "");
  assert.equal((await f.git("ls-remote", "--tags", "origin")).stdout, "");
  assert.match((await f.git("ls-remote", "origin", "refs/heads/main")).stdout, new RegExp(head.trim()));
});
