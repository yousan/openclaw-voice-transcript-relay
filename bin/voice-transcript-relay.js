#!/usr/bin/env node
// Standalone runner: follow an OpenClaw gateway log and post Discord voice
// transcripts to a text channel or thread. Inside OpenClaw, use the plugin
// instead (openclaw/index.js). See README.md.

import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { startRelay, replayFile } from "../src/service.js";
import { botSender, webhookSender } from "../src/discord.js";

const { values: args } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
    "dry-run": { type: "boolean" },
    "from-start": { type: "boolean" },
    replay: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(`usage: voice-transcript-relay [--config file.json] [--dry-run] [--from-start] [--replay log-file]

  --config      JSON config (see examples/config.example.json); env VTR_* overrides it
  --dry-run     print messages instead of posting; does not touch the state file
  --from-start  read today's log from the beginning instead of the end (first run only)
  --replay      read one log file from the beginning, print, and exit (implies --dry-run)`);
  process.exit(0);
}

const dryRun = Boolean(args["dry-run"] || args.replay);
const config = loadConfig({ file: args.config ?? process.env.VTR_CONFIG, needWebhook: !dryRun });

const send = dryRun
  ? async (content) => void console.log(content + "\n---")
  : config.bot
    ? botSender(config.bot)
    : webhookSender(config.webhook);

if (args.replay) {
  await replayFile({ config, file: args.replay, send });
  process.exit(0);
}

const relay = startRelay({ config, send, persist: !dryRun, fromStart: Boolean(args["from-start"]) });
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await relay.stop();
    process.exit(0);
  });
}
// startRelay's timer is unref'd so the plugin never holds the Gateway open; keep the CLI alive.
setInterval(() => {}, 1 << 30);
