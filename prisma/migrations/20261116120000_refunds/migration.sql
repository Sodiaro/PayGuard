-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "refund_failure_code" AS ENUM ('DECLINED', 'PROVIDER_UNAVAILABLE');

-- AlterEnum
ALTER TYPE "outbox_job_type" ADD VALUE 'PROCESS_REFUND';
ALTER TYPE "outbox_job_type" ADD VALUE 'RECONCILE_REFUND';

-- DropIndex
DROP INDEX "outbox_jobs_attempt_id_type_key";

-- AlterTable
ALTER TABLE "outbox_jobs" ADD COLUMN     "refund_id" UUID;

-- AlterTable
ALTER TABLE "payment_events" ADD COLUMN     "refund_id" UUID;

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "refund_status" NOT NULL DEFAULT 'PENDING',
    "reference" VARCHAR(64),
    "provider_reference" VARCHAR(100),
    "failure_code" "refund_failure_code",
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_merchant_id_idempotency_key_key" ON "refunds"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_jobs_refund_id_idx" ON "outbox_jobs"("refund_id");

-- CreateIndex
CREATE INDEX "payment_events_refund_id_idx" ON "payment_events"("refund_id");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Attempt jobs stay unique per (attempt, type) and refund jobs become unique per (refund, type), so
-- re-enqueueing either is a no-op while one charge can carry several refunds.
CREATE UNIQUE INDEX "outbox_jobs_attempt_id_type_key" ON "outbox_jobs"("attempt_id", "type")
    WHERE "webhook_event_id" IS NULL AND "refund_id" IS NULL;
CREATE UNIQUE INDEX "outbox_jobs_refund_id_type_key" ON "outbox_jobs"("refund_id", "type")
    WHERE "refund_id" IS NOT NULL;

-- Invariants the Prisma schema cannot express. The new enum values cannot be used as literals in
-- the transaction that adds them, hence the text comparison.
ALTER TABLE "outbox_jobs"
    ADD CONSTRAINT "outbox_jobs_refund_iff_refund_job" CHECK (
        ("type"::text IN ('PROCESS_REFUND', 'RECONCILE_REFUND')) = ("refund_id" IS NOT NULL)
    );

ALTER TABLE "refunds"
    ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0),
    ADD CONSTRAINT "refunds_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "refunds_idempotency_key_present" CHECK (length("idempotency_key") > 0),
    ADD CONSTRAINT "refunds_request_fingerprint_format" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "refunds_completed_iff_terminal" CHECK (("status" = 'PENDING') = ("completed_at" IS NULL)),
    ADD CONSTRAINT "refunds_failure_code_iff_failed" CHECK (("status" = 'FAILED') = ("failure_code" IS NOT NULL));

-- A refund must return part of a succeeded charge of its own payment, in that payment's currency,
-- and the payment's pending and succeeded refunds together must not exceed its amount. Locking the
-- payment row serializes concurrent refunds, so two cannot each see room for themselves. Status
-- changes are guarded by the application's transitions, which never reopen a failed refund.
CREATE FUNCTION "refunds_within_payment_amount"() RETURNS trigger AS $$
DECLARE
    payment RECORD;
    committed BIGINT;
BEGIN
    SELECT "amount", "currency", "merchant_id", "status" INTO payment
    FROM "payments" WHERE "id" = NEW."payment_id" FOR UPDATE;

    IF payment."status" <> 'SUCCEEDED'
        OR payment."merchant_id" <> NEW."merchant_id"
        OR payment."currency" <> NEW."currency"
        OR NOT EXISTS (
            SELECT 1 FROM "payment_attempts"
            WHERE "id" = NEW."attempt_id" AND "payment_id" = NEW."payment_id" AND "status" = 'SUCCEEDED'
        )
    THEN
        RAISE EXCEPTION 'refund must match a succeeded charge of its payment'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_match_succeeded_charge';
    END IF;

    SELECT coalesce(sum("amount"), 0) INTO committed
    FROM "refunds"
    WHERE "payment_id" = NEW."payment_id" AND "status" IN ('PENDING', 'SUCCEEDED');
    IF committed + NEW."amount" > payment."amount" THEN
        RAISE EXCEPTION 'refunds would exceed the payment amount'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_within_payment_amount';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refunds_within_payment_amount"
    BEFORE INSERT ON "refunds"
    FOR EACH ROW EXECUTE FUNCTION "refunds_within_payment_amount"();

-- Finding unresolved refunds (operator tooling, stats, the stale sweep) without scanning history.
CREATE INDEX "refunds_pending_created_at" ON "refunds"("created_at") WHERE "status" = 'PENDING';

-- Privileges, as documented in 20261026120000_runtime_and_operator_privileges.
GRANT SELECT, INSERT,
    UPDATE ("status", "provider_reference", "failure_code", "submitted_at", "completed_at", "updated_at")
    ON "refunds" TO payguard_runtime;
GRANT SELECT ON "refunds" TO payguard_operator;
