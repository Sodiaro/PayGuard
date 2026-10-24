-- CreateEnum
CREATE TYPE "merchant_status" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "merchant_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_api_keys" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "prefix" VARCHAR(32) NOT NULL,
    "secret_hash" BYTEA NOT NULL,
    "label" VARCHAR(100),
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_api_keys_prefix_key" ON "merchant_api_keys"("prefix");

-- CreateIndex
CREATE INDEX "merchant_api_keys_merchant_id_idx" ON "merchant_api_keys"("merchant_id");

-- AddForeignKey
ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Not expressible in the Prisma schema: only a 32-byte SHA-256 digest may be stored, never key material.
ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_secret_hash_length" CHECK (octet_length("secret_hash") = 32);
