import type { PrismaService } from '../../src/database/prisma.service.js';

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const [{ database }] = await prisma.$queryRaw<{ database: string }[]>`
    SELECT current_database() AS database`;
  if (!database.endsWith('_test')) {
    throw new Error(`Refusing to truncate tables in "${database}"`);
  }

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;

  // A single TRUNCATE over every table satisfies foreign keys without ordering them.
  const list = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY`);
}
