import type { Prisma } from '../generated/prisma/client.js';

// One currency of a merchant's balance, as the merchant_balances database function derives it.
// refunded includes pending refunds and inTransit is pending payouts: both are already committed.
export interface CurrencyBalance {
  currency: string;
  captured: bigint;
  refunded: bigint;
  paidOut: bigint;
  inTransit: bigint;
  available: bigint;
}

export async function loadBalances(
  db: Prisma.TransactionClient,
  merchantId: string,
): Promise<CurrencyBalance[]> {
  const rows = await db.$queryRaw<
    {
      currency: string;
      captured: bigint;
      refunded: bigint;
      paid_out: bigint;
      in_transit: bigint;
    }[]
  >`SELECT currency, captured, refunded, paid_out, in_transit
    FROM merchant_balances(${merchantId}::uuid)`;
  return rows.map((row) => ({
    currency: row.currency,
    captured: row.captured,
    refunded: row.refunded,
    paidOut: row.paid_out,
    inTransit: row.in_transit,
    available: row.captured - row.refunded - row.paid_out - row.in_transit,
  }));
}

export async function loadCurrencyBalance(
  db: Prisma.TransactionClient,
  merchantId: string,
  currency: string,
): Promise<CurrencyBalance> {
  const balances = await loadBalances(db, merchantId);
  return (
    balances.find((balance) => balance.currency === currency) ?? {
      currency,
      captured: 0n,
      refunded: 0n,
      paidOut: 0n,
      inTransit: 0n,
      available: 0n,
    }
  );
}

// The same transaction-scoped lock the payouts_within_available_balance trigger takes, so payouts
// of one merchant and currency are decided one at a time against a balance that includes the last.
export async function lockBalance(
  tx: Prisma.TransactionClient,
  merchantId: string,
  currency: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended('payguard.balance:' || ${merchantId}::uuid::text || ':' || ${currency}, 0)
    )`;
}
