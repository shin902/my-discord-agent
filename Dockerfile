FROM node:22-alpine

RUN apk add --no-cache \
    bash \
    python3 \
    curl \
    bind-tools \
    jq \
    git \
    github-cli \
    tzdata \
    sqlite

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN apk add --no-cache --virtual .native-build python3 make g++ && \
    corepack enable && \
    npm_config_build_from_source=true npm_config_nodedir=/usr/local pnpm install --prod --frozen-lockfile && \
    apk del .native-build

RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir \
    yt-dlp \
    feedparser \
    md2html-phuker

ENV PATH="/opt/venv/bin:$PATH"

COPY dist/sandbox/runner.bundle.mjs ./runner.mjs
