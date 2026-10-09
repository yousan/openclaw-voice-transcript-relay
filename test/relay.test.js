import test from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../src/parse.js";
import { Relay } from "../src/relay.js";
import { formatLine, chunk } from "../src/outbox.js";
import { G, C, U1, U2, at, joined, turn, said, line } from "./fixtures.js";

function run(lines, options = {}) {
  const relay = new Relay({ assistantName: "Bot", allChannels: true, ...options });
  return lines.map((l) => relay.push(parseLine(l))).filter(Boolean);
}

test("parses the four line kinds and ignores everything else", () => {
  assert.equal(parseLine("not json"), null);
  assert.equal(parseLine(line("discord voice: realtime audio playback stopped reason=player-idle")), null);
  assert.deepEqual(
    { ...parseLine(turn(U1, "Alice")), at: 0 },
    { type: "turn", at: 0, guildId: G, channelId: C, userId: U1, speaker: "Alice", owner: true },
  );
  const t = parseLine(said("assistant", "hello"));
  assert.equal(t.type, "assistant");
  assert.equal(t.text, "hello");
  assert.equal(t.truncated, false);
});

test("keeps speaker labels that contain spaces", () => {
  assert.equal(parseLine(turn(U1, "Alice B. Smith")).speaker, "Alice B. Smith");
});

test("marks text the logger cut at 500 characters", () => {
  const shown = "a".repeat(500) + "...";
  const t = parseLine(said("user", shown, 812));
  assert.equal(t.truncated, true);
  assert.equal(t.text.length, 500);
  // A short line that merely ends in "..." is not truncated.
  assert.equal(parseLine(said("user", "well...")).truncated, false);
});

test("names the human from the preceding turn and the bot from config", () => {
  const out = run([joined(), turn(U1, "Alice"), said("user", "hi"), said("assistant", "hello")]);
  assert.equal(out[0].kind, "session");
  assert.deepEqual(
    out.slice(1).map((o) => [o.speaker, o.guess, o.text]),
    [
      ["Alice", false, "hi"],
      ["Bot", false, "hello"],
    ],
  );
});

test("flags a guess when two people opened turns close together", () => {
  at(0);
  const a = turn(U1, "Alice");
  at(2000);
  const b = turn(U2, "Bob");
  at(3000);
  const s = said("user", "who said this");
  const [, line1] = run([joined(), a, b, s]);
  assert.equal(line1.speaker, "Bob");
  assert.equal(line1.guess, true);
});

test("speakerNames overrides the Discord label by user id", () => {
  const [, l] = run([joined(), turn(U1, "alice_42"), said("user", "hi")], { speakerNames: { [U1]: "Alice" } });
  assert.equal(l.speaker, "Alice");
});

test("guild and channel filters drop other rooms", () => {
  const other = "999999999999999999";
  const out = run([joined(G, other), turn(U1, "Alice", G, other), said("user", "elsewhere")], { channelIds: [C] });
  assert.equal(out.length, 0);
  const out2 = run([joined(), turn(U1, "Alice"), said("user", "here")], { channelIds: [C] });
  assert.equal(out2.at(-1).text, "here");
});

test("formatting escapes markdown in names and marks guesses and cuts", () => {
  assert.equal(formatLine({ speaker: "a*b", guess: true, text: "x", truncated: true }), "**a\\*b?**: x …");
});

test("chunk keeps messages under the Discord limit", () => {
  const parts = chunk(["x".repeat(1500), "y".repeat(1500), "z".repeat(4500)]);
  assert.ok(parts.every((p) => p.length <= 2000));
  assert.equal(parts.join("").replace(/\n/g, "").length, 7500);
});

test("excludeChannelIds skips a room, also with allChannels", () => {
  const other = "999999999999999999";
  const lines = (c) => [joined(G, c), turn(U1, "Alice", G, c), said("user", "hi")];
  assert.equal(run(lines(C)).at(-1).text, "hi"); // allChannels: everything
  assert.equal(run(lines(C), { excludeChannelIds: [C] }).length, 0);
  assert.equal(run(lines(other), { excludeChannelIds: [C] }).at(-1).text, "hi");
  // Exclusion wins over the allowlist.
  assert.equal(run(lines(C), { channelIds: [C], excludeChannelIds: [C] }).length, 0);
  assert.equal(run(lines(C), { excludeGuildIds: [G] }).length, 0);
});

test("off by default: nothing is relayed until rooms are chosen", () => {
  const lines = [joined(), turn(U1, "Alice"), said("user", "hi"), said("assistant", "yo")];
  assert.equal(run(lines, { allChannels: undefined }).length, 0);
  assert.equal(run(lines, { allChannels: false }).length, 0);
  assert.equal(run(lines, { allChannels: false, channelIds: [C] }).at(-1).text, "yo");
  assert.equal(run(lines, { allChannels: false, guildIds: [G] }).at(-1).text, "yo");
  assert.equal(new Relay({}).enabled, false);
  assert.equal(new Relay({ allChannels: true }).enabled, true);
});
