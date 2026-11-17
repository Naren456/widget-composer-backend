-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "generation_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "attempts" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widgets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "current_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_versions" (
    "id" UUID NOT NULL,
    "widget_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "spec_json" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "generation_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_instances" (
    "id" UUID NOT NULL,
    "widget_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "platform_widget_id" INTEGER NOT NULL,
    "renderer" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_snapshots" (
    "widget_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "data_json" JSONB,
    "fetched_at" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "last_error" TEXT,

    CONSTRAINT "widget_snapshots_pkey" PRIMARY KEY ("widget_id")
);

-- CreateTable
CREATE TABLE "widget_image_assets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "media_type" TEXT NOT NULL,
    "image_data" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) DEFAULT (now() + interval '1 day'),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prompt" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "style" TEXT NOT NULL DEFAULT 'abstract',
    "width" INTEGER,
    "height" INTEGER,

    CONSTRAINT "widget_image_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refresh_tokens_user" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "generation_runs_user" ON "generation_runs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "widgets_user" ON "widgets"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "widget_versions_widget_id_version_number_key" ON "widget_versions"("widget_id", "version_number");

-- CreateIndex
CREATE INDEX "widget_instances_widget" ON "widget_instances"("widget_id");

-- CreateIndex
CREATE UNIQUE INDEX "widget_instances_user_id_device_id_platform_widget_id_key" ON "widget_instances"("user_id", "device_id", "platform_widget_id");

-- CreateIndex
CREATE INDEX "widget_image_assets_expiry" ON "widget_image_assets"("expires_at");

-- Retain validations enforced by the pre-Prisma schema migrations.
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_status_check"
    CHECK ("status" IN ('succeeded', 'invalid', 'refused', 'failed'));

ALTER TABLE "widgets" ADD CONSTRAINT "widgets_status_check"
    CHECK ("status" IN ('draft', 'published', 'archived'));

ALTER TABLE "widget_versions" ADD CONSTRAINT "widget_versions_source_check"
    CHECK ("source" IN ('generated', 'edited', 'manual'));

ALTER TABLE "widget_instances" ADD CONSTRAINT "widget_instances_status_check"
    CHECK ("status" IN ('active', 'removed'));

ALTER TABLE "widget_image_assets" ADD CONSTRAINT "widget_image_assets_media_type_check"
    CHECK ("media_type" IN ('image/jpeg', 'image/png', 'image/webp'));

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "widget_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_versions" ADD CONSTRAINT "widget_versions_widget_id_fkey" FOREIGN KEY ("widget_id") REFERENCES "widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_versions" ADD CONSTRAINT "widget_versions_generation_run_id_fkey" FOREIGN KEY ("generation_run_id") REFERENCES "generation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_instances" ADD CONSTRAINT "widget_instances_widget_id_fkey" FOREIGN KEY ("widget_id") REFERENCES "widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_instances" ADD CONSTRAINT "widget_instances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_snapshots" ADD CONSTRAINT "widget_snapshots_widget_id_fkey" FOREIGN KEY ("widget_id") REFERENCES "widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_snapshots" ADD CONSTRAINT "widget_snapshots_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "widget_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_image_assets" ADD CONSTRAINT "widget_image_assets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
