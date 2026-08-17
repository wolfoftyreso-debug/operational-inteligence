# Operational Intelligence — production image.
# Multi-stage: build TypeScript, then run a minimal runtime image.
# Runtime state (SQLite + generated secret key) lives in /data — mount a
# persistent volume there. See docs/DEPLOYMENT.md for the full contract.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/db/schema.sql ./src/db/schema.sql
COPY public ./public

# Non-root user; /data holds SQLite + secret key (mount persistent volume).
RUN addgroup -S oi && adduser -S oi -G oi && mkdir -p /data && chown oi:oi /data
USER oi
ENV OI_DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

# Liveness: /healthz  Readiness: /readyz
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "--no-warnings", "dist/src/index.js"]
