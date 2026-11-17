-- CreateEnum
CREATE TYPE "capture_method" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "payment_action_type" AS ENUM ('CAPTURE', 'VOID');

-- CreateEnum
CREATE TYPE "payment_action_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "payment_action_failure_code" AS ENUM ('DECLINED', 'PROVIDER_UNAVAILABLE');

-- AlterEnum
ALTER TYPE "outbox_job_type" ADD VALUE 'PROCESS_PAYMENT_ACTION';
ALTER TYPE "outbox_job_type" ADD VALUE 'RECONCILE_PAYMENT_ACTION';

-- AlterEnum
ALTER TYPE "payment_status" ADD VALUE 'AUTHORIZED';
ALTER TYPE "payment_status" ADD VALUE 'CANCELED';

-- DropIndex
DROP INDEX "outbox_jobs_attempt_id_type_key";

-- AlterTable
ALTER TABLE "outbox_jobs" ADD COLUMN     "payment_action_id" UUID;

-- AlterTable
ALTER TABLE "payment_events" ADD COLUMN     "payment_action_id" UUID;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "capture_method" "capture_method" NOT NULL DEFAULT 'AUTOMATIC';

-- CreateTable
CREATE TABLE "payment_actions" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "type" "payment_action_type" NOT NULL,
    "amount" BIGINT,
    "status" "payment_action_status" NOT NULL DEFAULT 'PENDING',
    "provider_reference" VARCHAR(100),
    "failure_code" "payment_action_failure_code",
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_actions_payment_id_idx" ON "payment_actions"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_actions_merchant_id_idempotency_key_key" ON "payment_actions"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_jobs_payment_action_id_idx" ON "outbox_jobs"("payment_action_id");

-- CreateIndex
CREATE INDEX "payment_events_payment_action_id_idx" ON "payment_events"("payment_action_id");

-- AddForeignKey
ALTER TABLE "payment_actions" ADD CONSTRAINT "payment_actions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_actions" ADD CONSTRAINT "payment_actions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_actions" ADD CONSTRAINT "payment_actions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_payment_action_id_fkey" FOREIGN KEY ("payment_action_id") REFERENCES "payment_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_action_id_fkey" FOREIGN KEY ("payment_action_id") REFERENCES "payment_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Attempt jobs stay unique per (attempt, type); capture and void jobs become unique per (action,
-- type), since one authorization can see a failed capture followed by another.
CREATE UNIQUE INDEX "outbox_jobs_attempt_id_type_key" ON "outbox_jobs"("attempt_id", "type")
    WHERE "webhook_event_id" IS NULL AND "refund_id" IS NULL AND "merchant_event_id" IS NULL
      AND "payment_action_id" IS NULL;
CREATE UNIQUE INDEX "outbox_jobs_payment_action_id_type_key" ON "outbox_jobs"("payment_action_id", "type")
    WHERE "payment_action_id" IS NOT NULL;

-- One capture or void in flight per payment, so they cannot race each other at the provider, and at
-- most one that succeeded: an authorization is captured or voided once.
CREATE UNIQUE INDEX "payment_actions_one_pending_per_payment" ON "payment_actions"("payment_id")
    WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "payment_actions_one_succeeded_per_payment" ON "payment_actions"("payment_id")
    WHERE "status" = 'SUCCEEDED';

-- Finding unresolved actions (operator tooling, stats, the stale sweep) without scanning history.
CREATE INDEX "payment_actions_pending_created_at" ON "payment_actions"("created_at") WHERE "status" = 'PENDING';

-- Invariants the Prisma schema cannot express. New enum values cannot be used as literals in the
-- transaction that adds them, hence the text comparison.
ALTER TABLE "outbox_jobs"
    ADD CONSTRAINT "outbox_jobs_payment_action_iff_action_job" CHECK (
        ("type"::text IN ('PROCESS_PAYMENT_ACTION', 'RECONCILE_PAYMENT_ACTION')) = ("payment_action_id" IS NOT NULL)
    );

ALTER TABLE "payment_actions"
    ADD CONSTRAINT "payment_actions_amount_iff_capture" CHECK (("type" = 'CAPTURE') = ("amount" IS NOT NULL)),
    ADD CONSTRAINT "payment_actions_amount_positive" CHECK ("amount" IS NULL OR "amount" > 0),
    ADD CONSTRAINT "payment_actions_idempotency_key_present" CHECK (length("idempotency_key") > 0),
    ADD CONSTRAINT "payment_actions_request_fingerprint_format" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "payment_actions_completed_iff_terminal" CHECK (("status" = 'PENDING') = ("completed_at" IS NULL)),
    ADD CONSTRAINT "payment_actions_failure_code_iff_failed" CHECK (("status" = 'FAILED') = ("failure_code" IS NOT NULL));

-- An action must act on a manual-capture payment that is authorized now, through its succeeded
-- attempt, for its own merchant, and a capture cannot exceed the authorized amount. Locking the
-- payment row serializes actions on one payment with each other and with its refunds.
CREATE FUNCTION "payment_actions_match_authorization"() RETURNS trigger AS $$
DECLARE
    payment RECORD;
BEGIN
    SELECT "amount", "merchant_id", "status", "capture_method" INTO payment
    FROM "payments" WHERE "id" = NEW."payment_id" FOR UPDATE;

    IF payment."status"::text <> 'AUTHORIZED'
        OR payment."capture_method" <> 'MANUAL'
        OR payment."merchant_id" <> NEW."merchant_id"
        OR (NEW."type" = 'CAPTURE' AND NEW."amount" > payment."amount")
        OR NOT EXISTS (
            SELECT 1 FROM "payment_attempts"
            WHERE "id" = NEW."attempt_id" AND "payment_id" = NEW."payment_id" AND "status" = 'SUCCEEDED'
        )
    THEN
        RAISE EXCEPTION 'payment action must match an authorized payment and its authorization'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_actions_match_authorization';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_actions_match_authorization"
    BEFORE INSERT ON "payment_actions"
    FOR EACH ROW EXECUTE FUNCTION "payment_actions_match_authorization"();

-- Refunds are now limited by what was captured: the payment amount for automatic capture, the
-- succeeded capture's amount for manual capture.
CREATE OR REPLACE FUNCTION "refunds_within_payment_amount"() RETURNS trigger AS $$
DECLARE
    payment RECORD;
    captured BIGINT;
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

    SELECT coalesce(
        (SELECT "amount" FROM "payment_actions"
         WHERE "payment_id" = NEW."payment_id" AND "type" = 'CAPTURE' AND "status" = 'SUCCEEDED'),
        payment."amount"
    ) INTO captured;
    SELECT coalesce(sum("amount"), 0) INTO committed
    FROM "refunds"
    WHERE "payment_id" = NEW."payment_id" AND "status" IN ('PENDING', 'SUCCEEDED');
    IF committed + NEW."amount" > captured THEN
        RAISE EXCEPTION 'refunds would exceed the payment amount'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_within_payment_amount';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Privileges, as documented in 20261026120000_runtime_and_operator_privileges.
GRANT SELECT, INSERT,
    UPDATE ("status", "provider_reference", "failure_code", "submitted_at", "completed_at", "updated_at")
    ON "payment_actions" TO payguard_runtime;
GRANT SELECT ON "payment_actions" TO payguard_operator;
