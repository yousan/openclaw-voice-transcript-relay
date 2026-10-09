// Turn parsed voice events into transcript lines with a speaker name.
//
// User transcript lines carry no speaker, so the speaker is taken from the
// "speaker turn opened" lines just before them. With one person talking this
// is exact. When several people opened turns within `speakerWindowMs`, the
// most recent one is used and the line is marked as a guess.

export class Relay {
  constructor(options = {}) {
    this.assistantName = options.assistantName || "assistant";
    this.unknownSpeaker = options.unknownSpeaker || "?";
    this.speakerWindowMs = options.speakerWindowMs ?? 30_000;
    this.guildIds = toSet(options.guildIds);
    this.channelIds = toSet(options.channelIds);
    this.speakerNames = options.speakerNames || {};
    this.current = null; // { guildId, channelId }
    this.turns = []; // [{ at, userId, speaker }]
  }

  /** Feed one parsed event. Returns an output item or null. */
  push(event) {
    if (!event) return null;
    switch (event.type) {
      case "joined": {
        const changed =
          !this.current || this.current.guildId !== event.guildId || this.current.channelId !== event.channelId;
        this.current = { guildId: event.guildId, channelId: event.channelId };
        this.turns = [];
        if (!this.allowed()) return null;
        return { kind: "session", at: event.at, guildId: event.guildId, channelId: event.channelId, changed };
      }
      case "turn": {
        this.current = { guildId: event.guildId, channelId: event.channelId };
        this.turns.push({ at: event.at, userId: event.userId, speaker: event.speaker });
        if (this.turns.length > 50) this.turns.splice(0, this.turns.length - 50);
        return null;
      }
      case "user":
      case "assistant": {
        if (!this.allowed() || !event.text) return null;
        const who = event.type === "assistant" ? { name: this.assistantName, guess: false } : this.speakerAt(event.at);
        return {
          kind: "line",
          at: event.at,
          role: event.type,
          speaker: who.name,
          guess: who.guess,
          text: event.text,
          truncated: event.truncated,
          guildId: this.current?.guildId,
          channelId: this.current?.channelId,
        };
      }
      default:
        return null;
    }
  }

  allowed() {
    // Before any join/turn line we cannot tell which room this is.
    if (!this.current) return this.guildIds.size === 0 && this.channelIds.size === 0;
    if (this.guildIds.size && !this.guildIds.has(this.current.guildId)) return false;
    if (this.channelIds.size && !this.channelIds.has(this.current.channelId)) return false;
    return true;
  }

  speakerAt(at) {
    const recent = this.turns.filter((t) => t.at <= at + 1000 && at - t.at <= this.speakerWindowMs);
    const last = recent.at(-1) ?? this.turns.at(-1);
    if (!last) return { name: this.unknownSpeaker, guess: true };
    const distinct = new Set(recent.map((t) => t.userId));
    return { name: this.nameFor(last), guess: distinct.size > 1 || recent.length === 0 };
  }

  nameFor(turn) {
    return this.speakerNames[turn.userId] || turn.speaker || this.unknownSpeaker;
  }
}

function toSet(value) {
  if (!value) return new Set();
  return new Set((Array.isArray(value) ? value : String(value).split(",")).map((v) => String(v).trim()).filter(Boolean));
}
