import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultLogDir } from "../src/logdir.js";

const dirStat = (uid, { dir = true, link = false } = {}) => ({ uid, isDirectory: () => dir, isSymbolicLink: () => link });
const enoent = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
const base = { platform: "linux", getuid: () => 1000, tmpdir: () => "/tmp/claude-1000", access: () => {} };

test("another user's /tmp/openclaw is skipped for <tmpdir>/openclaw-<uid>", () => {
  assert.equal(defaultLogDir({ ...base, lstat: () => dirStat(1010) }), "/tmp/claude-1000/openclaw-1000");
});

test("our own /tmp/openclaw is used", () => {
  assert.equal(defaultLogDir({ ...base, lstat: () => dirStat(1000) }), "/tmp/openclaw");
});

test("a symlink, a file, or a dir we cannot use falls back", () => {
  const fb = "/tmp/claude-1000/openclaw-1000";
  assert.equal(defaultLogDir({ ...base, lstat: () => dirStat(1000, { link: true }) }), fb);
  assert.equal(defaultLogDir({ ...base, lstat: () => dirStat(1000, { dir: false }) }), fb);
  assert.equal(defaultLogDir({ ...base, lstat: () => dirStat(1000), access: () => { throw new Error("EACCES"); } }), fb);
  assert.equal(defaultLogDir({ ...base, lstat: () => { throw Object.assign(new Error(), { code: "EACCES" }); } }), fb);
});

test("a missing /tmp/openclaw is used when /tmp is writable, as OpenClaw creates it", () => {
  assert.equal(defaultLogDir({ ...base, lstat: enoent }), "/tmp/openclaw");
  assert.equal(defaultLogDir({ ...base, lstat: enoent, access: () => { throw new Error("EACCES"); } }), "/tmp/claude-1000/openclaw-1000");
});

test("Windows always uses the tmpdir fallback", () => {
  assert.equal(defaultLogDir({ ...base, platform: "win32", lstat: () => dirStat(1000) }), path.join("/tmp/claude-1000", "openclaw-1000"));
});

test("real filesystem: a dir we own is accepted", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vtr-logdir-"));
  assert.equal(defaultLogDir({ preferred: d }), d);
});
