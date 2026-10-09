// Parse OpenClaw gateway log lines (JSON per line) into voice events.
//
// The Discord voice runtime logs, at INFO:
//   discord voice: joined guild=<g> channel=<c> mode=... agent=<a> ...
//   discord voice: realtime speaker turn opened guild=<g> channel=<c> user=<u> speaker=<label> owner=<bool>
//   discord voice: realtime user transcript (<n> chars): <text>
//   discord voice: realtime assistant transcript (<n> chars): <text>
// Transcript text is whitespace-collapsed and cut at 500 chars ("..." suffix).
// None of this is a public API; tests pin the formats seen in OpenClaw 2026.9.6.

const JOINED = /^discord voice: joined guild=(\S+) channel=(\S+)(?: .*?\bagent=(\S+))?/;
const TURN_OPENED = /^discord voice: realtime speaker turn opened guild=(\S+) channel=(\S+) user=(\S+) speaker=(.*?) owner=(\S+)/;
const TRANSCRIPT = /^discord voice: realtime (user|assistant) transcript \((\d+) chars\): ([\s\S]*)$/;

export function parseLine(line) {
  if (!line || line[0] !== "{" || !line.includes("discord voice: ")) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const message = typeof record.message === "string" ? record.message : record["1"];
  if (typeof message !== "string") return null;
  const at = parseTime(record);

  let m = TRANSCRIPT.exec(message);
  if (m) {
    const length = Number(m[2]);
    let text = m[3].trim();
    // The logger cuts at 500 UTF-16 units and appends "...".
    const truncated = length > 500 && text.endsWith("...") && text.length - 3 >= 499;
    if (truncated) text = text.slice(0, -3);
    return { type: m[1], at, text, length, truncated };
  }
  m = TURN_OPENED.exec(message);
  if (m) {
    return { type: "turn", at, guildId: m[1], channelId: m[2], userId: m[3], speaker: m[4], owner: m[5] === "true" };
  }
  m = JOINED.exec(message);
  if (m) {
    return { type: "joined", at, guildId: m[1], channelId: m[2], agentId: m[3] };
  }
  return null;
}

function parseTime(record) {
  const raw = record.time ?? record._meta?.date;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}
