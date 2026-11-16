import { type Db } from "./db.js";

/**
 * Ordered schema migrations. Applied ones are recorded in `schema_migrations`; never
 * edit a shipped migration — add a new one.
 */
const migrations: { id: string; sql: string }[] = [
  {
    id: "001_init",
    sql: `
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- Opaque refresh tokens, stored hashed. Rotated on every use.
      CREATE TABLE refresh_tokens (
        token_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz
      );
      CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);

      CREATE TABLE generation_runs (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model text NOT NULL,
        status text NOT NULL CHECK (status IN ('succeeded', 'invalid', 'refused', 'failed')),
        error_code text,
        attempts int NOT NULL,
        latency_ms int NOT NULL,
        input_tokens int NOT NULL DEFAULT 0,
        output_tokens int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX generation_runs_user ON generation_runs(user_id, created_at DESC);

      CREATE TABLE widgets (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        current_version_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX widgets_user ON widgets(user_id, updated_at DESC);

      -- Immutable: an edit is a new row with the next version number.
      CREATE TABLE widget_versions (
        id uuid PRIMARY KEY,
        widget_id uuid NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
        version_number int NOT NULL,
        schema_version int NOT NULL,
        spec_json jsonb NOT NULL,
        source text NOT NULL CHECK (source IN ('generated', 'edited', 'manual')),
        generation_run_id uuid REFERENCES generation_runs(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (widget_id, version_number)
      );

      ALTER TABLE widgets
        ADD CONSTRAINT widgets_current_version_fk
        FOREIGN KEY (current_version_id) REFERENCES widget_versions(id) ON DELETE SET NULL;

      CREATE TABLE widget_instances (
        id uuid PRIMARY KEY,
        widget_id uuid NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id text NOT NULL,
        platform_widget_id int NOT NULL,
        renderer text NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, device_id, platform_widget_id)
      );
      CREATE INDEX widget_instances_widget ON widget_instances(widget_id);

      CREATE TABLE connectors (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider text NOT NULL CHECK (provider IN ('github')),
        provider_account_id text NOT NULL,
        provider_login text NOT NULL,
        scopes text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, provider)
      );

      -- Kept apart from connector metadata so ordinary reads never touch ciphertext.
      CREATE TABLE connector_credentials (
        connector_id uuid PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
        encrypted_credentials text NOT NULL,
        key_version int NOT NULL,
        expires_at timestamptz
      );

      -- One-time OAuth state values, stored hashed, valid for ten minutes.
      CREATE TABLE oauth_states (
        state_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider text NOT NULL,
        expires_at timestamptz NOT NULL
      );

      -- Last good data per widget. A failed refresh records the error and keeps the data.
      CREATE TABLE widget_snapshots (
        widget_id uuid PRIMARY KEY REFERENCES widgets(id) ON DELETE CASCADE,
        version_id uuid NOT NULL REFERENCES widget_versions(id) ON DELETE CASCADE,
        data_json jsonb,
        fetched_at timestamptz,
        last_attempt_at timestamptz NOT NULL,
        last_error text
      );
    `,
  },
  {
    // Connected accounts and their tokens moved to Composio.
    id: "002_composio_connectors",
    sql: `
      DROP TABLE oauth_states;
      DROP TABLE connector_credentials;
      DROP TABLE connectors;
    `,
  },
  {
    id: "003_widget_image_assets",
    sql: `
      CREATE TABLE widget_image_assets (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        media_type text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
        image_data bytea NOT NULL,
        expires_at timestamptz DEFAULT (now() + interval '1 day'),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX widget_image_assets_expiry ON widget_image_assets(expires_at);
    `,
  },
  {
    id: "004_generated_image_assets",
    sql: `
      ALTER TABLE widget_image_assets
        ADD COLUMN prompt text NOT NULL DEFAULT '',
        ADD COLUMN model text NOT NULL DEFAULT '',
        ADD COLUMN style text NOT NULL DEFAULT 'abstract',
        ADD COLUMN width int,
        ADD COLUMN height int;
    `,
  },
];

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = new Set((await db.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await tx.query(m.sql);
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}
