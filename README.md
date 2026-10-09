# OpenClaw Voice Transcript Relay

**You talk to your OpenClaw agent in a Discord voice channel. This posts the conversation — what you said and what the agent said back, with names — into a text channel or thread while you talk, so you can read it later.**

[日本語](#日本語) · MIT · OpenClaw plugin (and a standalone CLI) · verified with **OpenClaw 2026.9.6 + `@openclaw/discord` 2026.9.6**, Discord voice in realtime mode · no model calls, no extra cost

```text
#voice-lounge (the voice channel's own chat)
🎙️ This voice chat is transcribed here.
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

The text is already there, though: the Gateway logs every final transcript, user and assistant, the moment it arrives. This plugin follows that log and posts the lines to Discord.

> [!IMPORTANT]
> **This reads the Gateway's log lines, not an API.** In OpenClaw 2026.9.6 the Discord voice runtime does not expose realtime transcripts through plugin hooks or events, so the log is the only place they appear. The line formats are pinned by tests against 2026.9.6; a Gateway update can change them. After upgrading, check with `--replay` (see [Check it against a log](#check-it-against-a-log)).

## Install the plugin

```sh
openclaw plugins install clawhub:@yousan/openclaw-voice-transcript-relay
openclaw config set plugins.entries.voice-transcript-relay.config '{
  "channelIds": ["234567890123456789"],
  "assistantName": "Assistant"
}' --json
openclaw config set plugins.entries.voice-transcript-relay.enabled true --json
openclaw gateway restart
```

That's all: when the agent joins that voice channel, what is said appears in the **voice channel's own chat**, posted by the agent's Discord account (no webhook, no extra token). The Gateway log shows `voice-transcript-relay: posted <message id>` for each post.

From a clone instead of ClawHub: `openclaw plugins install --link /path/to/openclaw-voice-transcript-relay`.

## How it works

```text
OpenClaw Gateway ──writes──▶ /tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log
                                 │  discord voice: joined guild=… channel=…
                                 │  discord voice: realtime speaker turn opened … user=… speaker=Alice
                                 │  discord voice: realtime user transcript (…): …
                                 │  discord voice: realtime assistant transcript (…): …
                                 ▼
          voice-transcript-relay service inside the Gateway (follows the file, ~0.5 s)
                                 │
                                 ▼  Gateway's Discord account (or a webhook), mentions defused
                      the voice channel's chat  ·  or `to`: any channel / thread
```

- **Speaker names.** The agent's lines get `assistantName`. A human's line gets the Discord display name from the `speaker turn opened` line just before it. With one person in the room this is exact. If two people started talking within `speakerWindowMs`, the line is posted as `Name?` to show it is a guess. `speakerNames` maps user ids to fixed names.
- **No model calls.** Nothing is summarised or rewritten; there is no agent turn per utterance.
- **Nothing lost on restart.** The read position (file, inode, byte offset) is saved after each successful post, in `<state dir>/voice-transcript-relay/state.json`. On restart it resumes there, including when the log was rotated in between. Rate limits (429) and network errors are retried in order.
- **Delay.** About the poll interval (0.5 s) plus `flushMs` (default 5 s): lines are collected and posted together, because Discord allows about 30 messages per minute per channel.
- **Joins and leaves.** `➡️ Bob joined` / `⬅️ Bob left` lines, from the Gateway's `participant joined/left` log lines. Names and "is this a bot" come from a Discord member lookup (the plugin uses the Gateway's own Discord token for it; the CLI uses `bot.*` or `lookup.*`).
- **Join notice.** When someone joins while the agent is in the room, the destination gets `@Bob This channel's conversation is transcribed as text.` — a real mention that notifies them. Not for the agent or other bots, nor for anyone the lookup cannot resolve; at most once per person while the agent stays in the room. Turn it off with `welcome.enabled: false`.
- **The agent does not answer its own transcript.** The posts are the agent's own messages (or webhook/bot messages, which OpenClaw ignores unless `channels.discord.allowBots` is on).

## Standalone CLI

The same relay runs outside the Gateway, without a restart: `bin/voice-transcript-relay.js`. It posts through a Discord webhook (`webhook.urlFile`), or as a bot (`bot.channelId` + `bot.tokenFile` / `bot.openclawConfig`) where you cannot create a webhook. You need Node 20+.

```sh
git clone https://github.com/yousan/openclaw-voice-transcript-relay
cd openclaw-voice-transcript-relay
mkdir -p ~/.config/openclaw-voice-transcript-relay
cp examples/config.example.json ~/.config/openclaw-voice-transcript-relay/work.json   # edit it
( umask 077; printf '%s\n' 'https://discord.com/api/webhooks/…' > ~/.config/openclaw-voice-transcript-relay/work.webhook )
node bin/voice-transcript-relay.js --config ~/.config/openclaw-voice-transcript-relay/work.json
```

