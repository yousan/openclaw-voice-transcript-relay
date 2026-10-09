import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../openclaw/index.js";
import { resolvePluginConfig } from "../openclaw/config.js";
import { C, joined, turn, said, U1 } from "./fixtures.js";

function fakeApi({ pluginConfig, stateDir }) {
  const sent = [];
  const services = [];
  const api = {
    registrationMode: "full",
    pluginConfig,
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    registerService: (s) => services.push(s),
    runtime: {
      config: { current: () => ({ marker: "live" }) },
      state: { resolveStateDir: () => stateDir },
      channel: {
        outbound: {
          loadAdapter: async (id) => ({
            sendText: async (ctx) => (sent.push({ id, ...ctx }), { channel: id, messageId: `m${sent.length}` }),
          }),
        },
      },
    },
  };
  return { api, sent, services };
}

test("the service posts the room's lines into the voice channel's own chat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtr-plugin-"));
  const logFile = path.join(dir, "gateway.log");
  fs.writeFileSync(logFile, "");
  const { api, sent, services } = fakeApi({
    pluginConfig: { logFile, flushMs: 0, pollMs: 100, assistantName: "Bot", sessionHeader: false },
    stateDir: dir,
  });
  plugin.register(api);
  assert.equal(services.length, 1);
  await services[0].start({});
  await new Promise((r) => setTimeout(r, 150));
  fs.appendFileSync(logFile, [joined(), turn(U1, "Alice"), said("user", "hi"), said("assistant", "hello")].join("\n") + "\n");
  await new Promise((r) => setTimeout(r, 300));
  await services[0].stop();
  assert.deepEqual(
    sent.map((s) => [s.id, s.to, s.text, s.cfg.marker]),
    [
      ["discord", `channel:${C}`, "**Alice**: hi", "live"],
      ["discord", `channel:${C}`, "**Bot**: hello", "live"],
    ],
  );
  const state = JSON.parse(fs.readFileSync(path.join(dir, "voice-transcript-relay", "state.json"), "utf8"));
  assert.equal(state.offset, fs.statSync(logFile).size);
});

test("does nothing outside full registration", () => {
  const { api, services } = fakeApi({ pluginConfig: {}, stateDir: "/x" });
  api.registrationMode = "tool-discovery";
  plugin.register(api);
  assert.equal(services.length, 0);
});

test("plugin config defaults follow the Gateway's profile and state dir", () => {
  const c = resolvePluginConfig({}, { env: { OPENCLAW_PROFILE: "work" }, stateDir: "/s" });
  assert.equal(c.profile, "work");
  assert.equal(c.stateFile, "/s/voice-transcript-relay/state.json");
  assert.equal(c.flushMs, 5000);
  assert.equal(c.webhook, undefined);
});
