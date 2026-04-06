import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const pkgRoot = resolve(root, "node_modules/stellar-mpp-sdk");

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function hasBuiltDist() {
  return exists(join(pkgRoot, "dist/index.js")) && exists(join(pkgRoot, "dist/client/index.js"));
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function ensurePackageInstalled() {
  try {
    readdirSync(pkgRoot);
  } catch {
    return false;
  }
  return true;
}

function buildEntry(entry, outfile) {
  const result = spawnSync(
    "bun",
    [
      "build",
      entry,
      "--target=node",
      "--format=esm",
      `--outfile=${outfile}`,
    ],
    {
      cwd: root,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to build ${entry}`);
  }
}

function writeTypeStub(path, sourcePath) {
  writeFile(path, `export * from "${sourcePath}";\n`);
}

if (!ensurePackageInstalled() || hasBuiltDist()) {
  process.exit(0);
}

const entries = [
  ["sdk/src/index.ts", "dist/index.js", "../sdk/src/index"],
  ["sdk/src/client/index.ts", "dist/client/index.js", "../../sdk/src/client/index"],
  ["sdk/src/server/index.ts", "dist/server/index.js", "../../sdk/src/server/index"],
  ["sdk/src/channel/index.ts", "dist/channel/index.js", "../../sdk/src/channel/index"],
  [
    "sdk/src/channel/client/index.ts",
    "dist/channel/client/index.js",
    "../../../sdk/src/channel/client/index",
  ],
  [
    "sdk/src/channel/server/index.ts",
    "dist/channel/server/index.js",
    "../../../sdk/src/channel/server/index",
  ],
];

for (const [entry, outfile] of entries) {
  buildEntry(join(pkgRoot, entry), join(pkgRoot, outfile));
}

for (const [, outfile, sourcePath] of entries) {
  writeTypeStub(join(pkgRoot, outfile.replace(/\.js$/, ".d.ts")), sourcePath);
}
