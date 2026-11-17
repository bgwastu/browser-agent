FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY server ./server
COPY extension/src/shared.ts ./extension/src/shared.ts
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "server/src/index.ts"]
