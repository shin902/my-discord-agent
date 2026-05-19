FROM node:22-alpine

RUN apk add --no-cache \
    bash \
    python3 \
    curl \
    github-cli

RUN python3 -m venv /opt/venv
RUN /opt/venv/bin/pip install --no-cache-dir \
    yt-dlp==2026.3.17 \
    feedparser==6.0.12

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY dist/sandbox/runner.bundle.mjs ./runner.mjs
