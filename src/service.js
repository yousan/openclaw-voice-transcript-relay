// The relay loop shared by the CLI and the OpenClaw plugin: follow the log,
// turn voice lines into messages, deliver them, and remember how far we got.

import fs from "node:fs";
import path from "node:path";
import { parseLine } from "./parse.js";
import { Relay } from "./relay.js";
import { LogFollower, logFileFor } from "./tail.js";
import { Outbox, formatLine, formatSession } from "./outbox.js";

/**
 * @param {object} o
 * @param {object} o.config        see README "Configuration"
 * @param {(content: string, dest: {guildId?: string, channelId?: string}) => Promise<string|undefined>} o.send
 * @param {{info: Function, warn: Function}} [o.log]
 * @param {boolean} [o.persist]    save the read position (false for dry runs)
 * @param {boolean} [o.fromStart]
 */
export function startRelay({ config, send, log = consoleLog, persist = true, fromStart = false }) {
  const relay = new Relay(config);
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
    const item = relay.push(parseLine(line));
    if (!item) return outbox.advance(pos);
    const dest = { guildId: item.guildId, channelId: item.channelId };
    if (item.kind === "session") {
      if (config.sessionHeader === false || !item.changed) return outbox.advance(pos);
      return outbox.add(formatSession(item, config), pos, dest);
    }
    outbox.add(formatLine(item, config), pos, dest);
  }

  const resolvePath = config.logFile ? () => config.logFile : () => logFileFor(config.logDir, config.profile);
  const follower = new LogFollower({
    resolvePath,
    onLine,
    resume: state,
    fromStart,
    onSwitch: (p) => log.info(`following ${p.file} from byte ${p.offset}`),
  });
  log.info(`watching ${resolvePath()} (flushMs=${config.flushMs})`);

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
export async function replayFile({ config, file, send }) {
  const relay = new Relay(config);
  const outbox = new Outbox({ send, flushMs: config.flushMs });
  const follower = new LogFollower({
    resolvePath: () => file,
    fromStart: true,
    onLine: (line, pos) => {
      const item = relay.push(parseLine(line));
      if (!item) return;
      const dest = { guildId: item.guildId, channelId: item.channelId };
      if (item.kind === "session") {
        if (config.sessionHeader !== false && item.changed) outbox.add(formatSession(item, config), pos, dest);
        return;
      }
      outbox.add(formatLine(item, config), pos, dest);
    },
  });
  follower.poll();
  follower.close();
  await outbox.flush();
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
