-- Privileges of the two group roles the application uses; the schema owner (who runs migrations)
-- keeps everything else. The roles are provisioned outside the application by
-- docker/postgres/init/01-roles-and-databases.sh, and this migration fails if they are missing,
-- so a deployment cannot run with roles that were never set up. A migration that adds a table
-- must grant on it in the same way.
--
-- payguard_runtime (the API and worker) can read what it serves and write only the columns its
-- state changes touch. It cannot delete anything, truncate, alter tables or triggers, or touch
-- operator_audit_events, and it can only append to payment_events.

GRANT SELECT ON "merchants" TO payguard_runtime;
GRANT SELECT, UPDATE ("last_used_at") ON "merchant_api_keys" TO payguard_runtime;
GRANT SELECT, INSERT, UPDATE ("status", "updated_at") ON "payments" TO payguard_runtime;
GRANT SELECT, INSERT,
    UPDATE ("status", "provider_reference", "failure_code", "submitted_at", "completed_at")
    ON "payment_attempts" TO payguard_runtime;
GRANT SELECT, INSERT ON "payment_retry_requests" TO payguard_runtime;
GRANT SELECT, INSERT,
    UPDATE ("status", "run_count", "lease_recoveries", "available_at", "locked_by", "lease_token",
            "locked_until", "last_error", "completed_at", "updated_at")
    ON "outbox_jobs" TO payguard_runtime;
GRANT SELECT, INSERT,
    UPDATE ("heartbeat_at", "last_job_finished_at", "jobs_finished", "stopped_at")
    ON "outbox_workers" TO payguard_runtime;
GRANT SELECT, INSERT,
    UPDATE ("status", "result", "processed_at", "duplicate_deliveries", "conflicting_deliveries",
            "last_conflict_at")
    ON "provider_webhook_events" TO payguard_runtime;
GRANT SELECT, INSERT ON "payment_events" TO payguard_runtime;

-- payguard_operator (the operator CLI) provisions merchants and keys, inspects everything,
-- requeues dead jobs, prunes completed jobs and old worker rows, and records what it did. It
-- cannot change payments or attempts, and can only append to both history tables.

GRANT SELECT, INSERT, UPDATE ("status", "updated_at") ON "merchants" TO payguard_operator;
GRANT SELECT, INSERT, UPDATE ("revoked_at") ON "merchant_api_keys" TO payguard_operator;
GRANT SELECT ON "payments", "payment_attempts", "payment_retry_requests", "provider_webhook_events"
    TO payguard_operator;
GRANT SELECT, UPDATE ("status", "run_count", "available_at", "updated_at"), DELETE
    ON "outbox_jobs" TO payguard_operator;
GRANT SELECT, DELETE ON "outbox_workers" TO payguard_operator;
GRANT SELECT, INSERT ON "payment_events", "operator_audit_events" TO payguard_operator;
