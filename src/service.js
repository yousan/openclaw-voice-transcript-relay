// The relay loop shared by the CLI and the OpenClaw plugin: follow the log,
// turn voice lines into messages, deliver them, and remember how far we got.

import fs from "node:fs";
import path from "node:path";
import { parseLine } from "./parse.js";
import { Relay } from "./relay.js";
import { LogFollower, logFileFor } from "./tail.js";
import { Outbox, formatLine, formatPresence, formatSession, formatSessionEnd, formatWelcome } from "./outbox.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * @param {object} o
 * @param {object} o.config        see README "Configuration"
 * @param {(content: string, dest: {guildId?: string, channelId?: string}) => Promise<string|undefined>} o.send
 * @param {{info: Function, warn: Function}} [o.log]
 * @param {boolean} [o.persist]    save the read position (false for dry runs)
 * @param {boolean} [o.fromStart]
 * @param {(guildId: string, userId: string) => Promise<{name?: string, bot: boolean}|null>} [o.lookup]
 */
export function startRelay({ config, send, log = consoleLog, persist = true, fromStart = false, lookup }) {
  const relay = new Relay(config);
  if (!relay.enabled) log.warn("nothing to relay: set channelIds (or guildIds), or allChannels: true");
  const handle = itemHandler(config, { lookup, log });
  const state = persist ? readState(config.stateFile) : null;
  let latestPos = null;
  let saveTimer = null;

  const saveSoon = (pos) => {
    if (!persist) return;
    latestPos = pos;
    saveTimer ??= setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 1000);
  };
  const saveNow = () => {
    if (!latestPos) return;
    try {
      writeState(config.stateFile, latestPos);
    } catch (e) {
      log.warn(`state write failed: ${e.message}`);
    }
  };

  const outbox = new Outbox({
    send,
    flushMs: config.flushMs,
    onDelivered: saveSoon,
    onError: (e) => log.warn(`send failed: ${e.message}`),
    onSent: (id, content) => persist && log.info(`posted ${id ?? "?"} (${content.split("\n").length} lines)`),
  });

  function onLine(line, pos) {
    if (!handle(relay.push(parseLine(line)), pos, outbox)) outbox.advance(pos);
  }

  const resolvePath = config.logFile ? () => config.logFile : () => logFileFor(config.logDir, config.profile);
  const follower = new LogFollower({
    resolvePath,
    onLine,
    resume: state,
    fromStart,
    onSwitch: (p) => log.info(`following ${p.file} from byte ${p.offset}`),
  });
  log.info(`watching ${resolvePath()} (v${VERSION}, flushMs=${config.flushMs})`);

  const timer = setInterval(() => {
    try {
      follower.poll();
    } catch (e) {
      log.warn(`read failed: ${e.message}`);
    }
  }, config.pollMs ?? 500);
  timer.unref?.();

  return {
    async stop() {
      clearInterval(timer);
      follower.close();
      await outbox.flush();
      if (saveTimer) clearTimeout(saveTimer), (saveTimer = null);
      if (persist) saveNow();
    },
  };
}

/** Read one log file from the start and deliver everything, then return. */
export async function replayFile({ config, file, send, lookup }) {
  const relay = new Relay(config);
  const handle = itemHandler(config, { lookup, log: { info() {}, warn() {} } });
  const outbox = new Outbox({ send, flushMs: config.flushMs });
  const follower = new LogFollower({
    resolvePath: () => file,
    fromStart: true,
    onLine: (line, pos) => handle(relay.push(parseLine(line)), pos, outbox),
  });
  follower.poll();
  follower.close();
  await outbox.flush();
}

/**
 * Queue what one relay item turns into. Returns false when nothing was queued.
 * The session header waits for the first thing worth posting, so a stay with
 * nothing relayed (the agent joining an empty room and leaving) posts nothing.
 */
function itemHandler(config, { lookup, log }) {
  const welcomeOn = config.welcome?.enabled !== false;
  let welcomed = new Set(); // user ids welcomed since the agent joined this room
  let header = null; // {item, dest} of a header not posted yet
  let started = false; // something was posted in this stay
  let warned = false;
  const begin = (pos, outbox) => {
    if (header) outbox.add(formatSession(header.item, config), pos, header.dest);
    header = null;
    started = true;
  };
  return function handle(item, pos, outbox) {
    if (!item) return false;
    const dest = { guildId: item.guildId, channelId: item.channelId };
    if (item.kind === "session") {
      if (!item.changed) return false;
      welcomed = new Set();
      started = false;
      header = config.sessionHeader === false ? null : { item, dest };
      return false;
    }
    if (item.kind === "session-end") {
      welcomed = new Set();
      header = null;
      const had = started;
      started = false;
      if (config.sessionFooter === false || !had) return false;
      outbox.add(formatSessionEnd(item, config), pos, dest);
      return true;
    }
    if (item.kind === "line") {
      begin(pos, outbox);
      outbox.add(formatLine(item, config), pos, dest);
      return true;
    }
    if (item.kind !== "presence") return false;
    const who = lookup ? lookup(item.guildId, item.userId) : Promise.resolve(null);
    let queued = false;
    if (item.relay) {
      begin(pos, outbox);
      outbox.add(who.then((u) => formatPresence(item, u, config)), pos, dest);
      queued = true;
    }
    if (item.joined && welcomeOn && !welcomed.has(item.userId)) {
      if (!lookup && !warned) {
        warned = true;
        log.warn("join notices need a Discord lookup to tell people from bots; none is configured, so none are sent");
      }
      welcomed.add(item.userId);
      if (lookup) begin(pos, outbox);
      // Only people: a bot, or someone we could not look up, gets no notice.
      outbox.add(who.then((u) => (u && !u.bot ? formatWelcome(item, config) : null)), pos, dest, { mentions: [item.userId] });
      queued = true;
    }
    return queued;
  };
}

const consoleLog = {
  info: (m) => console.error(new Date().toISOString(), m),
  warn: (m) => console.error(new Date().toISOString(), m),
};

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
