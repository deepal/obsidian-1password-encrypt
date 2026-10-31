import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import config from "../release.config.mjs";
const exec=promisify(execFile);
test("release preparation synchronizes metadata and preserves compatibility history",async(t)=>{
	const cwd=await mkdtemp(join(tmpdir(),"protected-notes-release-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
	const originals={"package.json":{version:"0.1.0",private:true},"package-lock.json":{version:"0.1.0",packages:{"":{version:"0.1.0"}}},"manifest.json":{id:"1password-encrypt",version:"0.1.0",minAppVersion:"1.14.5"},"versions.json":{"0.1.0":"1.14.5"}};
	for(const [name,value] of Object.entries(originals))await writeFile(join(cwd,name),JSON.stringify(value));
	const script=fileURLToPath(new URL("../scripts/prepare-release.mjs",import.meta.url));
	await assert.rejects(exec(process.execPath,[script,"v1.0.0"],{cwd}));
	await exec(process.execPath,[script,"1.0.0"],{cwd});
	for(const file of ["package.json","manifest.json","package-lock.json"])assert.equal(JSON.parse(await readFile(join(cwd,file))).version,"1.0.0");
	assert.deepEqual(JSON.parse(await readFile(join(cwd,"versions.json"))),{"0.1.0":"1.14.5","1.0.0":"1.14.5"});
});
test("Conventional Commits choose appropriate bumps and release tags are bare versions",async()=>{
	assert.equal(config.tagFormat,"${version}");
	const options=config.plugins.find(([name])=>name==="@semantic-release/commit-analyzer")[1];
	for(const [message,bump] of [["fix: avoid plaintext recovery","patch"],["feat: add protection","minor"],["feat!: change encrypted format","major"],["docs: clarify recovery",null]])assert.equal(await analyzeCommits(options,{cwd:process.cwd(),commits:[{hash:"abc123",message}],logger:{log(){}}}),bump);
});
