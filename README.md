# WidgetComposer API

Backend for the WidgetComposer app: turns a prompt into a validated widget spec,
stores widgets with immutable versions, connects GitHub through Composio, and serves
cached widget data. All Composio code and keys live here; the app only calls this API.

Express 5 · TypeScript · Prisma ORM · PostgreSQL · Zod · Claude (structured outputs) · Composio.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current implementation, planned gaps,
and scale-up decisions. The pasted reference architecture is treated as a target, not
as a claim that every listed service is already installed.
See [ARCHITECTURE-TARGET.md](ARCHITECTURE-TARGET.md) for the proposed end-state and
implementation gates; it is a review document, not approval to begin those changes.

## Widget contract artifacts

The backend's strict Zod schema in `apps/api/src/spec/widget-spec.ts` is the canonical
contract. It generates the JSON Schema checked in beside it and the app TypeScript /
Android Kotlin compatibility artifacts. When both repositories are checked out as
sibling folders under `Documents`, run:

```bash
cd apps/api
npm run contract:generate
npm run contract:check
```

For another app checkout location, pass `--app-root=/absolute/path/to/web2widgets`
after the command. Backend tests run the artifact check; if the app checkout is
available, this also verifies the checked-in TypeScript and Kotlin outputs. Never edit
generated app artifacts by hand; change the backend schema/registries and regenerate.

## Run locally

```bash
docker compose up -d db          # Postgres on 127.0.0.1:5433
cd apps/api
cp .env.example .env             # fill SESSION_SECRET (32 random bytes)
npm install
npm run db:generate
npm run db:migrate:deploy        # applies checked-in Prisma migrations
npm run dev                      # serves on :3000
npm test                         # tests run Prisma against PGlite (in-process Postgres), no server needed
```

The Prisma schema is in `apps/api/prisma/schema.prisma`. The checked-in migration
history is managed with Prisma Migrate; runtime reads and writes use Prisma Client
model operations. For schema changes, update the schema and run
`npm run db:migrate:dev -- --name describe_change`. Deployments should run
`npm run db:migrate:deploy` before starting the API.

The API source is organized by responsibility: `src/routes/` defines HTTP endpoints,
`src/modules/` contains feature services and integrations, and `src/repositories/`
contains persistence operations. `src/app.ts` and `src/server.ts` compose and start
the application.

Server-side data connectors share the typed adapter contract in
`apps/api/src/modules/connectors/data-connector.ts`; adapters are registered in
`data-connectors.ts`. Each adapter fetches the validated source into the shared
`SourceData` response shape and can optionally provide connection-status checks and
sample preview data. When adding a provider, implement this contract, register its
adapter, and add its source/query to `src/spec/provider-catalog.ts`,
`src/spec/widget-spec.ts`, and `src/spec/flat.ts`. Keep provider credentials and
fetching in the backend; the mobile contract consumes normalized data only.

If upgrading a database created by the previous API migration runner, first back it
up and confirm its `schema_migrations` table contains `001_init` through
`004_generated_image_assets`. Then, from `apps/api`, baseline the already-current
schema once with `npx prisma migrate resolve --applied 0001_initial`, and run
`npm run db:migrate:deploy`. This records the existing schema as the initial Prisma
migration without recreating tables or changing data.

`ANTHROPIC_API_KEY` and `COMPOSIO_API_KEY` are optional: without them, generation and
GitHub connect answer 503 with a clear message, and previews use sample data.
Website thumbnails and user-uploaded images do not require any extra provider.
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
| GET | `/v1/image-assets` | List the signed-in user's saved image assets |
| GET/DELETE | `/v1/image-assets/:id` | Retrieve or delete an unused owned image asset |
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
  (column, row, text, image, link, clock, metric, list, streak chart, divider, spacer, button), data sources for known
  GitHub queries, public websites, and RSS/Atom news feeds, and bindings like `prs.count` / `prs.items[0].url`. Specs never contain code,
  arbitrary URLs or credentials; `open_url` can only open a URL that came from connector data. A `lock_screen` button action is available
  only when explicitly requested and requires the user to approve Android device-admin access before the app can lock the screen.
- **Generation** (`src/modules/generation`) uses structured outputs. Follow-up edits give the
  prompt fixer a compact summary of the current widget, so short edit requests can rely on its
  existing source and displayed fields. Structured outputs can't
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
- **Attached images** are compressed and bounded for Android widget transport; saved asset IDs can be rendered
  as image nodes or as a WidgetSpec v9 background while clocks, labels, and data remain native.
- **News feeds** (`src/modules/widget-data/news.ts`) discover a linked RSS/Atom feed from a publisher URL, normalize story fields and thumbnails, and fall back to linked page headlines. News/headline generation uses this live-story provider when the model otherwise selects a generic website snapshot.
- **Auth** is anonymous per device for now; a sign-in provider can attach to the same user rows.

## Not built yet

Scheduled background refresh jobs, refresh-history records, telemetry export, more
connectors, and shared rate limits for multiple replicas (counters are in memory). See
[ARCHITECTURE.md](ARCHITECTURE.md) for priorities and the current storage/auth boundaries.
# widget-composer-backend
