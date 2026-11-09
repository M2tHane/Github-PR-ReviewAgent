FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY frontend ./frontend
COPY scripts/build-admin.mjs ./scripts/build-admin.mjs
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3-venv ripgrep fd-find \
    && python3 -m venv /opt/semgrep \
    && /opt/semgrep/bin/pip install --no-cache-dir semgrep==1.136.0 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    SEMGREP_PATH=/opt/semgrep/bin/semgrep
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/admin ./dist/admin
COPY migrations ./migrations
COPY rules ./rules
# 服务自有的 Pi AGENTS.md 与 Skills；Pi 的 grep / find 离线运行，依赖上面装的 ripgrep 和 fd-find。
COPY agent ./agent
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
