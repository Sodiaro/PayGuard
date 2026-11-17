-- CreateEnum
CREATE TYPE "payout_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "payout_failure_code" AS ENUM ('DECLINED', 'PROVIDER_UNAVAILABLE');

-- AlterEnum
ALTER TYPE "outbox_job_type" ADD VALUE 'PROCESS_PAYOUT';
ALTER TYPE "outbox_job_type" ADD VALUE 'RECONCILE_PAYOUT';

-- AlterTable
ALTER TABLE "merchant_events" ADD COLUMN     "payout_id" UUID,
ALTER COLUMN "payment_id" DROP NOT NULL,
ALTER COLUMN "attempt_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "outbox_jobs" ADD COLUMN     "payout_id" UUID,
ALTER COLUMN "payment_id" DROP NOT NULL,
ALTER COLUMN "attempt_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "payout_status" NOT NULL DEFAULT 'PENDING',
    "bank_code" VARCHAR(11) NOT NULL,
    "account_number" VARCHAR(34) NOT NULL,
    "account_name" VARCHAR(100) NOT NULL,
    "reference" VARCHAR(64),
    "provider_reference" VARCHAR(100),
    "failure_code" "payout_failure_code",
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_events" (
    "id" UUID NOT NULL,
    "payout_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "source" "payment_event_source" NOT NULL,
    "status_before" "payout_status",
    "status_after" "payout_status",
    "actor" VARCHAR(200),
    "request_id" VARCHAR(128),
    "outbox_job_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "payout_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payouts_merchant_id_created_at_idx" ON "payouts"("merchant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_merchant_id_idempotency_key_key" ON "payouts"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payout_events_payout_id_created_at_idx" ON "payout_events"("payout_id", "created_at");

-- CreateIndex
CREATE INDEX "payout_events_type_created_at_idx" ON "payout_events"("type", "created_at");

-- CreateIndex
CREATE INDEX "merchant_events_payout_id_idx" ON "merchant_events"("payout_id");

-- CreateIndex
CREATE INDEX "outbox_jobs_payout_id_idx" ON "outbox_jobs"("payout_id");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_events" ADD CONSTRAINT "payout_events_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Payout jobs are unique per (payout, type), so re-enqueueing one is a no-op. Deliveries of payout
-- events are unique per event instead, like every delivery job.
CREATE UNIQUE INDEX "outbox_jobs_payout_id_type_key" ON "outbox_jobs"("payout_id", "type")
    WHERE "payout_id" IS NOT NULL AND "merchant_event_id" IS NULL;

-- Finding unresolved payouts (operator tooling, stats, the stale sweep) without scanning history.
CREATE INDEX "payouts_pending_created_at" ON "payouts"("created_at") WHERE "status" = 'PENDING';

-- Invariants the Prisma schema cannot express. The new enum values cannot be used as literals in
-- the transaction that adds them, hence the text comparisons.
-- A job or merchant event is about a payment (with an attempt) or about a payout, never both.
ALTER TABLE "outbox_jobs"
    ADD CONSTRAINT "outbox_jobs_one_subject" CHECK (
        ("payment_id" IS NULL) = ("attempt_id" IS NULL)
        AND ("payment_id" IS NULL) = ("payout_id" IS NOT NULL)
    ),
    ADD CONSTRAINT "outbox_jobs_payout_job_has_payout" CHECK (
        "type"::text NOT IN ('PROCESS_PAYOUT', 'RECONCILE_PAYOUT') OR "payout_id" IS NOT NULL
    ),
    ADD CONSTRAINT "outbox_jobs_payout_only_on_payout_work" CHECK (
        "payout_id" IS NULL
        OR "type"::text IN ('PROCESS_PAYOUT', 'RECONCILE_PAYOUT', 'DELIVER_MERCHANT_EVENT')
    );

ALTER TABLE "merchant_events"
    ADD CONSTRAINT "merchant_events_one_subject" CHECK (
        ("payment_id" IS NULL) = ("attempt_id" IS NULL)
        AND ("payment_id" IS NULL) = ("payout_id" IS NOT NULL)
    );

ALTER TABLE "payouts"
    ADD CONSTRAINT "payouts_amount_positive" CHECK ("amount" > 0),
    ADD CONSTRAINT "payouts_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "payouts_bank_code_format" CHECK ("bank_code" ~ '^[0-9A-Z]{2,11}$'),
    ADD CONSTRAINT "payouts_account_number_format" CHECK ("account_number" ~ '^[0-9A-Z]{6,34}$'),
    ADD CONSTRAINT "payouts_account_name_present" CHECK (length(btrim("account_name")) > 0),
    ADD CONSTRAINT "payouts_idempotency_key_present" CHECK (length("idempotency_key") > 0),
    ADD CONSTRAINT "payouts_request_fingerprint_format" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "payouts_completed_iff_terminal" CHECK (("status" = 'PENDING') = ("completed_at" IS NULL)),
    ADD CONSTRAINT "payouts_failure_code_iff_failed" CHECK (("status" = 'FAILED') = ("failure_code" IS NOT NULL));

