import unitConfig from './jest.config.js';

const config = {
  ...unitConfig,
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  setupFiles: [...unitConfig.setupFiles, '<rootDir>/test/setup-env.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: true, tsconfig: '<rootDir>/tsconfig.json' },
    ],
  },
};

export default config;
