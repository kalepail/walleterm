import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../helpers/temp-dir.js";
import {
  findAccountByContractId,
  loadConfig,
  resolveAccount,
  resolveNetwork,
} from "../../src/config.js";

function writeConfig(contents: string): string {
  const root = makeTempDir("walleterm-config-unit-");
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

  it("rejects NaN assumed_ledger_time_seconds", () => {
    const cfg = BASE_CONFIG.replace(
      "assumed_ledger_time_seconds = 6",
      'assumed_ledger_time_seconds = "abc"',
    );
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      /app\.assumed_ledger_time_seconds must be a valid number/i,
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

  it("does not warn when an http URL is malformed", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "http://["
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"
`;
    loadConfig(writeConfig(cfg));
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining("non-HTTPS URL"));
    stderrSpy.mockRestore();
  });

  it("rejects the removed top-level x402 config section", () => {
    const cfg = `${BASE_CONFIG}
[x402]
default_payer_secret_ref = "op://Private/testnet/payer_seed"
`;
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      /Top-level \[x402\] is no longer supported/i,
    );
  });

  it("loads config without payments.x402 section", () => {
    const config = loadConfig(writeConfig(BASE_CONFIG));
    expect(config.payments?.x402).toBeUndefined();
  });

  it("rejects invalid payments.x402.max_payment_amount values", () => {
    const cfg = `${BASE_CONFIG}
[payments.x402]
max_payment_amount = "-1"
`;
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      /payments\.x402\.max_payment_amount must be a valid non-negative/i,
    );

    const nanCfg = `${BASE_CONFIG}
[payments.x402]
max_payment_amount = "nope"
`;
    expect(() => loadConfig(writeConfig(nanCfg))).toThrow(
      /payments\.x402\.max_payment_amount must be a valid non-negative/i,
    );
  });

  it("accepts valid non-negative payments.x402.max_payment_amount values", () => {
    const cfg = `${BASE_CONFIG}
[payments.x402]
max_payment_amount = "0"
`;
    const config = loadConfig(writeConfig(cfg));
    expect(config.payments?.x402?.max_payment_amount).toBe("0");
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
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      /Top-level \[x402\] is no longer supported/i,
    );
  });

  it("loads payments config section when present", () => {
    const cfg = `${BASE_CONFIG}
[payments]
default_protocol = "mpp"

[payments.mpp]
default_intent = "channel"
default_payer_secret_ref = "keychain://walleterm-testnet/mpp_seed"
max_payment_amount = "1000"

[payments.mpp.channel]
source_account = "GCHANNELSOURCE"

[payments.x402]
default_payer_secret_ref = "op://Private/testnet/payer_seed"
max_payment_amount = "0.5"
default_scheme = "auto"

[payments.x402.channel]
state_file = ".x402-channels.json"
default_deposit = "1000000"
max_deposit_amount = "5000000"
commitment_secret_ref = "keychain://walleterm-testnet/channel_seed"
`;
    const config = loadConfig(writeConfig(cfg));
    expect(config.payments?.default_protocol).toBe("mpp");
    expect(config.payments?.mpp?.default_intent).toBe("channel");
    expect(config.payments?.mpp?.default_payer_secret_ref).toBe(
      "keychain://walleterm-testnet/mpp_seed",
    );
    expect(config.payments?.mpp?.channel?.source_account).toBe("GCHANNELSOURCE");
    expect(config.payments?.x402?.default_payer_secret_ref).toBe("op://Private/testnet/payer_seed");
    expect(config.payments?.x402?.default_scheme).toBe("auto");
    expect(config.payments?.x402?.channel).toMatchObject({
      state_file: ".x402-channels.json",
      default_deposit: "1000000",
      max_deposit_amount: "5000000",
      commitment_secret_ref: "keychain://walleterm-testnet/channel_seed",
    });
  });

  it("loads extended payments.mpp.channel config fields", () => {
    const cfg = `${BASE_CONFIG}
[payments]
default_protocol = "mpp"

[payments.mpp]
default_intent = "channel"

[payments.mpp.channel]
default_channel_contract_id = "CCHANNEL"
default_deposit = "10000000"
factory_contract_id = "CFACTORY"
token_contract_id = "CTOKEN"
recipient = "GRECIPIENT"
recipient_secret_ref = "keychain://walleterm-testnet/recipient_seed"
refund_waiting_period = 24
state_file = ".channels.json"
source_account = "GSOURCE"
`;
    const config = loadConfig(writeConfig(cfg));
    expect(config.payments?.mpp?.channel?.default_channel_contract_id).toBe("CCHANNEL");
    expect(config.payments?.mpp?.channel?.default_deposit).toBe("10000000");
    expect(config.payments?.mpp?.channel?.factory_contract_id).toBe("CFACTORY");
    expect(config.payments?.mpp?.channel?.token_contract_id).toBe("CTOKEN");
    expect(config.payments?.mpp?.channel?.recipient).toBe("GRECIPIENT");
    expect(config.payments?.mpp?.channel?.recipient_secret_ref).toBe(
      "keychain://walleterm-testnet/recipient_seed",
    );
    expect(config.payments?.mpp?.channel?.refund_waiting_period).toBe(24);
    expect(config.payments?.mpp?.channel?.state_file).toBe(".channels.json");
  });

  it("rejects invalid payments defaults", () => {
    const badProtocol = `${BASE_CONFIG}
[payments]
default_protocol = "nope"
`;
    expect(() => loadConfig(writeConfig(badProtocol))).toThrow(/payments\.default_protocol/i);

    const badIntent = `${BASE_CONFIG}
[payments]
default_protocol = "mpp"

[payments.mpp]
default_intent = "nope"
`;
    expect(() => loadConfig(writeConfig(badIntent))).toThrow(/payments\.mpp\.default_intent/i);
  });

  it("rejects invalid payments max payment amount values", () => {
    const badMpp = `${BASE_CONFIG}
[payments]
default_protocol = "mpp"

[payments.mpp]
max_payment_amount = "-1"
`;
    expect(() => loadConfig(writeConfig(badMpp))).toThrow(/payments\.mpp\.max_payment_amount/i);

    const badX402 = `${BASE_CONFIG}
[payments]
default_protocol = "x402"

[payments.x402]
max_payment_amount = "-1"
`;
    expect(() => loadConfig(writeConfig(badX402))).toThrow(/payments\.x402\.max_payment_amount/i);
  });

  it("rejects invalid x402 default schemes", () => {
    const badTopLevel = `${BASE_CONFIG}
[x402]
default_scheme = "nope"
`;
    expect(() => loadConfig(writeConfig(badTopLevel))).toThrow(
      /Top-level \[x402\] is no longer supported/i,
    );

    const badPayments = `${BASE_CONFIG}
[payments.x402]
default_scheme = "nope"
`;
    expect(() => loadConfig(writeConfig(badPayments))).toThrow(/payments\.x402\.default_scheme/i);
  });

  it("rejects invalid payments.x402.channel values", () => {
    const badDeposit = `${BASE_CONFIG}
[payments.x402.channel]
default_deposit = "-1"
`;
    expect(() => loadConfig(writeConfig(badDeposit))).toThrow(
      /payments\.x402\.channel\.default_deposit/i,
    );

    const badMaxDeposit = `${BASE_CONFIG}
[payments.x402.channel]
max_deposit_amount = "-1"
`;
    expect(() => loadConfig(writeConfig(badMaxDeposit))).toThrow(
      /payments\.x402\.channel\.max_deposit_amount/i,
    );

    const decimalDeposit = `${BASE_CONFIG}
[payments.x402.channel]
default_deposit = "1.5"
`;
    expect(() => loadConfig(writeConfig(decimalDeposit))).toThrow(
      /payments\.x402\.channel\.default_deposit/i,
    );

    const scientificMaxDeposit = `${BASE_CONFIG}
[payments.x402.channel]
max_deposit_amount = "1e6"
`;
    expect(() => loadConfig(writeConfig(scientificMaxDeposit))).toThrow(
      /payments\.x402\.channel\.max_deposit_amount/i,
    );
  });

  it("rejects invalid payments.mpp.channel values", () => {
    const badDeposit = `${BASE_CONFIG}
[payments]
default_protocol = "mpp"

[payments.mpp.channel]
default_deposit = "-1"
`;
    expect(() => loadConfig(writeConfig(badDeposit))).toThrow(
      /payments\.mpp\.channel\.default_deposit/i,
    );

    const badRefund = `${BASE_CONFIG}
[payments]
default_protocol = "mpp"

[payments.mpp.channel]
refund_waiting_period = -1
`;
    expect(() => loadConfig(writeConfig(badRefund))).toThrow(
      /payments\.mpp\.channel\.refund_waiting_period/i,
    );
  });

  it("coerces unexpected types in config fields via String() without crashing", () => {
    // When TOML parsing yields a number where a string is expected, loadConfig
    // calls String() which coerces it. Verify this produces technically valid
    // (but likely broken) configs rather than crashing.
    //
    // We cannot feed a raw number through TOML for rpc_url since TOML typing
    // enforces string values for table fields. Instead we test through the
    // normalizer functions by constructing TOML that exercises String() coercion
    // on fields that go through String().

    // rpc_url = 42 in TOML is an integer. This tests that the config loader
    // coerces it to the string "42" rather than throwing.
    const numericRpcUrl = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = 42
network_passphrase = true

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"
`;
    const config = loadConfig(writeConfig(numericRpcUrl));
    // String(42) -> "42"
    expect(config.networks.testnet?.rpc_url).toBe("42");
    // String(true) -> "true"
    expect(config.networks.testnet?.network_passphrase).toBe("true");
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

  it("rejects invalid expected_wasm_hash values", () => {
    const cfg = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"
expected_wasm_hash = "abcd"
`;
    expect(() => loadConfig(writeConfig(cfg))).toThrow(
      /smart_accounts\.a\.expected_wasm_hash must be a 32-byte hex string/i,
    );
  });

  it("warns on non-localhost x402_facilitator_url over HTTP", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"
x402_facilitator_url = "http://facilitator.example.com"

[smart_accounts.a]
network = "testnet"
contract_id = "CTESTACCOUNTA"
`;
    loadConfig(writeConfig(cfg));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("x402_facilitator_url"));
    stderrSpy.mockRestore();
  });
});
