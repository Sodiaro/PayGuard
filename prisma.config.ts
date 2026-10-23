// Prisma 7 no longer loads .env itself.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Not env(): it throws when unset, which would break `prisma generate` without a database.
    url: process.env.DATABASE_URL,
  },
});
