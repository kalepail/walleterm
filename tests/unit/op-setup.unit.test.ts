import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultItemForNetwork, setupOnePasswordForWallet } from "../../src/op-setup.js";

function makeOpBin(mode: "ok" | "fail-whoami-stderr"): string {
  const root = mkdtempSync(join(tmpdir(), "walleterm-op-setup-unit-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const opBin = join(binDir, "op");

  writeFileSync(
    opBin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};

const out = (v) => process.stdout.write(String(v));
const fail = (msg) => { process.stderr.write(String(msg)); process.exit(1); };

if (args[0] === '--version') { out('2.32.1'); process.exit(0); }
if (args[0] === 'whoami') {
  if (mode === 'fail-whoami-stderr') fail('account is not signed in');
  out('tester@example.com');
  process.exit(0);
}
if (args[0] === 'vault' && args[1] === 'get') { out('{}'); process.exit(0); }
if (args[0] === 'vault' && args[1] === 'create') { out('{}'); process.exit(0); }
if (args[0] === 'item' && args[1] === 'get') fail('item not found');
if (args[0] === 'item' && (args[1] === 'create' || args[1] === 'edit')) { out('{"id":"item1"}'); process.exit(0); }

fail('unexpected op command');
`,
    "utf8",
  );
  chmodSync(opBin, 0o755);
  return opBin;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("op-setup unit", () => {
  it("defaultItemForNetwork handles known and custom networks", () => {
    expect(defaultItemForNetwork("testnet")).toBe("walleterm-testnet");
    expect(defaultItemForNetwork("mainnet")).toBe("walleterm-mainnet");
    expect(defaultItemForNetwork("future")).toBe("walleterm-future");
  });

  it("auto-generates channels API key from testnet and mainnet generators", async () => {
    const opBin = makeOpBin("ok");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ apiKey: "generated-api-key" }),
    } as Response);

    const testnet = await setupOnePasswordForWallet({
      opBin,
      vault: "Private",
      item: "walleterm-testnet",
      network: "testnet",
      overwriteExisting: true,
      createVault: true,
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(1, "https://channels.openzeppelin.com/testnet/gen");
    expect(testnet.refs.channels_api_key_ref).toBe(
      "op://Private/walleterm-testnet/channels_api_key",
    );

    const mainnet = await setupOnePasswordForWallet({
      opBin,
      vault: "Private",
      item: "walleterm-mainnet",
      network: "mainnet",
      overwriteExisting: true,
      createVault: true,
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(2, "https://channels.openzeppelin.com/gen");
    expect(mainnet.refs.channels_api_key_ref).toBe(
      "op://Private/walleterm-mainnet/channels_api_key",
    );
  }, 15000);

  it("throws when unknown network has no default channels API key generator", async () => {
    const opBin = makeOpBin("ok");
    await expect(
      setupOnePasswordForWallet({
        opBin,
        vault: "Private",
        item: "walleterm-future",
        network: "future",
        overwriteExisting: true,
        createVault: true,
      }),
    ).rejects.toThrow(/No default Channels API key generator/i);
  });

  it("throws when channels key generator fails or response omits apiKey", async () => {
    const opBin = makeOpBin("ok");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    await expect(
      setupOnePasswordForWallet({
        opBin,
        vault: "Private",
        item: "walleterm-testnet",
        network: "testnet",
        overwriteExisting: true,
        createVault: true,
      }),
    ).rejects.toThrow(/Failed to generate channels API key/i);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    await expect(
      setupOnePasswordForWallet({
        opBin,
        vault: "Private",
        item: "walleterm-testnet",
        network: "testnet",
        overwriteExisting: true,
        createVault: true,
      }),
    ).rejects.toThrow(/did not include apiKey/i);
  });

  it("validates provided deployer/delegated seeds", async () => {
    const opBin = makeOpBin("ok");

    await expect(
      setupOnePasswordForWallet({
        opBin,
        vault: "Private",
        item: "walleterm-testnet",
        network: "testnet",
        deployerSeed: "invalid",
        includeDeployerSeed: true,
        channelsApiKey: "abc",
        overwriteExisting: true,
        createVault: true,
      }),
    ).rejects.toThrow(/deployer seed must be a valid Stellar secret seed/i);

    await expect(
      setupOnePasswordForWallet({
        opBin,
        vault: "Private",
        item: "walleterm-testnet",
        network: "testnet",
        delegatedSeed: "invalid",
        channelsApiKey: "abc",
        overwriteExisting: true,
        createVault: true,
      }),
    ).rejects.toThrow(/delegated seed must be a valid Stellar secret seed/i);
  });

  it("uses placeholder config defaults for unknown network when explicit channels key is provided", async () => {
    const opBin = makeOpBin("ok");

    const out = await setupOnePasswordForWallet({
      opBin,
      vault: "Private",
      item: "walleterm-future",
      network: "future",
      channelsApiKey: "manual-key",
      overwriteExisting: true,
      createVault: true,
    });

    expect(out.config_snippet).toContain('rpc_url = "<set-rpc-url>"');
    expect(out.config_snippet).toContain('channels_base_url = "<set-channels-base-url>"');
  });

  it("generates deployer seed when includeDeployerSeed is true and no seed is provided", async () => {
    const opBin = makeOpBin("ok");

    const out = await setupOnePasswordForWallet({
      opBin,
      vault: "Private",
      item: "walleterm-testnet",
      network: "testnet",
      includeDeployerSeed: true,
      channelsApiKey: "manual-key",
      overwriteExisting: true,
      createVault: true,
    });

    expect(out.deployer_seed_stored).toBe(true);
    expect(out.refs.deployer_seed_ref).toBe("op://Private/walleterm-testnet/deployer_seed");
  });

  it("surfaces stderr from op failures and handles missing op binary", async () => {
    const failingBin = makeOpBin("fail-whoami-stderr");

    await expect(
      setupOnePasswordForWallet({
        opBin: failingBin,
        vault: "Private",
        item: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "abc",
        overwriteExisting: true,
        createVault: true,
      }),
    ).rejects.toThrow(/account is not signed in/i);

    await expect(
      setupOnePasswordForWallet({
        opBin: join(tmpdir(), "definitely-missing-op-binary"),
        vault: "Private",
        item: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "abc",
        overwriteExisting: true,
        createVault: true,
      }),
    ).rejects.toThrow(/failed:/i);
  });

  it("uses WALLETERM_OP_BIN when opBin option is omitted", async () => {
    const opBin = makeOpBin("ok");
    const prev = process.env.WALLETERM_OP_BIN;
    process.env.WALLETERM_OP_BIN = opBin;
    try {
      const out = await setupOnePasswordForWallet({
        vault: "Private",
        item: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "manual-key",
        overwriteExisting: true,
        createVault: true,
      });
      expect(out.op_bin).toBe(opBin);
    } finally {
      if (prev === undefined) delete process.env.WALLETERM_OP_BIN;
      else process.env.WALLETERM_OP_BIN = prev;
    }
  });

  it("falls back to default 'op' binary name when opBin/env are unset", async () => {
    const opBin = makeOpBin("ok");
    const prevEnvOp = process.env.WALLETERM_OP_BIN;
    const prevPath = process.env.PATH;
    delete process.env.WALLETERM_OP_BIN;
    process.env.PATH = `${dirname(opBin)}:${prevPath ?? ""}`;
    try {
      const out = await setupOnePasswordForWallet({
        vault: "Private",
        item: "walleterm-testnet",
        network: "testnet",
        channelsApiKey: "manual-key",
        overwriteExisting: true,
        createVault: true,
      });
      expect(out.op_bin).toBe("op");
    } finally {
      if (prevEnvOp === undefined) delete process.env.WALLETERM_OP_BIN;
      else process.env.WALLETERM_OP_BIN = prevEnvOp;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});
