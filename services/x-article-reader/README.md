# x-article-reader

Host-only HTTP service for `agent-reach` X Article integration.

This service exposes only:

- `GET /healthz`
- `POST /v1/article`

It accepts an Article ID, not a URL, and authenticates requests with `Authorization: Bearer $X_ARTICLE_READER_TOKEN`. Run it on the host (default `127.0.0.1:8788`) and expose it to sandboxed agents only through Credential Proxy.

```bash
X_ARTICLE_READER_TOKEN='long-random-token' pnpm --dir services/x-article-reader start
```

For local integration tests without X access, run deterministic mock mode:

```bash
X_ARTICLE_READER_TOKEN='long-random-token' pnpm --dir services/x-article-reader mock
```

The initial upstream adapter is intentionally not bundled here because it depends on a non-public X GraphQL flow / `twikit-mcp`-equivalent code. Without mock mode or a fixture, the service returns `UPSTREAM_CHANGED` rather than attempting scraping or exposing a generic fetcher.
