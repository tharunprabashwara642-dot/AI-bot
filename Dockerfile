FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/workspace
EXPOSE 8080
CMD ["node", "server.js"]
