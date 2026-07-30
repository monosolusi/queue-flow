/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@core-api/domain(/.*)?$': '<rootDir>/src/domain$1',
    '^@core-api/application(/.*)?$': '<rootDir>/src/application$1',
    '^@core-api/infrastructure(/.*)?$': '<rootDir>/src/infrastructure$1',
  },
  collectCoverageFrom: ['src/domain/**/*.ts', '!src/domain/**/index.ts'],
  verbose: false,
};