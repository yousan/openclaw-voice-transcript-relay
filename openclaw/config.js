// Plugin config (plugins.entries.voice-transcript-relay.config) → relay config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  guildIds: [],
  channelIds: [],
  assistantName: "assistant",
  speakerNames: {},
  speakerWindowMs: 30_000,
  flushMs: 5000,
  showTime: false,
  sessionHeader: "🎙️ This voice chat is transcribed here.",
  truncatedMark: " …",
  pollMs: 500,
  relay: { user: true, assistant: true, presence: true },
  welcome: { enabled: true },
};

/**
 * @param {object} pc  the plugin's config object
 * @param {{env?: object, stateDir: string, logging?: {file?: string}}} host
 */
export function resolvePluginConfig(pc = {}, { env = process.env, stateDir, logging } = {}) {
  const c = {
    ...DEFAULTS,
    ...pc,
    relay: { ...DEFAULTS.relay, ...(pc.relay || {}) },
    welcome: { ...DEFAULTS.welcome, ...(pc.welcome || {}) },
  };
  c.profile = pc.profile ?? env.OPENCLAW_PROFILE ?? "";
  if (pc.logFile) c.logFile = expand(pc.logFile);
  else if (logging?.file) c.logFile = expand(logging.file);
  c.logDir = expand(pc.logDir) || defaultLogDir();
  c.stateFile = expand(pc.stateFile) || path.join(stateDir, "voice-transcript-relay", "state.json");
  if (pc.webhook?.urlFile || pc.webhook?.url) {
    c.webhook = { ...pc.webhook };
    if (!c.webhook.url) c.webhook.url = fs.readFileSync(expand(c.webhook.urlFile), "utf8").trim();
  }
  return c;
}

// OpenClaw writes to /tmp/openclaw, or to <tmpdir>/openclaw-<uid> when that is unsafe.
function defaultLogDir() {
  const primary = "/tmp/openclaw";
  if (process.platform !== "win32" && fs.existsSync(primary)) return primary;
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return path.join(os.tmpdir(), `openclaw-${uid}`);
}

function expand(p) {
  return p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
