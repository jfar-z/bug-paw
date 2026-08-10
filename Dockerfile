FROM node:24-bookworm-slim AS build

WORKDIR /app
# LanceDB 的 ONNX 依赖默认下载 CUDA 二进制；本服务使用 CPU 索引，跳过该可选下载。
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY config ./config
RUN npm run verify

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=7080
ENV PI_AGENT_DATA_ROOT=/data
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip

WORKDIR /app
# 为容器内 Agent 提供常用开发、网络诊断与文件处理能力。
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates curl wget iproute2 iputils-ping dnsutils netcat-openbsd \
    git python3 python3-pip python3-venv build-essential pkg-config \
    jq ripgrep fd-find less file patch zip unzip xz-utils bzip2 tree \
    procps psmisc lsof sqlite3 \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && ln -s /usr/bin/python3 /usr/local/bin/python \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist/web ./dist/web
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY scripts ./scripts

EXPOSE 7080
# 直接执行应用进程，确保 Compose 的 SIGTERM 不经过 npm 转发层。
CMD ["node", "--import", "tsx", "src/server/main.ts"]
