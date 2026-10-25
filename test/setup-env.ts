import { config } from 'dotenv';
import { requireTestDatabaseUrl } from './global-setup.js';

config({ quiet: true });

// Point the app at the dedicated test database so e2e runs can never touch dev data.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = requireTestDatabaseUrl();

// Tests drive the outbox worker explicitly (processDueJobs) instead of racing a background loop.
process.env.OUTBOX_WORKER_ENABLED = 'false';

// A dedicated secret, so tests never depend on (or reveal) one configured in .env.
process.env.SIMULATOR_WEBHOOK_SECRET =
  'payguard-e2e-only-webhook-secret-5f0c2a9e7d41';
