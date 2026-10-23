import { config } from 'dotenv';

config({ quiet: true });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL must be set to run integration tests (see .env.example).',
  );
}

// Point the app at the dedicated test database so e2e runs can never touch dev data.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl;
