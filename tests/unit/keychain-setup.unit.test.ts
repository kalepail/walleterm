import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultServiceForNetwork, setupMacOSKeychainForWallet } from "../../src/keychain-setup.js";

function makeSecurityBin(): { securityBin: string; logPath: string } {
  const root = mkdtempSync(join(tmpdir(), "walleterm-keychain-setup-unit-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const securityBin = join(binDir, "security");
  const logPath = join(root, "security.log");

  writeFileSync(
    securityBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const logPath = process.env.WALLETERM_SECURITY_LOG_PATH;
const existing = new Set((process.env.WALLETERM_SECURITY_EXISTING_ACCOUNTS || "").split(",").filter(Boolean));

function findFlag(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

if (args[0] === "help") {
  process.stdout.write("security help");
  process.exit(0);
}

if (args[0] === "find-generic-password") {
  const account = findFlag("-a");
  if (existing.has(account)) {
    process.stdout.write("found");
    process.exit(0);
  }
  process.exit(1);
}

if (args[0] === "add-generic-password") {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n", "utf8");
  process.stdout.write("stored");
  process.exit(0);
}

process.stderr.write("unexpected security command: " + args.join(" "));
process.exit(1);
`,
    "utf8",
  );
  chmodSync(securityBin, 0o755);
  return { securityBin, logPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.WALLETERM_SECURITY_LOG_PATH;
  delete process.env.WALLETERM_SECURITY_EXISTING_ACCOUNTS;
});

describe("keychain setup unit", () => {
  it("defaultServiceForNetwork follows walleterm naming", () => {
    expect(defaultServiceForNetwork("testnet")).toBe("walleterm-testnet");
    expect(defaultServiceForNetwork("mainnet")).toBe("walleterm-mainnet");
    expect(defaultServiceForNetwork("future")).toBe("walleterm-future");
  });

  it("stores wallet secrets in the macOS keychain and returns keychain refs", async () => {
    const { securityBin, logPath } = makeSecurityBin();
    process.env.WALLETERM_SECURITY_LOG_PATH = logPath;

    const out = await setupMacOSKeychainForWallet({
      securityBin,
      service: "walleterm-testnet",
      network: "testnet",
      channelsApiKey: "manual-key",
      overwriteExisting: true,
      includeDeployerSeed: true,
    });

    const log = readFileSync(logPath, "utf8").trim().split("\n");
    expect(log).toHaveLength(3);
    expect(log[0]).toContain('"deployer_seed"');
    expect(log[1]).toContain('"delegated_seed"');
    expect(log[2]).toContain('"channels_api_key"');

    expect(out.refs.deployer_seed_ref).toBe("keychain://walleterm-testnet/deployer_seed");
    expect(out.refs.delegated_seed_ref).toBe("keychain://walleterm-testnet/delegated_seed");
    expect(out.refs.channels_api_key_ref).toBe("keychain://walleterm-testnet/channels_api_key");
    expect(out.config_snippet).toContain(
      'channels_api_key_ref = "keychain://walleterm-testnet/channels_api_key"',
    );
  });

  it("refuses to overwrite existing entries without --force", async () => {
    const { securityBin } = makeSecurityBin();
    process.env.WALLETERM_SECURITY_EXISTING_ACCOUNTS = "delegated_seed";

    await expect(
      setupMacOSKeychainForWallet({
        securityBin,
        service: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "manual-key",
        overwriteExisting: false,
      }),
    ).rejects.toThrow(/already contains delegated_seed/i);
  });

  it("uses WALLETERM_SECURITY_BIN when the option is omitted", async () => {
    const { securityBin, logPath } = makeSecurityBin();
    const prevBin = process.env.WALLETERM_SECURITY_BIN;
    process.env.WALLETERM_SECURITY_BIN = securityBin;
    process.env.WALLETERM_SECURITY_LOG_PATH = logPath;
    try {
      const out = await setupMacOSKeychainForWallet({
        service: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "manual-key",
        overwriteExisting: true,
      });
      expect(out.security_bin).toBe(securityBin);
    } finally {
      if (prevBin === undefined) delete process.env.WALLETERM_SECURITY_BIN;
      else process.env.WALLETERM_SECURITY_BIN = prevBin;
    }
  });

  it("redacts -w secret values in error messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "walleterm-keychain-redact-"));
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const securityBin = join(binDir, "security");

    writeFileSync(
      securityBin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "help") { process.exit(0); }
if (args[0] === "find-generic-password") { process.exit(1); }
if (args[0] === "add-generic-password") {
  process.stderr.write("simulated error");
  process.exit(1);
}
process.exit(1);
`,
      "utf8",
    );
    chmodSync(securityBin, 0o755);

    const result = setupMacOSKeychainForWallet({
      securityBin,
      service: "walleterm-testnet",
      network: "testnet",
      channelsApiKey: "manual-key",
      overwriteExisting: true,
      includeDeployerSeed: true,
      deployerSeed: "SBKZYLIJ3LKRJJQVDKYRHGUGZ3IJZIVAX2USAF5HSMH2WSOQKLJEWTXA",
    });

    await expect(result).rejects.toThrow("[REDACTED]");
    await expect(
      setupMacOSKeychainForWallet({
        securityBin,
        service: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "manual-key",
        overwriteExisting: true,
        includeDeployerSeed: true,
        deployerSeed: "SBKZYLIJ3LKRJJQVDKYRHGUGZ3IJZIVAX2USAF5HSMH2WSOQKLJEWTXA",
      }),
    ).rejects.not.toThrow("SBKZYLIJ3LKRJJQVDKYRHGUGZ3IJZIVAX2USAF5HSMH2WSOQKLJEWTXA");
  });

  it("falls back to default 'security' binary name when option/env are unset", async () => {
    const { securityBin, logPath } = makeSecurityBin();
    const prevBin = process.env.WALLETERM_SECURITY_BIN;
    const prevPath = process.env.PATH;
    delete process.env.WALLETERM_SECURITY_BIN;
    process.env.PATH = `${dirname(securityBin)}:${prevPath ?? ""}`;
    process.env.WALLETERM_SECURITY_LOG_PATH = logPath;
    try {
      const out = await setupMacOSKeychainForWallet({
        service: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "manual-key",
        overwriteExisting: true,
      });
      expect(out.security_bin).toBe("security");
    } finally {
      if (prevBin === undefined) delete process.env.WALLETERM_SECURITY_BIN;
      else process.env.WALLETERM_SECURITY_BIN = prevBin;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});
