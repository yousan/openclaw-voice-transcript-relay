// Format transcript lines and deliver them in order, either one message per
// utterance (flushMs = 0) or collected for flushMs and sent together.

const DISCORD_LIMIT = 2000;

export function formatLine(item, options = {}) {
  const name = escapeMarkdown(item.speaker) + (item.guess ? "?" : "");
  const time = options.showTime ? `\`${clock(item.at, options.timeZone)}\` ` : "";
  const cut = item.truncated ? options.truncatedMark ?? " …" : "";
  return `${time}**${name}**: ${defuse(item.text)}${cut}`;
}

export function formatSession(item, options = {}) {
  const template = options.sessionHeader ?? "🎙️ <#{channelId}>";
  return template.replaceAll("{channelId}", item.channelId).replaceAll("{guildId}", item.guildId);
}

export function formatSessionEnd(item, options = {}) {
  const template = options.sessionFooter ?? "🎙️ The agent left the voice channel.";
  return template.replaceAll("{channelId}", item.channelId).replaceAll("{guildId}", item.guildId);
}

/** Split text into Discord-sized messages, preferring line boundaries. */
export function chunk(lines, limit = DISCORD_LIMIT) {
  const out = [];
  let cur = "";
  for (let line of lines) {
    while (line.length > limit) {
      if (cur) out.push(cur), (cur = "");
      out.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    if (cur && cur.length + 1 + line.length > limit) out.push(cur), (cur = "");
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

export class Outbox {
  /**
   * @param {object} o
   * @param {(content: string) => Promise<void>} o.send
   * @param {number} [o.flushMs]  0 = send each line as it arrives
   * @param {(pos: any) => void} [o.onDelivered]  called with the log position after a successful send
   */
  constructor({ send, flushMs = 0, onDelivered = () => {}, onError = () => {}, onSent = () => {}, retryMs = 5000 }) {
    this.onSent = onSent;
    this.sendFn = send;
    this.flushMs = flushMs;
    this.onDelivered = onDelivered;
    this.onError = onError;
    this.retryMs = retryMs;
    this.pending = []; // [{ text, pos }]
    this.timer = null;
    this.running = Promise.resolve();
    this.idlePos = null;
  }

  /**
   * @param {string|Promise<string|null>} text  a promise is awaited at send time, in order; null drops it
   * @param {{mentions?: string[]}} [opts]  mentions: user ids this message should notify; sent on its own
   */
  add(text, pos, dest = {}, opts = {}) {
    this.idlePos = null; // pos is later than any idle position seen so far
    this.pending.push({ text, pos, dest, mentions: opts.mentions });
    if (this.flushMs <= 0) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  /** Remember a read position that produced nothing to send. */
  advance(pos) {
    if (this.pending.length === 0 && !this.busy) this.onDelivered(pos);
    else this.idlePos = pos;
  }

  flush() {
    if (this.timer) clearTimeout(this.timer), (this.timer = null);
    if (this.pending.length === 0) return this.running;
    const batch = this.pending.splice(0);
    const lastPos = batch.at(-1).pos;
    this.busy = true;
    this.running = this.running.then(async () => {
      const texts = await Promise.all(batch.map((b) => Promise.resolve(b.text).catch(() => null)));
      for (const { content, dest, mentions } of toMessages(batch, texts)) {
        for (;;) {
          try {
            this.onSent(await this.sendFn(content, dest, { mentions }), content);
            break;
          } catch (error) {
            this.onError(error);
            if (error?.permanent) break; // e.g. 400: retrying cannot help, skip this message
            await sleep(error?.retryAfterMs ?? this.retryMs);
          }
        }
      }
      this.onDelivered(lastPos);
      if (this.pending.length === 0) {
        this.busy = false;
        if (this.idlePos) this.onDelivered(this.idlePos), (this.idlePos = null);
      }
    });
    return this.running;
  }
}

// One message per run of lines with the same destination; a message that
// mentions someone always goes out on its own.
function toMessages(batch, texts) {
  const groups = [];
  batch.forEach((b, i) => {
    if (texts[i] == null) return;
    const key = `${b.dest?.guildId}/${b.dest?.channelId}`;
    if (b.mentions?.length) return groups.push({ key, dest: b.dest, texts: [texts[i]], mentions: b.mentions, solo: true });
    const last = groups.at(-1);
    if (!last || last.solo || last.key !== key) groups.push({ key, dest: b.dest, texts: [] });
    groups.at(-1).texts.push(texts[i]);
  });
  return groups.flatMap((g) => chunk(g.texts).map((content) => ({ content, dest: g.dest, mentions: g.mentions })));
}

export function formatPresence(item, user, options = {}) {
  const name = escapeMarkdown(user?.name || item.label || item.userId) + (user?.bot ? " (bot)" : "");
  const template = item.joined ? options.joinedText ?? "➡️ {name} joined" : options.leftText ?? "⬅️ {name} left";
  return template.replaceAll("{name}", name);
}

export function formatWelcome(item, options = {}) {
  const template = options.welcome?.text ?? "{mention} This channel's conversation is transcribed as text.";
  return template.replaceAll("{mention}", `<@${item.userId}>`);
}

// Spoken "@everyone" must not ping, whichever way the message is delivered.
function defuse(s) {
  return String(s).replace(/@(everyone|here)/g, "@\u200b$1");
}

function escapeMarkdown(s) {
  return String(s).replace(/([\\*_`~|>])/g, "\\$1");
}

function clock(at, timeZone) {
  return new Date(at).toLocaleTimeString("en-GB", { hour12: false, ...(timeZone ? { timeZone } : {}) });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
