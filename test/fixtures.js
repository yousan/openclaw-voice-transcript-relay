// Log lines in the shape OpenClaw 2026.9.6 writes them. All ids are dummies.
export const G = "100000000000000001";
export const C = "200000000000000002";
export const U1 = "300000000000000003";
export const U2 = "300000000000000004";

let clock = Date.parse("2026-01-02T03:04:05.000Z");
export function at(ms) {
  clock = Date.parse("2026-01-02T03:04:05.000Z") + ms;
}

export function line(message) {
  const iso = new Date(clock).toISOString();
  return JSON.stringify({
    0: '{"subsystem":"discord/voice"}',
    1: message,
    _meta: { logLevelName: "INFO", date: iso },
    time: iso,
    message,
  });
}

export const joined = (g = G, c = C) =>
  line(`discord voice: joined guild=${g} channel=${c} mode=agent-proxy agent=main voiceSession=agent:main:discord:channel:${c}`);
export const turn = (user, speaker, g = G, c = C) =>
  line(`discord voice: realtime speaker turn opened guild=${g} channel=${c} user=${user} speaker=${speaker} owner=true`);
export const said = (role, text, length = text.length) =>
  line(`discord voice: realtime ${role} transcript (${length} chars): ${text}`);
export const presence = (joinedOrLeft, user, g = G, c = C) =>
  line(`discord voice: participant ${joinedOrLeft} event queued guild=${g} channel=${c} user=${user} supervisorSession=agent:main:discord:channel:${c}`);
