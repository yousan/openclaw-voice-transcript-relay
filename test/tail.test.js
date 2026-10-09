import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogFollower, logFileFor } from "../src/tail.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vtr-"));
}

test("log file name follows OpenClaw's profile convention", () => {
  const d = new Date(2026, 0, 2);
  assert.equal(path.basename(logFileFor("/x", "work", d)), "openclaw-work-2026-01-02.log");
  assert.equal(path.basename(logFileFor("/x", "", d)), "openclaw-2026-01-02.log");
});

test("starts at the end, reads appended lines, and waits for the newline", () => {
  const dir = tmp();
  const f = path.join(dir, "a.log");
  fs.writeFileSync(f, "old\n");
  const got = [];
  const fl = new LogFollower({ resolvePath: () => f, onLine: (l, p) => got.push([l, p.offset]) });
  fl.poll();
  fs.appendFileSync(f, "new1\nne");
  fl.poll();
  fs.appendFileSync(f, "w2\n");
  fl.poll();
  assert.deepEqual(got, [
    ["new1", 9],
    ["new2", 14],
  ]);
});

test("multi-byte text split across reads stays intact", () => {
  const dir = tmp();
  const f = path.join(dir, "a.log");
  fs.writeFileSync(f, "");
  const got = [];
  const fl = new LogFollower({ resolvePath: () => f, onLine: (l) => got.push(l) });
  fl.poll();
  const bytes = Buffer.from("こんにちは\n");
  fs.appendFileSync(f, bytes.subarray(0, 4));
  fl.poll();
  fs.appendFileSync(f, bytes.subarray(4));
  fl.poll();
  assert.deepEqual(got, ["こんにちは"]);
});

test("finishes the old file after a size rotation, then follows the new one", () => {
  const dir = tmp();
  const f = path.join(dir, "a.log");
  fs.writeFileSync(f, "");
  const got = [];
  const fl = new LogFollower({ resolvePath: () => f, onLine: (l) => got.push(l) });
  fl.poll();
  fs.appendFileSync(f, "before\n");
  fs.renameSync(f, `${f}.1`);
  fs.appendFileSync(`${f}.1`, "late\n");
  fs.writeFileSync(f, "after\n");
  fl.poll();
  assert.deepEqual(got, ["before", "late", "after"]);
});

test("switches to the next day's file", () => {
  const dir = tmp();
  let name = path.join(dir, "d1.log");
  fs.writeFileSync(name, "");
  const got = [];
  const fl = new LogFollower({ resolvePath: () => name, onLine: (l) => got.push(l) });
  fl.poll();
  fs.appendFileSync(name, "day1\n");
  name = path.join(dir, "d2.log");
  fl.poll(); // d2 does not exist yet: keep reading d1
  fs.writeFileSync(name, "day2\n");
  fl.poll();
  assert.deepEqual(got, ["day1", "day2"]);
});

test("resumes from a saved position, also when that file was rotated", () => {
  const dir = tmp();
  const f = path.join(dir, "a.log");
  fs.writeFileSync(f, "one\ntwo\n");
  const ino = fs.statSync(f).ino;
  fs.renameSync(f, `${f}.1`);
  fs.writeFileSync(f, "three\n");
  const got = [];
  const fl = new LogFollower({ resolvePath: () => f, onLine: (l) => got.push(l), resume: { file: f, ino, offset: 4 } });
  fl.poll();
  assert.deepEqual(got, ["two", "three"]);
});
