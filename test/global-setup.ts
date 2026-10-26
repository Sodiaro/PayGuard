import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';

// Jest imports this file natively, outside its module mapper, so it must not import
// project files. setup-env.ts reuses requireTestDatabaseUrl from here.

export type TestDatabaseVariable =
  | 'TEST_DATABASE_URL'
  | 'TEST_MIGRATION_DATABASE_URL'
  | 'TEST_OPERATOR_DATABASE_URL';

// Integration tests truncate tables, so they only ever run against a database whose name says
// it is disposable. There is deliberately no fallback to the non-test connection variables.
// TEST_DATABASE_URL connects as the application's runtime role, TEST_OPERATOR_DATABASE_URL as the
// CLI's operator role, and TEST_MIGRATION_DATABASE_URL as the schema owner, which migrates and
// does the test-only control (truncation, fault triggers) the application may not.
export function requireTestDatabaseUrl(
  variable: TestDatabaseVariable = 'TEST_DATABASE_URL',
): string {
  const url = process.env[variable];
  if (!url) {
    throw new Error(
      `${variable} must be set to run integration tests (see .env.example).`,
    );
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    throw new Error(`${variable} is not a valid connection URL.`);
  }
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${databaseName}": the test database name must end with "_test".`,
    );
  }
  return url;
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

export default function globalSetup(): void {
  config({ quiet: true });
  const urls = [
    requireTestDatabaseUrl('TEST_DATABASE_URL'),
    requireTestDatabaseUrl('TEST_OPERATOR_DATABASE_URL'),
    requireTestDatabaseUrl('TEST_MIGRATION_DATABASE_URL'),
  ];
  if (new Set(urls.map(databaseName)).size !== 1) {
    throw new Error(
      'TEST_DATABASE_URL, TEST_OPERATOR_DATABASE_URL and TEST_MIGRATION_DATABASE_URL must name the same database.',
    );
  }

  execFileSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      env: { ...process.env, MIGRATION_DATABASE_URL: urls[2] },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
}
