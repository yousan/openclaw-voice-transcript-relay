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

  add(text, pos, dest = {}) {
    this.idlePos = null; // pos is later than any idle position seen so far
    this.pending.push({ text, pos, dest });
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
    // One group per destination, in order (rooms rarely change within a batch).
    const groups = [];
    for (const b of batch) {
      const key = `${b.dest?.guildId}/${b.dest?.channelId}`;
      if (groups.at(-1)?.key !== key) groups.push({ key, dest: b.dest, texts: [] });
      groups.at(-1).texts.push(b.text);
    }
    const messages = groups.flatMap((g) => chunk(g.texts).map((content) => ({ content, dest: g.dest })));
    const lastPos = batch.at(-1).pos;
    this.busy = true;
    this.running = this.running.then(async () => {
      for (const { content, dest } of messages) {
        for (;;) {
          try {
            this.onSent(await this.sendFn(content, dest), content);
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
