/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  // The acceptance suite (DoD-1..4) lives under test/acceptance/*.acceptance.spec.ts
  // and runs via the dedicated `test:acceptance` script (which overrides
  // testMatch on the CLI, replacing this list entirely). The negation keeps
  // acceptance specs out of the default `npm test` unit gate so it stays fast.
  testMatch: ['**/*.spec.ts', '!**/*.acceptance.spec.ts'],
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@core-api/domain(/.*)?$': '<rootDir>/src/domain$1',
    '^@core-api/application(/.*)?$': '<rootDir>/src/application$1',
    '^@core-api/infrastructure(/.*)?$': '<rootDir>/src/infrastructure$1',
  },
  collectCoverageFrom: ['src/domain/**/*.ts', '!src/domain/**/index.ts'],
  verbose: false,
};