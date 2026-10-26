import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

let owner: PrismaClient | undefined;

// The schema owner's connection, for test-only control that the application's roles are rightly
// denied: truncating tables, installing fault triggers, rewriting timestamps and reading the
// operator audit trail. Application code under test never uses it.
export function ownerDatabase(): PrismaClient {
  owner ??= new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.MIGRATION_DATABASE_URL,
    }),
  });
  return owner;
}

export async function closeOwnerDatabase(): Promise<void> {
  await owner?.$disconnect();
  owner = undefined;
}

export async function resetDatabase(): Promise<void> {
  const db = ownerDatabase();
  const [{ database }] = await db.$queryRaw<{ database: string }[]>`
    SELECT current_database() AS database`;
  if (!database.endsWith('_test')) {
    throw new Error(`Refusing to truncate tables in "${database}"`);
  }

  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;

  // A single TRUNCATE over every table satisfies foreign keys without ordering them.
  const list = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY`);
}
