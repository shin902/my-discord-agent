FROM node:22-alpine

RUN apk add --no-cache \
    bash \
    python3 \
    py3-pip \
    curl \
    github-cli

RUN pip3 install --break-system-packages \
    https://github.com/Panniantong/agent-reach/archive/main.zip \
    yt-dlp \
    feedparser

WORKDIR /app

COPY dist/sandbox/runner.bundle.mjs ./runner.mjs
