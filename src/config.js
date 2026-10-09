import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = {
  profile: "",
  logDir: "/tmp/openclaw",
  guildIds: [],
  channelIds: [],
  excludeGuildIds: [],
  excludeChannelIds: [],
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
  bot: undefined,
  lookup: undefined,
  relay: { user: true, assistant: true, presence: true },
  welcome: { enabled: true },
};

/**
 * Load config: JSON file, then environment variables on top.
 * Secrets (the webhook URL, a bot token) should come from the environment or a
 * file (`webhook.urlFile`, `bot.tokenFile`, `bot.openclawConfig`), not the JSON.
 */
export function loadConfig({ file, env = process.env, needWebhook = true } = {}) {
  const fromFile = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const c = { ...DEFAULTS, ...fromFile, webhook: { ...DEFAULTS.webhook, ...(fromFile.webhook || {}) } };
  c.relay = { ...DEFAULTS.relay, ...(fromFile.relay || {}) };
  c.welcome = { ...DEFAULTS.welcome, ...(fromFile.welcome || {}) };
  if (fromFile.bot) c.bot = { ...fromFile.bot };
  if (fromFile.lookup) c.lookup = { ...fromFile.lookup };
  if (env.VTR_PROFILE) c.profile = env.VTR_PROFILE;
  if (env.VTR_LOG_DIR) c.logDir = env.VTR_LOG_DIR;
  if (env.VTR_GUILD_IDS) c.guildIds = env.VTR_GUILD_IDS.split(",");
  if (env.VTR_CHANNEL_IDS) c.channelIds = env.VTR_CHANNEL_IDS.split(",");
  if (env.VTR_EXCLUDE_CHANNEL_IDS) c.excludeChannelIds = env.VTR_EXCLUDE_CHANNEL_IDS.split(",");
  if (env.VTR_ASSISTANT_NAME) c.assistantName = env.VTR_ASSISTANT_NAME;
  if (env.VTR_FLUSH_MS) c.flushMs = Number(env.VTR_FLUSH_MS);
  if (env.VTR_WEBHOOK_URL) c.webhook.url = env.VTR_WEBHOOK_URL;
  if (env.VTR_THREAD_ID) c.webhook.threadId = env.VTR_THREAD_ID;
  if (env.VTR_STATE_FILE) c.stateFile = env.VTR_STATE_FILE;
  if (env.VTR_BOT_TOKEN && c.bot) c.bot.token = env.VTR_BOT_TOKEN;
  // Member lookup (names, bot or not) for join/leave lines and join notices. Optional.
  if (needWebhook && c.lookup && !c.lookup.token) c.lookup.token = readBotToken(c.lookup);
  if (c.bot) {
    if (needWebhook && !c.bot.token) c.bot.token = readBotToken(c.bot);
    return finish(c, env);
  }
  if (needWebhook && !c.webhook.url) {
    if (!c.webhook.urlFile) throw new Error("no webhook: set webhook.urlFile or VTR_WEBHOOK_URL");
    c.webhook.url = fs.readFileSync(expand(c.webhook.urlFile), "utf8").trim();
  }
  return finish(c, env);
}

function finish(c, env) {
  c.logDir = expand(c.logDir);
  if (!c.stateFile) {
    const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    c.stateFile = path.join(base, "openclaw-voice-transcript-relay", `${c.profile || "default"}.json`);
  }
  c.stateFile = expand(c.stateFile);
  return c;
}

function readBotToken(bot) {
  if (bot.tokenFile) return fs.readFileSync(expand(bot.tokenFile), "utf8").trim();
  if (bot.openclawConfig) {
    const token = JSON.parse(fs.readFileSync(expand(bot.openclawConfig), "utf8"))?.channels?.discord?.token;
    if (typeof token !== "string" || !token) {
      throw new Error("bot.openclawConfig: channels.discord.token is not a plain string; use bot.tokenFile or VTR_BOT_TOKEN");
    }
    return token;
  }
  throw new Error("set tokenFile or openclawConfig (or VTR_BOT_TOKEN for bot)");
}

function expand(p) {
  return p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
