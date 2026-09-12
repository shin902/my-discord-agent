FROM node:22-alpine

ARG MNEMON_VERSION=0.2.8
ARG MNEMON_SHA256_AMD64=0ba89bed5fc55b405f8f923d9f942b9f0cb97bc1a253df24b61b342166589e54
ARG MNEMON_SHA256_ARM64=54f6d5adc205a90f756e348fe1f439dbc961e4886b6f56fa9f0a80db614559ef
ARG TARGETARCH

RUN apk add --no-cache \
    bash \
    python3 \
    curl \
    ca-certificates \
    bind-tools \
    jq \
    git \
    github-cli \
    iptables \
    util-linux \
    tzdata \
    sqlite

RUN set -eux; \
    target_arch="${TARGETARCH:-amd64}"; \
    case "${target_arch}" in \
      amd64) checksum="${MNEMON_SHA256_AMD64}" ;; \
      arm64) checksum="${MNEMON_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${target_arch}" >&2; exit 1 ;; \
    esac; \
    archive="mnemon_${MNEMON_VERSION}_linux_${target_arch}.tar.gz"; \
    url="https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/${archive}"; \
    curl -fsSL "${url}" -o "/tmp/${archive}"; \
    echo "${checksum}  /tmp/${archive}" | sha256sum -c -; \
    tar -xzf "/tmp/${archive}" -C /usr/local/bin mnemon; \
    chmod 755 /usr/local/bin/mnemon; \
    test "$(/usr/local/bin/mnemon --version)" = "mnemon version ${MNEMON_VERSION}"; \
    rm "/tmp/${archive}"

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
ARG RUNNER_SQLITE_BUILD_FROM_SOURCE=false
RUN apk add --no-cache --virtual .native-build python3 make g++ && \
    corepack enable && \
    if [ "$RUNNER_SQLITE_BUILD_FROM_SOURCE" = "true" ]; then \
      export npm_config_build_from_source=true; \
    fi && \
    npm_config_nodedir=/usr/local pnpm install --prod --frozen-lockfile && \
    apk del .native-build

RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir md2html-phuker

ENV PATH="/opt/venv/bin:$PATH" \
    TZ="Asia/Tokyo" \
    MNEMON_DATA_DIR="/workspace/.mnemon"

COPY dist/sandbox/runner.bundle.mjs ./runner.mjs

COPY dist/sandbox/tool-proxy-cli.mjs ./tool-proxy-cli.mjs
RUN chmod 755 /app/tool-proxy-cli.mjs && ln -s /app/tool-proxy-cli.mjs /usr/local/bin/tool-proxy
COPY scripts/sandbox-entrypoint.sh ./sandbox-entrypoint.sh
