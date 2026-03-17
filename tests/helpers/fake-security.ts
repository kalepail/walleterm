import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./temp-dir.js";

export interface FakeSecurityFixture {
  env: NodeJS.ProcessEnv;
  logPath: string;
  rootDir: string;
  securityBin: string;
  storePath: string;
  /** Remove the temp directory and all contents. Call in afterAll/afterEach to avoid leaking seed material. */
  cleanup: () => void;
}

export function securityStoreKey(service: string, account: string): string {
  return `${service}::${account}`;
}

export function readSecurityStore(storePath: string): Record<string, string> {
  return JSON.parse(readFileSync(storePath, "utf8")) as Record<string, string>;
}

export function readSecurityCalls(logPath: string): string[][] {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

export function makeFakeSecurityFixture(
  initialStore: Record<string, string> = {},
): FakeSecurityFixture {
  const rootDir = makeTempDir("walleterm-fake-security-");
  const binDir = join(rootDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const securityBin = join(binDir, "security");
  const logPath = join(rootDir, "security.log");
  const storePath = join(rootDir, "security-store.json");
  writeFileSync(logPath, "", { encoding: "utf8", mode: 0o600 });
  writeFileSync(storePath, JSON.stringify(initialStore), { encoding: "utf8", mode: 0o600 });

  writeFileSync(
    securityBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const logPath = process.env.WALLETERM_SECURITY_LOG_PATH;
const storePath = process.env.WALLETERM_SECURITY_STORE_PATH;

function appendLog() {
  if (logPath) {
    fs.appendFileSync(logPath, JSON.stringify(args) + "\\n", { encoding: "utf8", mode: 0o600 });
  }
}

function fail(message, code = 1) {
  process.stderr.write(String(message));
  process.exit(code);
}

function findFlag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
}

appendLog();

if (args[0] === "help") {
  process.stdout.write("security help");
  process.exit(0);
}

if (args[0] === "find-generic-password") {
  const account = findFlag("-a");
  const service = findFlag("-s");
  const wantsPassword = args.includes("-w");
  const store = loadStore();
  const value = store[\`\${service}::\${account}\`];

  if (typeof value === "string") {
    if (wantsPassword) {
      process.stdout.write(value);
    } else {
      process.stdout.write("keychain item found");
    }
    process.exit(0);
  }

  process.exit(44);
}

if (args[0] === "add-generic-password") {
  const account = findFlag("-a");
  const service = findFlag("-s");
  const value = findFlag("-w");

  if (!account || !service || value === undefined) {
    fail("missing add-generic-password arguments");
  }

  const store = loadStore();
  store[\`\${service}::\${account}\`] = value;
  saveStore(store);
  process.stdout.write("stored");
  process.exit(0);
}

fail("unexpected security invocation: " + args.join(" "));
`,
    "utf8",
  );
  chmodSync(securityBin, 0o755);

  return {
    env: {
      ...process.env,
      WALLETERM_SECURITY_BIN: securityBin,
      WALLETERM_SECURITY_LOG_PATH: logPath,
      WALLETERM_SECURITY_STORE_PATH: storePath,
    },
    logPath,
    rootDir,
    securityBin,
    storePath,
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
