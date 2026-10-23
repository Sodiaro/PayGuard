// NestJS 12 is ESM-only, so Jest runs in ESM mode (--experimental-vm-modules in the npm scripts).
const config = {
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  // Sources import './x.js' per Node ESM rules; resolve those to the .ts files.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: true, tsconfig: '<rootDir>/../tsconfig.json' },
    ],
  },
  // Nest normally loads this; needed for decorator-based classes tested without booting Nest.
  setupFiles: ['reflect-metadata'],
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!generated/**',
    '!main.ts',
  ],
  coverageDirectory: '../coverage',
};

export default config;
