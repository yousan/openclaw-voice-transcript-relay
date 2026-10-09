#!/usr/bin/env node
// Follow an OpenClaw gateway log and post Discord voice transcripts to a
// text channel or thread. See README.md.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { parseLine } from "../src/parse.js";
import { Relay } from "../src/relay.js";
import { LogFollower, logFileFor } from "../src/tail.js";
import { Outbox, formatLine, formatSession } from "../src/outbox.js";
import { botSender, webhookSender } from "../src/discord.js";

const { values: args } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
    "dry-run": { type: "boolean" },
    "from-start": { type: "boolean" },
    replay: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(`usage: voice-transcript-relay [--config file.json] [--dry-run] [--from-start] [--replay log-file]

  --config      JSON config (see examples/config.example.json); env VTR_* overrides it
  --dry-run     print messages instead of posting; does not touch the state file
  --from-start  read today's log from the beginning instead of the end (first run only)
  --replay      read one log file from the beginning, print, and exit (implies --dry-run)`);
  process.exit(0);
}

const dryRun = Boolean(args["dry-run"] || args.replay);
const config = loadConfig({ file: args.config ?? process.env.VTR_CONFIG, needWebhook: !dryRun });
const log = (...a) => console.error(new Date().toISOString(), ...a);

const send = dryRun
  ? async (content) => console.log(content + "\n---")
  : config.bot
    ? botSender(config.bot)
    : webhookSender(config.webhook);

const state = dryRun ? null : readState(config.stateFile);
const outbox = new Outbox({
  send,
  flushMs: config.flushMs,
  onDelivered: (pos) => !dryRun && saveSoon(pos),
  onError: (e) => log("send failed:", e.message),
});
const relay = new Relay(config);

function onLine(line, pos) {
  const item = relay.push(parseLine(line));
  if (!item) return outbox.advance(pos);
  if (item.kind === "session") {
    if (config.sessionHeader === false || !item.changed) return outbox.advance(pos);
    return outbox.add(formatSession(item, config), pos);
  }
  outbox.add(formatLine(item, config), pos);
}

if (args.replay) {
  const follower = new LogFollower({ resolvePath: () => args.replay, onLine, fromStart: true });
  follower.poll();
  follower.close();
  await outbox.flush();
  process.exit(0);
}

const resolvePath = () => logFileFor(config.logDir, config.profile);
const follower = new LogFollower({
  resolvePath,
  onLine,
  resume: state,
  fromStart: Boolean(args["from-start"]),
  onSwitch: (p) => log("following", p.file, "from byte", p.offset),
});
log(`watching ${resolvePath()} (flushMs=${config.flushMs}${dryRun ? ", dry run" : ""})`);
const timer = setInterval(() => {
  try {
    follower.poll();
  } catch (e) {
    log("read failed:", e.message);
  }
}, config.pollMs);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    clearInterval(timer);
    follower.close();
    await outbox.flush();
    if (latestPos) writeState(config.stateFile, latestPos);
    process.exit(0);
  });
}

// Most log lines are not voice lines; save the position at most once a second.
let latestPos = null;
let saveTimer = null;
function saveSoon(pos) {
  latestPos = pos;
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    try {
      writeState(config.stateFile, latestPos);
    } catch (e) {
      log("state write failed:", e.message);
    }
  }, 1000);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeState(file, pos) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ file: pos.file, ino: pos.ino, offset: pos.offset }) + "\n");
  fs.renameSync(tmp, file);
}
