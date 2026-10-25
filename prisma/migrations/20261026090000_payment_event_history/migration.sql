-- CreateEnum
CREATE TYPE "payment_event_source" AS ENUM ('MERCHANT', 'PROVIDER_RESPONSE', 'PROVIDER_LOOKUP', 'PROVIDER_WEBHOOK', 'WORKER', 'OPERATOR');

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "attempt_id" UUID,
    "type" VARCHAR(64) NOT NULL,
    "source" "payment_event_source" NOT NULL,
    "payment_status_before" "payment_status",
    "payment_status_after" "payment_status",
    "attempt_status_before" "payment_attempt_status",
    "attempt_status_after" "payment_attempt_status",
    "actor" VARCHAR(200),
    "request_id" VARCHAR(128),
    "outbox_job_id" UUID,
    "webhook_event_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_events_payment_id_created_at_idx" ON "payment_events"("payment_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_events_attempt_id_idx" ON "payment_events"("attempt_id");

-- CreateIndex
CREATE INDEX "payment_events_type_created_at_idx" ON "payment_events"("type", "created_at");

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "provider_webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants the Prisma schema cannot express.
ALTER TABLE "payment_events"
    ADD CONSTRAINT "payment_events_type_format" CHECK ("type" ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
    ADD CONSTRAINT "payment_events_actor_iff_operator" CHECK (("source" = 'OPERATOR') = ("actor" IS NOT NULL)),
    ADD CONSTRAINT "payment_events_details_object" CHECK (jsonb_typeof("details") = 'object');

-- History rows are append-only for the application, like operator_audit_events. This stops
-- accidental rewrites through code, not a database owner, who can drop the trigger.
CREATE FUNCTION "payment_events_reject_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'payment_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_events_append_only"
    BEFORE UPDATE OR DELETE ON "payment_events"
    FOR EACH ROW EXECUTE FUNCTION "payment_events_reject_change"();
-- Finding unresolved attempts (operator tooling, stats) without scanning settled history.
CREATE INDEX "payment_attempts_pending_created_at" ON "payment_attempts"("created_at") WHERE "status" = 'PENDING';