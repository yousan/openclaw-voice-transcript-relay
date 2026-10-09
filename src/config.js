import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = {
  profile: "",
  logDir: "/tmp/openclaw",
  guildIds: [],
  channelIds: [],
  assistantName: "assistant",
  speakerNames: {},
  speakerWindowMs: 30_000,
  flushMs: 0,
  showTime: false,
  timeZone: undefined,
  sessionHeader: "🎙️ <#{channelId}>",
  truncatedMark: " …",
  pollMs: 500,
  stateFile: undefined,
  webhook: {},
};

/**
 * Load config: JSON file, then environment variables on top.
 * Secrets (the webhook URL) should come from the environment or a file
 * referenced by `webhook.urlFile`, not from the JSON.
 */
export function loadConfig({ file, env = process.env, needWebhook = true } = {}) {
  const fromFile = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const c = { ...DEFAULTS, ...fromFile, webhook: { ...DEFAULTS.webhook, ...(fromFile.webhook || {}) } };
  if (env.VTR_PROFILE) c.profile = env.VTR_PROFILE;
  if (env.VTR_LOG_DIR) c.logDir = env.VTR_LOG_DIR;
  if (env.VTR_GUILD_IDS) c.guildIds = env.VTR_GUILD_IDS.split(",");
  if (env.VTR_CHANNEL_IDS) c.channelIds = env.VTR_CHANNEL_IDS.split(",");
  if (env.VTR_ASSISTANT_NAME) c.assistantName = env.VTR_ASSISTANT_NAME;
  if (env.VTR_FLUSH_MS) c.flushMs = Number(env.VTR_FLUSH_MS);
  if (env.VTR_WEBHOOK_URL) c.webhook.url = env.VTR_WEBHOOK_URL;
  if (env.VTR_THREAD_ID) c.webhook.threadId = env.VTR_THREAD_ID;
  if (env.VTR_STATE_FILE) c.stateFile = env.VTR_STATE_FILE;
  if (needWebhook && !c.webhook.url) {
    if (!c.webhook.urlFile) throw new Error("no webhook: set webhook.urlFile or VTR_WEBHOOK_URL");
    c.webhook.url = fs.readFileSync(expand(c.webhook.urlFile), "utf8").trim();
  }
  c.logDir = expand(c.logDir);
  if (!c.stateFile) {
    const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    c.stateFile = path.join(base, "openclaw-voice-transcript-relay", `${c.profile || "default"}.json`);
  }
  c.stateFile = expand(c.stateFile);
  return c;
}

function expand(p) {
  return p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
