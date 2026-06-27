FROM node:22-alpine

RUN apk add --no-cache \
    bash \
    python3 \
    curl \
    jq \
    git \
    github-cli \
    tzdata \
    sqlite

RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir \
    yt-dlp \
    feedparser \
    md2html-phuker

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY dist/sandbox/runner.bundle.mjs ./runner.mjs
