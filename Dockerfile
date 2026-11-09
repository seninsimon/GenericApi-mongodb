FROM node:22-alpine

ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src

USER node

EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT:-5000}/ >/dev/null || exit 1

CMD ["node", "src/server.js"]
