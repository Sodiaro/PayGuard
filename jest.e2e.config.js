import unitConfig from './jest.config.js';

const config = {
  ...unitConfig,
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  globalSetup: '<rootDir>/test/global-setup.ts',
  setupFiles: [...unitConfig.setupFiles, '<rootDir>/test/setup-env.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup-after-env.ts'],
  // All files share one database and truncate it between tests, so they must never run concurrently.
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: true, tsconfig: '<rootDir>/tsconfig.json' },
    ],
  },
};

export default config;
