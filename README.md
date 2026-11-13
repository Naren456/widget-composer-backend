# WidgetComposer API

Backend for the WidgetComposer app: turns a prompt into a validated widget spec,
stores widgets with immutable versions, connects GitHub through Composio, and serves
cached widget data. All Composio code and keys live here; the app only calls this API.

Express 5 · TypeScript · Zod · PostgreSQL · Claude (structured outputs) · Composio.

## Run locally

```bash
docker compose up -d db          # Postgres on 127.0.0.1:5433
cd apps/api
cp .env.example .env             # fill SESSION_SECRET (32 random bytes)
npm install
npm run dev                      # migrates, then serves on :3000
npm test                         # 24 tests on PGlite (in-process Postgres), no server needed
```

`ANTHROPIC_API_KEY` and `COMPOSIO_API_KEY` are optional: without them, generation and
GitHub connect answer 503 with a clear message, and previews use sample data. Set
Web research uses the local SearXNG service; no paid search API key is needed. Start it
with `docker compose up -d searxng` and set `SEARXNG_URL=http://127.0.0.1:8080` in the
API environment (the default). If the API runs inside Docker Compose, use
`SEARXNG_URL=http://searxng:8080`. Search results and up to three public pages are sent
to generation as untrusted references. Very large HTML pages are read up to an 8 MB
limit, then their extracted text is ranked in chunks for the prompt.

Every request is logged to the console (method, path, status, time, error code), plus one
line per generation run and any Composio failure.

## API

All `/v1` routes except auth and the OAuth callback need `Authorization: Bearer <accessToken>`.
Errors are always `{ "error": { "code", "message", "details"? } }`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/auth/device` | Create an anonymous account → access + refresh token |
| POST | `/v1/auth/refresh` | Rotate the refresh token, get a new access token |
| POST | `/v1/widgets/generate` | `{ prompt, widgetId? }` → `{ spec, generationRunId }` (edit when `widgetId`) |
| POST | `/v1/widgets/validate` | `{ spec, renderer? }` → `{ valid, issues }` |
| POST | `/v1/widgets/preview-data` | `{ spec }` → live data, or sample data flagged `sample: true` |
| GET/POST | `/v1/widgets` | List / create (version 1) |
| GET/PATCH/DELETE | `/v1/widgets/:id` | Read / rename or archive / delete |
| GET/POST | `/v1/widgets/:id/versions` | List / save a new immutable version |
| POST | `/v1/widgets/:id/publish` | `{ versionId }` — publish, or roll back to an older version |
| GET | `/v1/widgets/:id/data` | Cached normalized data; `?refresh=true` forces a fetch |
| POST/DELETE | `/v1/widgets/:id/instances[/:instanceId]` | Register / remove a home-screen placement |
| GET | `/v1/connectors` | Connected Composio accounts (never tokens) |
| POST | `/v1/connectors/github/connect` | → `{ authorizeUrl }`: a Composio link to open in a browser |
| GET | `/v1/connectors/github/callback` | Composio returns here; forwards the outcome to `APP_REDIRECT_URL` |
| DELETE | `/v1/connectors/:id` | Delete the Composio connected account |

## Design notes

- **WidgetSpec** (`src/spec/widget-spec.ts`) is the contract: a fixed component vocabulary
  (column, row, text, image, link, clock, metric, list, streak chart, divider, spacer, button), data sources limited to known
  GitHub queries, and bindings like `prs.count` / `prs.items[0].url`. Specs never contain code,
  arbitrary URLs or credentials; `open_url` can only open a URL that came from connector data.
- **Generation** (`src/modules/generation`) uses structured outputs. Structured outputs can't
  express recursive schemas, so the model returns a flat node list (`src/spec/flat.ts`) that is
  rebuilt into a tree and validated; invalid output goes back with the exact issues, up to 3
  attempts. Every run is recorded in `generation_runs` (model, latency, tokens, outcome).
- **Web research** (`src/modules/research/agent.ts`) uses the private SearXNG service only
  when a prompt signals a need for outside/current information, then reads at most three
  public result pages. Search runs without a vendor API key.
- **Connected accounts** live in Composio (`src/modules/connectors/composio.ts`), keyed by our
  user id. Composio runs the GitHub OAuth flow and holds the tokens; this API stores none and
  runs the read-only `GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS` tool with `@me` queries. GitHub
  contribution charts use the authenticated GraphQL proxy and require `proxy_execute` on the
  Composio project key plus `read:user` on its GitHub OAuth config.
- **Widget data** is cache-first: the last good snapshot is kept, and a failed refresh records
  `lastError` instead of replacing good data.
- **Auth** is anonymous per device for now; a sign-in provider can attach to the same user rows.

## Not built yet

Background refresh jobs (the Android runtime refreshes best-effort), telemetry export, more
connectors, and shared rate limits for multiple replicas (counters are in memory).
# widget-composer-backend
