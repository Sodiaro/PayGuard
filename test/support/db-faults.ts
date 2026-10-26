import { ownerDatabase } from './test-database.js';

// Makes writes to a table fail inside the database, to prove that a failure part-way through a
// transaction leaves nothing behind and that the worker treats it as an internal error. Triggers
// are installed by the schema owner: the application's roles may not create them.
export async function failWritesTo(
  table:
    | 'outbox_jobs'
    | 'payment_attempts'
    | 'provider_webhook_events'
    | 'payment_events',
  operation: 'INSERT' | 'UPDATE',
): Promise<() => Promise<void>> {
  const db = ownerDatabase();
  const name = `test_fail_${table}_${operation.toLowerCase()}`;
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected test failure'; END;
    $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  return async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}
