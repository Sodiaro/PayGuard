import e2eConfig from './jest.e2e.config.js';

// Opt-in concurrency soak (npm run test:soak): same database safeguards as the e2e suite, never
// part of npm test or npm run test:e2e.
const config = {
  ...e2eConfig,
  testRegex: '.*\\.soak-spec\\.ts$',
  testTimeout: 30 * 60 * 1000,
};

export default config;
