FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates openssh-client sudo \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Claude Code refuses --dangerously-skip-permissions when running as root.
# Create a dedicated unprivileged user for the Telegram agent.
RUN useradd --create-home --shell /bin/bash --uid 10001 agent \
    && mkdir -p /app /app/workspace \
    && chown -R agent:agent /app /home/agent

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chown -R agent:agent /app

USER agent

ENV HOME=/home/agent
ENV CLAUDE_WORKDIR=/app/workspace

EXPOSE 8080

CMD ["node", "server.js"]