A systemd user unit is in [`examples/voice-transcript-relay@.service`](examples/voice-transcript-relay@.service). Do not run the CLI and the plugin for the same Gateway at the same time — both would post. To switch, stop the CLI, then point the plugin's `stateFile` at the CLI's state file so it resumes where the CLI stopped.

### Check it against a log

```sh
# prints, posts nothing
node bin/voice-transcript-relay.js --config work.json --replay /tmp/openclaw/openclaw-work-2026-01-02.log
```

## Configuration

Plugin: `plugins.entries.voice-transcript-relay.config`. CLI: the JSON file given with `--config`.

| key | default | |
|---|---|---|
| `profile` | plugin: the Gateway's `OPENCLAW_PROFILE` | OpenClaw profile; selects `openclaw-<profile>-YYYY-MM-DD.log` |
| `logFile` | plugin: `logging.file` if set | Read this file instead of the rolling log |
| `logDir` | `/tmp/openclaw` | Where the Gateway writes its rolling log |
| `guildIds`, `channelIds` | all | Allowlist: only relay these voice rooms (empty = every room the agent joins) |
| `excludeGuildIds`, `excludeChannelIds` | none | Denylist: never relay these rooms, even if the allowlist is empty or lists them. Speech, joins/leaves and join notices alike |
| `assistantName` | `assistant` | Name shown on the agent's lines |
| `speakerNames` | `{}` | `{ "<user id>": "Name" }`, overrides the Discord display name |
| `speakerWindowMs` | `30000` | Turns opened by others within this window make a line a guess (`Name?`) |
| `flushMs` | plugin `5000`, CLI `0` | `0` = one message per utterance; otherwise collect for this long |
| `showTime` | `false` | Prefix each line with `HH:MM:SS` (`timeZone` to pick the zone) |
| `sessionHeader` | plugin `🎙️ This voice chat is transcribed here.`, CLI `🎙️ <#{channelId}>` | Posted when the agent joins a room (`{channelId}`, `{guildId}` replaced); `false` to turn off |
| `to` | plugin: the voice channel's chat | Discord target, e.g. `channel:<id>` (a thread id works too) |
| `accountId` | default account | Which configured Discord account posts (plugin) |
| `truncatedMark` | ` …` | Appended to lines the log cut short (see Limitations) |
| `relay` | `{ user: true, assistant: true, presence: true }` | What to post: human speech, the agent's speech, joins and leaves |
| `welcome` | `{ enabled: true, text: "{mention} This channel's conversation is transcribed as text." }` | Mention people who join (see above) |
| `joinedText`, `leftText` | `➡️ {name} joined`, `⬅️ {name} left` | Join/leave line templates |
| `lookup.tokenFile` / `lookup.openclawConfig` | CLI: `bot`'s token if set | Bot token used only to look up members (names, bot or not). Without one, join lines show the last known name or the user id and no join notices are sent |
| `webhook.url` / `webhook.urlFile` | | Post through a webhook instead. Keep the URL out of the config: use `urlFile` (or `VTR_WEBHOOK_URL` for the CLI) |
| `webhook.threadId` | | Post into this thread of the webhook's channel |
| `webhook.username`, `webhook.avatarUrl` | | How the poster appears |
| `bot.channelId` | | Post as a bot into this channel instead of a webhook (when you cannot create a webhook there). A voice channel's id posts into its own chat |
| `bot.tokenFile` / `bot.openclawConfig` | | The bot token: a file, or the OpenClaw config that already has it (`channels.discord.token`, plain string only). Or `VTR_BOT_TOKEN` |
| `stateFile` | plugin `<state dir>/voice-transcript-relay/state.json`, CLI `~/.local/state/openclaw-voice-transcript-relay/<profile>.json` | Saved read position |

CLI only — environment variables override the file: `VTR_CONFIG`, `VTR_PROFILE`, `VTR_LOG_DIR`, `VTR_GUILD_IDS`, `VTR_CHANNEL_IDS`, `VTR_EXCLUDE_CHANNEL_IDS`, `VTR_ASSISTANT_NAME`, `VTR_FLUSH_MS`, `VTR_WEBHOOK_URL`, `VTR_THREAD_ID`, `VTR_BOT_TOKEN`, `VTR_STATE_FILE`.

## Before you use it with other people

Everything said in the room by anyone the bot hears is posted, with their name, to a text channel that may have a different audience. Tell people before they join, and pick a destination only the participants can read. Discord voice channels have no topic and their chat cannot pin messages, so the plugin posts `sessionHeader` in the chat each time the agent joins; say it there, and in a server rule or channel the participants read. Use `channelIds` to keep it to the rooms you meant.

## Limitations

