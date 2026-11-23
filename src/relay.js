// Turn parsed voice events into transcript lines with a speaker name.
//
// User transcript lines carry no speaker, so the speaker is taken from the
// "speaker turn opened" lines just before them. With one person talking this
// is exact. When several people opened turns within `speakerWindowMs`, the
// most recent one is used and the line is marked as a guess.
//
// State (is the agent in the room, recent speaker turns) is kept per room, so
// one Gateway running several bots in several rooms does not mix them up.
// Transcript lines name their room when the Gateway logs it; older lines do
// not, and then the room of the latest join/turn line is used (one bot only).

export class Relay {
  constructor(options = {}) {
    this.assistantName = options.assistantName || "assistant";
    this.unknownSpeaker = options.unknownSpeaker || "?";
    this.speakerWindowMs = options.speakerWindowMs ?? 30_000;
    this.guildIds = toSet(options.guildIds);
    this.channelIds = toSet(options.channelIds);
    // Off by default: with no allowlist, relay every room only when asked to.
    this.allChannels = options.allChannels === true;
    this.excludeGuildIds = toSet(options.excludeGuildIds);
    this.excludeChannelIds = toSet(options.excludeChannelIds);
    this.speakerNames = options.speakerNames || {};
    this.relayKinds = { user: true, assistant: true, presence: true, ...(options.relay || {}) };
    this.labels = new Map(); // userId -> last Discord display label seen in a turn line
    this.current = null; // { guildId, channelId } of the latest join/turn line (for untagged transcripts)
    this.rooms = new Map(); // "guild/channel" -> { present, turns: [{ at, userId, speaker }] }
  }

  room(guildId, channelId) {
    const key = `${guildId}/${channelId}`;
    let r = this.rooms.get(key);
    if (!r) this.rooms.set(key, (r = { present: false, turns: [] }));
    return r;
  }

  /** True while the agent is in the current room (kept for callers of 0.4). */
  get present() {
    return this.current ? this.room(this.current.guildId, this.current.channelId).present : false;
  }

  /** Feed one parsed event. Returns an output item or null. */
  push(event) {
    if (!event) return null;
    switch (event.type) {
      case "joined": {
        // A repeated "joined" within one stay (reconnect) is not a new session.
        const room = this.room(event.guildId, event.channelId);
        const changed = !room.present;
        this.current = { guildId: event.guildId, channelId: event.channelId };
        room.present = true;
        room.turns = [];
        if (!this.allowed()) return null;
        return { kind: "session", at: event.at, guildId: event.guildId, channelId: event.channelId, changed };
      }
      case "turn": {
        this.current = { guildId: event.guildId, channelId: event.channelId };
        const { turns } = this.room(event.guildId, event.channelId);
        turns.push({ at: event.at, userId: event.userId, speaker: event.speaker });
        if (event.speaker) this.labels.set(event.userId, event.speaker);
        if (turns.length > 50) turns.splice(0, turns.length - 50);
        return null;
      }
      case "left": {
        const room = this.room(event.guildId, event.channelId);
        const wasPresent = room.present;
        room.present = false;
        room.turns = [];
        if (!wasPresent || !this.allowedRoom(event.guildId, event.channelId)) return null;
        return { kind: "session-end", at: event.at, guildId: event.guildId, channelId: event.channelId };
      }
      case "presence": {
        // The line names its own room; it does not move the current room.
        if (!this.allowedRoom(event.guildId, event.channelId)) return null;
        return {
          kind: "presence",
          at: event.at,
          joined: event.joined,
          userId: event.userId,
          label: this.speakerNames[event.userId] || this.labels.get(event.userId),
          relay: this.relayKinds.presence !== false,
          guildId: event.guildId,
          channelId: event.channelId,
        };
      }
      case "user":
      case "assistant": {
        if (this.relayKinds[event.type] === false) return null;
        // A tagged line names its room; an untagged one (older Gateways) belongs to the latest room seen.
        const where = event.channelId ? { guildId: event.guildId, channelId: event.channelId } : this.current;
        if (!event.text || !(where ? this.allowedRoom(where.guildId, where.channelId) : this.allowed())) return null;
        const turns = where ? this.room(where.guildId, where.channelId).turns : [];
        const who = event.type === "assistant" ? { name: this.assistantName, guess: false } : this.speakerAt(event.at, turns);
        return {
          kind: "line",
          at: event.at,
          role: event.type,
          speaker: who.name,
          guess: who.guess,
          text: event.text,
          truncated: event.truncated,
          guildId: where?.guildId,
          channelId: where?.channelId,
        };
      }
      default:
        return null;
    }
  }

  /** Is any room configured to be relayed at all? */
  get enabled() {
    return this.allChannels || this.guildIds.size > 0 || this.channelIds.size > 0;
  }

  allowed() {
    // Before any join/turn line we cannot tell which room this is.
    if (!this.current) return this.allChannels && this.guildIds.size === 0 && this.channelIds.size === 0;
    return this.allowedRoom(this.current.guildId, this.current.channelId);
  }

  // Denylist first, then the allowlist (empty = every room only with allChannels).
  allowedRoom(guildId, channelId) {
    if (!this.enabled) return false;
    if (this.excludeGuildIds.has(guildId) || this.excludeChannelIds.has(channelId)) return false;
    if (this.guildIds.size && !this.guildIds.has(guildId)) return false;
    if (this.channelIds.size && !this.channelIds.has(channelId)) return false;
    return true;
  }

  speakerAt(at, turns) {
    const recent = turns.filter((t) => t.at <= at + 1000 && at - t.at <= this.speakerWindowMs);
    const last = recent.at(-1) ?? turns.at(-1);
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
