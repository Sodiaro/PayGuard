import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';

// Jest imports this file natively, outside its module mapper, so it must not import
// project files. setup-env.ts reuses requireTestDatabaseUrl from here.

// Integration tests truncate tables, so they only ever run against a database whose
// name says it is disposable. There is deliberately no fallback to DATABASE_URL.
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL must be set to run integration tests (see .env.example).',
    );
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid connection URL.');
  }
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${databaseName}": the test database name must end with "_test".`,
    );
  }
  return url;
}

export default function globalSetup(): void {
  config({ quiet: true });
  const testDatabaseUrl = requireTestDatabaseUrl();

  execFileSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
}
