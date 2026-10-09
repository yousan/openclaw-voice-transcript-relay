// Post to a Discord channel or thread through an incoming webhook.
// A webhook needs no bot token, and messages from it are bot messages, which
// OpenClaw ignores by default (channels.discord.allowBots), so the agent does
// not answer its own transcript.

export function webhookSender({ url, threadId, username, avatarUrl, fetchImpl = fetch }) {
  if (!url) throw new Error("webhook url is required");
  const target = new URL(url);
  target.searchParams.set("wait", "true");
  if (threadId) target.searchParams.set("thread_id", threadId);
  return async function send(content) {
    const body = { content, allowed_mentions: { parse: [] } };
    if (username) body.username = username;
    if (avatarUrl) body.avatar_url = avatarUrl;
    const res = await fetchImpl(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    const error = new Error(`discord webhook ${res.status}: ${text.slice(0, 200)}`);
    if (res.status === 429) {
      let after = Number(res.headers.get("retry-after"));
      try {
        after = JSON.parse(text).retry_after ?? after;
      } catch {}
      error.retryAfterMs = Math.ceil((Number(after) || 1) * 1000) + 100;
    } else if (res.status >= 400 && res.status < 500 && res.status !== 408) {
      // 401/403/404 mean the webhook is gone or the config is wrong; keep
      // retrying slowly so nothing is lost once it is fixed. 400 cannot recover.
      if (res.status === 400) error.permanent = true;
      else error.retryAfterMs = 60_000;
    }
    throw error;
  };
}
