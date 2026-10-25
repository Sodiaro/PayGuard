-- CreateEnum
CREATE TYPE "provider_webhook_event_status" AS ENUM ('RECEIVED', 'PROCESSED');

-- CreateEnum
CREATE TYPE "provider_webhook_event_result" AS ENUM ('APPLIED', 'ALREADY_APPLIED', 'NO_ACTION', 'UNKNOWN_ATTEMPT', 'OUTCOME_CONFLICT', 'DATA_MISMATCH', 'PAYLOAD_CONFLICT');

-- AlterEnum
ALTER TYPE "outbox_job_type" ADD VALUE 'APPLY_WEBHOOK_EVENT';

-- DropIndex
DROP INDEX "outbox_jobs_attempt_id_type_key";

-- AlterTable
ALTER TABLE "outbox_jobs" ADD COLUMN     "webhook_event_id" UUID;

-- CreateTable
CREATE TABLE "provider_webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "event_id" VARCHAR(100) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "attempt_id" UUID NOT NULL,
    "provider_reference" VARCHAR(100) NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "event_created_at" TIMESTAMPTZ(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "status" "provider_webhook_event_status" NOT NULL DEFAULT 'RECEIVED',
    "result" "provider_webhook_event_result",
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "duplicate_deliveries" INTEGER NOT NULL DEFAULT 0,
    "conflicting_deliveries" INTEGER NOT NULL DEFAULT 0,
    "last_conflict_at" TIMESTAMPTZ(3),

    CONSTRAINT "provider_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_webhook_events_attempt_id_idx" ON "provider_webhook_events"("attempt_id");

-- CreateIndex
CREATE INDEX "provider_webhook_events_received_at_idx" ON "provider_webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_webhook_events_provider_event_id_key" ON "provider_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_jobs_webhook_event_id_key" ON "outbox_jobs"("webhook_event_id");

-- CreateIndex
CREATE INDEX "outbox_jobs_attempt_id_idx" ON "outbox_jobs"("attempt_id");

-- AddForeignKey
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "provider_webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Attempt jobs stay unique per (attempt, type), so re-enqueueing them is still a no-op. Webhook jobs
-- are excluded because one attempt can receive several events; they are unique per event instead.
CREATE UNIQUE INDEX "outbox_jobs_attempt_id_type_key" ON "outbox_jobs"("attempt_id", "type") WHERE "webhook_event_id" IS NULL;

-- Invariants the Prisma schema cannot express. The new enum value cannot be used as a literal in the
-- transaction that adds it, hence the text comparison.
ALTER TABLE "outbox_jobs"
    ADD CONSTRAINT "outbox_jobs_webhook_event_iff_webhook_job" CHECK (
        ("type"::text = 'APPLY_WEBHOOK_EVENT') = ("webhook_event_id" IS NOT NULL)
    );

ALTER TABLE "provider_webhook_events"
    ADD CONSTRAINT "provider_webhook_events_event_id_format" CHECK ("event_id" ~ '^[A-Za-z0-9_-]+$'),
    ADD CONSTRAINT "provider_webhook_events_payload_hash_format" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "provider_webhook_events_amount_positive" CHECK ("amount" > 0),
    ADD CONSTRAINT "provider_webhook_events_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "provider_webhook_events_deliveries_non_negative" CHECK (
        "duplicate_deliveries" >= 0 AND "conflicting_deliveries" >= 0
    ),
    ADD CONSTRAINT "provider_webhook_events_processed_iff_result" CHECK (
        ("status" = 'PROCESSED') = ("result" IS NOT NULL AND "processed_at" IS NOT NULL)
    );
