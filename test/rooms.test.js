// Several bots in one Gateway (0.5.0): transcript lines that name their room,
// per-room state, and the `rooms` plugin config.
import test from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../src/parse.js";
import { Relay } from "../src/relay.js";
import { roomConfigs } from "../openclaw/index.js";
import { resolvePluginConfig } from "../openclaw/config.js";
import { G, U1, U2, at, joined, turn, line, sessionEnded } from "./fixtures.js";

const CA = "200000000000000010"; // room of bot A
const CB = "200000000000000020"; // room of bot B
const saidIn = (role, text, c) =>
  line(`discord voice: realtime ${role} transcript (${text.length} chars) guild=${G} channel=${c}: ${text}`);

test("parses the room on a tagged transcript line, and text that contains ': '", () => {
  const t = parseLine(saidIn("user", "note: hi", CA));
  assert.deepEqual({ type: t.type, text: t.text, guildId: t.guildId, channelId: t.channelId }, { type: "user", text: "note: hi", guildId: G, channelId: CA });
});

test("two bots talking at once: each relay keeps only its room, with the right speaker", () => {
  const a = new Relay({ assistantName: "A", channelIds: [CA] });
  const b = new Relay({ assistantName: "B", channelIds: [CB] });
  const lines = [
    (at(0), joined(G, CA)),
    (at(10), joined(G, CB)),
    (at(20), turn(U1, "Alice", G, CA)),
    (at(30), turn(U2, "Bob", G, CB)),
    (at(40), saidIn("user", "hello A", CA)),
    (at(50), saidIn("user", "hello B", CB)),
    (at(60), saidIn("assistant", "hi Alice", CA)),
    (at(70), saidIn("assistant", "hi Bob", CB)),
    (at(80), sessionEnded(G, CB)),
    (at(90), saidIn("assistant", "still here", CA)),
    (at(100), sessionEnded(G, CA)),
  ];
  const outA = lines.map((l) => a.push(parseLine(l))).filter(Boolean);
  const outB = lines.map((l) => b.push(parseLine(l))).filter(Boolean);
  const show = (out) => out.map((o) => (o.kind === "line" ? `${o.speaker}: ${o.text} @${o.channelId}` : `${o.kind} @${o.channelId}`));
  assert.deepEqual(show(outA), [`session @${CA}`, `Alice: hello A @${CA}`, `A: hi Alice @${CA}`, `A: still here @${CA}`, `session-end @${CA}`]);
  assert.deepEqual(show(outB), [`session @${CB}`, `Bob: hello B @${CB}`, `B: hi Bob @${CB}`, `session-end @${CB}`]);
  // B leaving did not end A's stay, and B joining did not start a new session for A.
  assert.equal(outA.filter((o) => o.kind === "session").length, 1);
});

test("untagged transcripts (older Gateways) still follow the latest room, as in 0.4", () => {
  const r = new Relay({ assistantName: "Bot", channelIds: [CA] });
  const out = [joined(G, CA), turn(U1, "Alice", G, CA), line("discord voice: realtime user transcript (2 chars): hi")]
    .map((l) => r.push(parseLine(l)))
    .filter(Boolean);
  assert.equal(out.at(-1).text, "hi");
  assert.equal(out.at(-1).speaker, "Alice");
  assert.equal(r.present, true);
});

test("rooms: shared keys under each room, first room keeps the plain state file", () => {
  const pcs = roomConfigs({
    flushMs: 5000,
    rooms: [
      { channelIds: [CA], assistantName: "A", accountId: "default" },
      { channelIds: [CB], assistantName: "B", accountId: "kopuu" },
    ],
  });
  assert.equal(pcs.length, 2);
  const [a, b] = pcs.map((pc) => resolvePluginConfig(pc, { env: {}, stateDir: "/s" }));
  assert.deepEqual([a.flushMs, a.assistantName, a.accountId, a.stateFile], [5000, "A", "default", "/s/voice-transcript-relay/state.json"]);
  assert.deepEqual([b.flushMs, b.assistantName, b.accountId, b.stateFile], [5000, "B", "kopuu", "/s/voice-transcript-relay/state-kopuu.json"]);
  assert.equal(roomConfigs({ channelIds: [CA] }).length, 1);
});
