// voice-transcript-relay for OpenClaw: a Gateway service that follows the
// Gateway's own rolling log and posts Discord voice transcripts (the humans
// and the agent) to a text channel — by default the voice channel's own chat,
// through the Gateway's Discord account. No model calls.
//
// Why the log: in OpenClaw 2026.9.6 the Discord voice runtime does not expose
// realtime transcripts through hooks or events (Talk diagnostics drop the
// text), but it logs every final transcript at INFO. See README "Limitations".

import os from "node:os";
import path from "node:path";
import { startRelay } from "../src/service.js";
import { memberLookup, webhookSender } from "../src/discord.js";
import { resolvePluginConfig } from "./config.js";

export const PLUGIN_ID = "voice-transcript-relay";

export default {
  id: PLUGIN_ID,
  name: "Voice Transcript Relay",
  description:
    "Posts what is said in a Discord voice channel — the humans and the agent — into a text channel as it is said, for the voice channels you choose. Off until configured. No model calls.",
  register(api) {
    if (api.registrationMode && api.registrationMode !== "full") return;
    let running = null;
    api.registerService({
      id: PLUGIN_ID,
      reload: { configPrefixes: [`plugins.entries.${PLUGIN_ID}`] },
      async start(ctx) {
        const log = api.logger || console;
        const config = resolvePluginConfig(api.pluginConfig, {
          env: process.env,
          stateDir: stateDir(api),
          logging: hostConfig(api, ctx)?.logging,
        });
        const token = discordToken(hostConfig(api, ctx), config.accountId);
        running = startRelay({
          config,
          send: createSender(api, ctx, config),
          log: prefixed(log),
          lookup: token ? memberLookup({ token }) : undefined,
        });
      },
      async stop() {
        const r = running;
        running = null;
        await r?.stop();
      },
    });
  },
};

/** Deliver through the Gateway's Discord account, or a webhook when one is configured. */
export function createSender(api, ctx, config) {
  if (config.webhook?.url) return webhookSender(config.webhook);
  let adapter;
  return async function send(content, dest) {
    const to = config.to || (dest?.channelId ? `channel:${dest.channelId}` : undefined);
    if (!to) throw Object.assign(new Error("no destination: set `to` or wait for a voice join"), { permanent: true });
    adapter ??= await api.runtime.channel.outbound.loadAdapter("discord");
    if (!adapter?.sendText) throw new Error("Discord outbound adapter is not available");
    const result = await adapter.sendText({
      cfg: hostConfig(api, ctx),
      to,
      text: content,
      ...(config.accountId ? { accountId: config.accountId } : {}),
    });
    return result?.messageId;
  };
}

/** The Discord bot token from the Gateway config, when it is a plain string (used only to look up members). */
export function discordToken(cfg, accountId) {
  const d = cfg?.channels?.discord;
  const token = (accountId && d?.accounts?.[accountId]?.token) || d?.token;
  return typeof token === "string" && token ? token : undefined;
}

function hostConfig(api, ctx) {
  try {
    return api.runtime?.config?.current?.() || ctx?.config || api.config;
  } catch {
    return ctx?.config || api.config;
  }
}

function stateDir(api) {
  try {
    const dir = api.runtime?.state?.resolveStateDir?.();
    if (dir) return dir;
  } catch {}
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function prefixed(log) {
  return {
    info: (m) => log.info(`voice-transcript-relay: ${m}`),
    warn: (m) => log.warn(`voice-transcript-relay: ${m}`),
  };
}
