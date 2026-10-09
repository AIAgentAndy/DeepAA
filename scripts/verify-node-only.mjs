#!/usr/bin/env node

import {readFile, readdir} from "node:fs/promises";
import {dirname, extname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const targets = [
  "bin",
  "src/proxy",
  "src/proxy-server.ts",
  "src/reverse-proxy.ts",
  "tsconfig.json",
  "tsconfig.proxy.json",
];
const forbiddenRuntimeName = ["B", "un"].join("");
const forbiddenPatterns = [
  new RegExp(`\\b${forbiddenRuntimeName}\\.`, "u"),
  new RegExp(`\\b${forbiddenRuntimeName.toLowerCase()}(?:\\s+run|\\s+test|:test|:dev)`, "iu"),
  new RegExp(`@types/${forbiddenRuntimeName.toLowerCase()}`, "iu"),
];
const violations = [];

for (const target of targets) {
  for (const path of await sourceFiles(join(rootDir, target))) {
    const source = await readFile(path, "utf8");
    if (forbiddenPatterns.some(pattern => pattern.test(source))) {
      violations.push(path.slice(rootDir.length + 1));
    }
  }
}
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  if (forbiddenPatterns.some(pattern => pattern.test(String(command)))) {
    violations.push(`package.json#scripts.${name}`);
  }
}
if (packageJson.devDependencies?.[`@types/${forbiddenRuntimeName.toLowerCase()}`]) {
  violations.push("package.json#devDependencies");
}
if (violations.length > 0) {
  process.stderr.write(`检测到非 Node 运行依赖:\n${violations.map(item => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Node-only runtime verification passed.\n");
}

async function sourceFiles(path) {
  try {
    const entries = await readdir(path, {withFileTypes: true});
    const files = [];
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) files.push(...await sourceFiles(child));
      else if ([".js", ".mjs", ".ts", ".json"].includes(extname(entry.name))) files.push(child);
    }
    return files;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOTDIR") return [path];
    throw error;
  }
}
