# Telegram setup

Status: Implemented

The Telegram adapter is a single-user private-chat bridge. It ignores every update not sent by the configured numeric Telegram user ID, and it sends output only to that same private chat.

## 1. Create the bot

Open the official [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. Telegram returns a bot token. Anyone with this token controls the bot, so do not paste it into source files, issue trackers, screenshots, or shell history. Revoke and replace it through @BotFather if it is exposed.

Open the new bot's private chat and press **Start** or send a message. Telegram bots cannot initiate this first conversation.

## 2. Find your numeric owner ID

If you do not already know it, stop any process polling this bot, send the bot a fresh private message, and read that update once. The following keeps the token out of the typed command line and prints only unique sender IDs:

```bash
read -rsp 'Telegram bot token: ' TELEGRAM_BOT_TOKEN; printf '\n'
export TELEGRAM_BOT_TOKEN
node <<'NODE'
const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`);
const payload = await response.json();
if (!response.ok || payload.ok !== true) throw new Error("Telegram getUpdates failed");
const ids = new Set(payload.result.flatMap((update) => {
  const message = update.message ?? update.edited_message;
  return message?.from?.id === undefined ? [] : [message.from.id];
}));
for (const id of ids) console.log(id);
NODE
```

Choose the ID belonging to your private message. Telegram's Bot API exposes user IDs as numeric values. Do not use a username or the bot's own ID.

## 3. Set the private-chat configuration

Store the three adapter values in `~/.qiyan-bot/.env`. Replace both placeholders and keep destination equal to owner:

```bash
mkdir -p "$HOME/.qiyan-bot"
chmod 700 "$HOME/.qiyan-bot"
cat > "$HOME/.qiyan-bot/.env" <<'EOF'
TELEGRAM_BOT_TOKEN=replace-with-botfather-token
TELEGRAM_OWNER_ID=123456789
TELEGRAM_DESTINATION_CHAT_ID=123456789
EOF
chmod 600 "$HOME/.qiyan-bot/.env"
```

`TELEGRAM_DESTINATION_CHAT_ID` must equal `TELEGRAM_OWNER_ID`; this enforces the single-user private chat. Group, channel, callback, edited, service, and non-owner input is not accepted as an assistant message.

When Slack is also configured, add its complete five-value group and set `PRIMARY_CHAT_APP=telegram` or `PRIMARY_CHAT_APP=slack`. Both adapters run in one process; the primary is only the route used before the first accepted owner message.

For a nondefault QiYan home, create `<QIYAN_HOME>/.env` instead and pass the same absolute `--home` to each command. Home selection is CLI `--home`, process `QIYAN_HOME`, then `$HOME/.qiyan-bot`; `QIYAN_HOME` is not valid inside `.env`.

## 4. Authenticate and start

Before starting, remember that the assistant defaults to non-interactive `danger-full-access`; workers must use an auto/non-interactive normal Codex configuration because Telegram has no approval UI. Complete the independent assistant login once, then start the bot:

```bash
qiyan-bot config-check
qiyan-bot assistant-login
qiyan-bot
```

No temporary Telegram exports or external service environment file are needed. Keep the process running. It starts in `~/.qiyan-bot/qiyan-workdir`; long polling receives updates while outbound replies use an independent transport, so one slow poll does not delay a ready response.

Telegram private-chat messages share one conversation identity. If QiYan is already working for that conversation, later text and attachments enter the same Codex turn through native `turn/steer`. QiYan supports one active conversation globally; a message from a future second adapter or conversation receives `[system] queued` and waits durably. The backend routes output to the owning conversation—QiYan never chooses a platform or destination.

## 5. Smoke test

In the bot's private chat:

1. Send a simple greeting and confirm the assistant responds.
2. Ask it to list available Codex sessions, then start or adopt a harmless project session with a memorable nickname.
3. Send `tell <nickname> /pass exact words` and verify the worker receives the text after `/pass ` unchanged.
4. Send `report <nickname> /collect 1` and verify the newest eligible worker final is delivered directly.
5. Send a small text attachment and ask the worker to inspect it.
6. Ask the assistant to send a small project file back as an attachment.

Worker terminal responses are delivered automatically with their session nickname. The assistant receives compact metadata and reads a full worker body only when management requires it.

`/pass` and `/collect` are ordinary messages and are steered or queued normally. They only activate exact FIFO validation when QiYan later invokes the matching worker send or collection tool.

If there is no input, confirm you messaged the bot before startup, the numeric owner ID is correct, and no other process is calling `getUpdates` for the same token. If replies are slow, inspect bot/app-server logs separately from Telegram delivery timing; sending itself should not wait for the long-poll request to finish.
