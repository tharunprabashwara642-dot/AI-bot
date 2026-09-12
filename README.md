# Railway Claude Code + Telegram + TabiToken

Railway-ready Docker project running Claude Code with a Telegram interface and a local Anthropic Messages compatibility bridge to TabiToken's OpenAI-compatible `/v1/chat/completions` endpoint.

## Railway Variables

Required:

```text
TELEGRAM_BOT_TOKEN=YOUR_BOTFATHER_TOKEN
TABITOKEN_API_KEY=YOUR_TABITOKEN_KEY
TABITOKEN_BASE_URL=https://tabitoken.com/v1
CLAUDE_MODEL=claude-sonnet-5
LOCAL_ANTHROPIC_AUTH_TOKEN=LONG_RANDOM_SECRET
```

Recommended:

```text
PORT=8080
CLAUDE_WORKDIR=/app/workspace
CLAUDE_TIMEOUT_MS=1800000
```

Optional security allowlist:

```text
TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

## Deploy

1. Deploy this GitHub repository to Railway.
2. Railway detects the Dockerfile.
3. Add the variables above.
4. Deploy.
5. Open the Telegram bot and send `/start`.

## Persistent workspace

Create a Railway Volume and mount it at `/app/workspace` if you want files to survive restarts/redeploys.

## Security

The worker uses `--dangerously-skip-permissions` for unattended execution. Restrict the bot with `TELEGRAM_ALLOWED_CHAT_IDS` and never put API keys in GitHub.

The default model is `claude-sonnet-5`.
