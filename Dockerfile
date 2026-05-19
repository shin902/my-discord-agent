FROM node:22-alpine

RUN apk add --no-cache \
    bash \
    python3 \
    py3-pip \
    curl \
    github-cli

RUN pip3 install --break-system-packages \
    https://github.com/Panniantong/agent-reach/archive/17624268a059ccfb23eba8a2ba50f9f92c8dc0ca.zip \
    yt-dlp \
    feedparser

WORKDIR /app

COPY dist/sandbox/runner.bundle.mjs ./runner.mjs
