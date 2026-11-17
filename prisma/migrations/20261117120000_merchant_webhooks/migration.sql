-- CreateEnum
CREATE TYPE "merchant_event_delivery_status" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "merchant_webhook_delivery_error" AS ENUM ('TIMEOUT', 'CONNECTION_FAILED', 'HTTP_STATUS', 'TARGET_BLOCKED', 'ENDPOINT_DISABLED');

-- AlterEnum
ALTER TYPE "outbox_error_category" ADD VALUE 'DELIVERY_FAILED';

-- AlterEnum
ALTER TYPE "outbox_job_type" ADD VALUE 'DELIVER_MERCHANT_EVENT';

-- DropIndex
DROP INDEX "outbox_jobs_attempt_id_type_key";

-- AlterTable
ALTER TABLE "outbox_jobs" ADD COLUMN     "merchant_event_id" UUID;

-- CreateTable
CREATE TABLE "merchant_webhook_endpoints" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "secret_ciphertext" BYTEA NOT NULL,
    "previous_secret_ciphertext" BYTEA,
    "previous_secret_expires_at" TIMESTAMPTZ(3),
    "secret_rotated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_events" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "payment_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "refund_id" UUID,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivery_status" "merchant_event_delivery_status",
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_response_status" INTEGER,
    "last_error" "merchant_webhook_delivery_error",
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "merchant_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_webhook_endpoints_merchant_id_key" ON "merchant_webhook_endpoints"("merchant_id");

-- CreateIndex
CREATE INDEX "merchant_events_merchant_id_created_at_idx" ON "merchant_events"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "merchant_events_payment_id_idx" ON "merchant_events"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_jobs_merchant_event_id_key" ON "outbox_jobs"("merchant_event_id");

-- AddForeignKey
ALTER TABLE "merchant_webhook_endpoints" ADD CONSTRAINT "merchant_webhook_endpoints_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_merchant_event_id_fkey" FOREIGN KEY ("merchant_event_id") REFERENCES "merchant_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Attempt jobs stay unique per (attempt, type). Delivery jobs are excluded because one attempt can
-- produce several events (a payment outcome, then refunds of it); they are unique per event.
CREATE UNIQUE INDEX "outbox_jobs_attempt_id_type_key" ON "outbox_jobs"("attempt_id", "type")
    WHERE "webhook_event_id" IS NULL AND "refund_id" IS NULL AND "merchant_event_id" IS NULL;

-- Invariants the Prisma schema cannot express. The new enum value cannot be used as a literal in
-- the transaction that adds it, hence the text comparison.
ALTER TABLE "outbox_jobs"
    ADD CONSTRAINT "outbox_jobs_merchant_event_iff_delivery_job" CHECK (
        ("type"::text = 'DELIVER_MERCHANT_EVENT') = ("merchant_event_id" IS NOT NULL)
    );

ALTER TABLE "merchant_webhook_endpoints"
    ADD CONSTRAINT "merchant_webhook_endpoints_url_format" CHECK ("url" ~ '^https?://'),
    ADD CONSTRAINT "merchant_webhook_endpoints_previous_secret_expiry" CHECK (
        ("previous_secret_ciphertext" IS NULL) = ("previous_secret_expires_at" IS NULL)
    );

ALTER TABLE "merchant_events"
    ADD CONSTRAINT "merchant_events_type_format" CHECK ("type" ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
    ADD CONSTRAINT "merchant_events_data_object" CHECK (jsonb_typeof("data") = 'object'),
    ADD CONSTRAINT "merchant_events_delivery_attempts_non_negative" CHECK ("delivery_attempts" >= 0),
    ADD CONSTRAINT "merchant_events_delivered_at_iff_delivered" CHECK (
        ("delivery_status" IS NOT DISTINCT FROM 'DELIVERED') = ("delivered_at" IS NOT NULL)
    ),
    ADD CONSTRAINT "merchant_events_response_status_range" CHECK (
        "last_response_status" IS NULL OR "last_response_status" BETWEEN 100 AND 599
    );

-- Privileges, as documented in 20261026120000_runtime_and_operator_privileges. The operator role
-- can see where and how events are delivered, but not the endpoint's (encrypted) secrets.
GRANT SELECT, INSERT,
    UPDATE ("url", "enabled", "secret_ciphertext", "previous_secret_ciphertext",
            "previous_secret_expires_at", "secret_rotated_at", "updated_at")
    ON "merchant_webhook_endpoints" TO payguard_runtime;
GRANT SELECT, INSERT,
    UPDATE ("delivery_status", "delivery_attempts", "last_attempt_at", "last_response_status",
            "last_error", "delivered_at")
    ON "merchant_events" TO payguard_runtime;
GRANT SELECT ("id", "merchant_id", "url", "enabled", "previous_secret_expires_at",
              "secret_rotated_at", "created_at", "updated_at")
    ON "merchant_webhook_endpoints" TO payguard_operator;
GRANT SELECT ON "merchant_events" TO payguard_operator;
