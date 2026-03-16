import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findAccountByContractId,
  loadConfig,
  resolveAccount,
  resolveNetwork,
} from "../../src/config.js";

function writeConfig(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "walleterm-config-unit-"));
  const path = join(root, "walleterm.toml");
  writeFileSync(path, contents, "utf8");
  return path;
}

const BASE_CONFIG = `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"
`;

describe("config unit", () => {
  it("loads a valid config and resolves network/account defaults", () => {
    const config = loadConfig(writeConfig(BASE_CONFIG));
    const network = resolveNetwork(config);
    const account = resolveAccount(config, "testnet");

    expect(network.name).toBe("testnet");
    expect(account?.alias).toBe("a");
    expect(findAccountByContractId(config, "testnet", "CTESTACCOUNTA")?.alias).toBe("a");
    expect(findAccountByContractId(config, "testnet", "CNOTFOUND")).toBeNull();
  });

  it("throws when top-level tables are not TOML objects", () => {
    expect(() => loadConfig(writeConfig(`app = 1\nnetworks = 1\nsmart_accounts = 1\n`))).toThrow(
      /must be a table\/object/i,
    );
  });

  it("throws when app.default_network is missing", () => {
    const cfg = BASE_CONFIG.replace('default_network = "testnet"\n', "");
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/app\.default_network is required/i);
  });

  it("throws when default network is not declared", () => {
    const cfg = BASE_CONFIG.replace('default_network = "testnet"', 'default_network = "mainnet"');
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/default network 'mainnet' is not defined/i);
  });

  it("throws when a network is missing rpc_url", () => {
    const cfg = BASE_CONFIG.replace('rpc_url = "https://example.test/rpc"\n', "");
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/networks\.testnet\.rpc_url is required/i);
  });

  it("throws when a network is missing network_passphrase", () => {
    const cfg = BASE_CONFIG.replace(
      'network_passphrase = "Test SDF Network ; September 2015"\n',
      "",
    );
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      /networks\.testnet\.network_passphrase is required/i,
    );
  });

  it("throws when a smart account is missing required fields", () => {
    const missingNetwork = `[app]
default_network = "testnet"
[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"
[smart_accounts.a]
contract_id = "CTESTACCOUNTA"
`;
    expect(() => loadConfig(writeConfig(missingNetwork))).toThrow(
      /smart_accounts\.a\.network is required/i,
    );

    const missingContract = `[app]
default_network = "testnet"
[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"
[smart_accounts.a]
network = "testnet"
`;
    expect(() => loadConfig(writeConfig(missingContract))).toThrow(
      /smart_accounts\.a\.contract_id is required/i,
    );
  });

  it("throws when a smart account points to an unknown network", () => {
    const cfg = `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "mainnet"
contract_id = "CTESTACCOUNTA"
`;
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      /smart_accounts\.a\.network 'mainnet' is not configured/i,
    );
  });

  it("resolveNetwork and resolveAccount validate explicit selections", () => {
    const cfg = `${BASE_CONFIG}
[smart_accounts.b]
network = "mainnet"
contract_id = "CTESTACCOUNTB"

[networks.mainnet]
rpc_url = "https://example.main/rpc"
network_passphrase = "Public Global Stellar Network ; September 2015"
`;
    const config = loadConfig(writeConfig(cfg));

    expect(() => resolveNetwork(config, "unknown")).toThrow(/Network 'unknown' not found/i);
    expect(() => resolveAccount(config, "testnet", "missing")).toThrow(
      /Smart account 'missing' not found/i,
    );
    expect(() => resolveAccount(config, "testnet", "b")).toThrow(
      /belongs to network 'mainnet', not 'testnet'/i,
    );
    expect(resolveAccount(config, "testnet")?.alias).toBe("a");
    expect(resolveAccount(config, "mainnet")?.alias).toBe("b");
  });

  it("resolveAccount returns null when multiple accounts exist for network", () => {
    const cfg = `${BASE_CONFIG}
[smart_accounts.b]
network = "testnet"
contract_id = "CTESTACCOUNTB"
`;
    const config = loadConfig(writeConfig(cfg));
    expect(resolveAccount(config, "testnet")).toBeNull();
  });

  it("validates signer arrays and normalizes enabled defaults", () => {
    const badExternal = `${BASE_CONFIG}
external_signers = "not-array"
`;
    expect(() => loadConfig(writeConfig(badExternal))).toThrow(/Expected array value in config/i);

    const badDelegated = `${BASE_CONFIG}
delegated_signers = "not-array"
`;
    expect(() => loadConfig(writeConfig(badDelegated))).toThrow(/Expected array value in config/i);

    const cfg = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"

[[smart_accounts.a.external_signers]]
name = "ext"
verifier_contract_id = "CVERIFIER"
public_key_hex = "AABB"
secret_ref = "op://v/i/ext"

[[smart_accounts.a.delegated_signers]]
name = "del"
address = "GDELEGATED"
secret_ref = "op://v/i/del"
`;
    const config = loadConfig(writeConfig(cfg));
    expect(config.app.strict_onchain).toBe(true);
    expect(config.app.default_submit_mode).toBe("sign-only");
    expect(config.smart_accounts.a?.external_signers?.[0]?.enabled).toBe(true);
    expect(config.smart_accounts.a?.delegated_signers?.[0]?.enabled).toBe(true);
    expect(config.smart_accounts.a?.external_signers?.[0]?.public_key_hex).toBe("aabb");
    expect(config.smart_accounts.a?.external_signers?.[0]?.name).toBe("ext");
    expect(config.smart_accounts.a?.delegated_signers?.[0]?.name).toBe("del");

    const sparseCfg = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"

[[smart_accounts.a.external_signers]]
enabled = true

[[smart_accounts.a.delegated_signers]]
enabled = true
`;
    const sparse = loadConfig(writeConfig(sparseCfg));
    expect(sparse.smart_accounts.a?.external_signers?.[0]).toMatchObject({
      name: "",
      verifier_contract_id: "",
      public_key_hex: "",
      secret_ref: "",
      enabled: true,
    });
    expect(sparse.smart_accounts.a?.delegated_signers?.[0]).toMatchObject({
      name: "",
      address: "",
      secret_ref: "",
      enabled: true,
    });
  });

  it("rejects invalid onchain_signer_mode", () => {
    const cfg = BASE_CONFIG.replace(
      'onchain_signer_mode = "subset"',
      'onchain_signer_mode = "all"',
    );
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/app\.onchain_signer_mode must be one of/i);
  });

  it("rejects invalid default_submit_mode", () => {
    const cfg = `[app]
default_network = "testnet"
default_submit_mode = "broadcast"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"
`;
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/app\.default_submit_mode must be one of/i);
  });

  it("rejects NaN default_ttl_seconds", () => {
    const cfg = BASE_CONFIG.replace("default_ttl_seconds = 30", 'default_ttl_seconds = "abc"');
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      /app\.default_ttl_seconds must be a valid number/i,
    );
  });

  it("warns on non-HTTPS URLs (not localhost)", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "http://remote-server.example.com/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"
`;
    loadConfig(writeConfig(cfg));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("non-HTTPS URL"));
    stderrSpy.mockRestore();
  });

  it("does not warn on localhost HTTP URLs", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "http://localhost:8000/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"
`;
    loadConfig(writeConfig(cfg));
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining("non-HTTPS URL"));
    stderrSpy.mockRestore();
  });

  it("loads x402 config section when present", () => {
    const cfg = `${BASE_CONFIG}
[x402]
default_payer_secret_ref = "op://Private/testnet/payer_seed"
`;
    const config = loadConfig(writeConfig(cfg));
    expect(config.x402?.default_payer_secret_ref).toBe("op://Private/testnet/payer_seed");
  });

  it("loads config without x402 section", () => {
    const config = loadConfig(writeConfig(BASE_CONFIG));
    expect(config.x402).toBeUndefined();
  });

  it("loads x402 section with no default_payer_secret_ref", () => {
    const cfg = `${BASE_CONFIG}
[x402]
`;
    const config = loadConfig(writeConfig(cfg));
    expect(config.x402).toBeDefined();
    expect(config.x402?.default_payer_secret_ref).toBeUndefined();
  });

  it("throws when x402 section is not a table", () => {
    const cfg = `x402 = "not-a-table"

[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts]
`;
    expect(() => loadConfig(writeConfig(cfg))).toThrow(/must be a table\/object/i);
  });

  it("loads x402_facilitator_url in network config", () => {
    const cfg = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"
x402_facilitator_url = "https://facilitator.example.com"

[smart_accounts]
`;
    const config = loadConfig(writeConfig(cfg));
    expect(config.networks.testnet?.x402_facilitator_url).toBe("https://facilitator.example.com");
  });
});
