#!/usr/bin/env node

import {spawn} from "node:child_process";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(rootDir, "node_modules", "vitest", "vitest.mjs");
const child = spawn(process.execPath, [vitest, "run", "tests/package-smoke.test.ts", "--reporter=verbose"], {
  cwd: rootDir,
  env: {...process.env, RUN_PACKAGE_SMOKE: "1"},
  stdio: "inherit",
});
child.once("error", error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
