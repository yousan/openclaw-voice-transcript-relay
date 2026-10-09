# OpenClaw Voice Transcript Relay

**You talk to your OpenClaw agent in a Discord voice channel. This posts the conversation — what you said and what the agent said back, with names — into a text channel or thread while you talk, so you can read it later.**

[日本語](#日本語) · MIT · works with OpenClaw 2026.9.6+ (Discord voice in realtime mode) · no model calls, no extra cost

```text
🎙️ #voice-lounge
**Alice**: Do you know what I was working on today?
**Assistant**: Let me check.
**Assistant**: You fixed the login bug and wrote the release notes.
**Alice**: That's right, thanks.
```

## Why

OpenClaw's Discord voice (realtime mode, e.g. `gpt-live-1-codex`) is a good way to talk to an agent, but nothing you said is left in Discord afterwards. OpenClaw's own [transcripts](https://docs.openclaw.ai/channels/discord/voice-transcripts) feature records meetings, but it

- records **only the humans** in realtime mode (the agent's spoken answers are not stored),
- needs an extra batch speech-to-text pass for full coverage (one more paid transcription per utterance),
- keeps the result in the Gateway's database and Control UI — *"Summaries are not automatically posted to Discord."*

The text is already there, though: the Gateway logs every final transcript, user and assistant, the moment it arrives. This tool follows that log and posts the lines to Discord.

## How it works

```text
OpenClaw Gateway ──writes──▶ /tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log
                                 │  discord voice: joined guild=… channel=…
                                 │  discord voice: realtime speaker turn opened … user=… speaker=Alice
                                 │  discord voice: realtime user transcript (…): …
                                 │  discord voice: realtime assistant transcript (…): …
                                 ▼
                      voice-transcript-relay  (follows the file, ~0.5 s)
                                 │
                                 ▼  Discord webhook (no bot token, mentions disabled)
                      #text-channel  or  a thread
```

- **Speaker names.** The agent's lines get `assistantName`. A human's line gets the Discord display name from the `speaker turn opened` line just before it. With one person in the room this is exact. If two people started talking within `speakerWindowMs`, the line is posted as `Name?` to show it is a guess. `speakerNames` maps user ids to fixed names.
- **No model calls.** Nothing is summarised or rewritten; there is no agent turn per utterance.
- **Nothing lost on restart.** The read position (file, inode, byte offset) is saved after each successful post. On restart it resumes there, including when the log was rotated in between. Rate limits (429) and network errors are retried in order.
- **Delay.** About the poll interval (0.5 s) plus Discord. With `flushMs` it waits that long and posts the collected lines as one message (recommended: a few seconds — Discord allows about 30 webhook messages per minute per channel).
- **The agent does not answer its own transcript.** Webhook messages are bot messages, which OpenClaw ignores unless `channels.discord.allowBots` is on. Still, prefer a channel or thread the agent does not listen in.

## Install

You need Node 20+ on the Gateway host, and a Discord webhook for the channel you want the transcript in (Channel settings → Integrations → Webhooks → New Webhook → Copy URL). To post into a thread, use the parent channel's webhook and set `threadId`.

```sh
git clone https://github.com/yousan/openclaw-voice-transcript-relay
cd openclaw-voice-transcript-relay

mkdir -p ~/.config/openclaw-voice-transcript-relay
cp examples/config.example.json ~/.config/openclaw-voice-transcript-relay/work.json   # edit it
( umask 077; printf '%s\n' 'https://discord.com/api/webhooks/…' > ~/.config/openclaw-voice-transcript-relay/work.webhook )

# Check it against a log you already have: prints, posts nothing
node bin/voice-transcript-relay.js --config ~/.config/openclaw-voice-transcript-relay/work.json \
  --replay /tmp/openclaw/openclaw-work-2026-01-02.log

# Run it
node bin/voice-transcript-relay.js --config ~/.config/openclaw-voice-transcript-relay/work.json
```

A systemd user unit is in [`examples/voice-transcript-relay@.service`](examples/voice-transcript-relay@.service). It runs next to the Gateway; the Gateway does not need a restart or any config change.

## Configuration

| key | default | |
|---|---|---|
| `profile` | `""` | OpenClaw profile; selects `openclaw-<profile>-YYYY-MM-DD.log` |
| `logDir` | `/tmp/openclaw` | Where the Gateway writes its rolling log |
| `guildIds`, `channelIds` | all | Only relay these voice rooms |
| `assistantName` | `assistant` | Name shown on the agent's lines |
| `speakerNames` | `{}` | `{ "<user id>": "Name" }`, overrides the Discord display name |
| `speakerWindowMs` | `30000` | Turns opened by others within this window make a line a guess (`Name?`) |
| `flushMs` | `0` | `0` = one message per utterance; otherwise collect for this long |
| `showTime` | `false` | Prefix each line with `HH:MM:SS` (`timeZone` to pick the zone) |
| `sessionHeader` | `🎙️ <#{channelId}>` | Posted when the bot joins a room; `false` to turn off |
| `truncatedMark` | ` …` | Appended to lines the log cut short (see Limitations) |
| `webhook.url` / `webhook.urlFile` | | The webhook. Keep it out of the JSON: use `urlFile` or `VTR_WEBHOOK_URL` |
| `webhook.threadId` | | Post into this thread of the webhook's channel |
| `webhook.username`, `webhook.avatarUrl` | | How the poster appears |
| `stateFile` | `~/.local/state/openclaw-voice-transcript-relay/<profile>.json` | Saved read position |

Environment variables override the file: `VTR_CONFIG`, `VTR_PROFILE`, `VTR_LOG_DIR`, `VTR_GUILD_IDS`, `VTR_CHANNEL_IDS`, `VTR_ASSISTANT_NAME`, `VTR_FLUSH_MS`, `VTR_WEBHOOK_URL`, `VTR_THREAD_ID`, `VTR_STATE_FILE`.

## Before you use it with other people

Everything said in the room by anyone the bot hears is posted, with their name, to a text channel that may have a different audience. Tell people before they join, for example in the voice channel's description or the channel topic, and pick a destination only the participants can read. Use `channelIds` to keep it to the rooms you meant.

## Limitations

- **It reads log lines, not an API.** The formats are pinned by tests against OpenClaw 2026.9.6. A Gateway update can change them; check `--replay` on a fresh log after upgrading. If `logging.level` is above `info`, there is nothing to read.
- **Long utterances are cut at 500 characters** by the Gateway's logger. Such lines end with `truncatedMark`.
- **Only realtime mode.** In `stt-tts` mode the Gateway does not log these lines.
- **Speech the realtime model did not transcribe is not there** — e.g. people the bot is not set up to talk to. For a full record of everyone in the room, use OpenClaw's transcripts feature.
- **One voice room at a time per Gateway.** Transcript lines carry no room id; they are assigned to the room of the latest `joined` / `turn opened` line.
- **Who said it is inferred** when several people talk at once (`Name?`).

## Development

```sh
npm test
node bin/voice-transcript-relay.js --replay path/to/openclaw-<profile>-YYYY-MM-DD.log
```

## 日本語

OpenClaw の Discord ボイス（realtime モード）で bot と話した内容を、**話しながら**テキストチャンネルかスレッドに全文で流します。人の発話も bot の返事も、名前付きで流れます。モデルは呼びません（追加費用なし）。

- **仕組み**: Gateway のログ（`/tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log`）に出る `realtime user transcript` / `realtime assistant transcript` の行を追いかけ、Discord の webhook に投稿します。Gateway の再起動や設定変更は要りません。
- **本体の transcripts との違い**: transcripts は realtime モードでは人の発話しか保存せず、Discord への投稿機能もありません。
- **話者名**: bot は `assistantName`、人は直前の `speaker turn opened` 行の表示名。同時に複数人が話し始めたときは `名前?` と推定であることを示します。
- **取りこぼし対策**: 投稿に成功した位置（ファイル・inode・バイト位置）を保存し、再起動やログのローテーションをまたいでも続きから流します。429 等は順番を保って再送します。
- **他の人がいる部屋で使う前に**: 部屋にいる人の発言が名前付きで別のチャンネルに残ることを、チャンネルの説明などで先に伝えてください。流す先は参加者だけが読める場所にしてください。
- **制限**: ログの書式は公開 API ではありません（2026.9.6 で確認、更新後は `--replay` で確認を）。500 文字を超える発話はログ側で切られます。stt-tts モードは対象外です。

設定は上の表を参照してください。webhook の URL は JSON に書かず、`webhook.urlFile` か環境変数 `VTR_WEBHOOK_URL` で渡します。

## Built with AI

This project was written with Claude Code (Anthropic's Claude), directed and reviewed by a human maintainer.

## License

MIT
