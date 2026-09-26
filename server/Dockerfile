# ── build ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
COPY packages/app-kit/package.json packages/app-kit/
COPY apps/student/package.json apps/student/
COPY apps/institute/package.json apps/institute/
COPY apps/developer/package.json apps/developer/
RUN npm ci --workspace server --include-workspace-root=false --ignore-scripts
COPY packages/protocol packages/protocol
COPY server server
RUN npm run build --workspace server

# ── runtime: just the self-contained bundle + SQL migrations ─────────────
FROM node:22-alpine
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /repo/server/dist ./dist
COPY --from=build /repo/server/migrations ./migrations
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "dist/server.cjs"]