- **It reads log lines, not an API.** The formats are pinned by tests against OpenClaw 2026.9.6 with `@openclaw/discord` 2026.9.6. A Gateway update can change them; check `--replay` on a fresh log after upgrading. If `logging.level` is above `info`, there is nothing to read (`debug` is fine).
- **Long utterances are cut at 500 characters** by the Gateway's logger. Such lines end with `truncatedMark`.
- **Only realtime mode.** In `stt-tts` mode the Gateway does not log these lines.
- **Speech the realtime model did not transcribe is not there** — e.g. people the bot is not set up to talk to. For a full record of everyone in the room, use OpenClaw's transcripts feature.
- **One voice room at a time per Gateway.** Transcript lines carry no room id; they are assigned to the room of the latest `joined` / `turn opened` line.
- **Who said it is inferred** when several people talk at once (`Name?`).
- **Joins and leaves only while the agent is in the room.** The Gateway logs individual joins and leaves only then. People already in the room when the agent joins — including the person whose arrival makes the agent join (`whenOccupied` auto-join) — appear in the log only as a count, so they get no join line and no join notice; the `sessionHeader` posted at that moment is what tells them. Nothing is logged while the agent is not in the room.
- **Mentions through the Gateway's account.** OpenClaw's Discord send does not take per-message mention settings, so join/leave lines use names, not mentions; only the join notice mentions anyone.

## Development

```sh
npm test                       # unit tests, including the plugin service with a stand-in Gateway API
clawhub package validate .
node bin/voice-transcript-relay.js --replay path/to/openclaw-<profile>-YYYY-MM-DD.log
```

## 日本語

OpenClaw の Discord ボイス（realtime モード）で bot と話した内容を、**話しながら**テキストチャンネルかスレッドに全文で流す OpenClaw プラグインです（単体で動く CLI 版も同梱）。人の発話も bot の返事も、名前付きで流れます。モデルは呼びません（追加費用なし）。**確認した版: OpenClaw 2026.9.6 + `@openclaw/discord` 2026.9.6。**

- **入れ方**: `openclaw plugins install clawhub:@yousan/openclaw-voice-transcript-relay` → `plugins.entries.voice-transcript-relay.config` に `channelIds` などを書く → gateway を再起動。既定では **VC 自身のチャット**に、bot の Discord アカウントで投稿します（webhook もトークンも不要）。

- **CLI 版の流す先**: webhook（スレッド・VC のチャットも可）。webhook を作れない場所は `bot` 設定で bot として投稿できます（トークンは `bot.tokenFile` か、OpenClaw の設定ファイルを `bot.openclawConfig` で参照）。
- **仕組み**: Gateway のログ（`/tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log`）に出る `realtime user transcript` / `realtime assistant transcript` の行を追いかけて投稿します。プラグインは gateway の中のサービスとして動きます。CLI 版は gateway の外で動くので、再起動も設定変更も要りません。
- **本体の transcripts との違い**: transcripts は realtime モードでは人の発話しか保存せず、Discord への投稿機能もありません。
- **話者名**: bot は `assistantName`、人は直前の `speaker turn opened` 行の表示名。同時に複数人が話し始めたときは `名前?` と推定であることを示します。
- **取りこぼし対策**: 投稿に成功した位置（ファイル・inode・バイト位置）を保存し、再起動やログのローテーションをまたいでも続きから流します。429 等は順番を保って再送します。
- **他の人がいる部屋で使う前に**: 部屋にいる人の発言が名前付きで別のチャンネルに残ることを、チャンネルの説明などで先に伝えてください。流す先は参加者だけが読める場所にしてください。
- **入退室と入室案内**: bot が VC にいる間の入退室を `➡️ 名前 joined` / `⬅️ 名前 left` で流し、入ってきた人にはメンションで「このチャンネルの会話は文字で転記されています」と知らせます（`welcome.text` で文言を変更、`welcome.enabled: false` で停止）。bot・ほかの bot・名前を引けない人には出しません。**bot が入った時点ですでに部屋にいた人（自動入室のきっかけになった人を含む）はログに人数しか出ないため、入退室の行も案内も出ません**。その場合は入室時の `sessionHeader` で伝えます。何を流すかは `relay: { user, assistant, presence }` で個別に切れます。
- **転記する VC の選び方**: `channelIds`（転記する VC だけを指定、空なら全部 = 既定）と `excludeChannelIds`（転記しない VC を指定）。両方書いたときは除外が優先です。
- **CLI 版とプラグインを同じ gateway に同時に使わない**（二重に流れます）。切り替えるときは CLI を止め、プラグインの `stateFile` を CLI の位置ファイルに向けると続きから流れます。
- **制限**: ログの書式は公開 API ではありません（2026.9.6 で確認、更新後は `--replay` で確認を）。500 文字を超える発話はログ側で切られます。stt-tts モードは対象外です。

設定は上の表を参照してください。webhook の URL は JSON に書かず、`webhook.urlFile` か環境変数 `VTR_WEBHOOK_URL` で渡します。

## Built with AI

This project was written with Claude Code (Anthropic's Claude), directed and reviewed by a human maintainer.

## License

MIT
