FROM oven/bun:1.4.2-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/tiny-sentry.sqlite \
    PORT=3000
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir /data && chown bun:bun /data
# Railway volumes mount with platform-managed ownership. The default root user
# keeps the first deployment writable; no credentials are baked into the image.
EXPOSE 3000
CMD ["bun", "src/server.ts"]
