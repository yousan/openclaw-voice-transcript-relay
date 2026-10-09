// Post to a Discord channel or thread through an incoming webhook.
// A webhook needs no bot token, and messages from it are bot messages, which
// OpenClaw ignores by default (channels.discord.allowBots), so the agent does
// not answer its own transcript.

export function webhookSender({ url, threadId, username, avatarUrl, fetchImpl = fetch }) {
  if (!url) throw new Error("webhook url is required");
  const target = new URL(url);
  target.searchParams.set("wait", "true");
  if (threadId) target.searchParams.set("thread_id", threadId);
  return async function send(content, _dest, { mentions } = {}) {
    const body = { content, allowed_mentions: allowedMentions(mentions) };
    if (username) body.username = username;
    if (avatarUrl) body.avatar_url = avatarUrl;
    const res = await fetchImpl(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return messageId(res);
    throw await toError(res);
  };
}

// Post as a bot (POST /channels/{id}/messages). For rooms where you cannot
// create a webhook. The token is read from a file, the environment, or the
// OpenClaw config that already holds it (channels.discord.token), so it is not
// copied anywhere else.
export function botSender({ token, channelId, fetchImpl = fetch }) {
  if (!token) throw new Error("bot token is required");
  if (!channelId) throw new Error("bot.channelId is required");
  const target = `https://discord.com/api/v10/channels/${channelId}/messages`;
  return async function send(content, _dest, { mentions } = {}) {
    const res = await fetchImpl(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bot ${token}`,
        "user-agent": "DiscordBot (https://github.com/yousan/openclaw-voice-transcript-relay, 0.1)",
      },
      body: JSON.stringify({ content, allowed_mentions: allowedMentions(mentions) }),
    });
    if (res.ok) return messageId(res);
    throw await toError(res);
  };
}

// Nothing pings except the users a message is meant to notify.
function allowedMentions(mentions) {
  return mentions?.length ? { parse: [], users: mentions.slice(0, 100) } : { parse: [] };
}

/**
 * Look up a guild member: display name and whether it is a bot. Cached; null
 * when the lookup fails (unknown users are never announced as humans).
 */
export function memberLookup({ token, fetchImpl = fetch, ttlMs = 3_600_000 }) {
  const cache = new Map();
  return async function lookup(guildId, userId) {
    const key = `${guildId}/${userId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    let value = null;
    try {
      const res = await fetchImpl(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
        headers: {
          authorization: `Bot ${token}`,
          "user-agent": "DiscordBot (https://github.com/yousan/openclaw-voice-transcript-relay, 0.2)",
        },
      });
      if (res.ok) {
        const m = await res.json();
        value = { name: m.nick || m.user?.global_name || m.user?.username, bot: Boolean(m.user?.bot) };
      }
    } catch {}
    // Remember failures only briefly so a network blip does not hide a person for an hour.
    cache.set(key, { at: value ? Date.now() : Date.now() - ttlMs + 60_000, value });
    return value;
  };
}

async function messageId(res) {
  try {
    return (await res.json())?.id;
  } catch {
    return undefined;
  }
}

async function toError(res) {
  const text = await res.text().catch(() => "");
  const error = new Error(`discord ${res.status}: ${text.slice(0, 200)}`);
  if (res.status === 429) {
    let after = Number(res.headers.get("retry-after"));
    try {
      after = JSON.parse(text).retry_after ?? after;
    } catch {}
    error.retryAfterMs = Math.ceil((Number(after) || 1) * 1000) + 100;
  } else if (res.status >= 400 && res.status < 500 && res.status !== 408) {
    // 401/403/404: the target or credentials are wrong; retry slowly so nothing
    // is lost once it is fixed. 400 cannot recover.
    if (res.status === 400) error.permanent = true;
    else error.retryAfterMs = 60_000;
  }
  return error;
}
