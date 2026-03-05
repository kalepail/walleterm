import { builtinModules } from "node:module";
import { defineConfig } from "rolldown";

const dependencyExternals = new Set([
  "@iarna/toml",
  "@openzeppelin/relayer-plugin-channels",
  "@stellar/stellar-sdk",
  "commander",
]);

const builtinExternals = new Set([
  ...builtinModules,
  ...builtinModules.map((mod) => (mod.startsWith("node:") ? mod : `node:${mod}`)),
]);

function isExternal(id) {
  if (builtinExternals.has(id)) {
    return true;
  }
  for (const dep of dependencyExternals) {
    if (id === dep || id.startsWith(`${dep}/`)) {
      return true;
    }
  }
  return false;
}

export default defineConfig({
  input: "src/cli.ts",
  tsconfig: "./tsconfig.build.json",
  platform: "node",
  external: isExternal,
  output: {
    file: "dist/cli.bundle.js",
    format: "esm",
    sourcemap: true,
    banner: "#!/usr/bin/env bun",
  },
});
