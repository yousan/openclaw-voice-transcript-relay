import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLine } from "../src/parse.js";
import { Relay } from "../src/relay.js";
import { replayFile } from "../src/service.js";
import { webhookSender } from "../src/discord.js";
import { C, G, U1, U2, joined, turn, said, presence } from "./fixtures.js";

const BOT = "300000000000000009";
const people = { [U1]: { name: "Alice", bot: false }, [U2]: { name: "Bob", bot: false }, [BOT]: { name: "Other bot", bot: true } };
const lookup = async (_g, u) => people[u] ?? null;

async function replay(lines, config = {}, withLookup = lookup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtr-pres-"));
  const file = path.join(dir, "g.log");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const sent = [];
  await replayFile({
    config: { assistantName: "Bot", flushMs: 0, sessionHeader: false, ...config },
    file,
    lookup: withLookup ?? undefined,
    send: async (content, dest, opts) => void sent.push({ content, mentions: opts?.mentions }),
  });
  return sent;
}

test("parses participant joined/left lines", () => {
  assert.deepEqual(
    { ...parseLine(presence("left", U1)), at: 0 },
    { type: "presence", at: 0, joined: false, guildId: G, channelId: C, userId: U1 },
  );
});

test("relays joins and leaves by name and welcomes people with a mention", async () => {
  const sent = await replay([joined(), presence("joined", U2), said("assistant", "hi"), presence("left", U2)]);
  assert.deepEqual(sent, [
    { content: "➡️ Bob joined", mentions: undefined },
    { content: `<@${U2}> This channel's conversation is transcribed as text.`, mentions: [U2] },
    { content: "**Bot**: hi", mentions: undefined },
    { content: "⬅️ Bob left", mentions: undefined },
  ]);
});

test("no welcome for bots or for people it could not look up; once per person per session", async () => {
  const sent = await replay([
    joined(),
    presence("joined", BOT),
    presence("joined", "300000000000000077"),
    presence("joined", U1),
    presence("left", U1),
    presence("joined", U1),
  ]);
  assert.equal(sent.filter((s) => s.mentions).length, 1);
  assert.equal(sent.find((s) => s.mentions).mentions[0], U1);
  assert.ok(sent.some((s) => s.content === "➡️ Other bot (bot) joined"));
  assert.ok(sent.some((s) => s.content === "➡️ 300000000000000077 joined"));
});

test("without a lookup: join lines use the last known label, and no welcomes", async () => {
  const sent = await replay([joined(), turn(U1, "alice_label"), presence("left", U1), presence("joined", U1)], {}, null);
  assert.deepEqual(sent.map((s) => s.content), ["⬅️ alice\\_label left", "➡️ alice\\_label joined"]);
});

test("each kind can be turned off", async () => {
  const lines = [joined(), turn(U1, "Alice"), said("user", "u"), said("assistant", "a"), presence("joined", U2)];
  const off = await replay(lines, { relay: { user: false, assistant: false, presence: false }, welcome: { enabled: false } });
  assert.deepEqual(off, []);
  const onlyWelcome = await replay(lines, { relay: { user: false, assistant: false, presence: false } });
  assert.deepEqual(onlyWelcome.map((s) => s.mentions), [[U2]]);
});

test("other rooms' presence is ignored", async () => {
  const sent = await replay([joined(), presence("joined", U2, G, "999999999999999999")], { channelIds: [C] });
  assert.deepEqual(sent, []);
});

test("webhook allows exactly the mentioned users to be notified", async () => {
  const bodies = [];
  const send = webhookSender({
    url: "https://discord.com/api/webhooks/1/dummy",
    fetchImpl: async (_u, init) => (bodies.push(JSON.parse(init.body)), { ok: true, json: async () => ({ id: "1" }) }),
  });
  await send("x", {}, { mentions: [U1] });
  await send("y", {}, {});
  assert.deepEqual(bodies.map((b) => b.allowed_mentions), [{ parse: [], users: [U1] }, { parse: [] }]);
});

test("Relay keeps presence in its own room without moving the current room", () => {
  const r = new Relay({});
  r.push(parseLine(joined()));
  const item = r.push(parseLine(presence("joined", U1, G, "888888888888888888")));
  assert.equal(item.channelId, "888888888888888888");
  assert.equal(r.current.channelId, C);
});