ALTER TABLE "payout_events"
    ADD CONSTRAINT "payout_events_type_format" CHECK ("type" ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
    ADD CONSTRAINT "payout_events_actor_iff_operator" CHECK (("source" = 'OPERATOR') = ("actor" IS NOT NULL)),
    ADD CONSTRAINT "payout_events_details_object" CHECK (jsonb_typeof("details") = 'object');

-- History rows are append-only for the application, like payment_events.
CREATE FUNCTION "payout_events_reject_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'payout_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payout_events_append_only"
    BEFORE UPDATE OR DELETE ON "payout_events"
    FOR EACH ROW EXECUTE FUNCTION "payout_events_reject_change"();

-- A merchant's balance per currency, derived from the records themselves so it cannot drift from
-- them: what succeeded payments captured, less pending and succeeded refunds, less payouts paid
-- out or in transit. Failed refunds and payouts release what they held.
CREATE FUNCTION "merchant_balances"(merchant UUID) RETURNS TABLE (
    "currency" CHAR(3),
    "captured" BIGINT,
    "refunded" BIGINT,
    "paid_out" BIGINT,
    "in_transit" BIGINT
) AS $$
    WITH captured AS (
        SELECT payment."currency", sum(coalesce(capture."amount", payment."amount")) AS amount
        FROM "payments" AS payment
        LEFT JOIN "payment_actions" AS capture
            ON capture."payment_id" = payment."id"
            AND capture."type" = 'CAPTURE' AND capture."status" = 'SUCCEEDED'
        WHERE payment."merchant_id" = merchant AND payment."status" = 'SUCCEEDED'
        GROUP BY payment."currency"
    ), refunded AS (
        SELECT "currency", sum("amount") AS amount
        FROM "refunds"
        WHERE "merchant_id" = merchant AND "status" IN ('PENDING', 'SUCCEEDED')
        GROUP BY "currency"
    ), payouts AS (
        SELECT "currency",
               sum("amount") FILTER (WHERE "status" = 'SUCCEEDED') AS paid_out,
               sum("amount") FILTER (WHERE "status" = 'PENDING') AS in_transit
        FROM "payouts"
        WHERE "merchant_id" = merchant AND "status" IN ('PENDING', 'SUCCEEDED')
        GROUP BY "currency"
    ), currencies AS (
        SELECT "currency" FROM captured
        UNION SELECT "currency" FROM refunded
        UNION SELECT "currency" FROM payouts
    )
    SELECT currencies."currency",
           coalesce(captured.amount, 0)::bigint,
           coalesce(refunded.amount, 0)::bigint,
           coalesce(payouts.paid_out, 0)::bigint,
           coalesce(payouts.in_transit, 0)::bigint
    FROM currencies
    LEFT JOIN captured ON captured."currency" = currencies."currency"
    LEFT JOIN refunded ON refunded."currency" = currencies."currency"
    LEFT JOIN payouts ON payouts."currency" = currencies."currency"
    ORDER BY currencies."currency";
$$ LANGUAGE sql STABLE;

-- Serializes payouts of one merchant and currency: the lock is taken first, so the balance read
-- after it includes every payout committed before. The API takes the same lock to refuse cleanly.
-- Refunds are not limited by the balance and may take it below zero.
CREATE FUNCTION "payouts_within_available_balance"() RETURNS trigger AS $$
DECLARE
    available BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('payguard.balance:' || NEW."merchant_id"::text || ':' || NEW."currency", 0)
    );
    SELECT coalesce(sum(balance."captured" - balance."refunded" - balance."paid_out" - balance."in_transit"), 0)
        INTO available
        FROM "merchant_balances"(NEW."merchant_id") AS balance
        WHERE balance."currency" = NEW."currency";
    IF NEW."amount" > available THEN
        RAISE EXCEPTION 'payout exceeds the available balance'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'payouts_within_available_balance';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payouts_within_available_balance"
    BEFORE INSERT ON "payouts"
    FOR EACH ROW EXECUTE FUNCTION "payouts_within_available_balance"();

-- Privileges, as documented in 20261026120000_runtime_and_operator_privileges. The operator role
-- appends payout history when it requeues a dead payout job.
GRANT SELECT, INSERT,
    UPDATE ("status", "provider_reference", "failure_code", "submitted_at", "completed_at", "updated_at")
    ON "payouts" TO payguard_runtime;
GRANT SELECT, INSERT ON "payout_events" TO payguard_runtime;
GRANT SELECT ON "payouts" TO payguard_operator;
GRANT SELECT, INSERT ON "payout_events" TO payguard_operator;
