/**
 * Root jest config — runs every workspace's unit tests with one command
 * (`npm test`). ts-jest transpiles TypeScript per-file, so no build step is
 * needed first. This is exactly what CI runs on every PR.
 */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/packages", "<rootDir>/infra"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.base.json" }],
  },
  moduleNameMapper: {
    "^@backrow/shared$": "<rootDir>/packages/shared/src/index.ts",
  },
  // CDK bundling can make the first synth slow on a cold machine.
  testTimeout: 60000,
};
