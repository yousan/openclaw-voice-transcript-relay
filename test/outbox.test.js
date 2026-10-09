import test from "node:test";
import assert from "node:assert/strict";
import { Outbox } from "../src/outbox.js";
import { botSender, webhookSender } from "../src/discord.js";

test("flushMs=0 sends each line in order and reports the position", async () => {
  const sent = [];
  const done = [];
  const ob = new Outbox({ send: async (c) => sent.push(c), onDelivered: (p) => done.push(p) });
  ob.add("a", 1);
  ob.add("b", 2);
  await ob.flush();
  assert.deepEqual(sent, ["a", "b"]);
  assert.deepEqual(done, [1, 2]);
});

test("flushMs>0 collects lines into one message", async () => {
  const sent = [];
  const ob = new Outbox({ send: async (c) => sent.push(c), flushMs: 20 });
  ob.add("a", 1);
  ob.add("b", 2);
  await new Promise((r) => setTimeout(r, 50));
  await ob.running;
  assert.deepEqual(sent, ["a\nb"]);
});

test("retries after a rate limit without losing or reordering", async () => {
  const sent = [];
  let fail = 1;
  const ob = new Outbox({
    send: async (c) => {
      if (fail-- > 0) throw Object.assign(new Error("429"), { retryAfterMs: 5 });
      sent.push(c);
    },
  });
  ob.add("a", 1);
  ob.add("b", 2);
  await ob.flush();
  assert.deepEqual(sent, ["a", "b"]);
});

test("webhook sender posts to the thread with mentions disabled", async () => {
  let req;
  const send = webhookSender({
    url: "https://discord.com/api/webhooks/1/dummy",
    threadId: "42",
    fetchImpl: async (url, init) => ((req = { url: String(url), body: JSON.parse(init.body) }), { ok: true }),
  });
  await send("hi @everyone");
  assert.match(req.url, /thread_id=42/);
  assert.match(req.url, /wait=true/);
  assert.deepEqual(req.body.allowed_mentions, { parse: [] });
});

test("webhook sender turns 429 into a retry delay", async () => {
  const send = webhookSender({
    url: "https://discord.com/api/webhooks/1/dummy",
    fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers(), text: async () => '{"retry_after":1.5}' }),
  });
  await assert.rejects(send("x"), (e) => e.retryAfterMs === 1600);
});

test("bot sender posts to the channel with the bot token and mentions disabled", async () => {
  let req;
  const send = botSender({
    token: "dummy-token",
    channelId: "42",
    fetchImpl: async (url, init) => ((req = { url: String(url), init, body: JSON.parse(init.body) }), { ok: true }),
  });
  await send("hi");
  assert.equal(req.url, "https://discord.com/api/v10/channels/42/messages");
  assert.equal(req.init.headers.authorization, "Bot dummy-token");
  assert.deepEqual(req.body.allowed_mentions, { parse: [] });
});
