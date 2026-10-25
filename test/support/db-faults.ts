import type { PrismaService } from '../../src/database/prisma.service.js';

// Makes writes to a table fail inside the database, to prove that a failure part-way through a
// transaction leaves nothing behind and that the worker treats it as an internal error.
export async function failWritesTo(
  prisma: PrismaService,
  table: 'outbox_jobs' | 'payment_attempts' | 'provider_webhook_events',
  operation: 'INSERT' | 'UPDATE',
): Promise<() => Promise<void>> {
  const name = `test_fail_${table}_${operation.toLowerCase()}`;
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected test failure'; END;
    $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  return async () => {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${name} ON ${table}`,
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}
