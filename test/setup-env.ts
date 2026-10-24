import { config } from 'dotenv';
import { requireTestDatabaseUrl } from './global-setup.js';

config({ quiet: true });

// Point the app at the dedicated test database so e2e runs can never touch dev data.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = requireTestDatabaseUrl();
