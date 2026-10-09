import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtr-cfg-"));
const write = (name, data) => (fs.writeFileSync(path.join(dir, name), data), path.join(dir, name));

test("bot token can come from the OpenClaw config without copying it", () => {
  const oc = write("openclaw.json", JSON.stringify({ channels: { discord: { token: "dummy-token" } } }));
  const cfg = write("a.json", JSON.stringify({ bot: { channelId: "42", openclawConfig: oc } }));
  assert.equal(loadConfig({ file: cfg, env: {} }).bot.token, "dummy-token");
});

test("dry runs need neither a webhook nor a token", () => {
  const cfg = write("b.json", JSON.stringify({ bot: { channelId: "42" } }));
  assert.equal(loadConfig({ file: cfg, env: {}, needWebhook: false }).bot.token, undefined);
  const cfg2 = write("c.json", JSON.stringify({ webhook: { urlFile: path.join(dir, "missing") } }));
  assert.doesNotThrow(() => loadConfig({ file: cfg2, env: {}, needWebhook: false }));
});

test("a token that is a secret reference is refused with a hint", () => {
  const oc = write("ref.json", JSON.stringify({ channels: { discord: { token: { source: "store", id: "X" } } } }));
  const cfg = write("d.json", JSON.stringify({ bot: { channelId: "42", openclawConfig: oc } }));
  assert.throws(() => loadConfig({ file: cfg, env: {} }), /plain string/);
});
