-- CreateEnum
CREATE TYPE "outbox_job_type" AS ENUM ('PROCESS_ATTEMPT', 'RECONCILE_ATTEMPT');

-- CreateEnum
CREATE TYPE "outbox_job_status" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'DEAD');

-- CreateEnum
CREATE TYPE "outbox_error_category" AS ENUM ('PROVIDER_TIMEOUT', 'PROVIDER_ERROR', 'PROVIDER_UNAVAILABLE', 'OUTCOME_PROCESSING', 'LEASE_EXPIRED', 'INTERNAL_ERROR');

-- AlterTable
ALTER TABLE "payment_attempts" ADD COLUMN     "submitted_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "payment_retry_requests" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "payment_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_retry_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_jobs" (
    "id" UUID NOT NULL,
    "type" "outbox_job_type" NOT NULL,
    "payment_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "status" "outbox_job_status" NOT NULL DEFAULT 'QUEUED',
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" VARCHAR(128),
    "lease_token" UUID,
    "locked_until" TIMESTAMPTZ(3),
    "last_error" "outbox_error_category",
    "request_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_retry_requests_attempt_id_key" ON "payment_retry_requests"("attempt_id");

-- CreateIndex
CREATE INDEX "payment_retry_requests_payment_id_idx" ON "payment_retry_requests"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_retry_requests_merchant_id_idempotency_key_key" ON "payment_retry_requests"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_jobs_payment_id_idx" ON "outbox_jobs"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_jobs_attempt_id_type_key" ON "outbox_jobs"("attempt_id", "type");

-- AddForeignKey
ALTER TABLE "payment_retry_requests" ADD CONSTRAINT "payment_retry_requests_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_retry_requests" ADD CONSTRAINT "payment_retry_requests_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants the Prisma schema cannot express.
ALTER TABLE "payment_retry_requests"
    ADD CONSTRAINT "payment_retry_requests_idempotency_key_present" CHECK (length("idempotency_key") > 0),
    ADD CONSTRAINT "payment_retry_requests_request_fingerprint_format" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE "outbox_jobs"
    ADD CONSTRAINT "outbox_jobs_run_count_non_negative" CHECK ("run_count" >= 0),
    ADD CONSTRAINT "outbox_jobs_lease_iff_processing" CHECK (
        ("status" = 'PROCESSING') = ("locked_by" IS NOT NULL AND "lease_token" IS NOT NULL AND "locked_until" IS NOT NULL)
    ),
    ADD CONSTRAINT "outbox_jobs_completed_at_iff_completed" CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL));

-- The two claim paths: queued work that is due, and processing work whose lease has expired.
CREATE INDEX "outbox_jobs_due" ON "outbox_jobs"("available_at") WHERE "status" = 'QUEUED';
CREATE INDEX "outbox_jobs_leased" ON "outbox_jobs"("locked_until") WHERE "status" = 'PROCESSING';
