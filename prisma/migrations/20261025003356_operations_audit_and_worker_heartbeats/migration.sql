-- AlterTable
ALTER TABLE "merchant_api_keys" ADD COLUMN     "last_used_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "outbox_jobs" ADD COLUMN     "lease_recoveries" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "outbox_workers" (
    "id" VARCHAR(128) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_job_finished_at" TIMESTAMPTZ(3),
    "jobs_finished" INTEGER NOT NULL DEFAULT 0,
    "stopped_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_audit_events" (
    "id" UUID NOT NULL,
    "actor" VARCHAR(200) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "target_type" VARCHAR(32) NOT NULL,
    "target_id" VARCHAR(128) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_workers_heartbeat_at_idx" ON "outbox_workers"("heartbeat_at");

-- CreateIndex
CREATE INDEX "operator_audit_events_created_at_idx" ON "operator_audit_events"("created_at");

-- CreateIndex
CREATE INDEX "operator_audit_events_target_type_target_id_idx" ON "operator_audit_events"("target_type", "target_id");

-- Invariants the Prisma schema cannot express.
ALTER TABLE "outbox_jobs"
    ADD CONSTRAINT "outbox_jobs_lease_recoveries_non_negative" CHECK ("lease_recoveries" >= 0);
ALTER TABLE "outbox_workers"
    ADD CONSTRAINT "outbox_workers_jobs_finished_non_negative" CHECK ("jobs_finished" >= 0);
ALTER TABLE "operator_audit_events"
    ADD CONSTRAINT "operator_audit_events_action_format" CHECK ("action" ~ '^[a-z][a-z_.]*$'),
    ADD CONSTRAINT "operator_audit_events_target_type_format" CHECK ("target_type" ~ '^[a-z][a-z_]*$');

-- Audit rows are append-only for the application. This stops accidental rewrites through code,
-- not a database administrator, who can drop the trigger.
CREATE FUNCTION "operator_audit_events_reject_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'operator_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "operator_audit_events_append_only"
    BEFORE UPDATE OR DELETE ON "operator_audit_events"
    FOR EACH ROW EXECUTE FUNCTION "operator_audit_events_reject_change"();
