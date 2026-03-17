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

  it("rejects on non-macOS when no explicit security binary is provided", async () => {
    const prevBin = process.env.WALLETERM_SECURITY_BIN;
    delete process.env.WALLETERM_SECURITY_BIN;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(
        setupMacOSKeychainForWallet({
          service: "walleterm-testnet",
          network: "testnet",
          channelsApiKey: "manual-key",
          overwriteExisting: true,
        }),
      ).rejects.toThrow(/macOS keychain backend is only available on macOS/i);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      if (prevBin === undefined) delete process.env.WALLETERM_SECURITY_BIN;
      else process.env.WALLETERM_SECURITY_BIN = prevBin;
    }
  });

  it("errorMessage: runSecurity catch path surfaces stderr from a failing command", async () => {
    const root = mkdtempSync(join(tmpdir(), "walleterm-keychain-errmsg-"));
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const securityBin = join(binDir, "security");

    writeFileSync(
      securityBin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "help") {
  process.stderr.write("stderr-from-security");
  process.exit(1);
}
process.exit(1);
`,
      "utf8",
    );
    chmodSync(securityBin, 0o755);

    await expect(
      setupMacOSKeychainForWallet({
        securityBin,
        service: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "manual-key",
        overwriteExisting: true,
      }),
    ).rejects.toThrow(/stderr-from-security/);
  });

  it("errorMessage: runSecurity catch path falls back to Error.message when stderr is empty", async () => {
    await expect(
      setupMacOSKeychainForWallet({
        securityBin: "/nonexistent/binary/path",
        service: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "manual-key",
        overwriteExisting: true,
      }),
    ).rejects.toThrow(/failed:/i);
  });

  it("networkDefaults: testnet config snippet contains testnet URLs", async () => {
    const { securityBin, logPath } = makeSecurityBin();
    process.env.WALLETERM_SECURITY_LOG_PATH = logPath;

    const out = await setupMacOSKeychainForWallet({
      securityBin,
      service: "walleterm-testnet",
      network: "testnet",
      channelsApiKey: "manual-key",
      overwriteExisting: true,
    });

    expect(out.config_snippet).toContain("https://channels.openzeppelin.com/testnet");
    expect(out.config_snippet).toContain("https://soroban-rpc.testnet.stellar.gateway.fm");
  });

  it("networkDefaults: mainnet config snippet contains mainnet URLs", async () => {
    const { securityBin, logPath } = makeSecurityBin();
    process.env.WALLETERM_SECURITY_LOG_PATH = logPath;

    const out = await setupMacOSKeychainForWallet({
      securityBin,
      service: "walleterm-mainnet",
      network: "mainnet",
      channelsApiKey: "manual-key",
      overwriteExisting: true,
    });

    expect(out.config_snippet).toContain('https://channels.openzeppelin.com"');
    expect(out.config_snippet).toContain("https://rpc.lightsail.network/");
  });

  it("networkDefaults: unknown network config snippet contains placeholder URLs", async () => {
    const { securityBin, logPath } = makeSecurityBin();
    process.env.WALLETERM_SECURITY_LOG_PATH = logPath;

    const out = await setupMacOSKeychainForWallet({
      securityBin,
      service: "walleterm-custom",
      network: "custom",
      channelsApiKey: "manual-key",
      overwriteExisting: true,
    });

    expect(out.config_snippet).toContain("<set-channels-base-url>");
    expect(out.config_snippet).toContain("<set-rpc-url>");
  });

  it("resolveChannelsApiKey: auto-generates key for testnet", async () => {
    const { securityBin, logPath } = makeSecurityBin();
    process.env.WALLETERM_SECURITY_LOG_PATH = logPath;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ apiKey: "auto-generated-testnet-key" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const out = await setupMacOSKeychainForWallet({
      securityBin,
      service: "walleterm-testnet",
      network: "testnet",
      overwriteExisting: true,
    });

    expect(fetchSpy).toHaveBeenCalledWith("https://channels.openzeppelin.com/testnet/gen");
    const log = readFileSync(logPath, "utf8").trim().split("\n");
    const channelsEntry = log.find((l) => l.includes("channels_api_key"));
    expect(channelsEntry).toContain("auto-generated-testnet-key");
    expect(out).toBeDefined();
  });

  it("resolveChannelsApiKey: auto-generates key for mainnet", async () => {
    const { securityBin, logPath } = makeSecurityBin();
    process.env.WALLETERM_SECURITY_LOG_PATH = logPath;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ apiKey: "auto-generated-mainnet-key" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const out = await setupMacOSKeychainForWallet({
      securityBin,
      service: "walleterm-mainnet",
      network: "mainnet",
      overwriteExisting: true,
    });

    expect(fetchSpy).toHaveBeenCalledWith("https://channels.openzeppelin.com/gen");
    const log = readFileSync(logPath, "utf8").trim().split("\n");
    const channelsEntry = log.find((l) => l.includes("channels_api_key"));
    expect(channelsEntry).toContain("auto-generated-mainnet-key");
    expect(out).toBeDefined();
  });

  it("resolveChannelsApiKey: throws for unknown network without explicit key", async () => {
    const { securityBin } = makeSecurityBin();

    await expect(
      setupMacOSKeychainForWallet({
        securityBin,
        service: "walleterm-custom",
        network: "custom",
        overwriteExisting: true,
      }),
    ).rejects.toThrow(/No default Channels API key generator for network 'custom'/);
  });
});
