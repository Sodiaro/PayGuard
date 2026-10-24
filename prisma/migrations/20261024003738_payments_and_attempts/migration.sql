-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "payment_attempt_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "payment_failure_code" AS ENUM ('DECLINED', 'PROVIDER_UNAVAILABLE');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "reference" VARCHAR(64),
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "status" "payment_attempt_status" NOT NULL DEFAULT 'PENDING',
    "provider_reference" VARCHAR(100),
    "failure_code" "payment_failure_code",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_merchant_id_created_at_idx" ON "payments"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_merchant_id_reference_idx" ON "payments"("merchant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_merchant_id_idempotency_key_key" ON "payments"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_payment_id_attempt_number_key" ON "payment_attempts"("payment_id", "attempt_number");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants the Prisma schema cannot express. The application enforces the same rules;
-- these make a bug or a manual write fail loudly instead of corrupting payment state.
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
    ADD CONSTRAINT "payments_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "payments_idempotency_key_present" CHECK (length("idempotency_key") > 0),
    ADD CONSTRAINT "payments_request_fingerprint_format" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE "payment_attempts"
    ADD CONSTRAINT "payment_attempts_number_positive" CHECK ("attempt_number" > 0),
    ADD CONSTRAINT "payment_attempts_completed_iff_terminal" CHECK (("status" = 'PENDING') = ("completed_at" IS NULL)),
    ADD CONSTRAINT "payment_attempts_failure_code_iff_failed" CHECK (("status" = 'FAILED') = ("failure_code" IS NOT NULL));

-- At most one attempt per payment may be in flight.
CREATE UNIQUE INDEX "payment_attempts_one_pending_per_payment" ON "payment_attempts"("payment_id") WHERE "status" = 'PENDING';
