FROM node:22-alpine

RUN apk add --no-cache \
    bash \
    python3

RUN adduser -D runner

WORKDIR /app

COPY dist/sandbox/runner.bundle.mjs ./runner.mjs

USER runner
