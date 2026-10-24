import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCacheFile, writeCacheFile } from "../src/lib/cache-file.js";

const mode = (p: string) => fs.statSync(p).mode & 0o777;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "homey-mcp-test-"));
}

test("writeCacheFile creates the directory 0700 and the file 0600", () => {
  const dir = path.join(tmp(), "sub");
  const file = path.join(dir, "cache.json");
  writeCacheFile(file, { address: "http://h", token: "t" });
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
  assert.deepEqual(readCacheFile(file), { address: "http://h", token: "t" });
});

test("writeCacheFile tightens an existing world-readable file and directory", () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o755);
  const file = path.join(dir, "cache.json");
  fs.writeFileSync(file, "{}", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  writeCacheFile(file, { address: "http://h", token: "t" });
  assert.equal(mode(file), 0o600);
  assert.equal(mode(dir), 0o700);
});

test("readCacheFile deletes a corrupt or incomplete cache and returns null", () => {
  const dir = tmp();
  const corrupt = path.join(dir, "a.json");
  fs.writeFileSync(corrupt, "{not json");
  assert.equal(readCacheFile(corrupt), null);
  assert.equal(fs.existsSync(corrupt), false);
  const incomplete = path.join(dir, "b.json");
  fs.writeFileSync(incomplete, JSON.stringify({ address: "http://h" }));
  assert.equal(readCacheFile(incomplete), null);
  assert.equal(fs.existsSync(incomplete), false);
  assert.equal(readCacheFile(path.join(dir, "missing.json")), null);
});

test("writeCacheFile does not follow a symlink planted at the temp path", () => {
  const dir = tmp();
  const file = path.join(dir, "cache.json");
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "keep me");
  fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
  writeCacheFile(file, { address: "http://h", token: "t" });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.deepEqual(readCacheFile(file), { address: "http://h", token: "t" });
  assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
});
