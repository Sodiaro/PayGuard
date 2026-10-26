import { afterAll } from '@jest/globals';
import { closeOwnerDatabase } from './support/test-database.js';

afterAll(async () => {
  await closeOwnerDatabase();
});
