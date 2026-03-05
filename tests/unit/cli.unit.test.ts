import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({
  mockCanSignInput: vi.fn(),
  mockComputeExpirationLedger: vi.fn(),
  mockInspectInput: vi.fn(),
  mockListSignerConfig: vi.fn(),
  mockLoadRuntimeSigners: vi.fn(),
  mockParseInputFile: vi.fn(),
  mockResolveAccountForCommand: vi.fn(),
  mockSignInput: vi.fn(),
  mockVerifySignerSecrets: vi.fn(),
  mockWriteOutput: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockResolveNetwork: vi.fn(),
  mockDefaultItemForNetwork: vi.fn(),
  mockSetupOnePasswordForWallet: vi.fn(),
  mockSubmitTxXdrViaRpc: vi.fn(),
  mockSubmitViaChannels: vi.fn(),
  mockBuildSignerMutationBundle: vi.fn(),
  mockCreateWalletDeployTx: vi.fn(),
  mockDeriveSaltHexFromRawString: vi.fn(),
  mockDiscoverContractsByAddress: vi.fn(),
  mockListContractSigners: vi.fn(),
  mockMakeDelegatedSignerScVal: vi.fn(),
  mockMakeExternalSignerScVal: vi.fn(),
  mockResolveIndexerUrl: vi.fn(),
  mockSmartAccountKitDeployerKeypair: vi.fn(),
  mockSecretResolve: vi.fn(),
}));

const {
  mockCanSignInput,
  mockComputeExpirationLedger,
  mockInspectInput,
  mockListSignerConfig,
  mockLoadRuntimeSigners,
  mockParseInputFile,
  mockResolveAccountForCommand,
  mockSignInput,
  mockVerifySignerSecrets,
  mockLoadConfig,
  mockResolveNetwork,
  mockDefaultItemForNetwork,
  mockSetupOnePasswordForWallet,
  mockSubmitTxXdrViaRpc,
  mockSubmitViaChannels,
  mockBuildSignerMutationBundle,
  mockCreateWalletDeployTx,
  mockDeriveSaltHexFromRawString,
  mockDiscoverContractsByAddress,
  mockListContractSigners,
  mockMakeDelegatedSignerScVal,
  mockMakeExternalSignerScVal,
  mockResolveIndexerUrl,
  mockSmartAccountKitDeployerKeypair,
  mockSecretResolve,
} = mocks;

vi.mock("../../src/core.js", () => ({
  canSignInput: mocks.mockCanSignInput,
  computeExpirationLedger: mocks.mockComputeExpirationLedger,
  inspectInput: mocks.mockInspectInput,
  listSignerConfig: mocks.mockListSignerConfig,
  loadRuntimeSigners: mocks.mockLoadRuntimeSigners,
  parseInputFile: mocks.mockParseInputFile,
  resolveAccountForCommand: mocks.mockResolveAccountForCommand,
  signInput: mocks.mockSignInput,
  verifySignerSecrets: mocks.mockVerifySignerSecrets,
  writeOutput: mocks.mockWriteOutput,
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: mocks.mockLoadConfig,
  resolveNetwork: mocks.mockResolveNetwork,
}));

vi.mock("../../src/op-setup.js", () => ({
  defaultItemForNetwork: mocks.mockDefaultItemForNetwork,
  setupOnePasswordForWallet: mocks.mockSetupOnePasswordForWallet,
}));

vi.mock("../../src/submit.js", () => ({
  submitTxXdrViaRpc: mocks.mockSubmitTxXdrViaRpc,
  submitViaChannels: mocks.mockSubmitViaChannels,
}));

vi.mock("../../src/wallet.js", () => ({
  buildSignerMutationBundle: mocks.mockBuildSignerMutationBundle,
  createWalletDeployTx: mocks.mockCreateWalletDeployTx,
  deriveSaltHexFromRawString: mocks.mockDeriveSaltHexFromRawString,
  discoverContractsByAddress: mocks.mockDiscoverContractsByAddress,
  listContractSigners: mocks.mockListContractSigners,
  makeDelegatedSignerScVal: mocks.mockMakeDelegatedSignerScVal,
  makeExternalSignerScVal: mocks.mockMakeExternalSignerScVal,
  resolveIndexerUrl: mocks.mockResolveIndexerUrl,
  smartAccountKitDeployerKeypair: mocks.mockSmartAccountKitDeployerKeypair,
}));

vi.mock("../../src/secrets.js", () => {
  class SecretResolver {
    async resolve(ref: string): Promise<string> {
      return mocks.mockSecretResolve(ref);
    }
  }
  return { SecretResolver };
});

import { __testOnly, runCli } from "../../src/cli.js";

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;
  process.exitCode = 0;

  process.stdout.write = ((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    await runCli(["bun", "walleterm", ...args]);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = originalExitCode;

  if (exitCode !== 0) {
    const err = new Error(stderr.trim() || `CLI exited with code ${exitCode}`) as Error & {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };
    err.stdout = stdout;
    err.stderr = stderr;
    err.exitCode = exitCode;
    throw err;
  }

  return { stdout, stderr };
}

const WASM_HASH = "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e";
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

beforeEach(() => {
  vi.clearAllMocks();

  const deployer = Keypair.random();

  mockLoadConfig.mockReturnValue({
    app: {
      default_network: "testnet",
      default_ttl_seconds: 30,
      assumed_ledger_time_seconds: 6,
    },
    networks: {
      testnet: {
        rpc_url: "https://rpc.invalid",
        network_passphrase: Networks.TESTNET,
      },
    },
    smart_accounts: {
      treasury: {
        network: "testnet",
        contract_id: CONTRACT_ID,
        external_signers: [],
        delegated_signers: [],
      },
    },
  });

  mockResolveNetwork.mockImplementation((config: any, explicit?: string) => {
    const name = explicit ?? "testnet";
    return { name, config: config.networks[name] };
  });

  mockResolveAccountForCommand.mockReturnValue({
    alias: "treasury",
    account: {
      network: "testnet",
      contract_id: CONTRACT_ID,
      external_signers: [],
      delegated_signers: [],
    },
  });

  mockLoadRuntimeSigners.mockResolvedValue({
    external: [],
    delegated: [],
    externalByComposite: new Map(),
    delegatedByAddress: new Map(),
    byAddress: new Map(),
    allKeypairs: [],
  });

  mockComputeExpirationLedger.mockResolvedValue(999);
  mockSignInput.mockReturnValue({
    output: JSON.stringify({ auth: [] }),
    report: { kind: "bundle", summary: { signed: 1, skipped: 0 }, details: [] },
  });
  mockParseInputFile.mockReturnValue({ kind: "bundle", auth: [] });
  mockInspectInput.mockReturnValue({ kind: "tx" });
  mockCanSignInput.mockReturnValue({ kind: "bundle", signableAuthEntries: 0 });
  mockVerifySignerSecrets.mockResolvedValue({ ok: true, verified: 2 });
  mockListSignerConfig.mockReturnValue({ account: "treasury", external: [], delegated: [] });

  mockDefaultItemForNetwork.mockReturnValue("walleterm-testnet");
  mockSetupOnePasswordForWallet.mockResolvedValue({
    vault: "Private",
    item: "walleterm-testnet",
    network: "testnet",
    op_bin: "op",
    created_vault: false,
    created_item: true,
    deployer_seed_stored: false,
    deployer_public_key: Keypair.random().publicKey(),
    delegated_public_key: Keypair.random().publicKey(),
    refs: {
      delegated_seed_ref: "op://Private/walleterm-testnet/delegated_seed",
      channels_api_key_ref: "op://Private/walleterm-testnet/channels_api_key",
    },
    config_snippet: "[networks.testnet]",
  });

  mockSubmitTxXdrViaRpc.mockResolvedValue({ hash: "txhash" });
  mockSubmitViaChannels.mockResolvedValue({ mode: "channels", ok: true });

  mockMakeDelegatedSignerScVal.mockReturnValue({ type: "delegated-scv" });
  mockMakeExternalSignerScVal.mockReturnValue({ type: "external-scv" });
  mockBuildSignerMutationBundle.mockReturnValue({ kind: "bundle", auth: [] });
  mockResolveIndexerUrl.mockReturnValue("https://indexer.invalid");
  mockDiscoverContractsByAddress.mockResolvedValue({ count: 0, contracts: [] });
  mockListContractSigners.mockResolvedValue({ contractId: CONTRACT_ID, signers: [] });
  mockCreateWalletDeployTx.mockResolvedValue({
    contractId: CONTRACT_ID,
    txXdr: "AAAA",
    saltHex: "00".repeat(32),
  });
  mockDeriveSaltHexFromRawString.mockReturnValue("11".repeat(32));
  mockSmartAccountKitDeployerKeypair.mockReturnValue(deployer);

  mockSecretResolve.mockResolvedValue(Keypair.random().secret());
});

describe("cli unit", () => {
  it("covers helper validations and submit overrides", () => {
    expect(__testOnly.parseOptionalInt(undefined)).toBeUndefined();
    expect(__testOnly.parseOptionalInt("42")).toBe(42);
    expect(() => __testOnly.parseOptionalInt("NaN")).toThrow(/Invalid integer value/i);

    expect(__testOnly.requireAccountAlias("treasury")).toBe("treasury");
    expect(() => __testOnly.requireAccountAlias(undefined)).toThrow(/Pass --account/i);

    expect(__testOnly.requireNonNegativeInt(0, "x")).toBe(0);
    expect(() => __testOnly.requireNonNegativeInt(-1, "x")).toThrow(/non-negative integer/i);

    expect(
      __testOnly.getSubmitOverrides({
        channelsBaseUrl: "https://channels",
        channelsApiKey: "k",
        channelsApiKeyRef: "op://v/i/key",
        pluginId: "p",
      }),
    ).toEqual({
      channelsBaseUrl: "https://channels",
      channelsApiKey: "k",
      channelsApiKeyRef: "op://v/i/key",
      pluginId: "p",
    });
  });

  it("runs inspect command", async () => {
    mockParseInputFile.mockReturnValue({ kind: "tx", envelope: { toXDR: () => "AAA" } });
    mockInspectInput.mockReturnValue({ kind: "tx", operations: 1 });

    const res = await run(["inspect", "--in", "in.txt"]);
    expect(JSON.parse(res.stdout)).toMatchObject({ kind: "tx", operations: 1 });
  });

  it("runCli stringifies non-Error parse failures", async () => {
    vi.spyOn(Command.prototype, "parseAsync").mockRejectedValueOnce("plain-failure");
    await expect(run(["inspect", "--in", "in.txt"])).rejects.toThrow(/plain-failure/i);
  });

  it("sign command errors when account cannot be resolved", async () => {
    mockParseInputFile.mockReturnValue({ kind: "auth", auth: [] });
    mockResolveAccountForCommand.mockReturnValue(null);

    await expect(
      run(["sign", "--in", "in.txt", "--out", "out.txt", "--ttl-seconds", "30"]),
    ).rejects.toThrow(/No smart account selected/i);
  });

  it("submit rpc rejects non-tx input and succeeds for tx input", async () => {
    mockParseInputFile.mockReturnValueOnce({ kind: "bundle", auth: [] });
    await expect(run(["submit", "--in", "in.json", "--mode", "rpc"])).rejects.toThrow(
      /RPC submission currently supports signed tx envelope input only/i,
    );

    mockParseInputFile.mockReturnValueOnce({
      kind: "tx",
      envelope: { toXDR: () => "AAAA" },
    });
    const ok = await run(["submit", "--in", "in.xdr", "--mode", "rpc"]);
    expect(JSON.parse(ok.stdout)).toMatchObject({ mode: "rpc", request_kind: "tx" });
  });

  it("submit defaults to channels mode when --mode is omitted", async () => {
    mockParseInputFile.mockReturnValueOnce({ kind: "bundle", auth: [] });
    await run(["submit", "--in", "in.json"]);
    expect(mockSubmitViaChannels).toHaveBeenCalledTimes(1);
  });

  it("setup op prints warning and verbose output without --json", async () => {
    mockSetupOnePasswordForWallet.mockResolvedValue({
      vault: "Private",
      item: "walleterm-testnet",
      network: "testnet",
      op_bin: "op",
      created_vault: false,
      created_item: false,
      deployer_seed_stored: true,
      deployer_public_key: Keypair.random().publicKey(),
      delegated_public_key: Keypair.random().publicKey(),
      refs: {
        deployer_seed_ref: "op://Private/walleterm-testnet/deployer_seed",
        delegated_seed_ref: "op://Private/walleterm-testnet/delegated_seed",
        channels_api_key_ref: "op://Private/walleterm-testnet/channels_api_key",
      },
      config_snippet: "[networks.testnet]",
    });

    const res = await run(["setup", "op", "--network", "testnet", "--force"]);
    expect(mockDefaultItemForNetwork).toHaveBeenCalledWith("testnet");
    expect(res.stderr).toContain("warning: item 'walleterm-testnet' already exists");
    expect(res.stderr).toContain("1Password wallet bootstrap complete.");
    expect(JSON.parse(res.stdout).created_item).toBe(false);
  });

  it("setup op verbose output shows '(not stored)' when deployer ref is absent", async () => {
    mockSetupOnePasswordForWallet.mockResolvedValueOnce({
      vault: "Private",
      item: "walleterm-testnet",
      network: "testnet",
      op_bin: "op",
      created_vault: false,
      created_item: true,
      deployer_seed_stored: false,
      deployer_public_key: Keypair.random().publicKey(),
      delegated_public_key: Keypair.random().publicKey(),
      refs: {
        delegated_seed_ref: "op://Private/walleterm-testnet/delegated_seed",
        channels_api_key_ref: "op://Private/walleterm-testnet/channels_api_key",
      },
      config_snippet: "[networks.testnet]",
    });
    const out = await run(["setup", "op"]);
    expect(out.stderr).toContain("(not stored)");
  });

  it("setup op passes includeDeployerSeed=true when flag is provided", async () => {
    await run(["setup", "op", "--include-deployer-seed", "--json"]);
    expect(mockSetupOnePasswordForWallet).toHaveBeenCalledWith(
      expect.objectContaining({ includeDeployerSeed: true }),
    );
  });

  it("keys list command outputs signer config", async () => {
    mockListSignerConfig.mockReturnValue({
      account: "treasury",
      external: [{ name: "ext" }],
      delegated: [{ name: "del" }],
    });

    const res = await run(["keys", "list", "--account", "treasury"]);
    expect(JSON.parse(res.stdout)).toMatchObject({ account: "treasury" });
  });

  it("keys commands fail when account alias is missing in config", async () => {
    mockLoadConfig.mockReturnValue({
      app: { default_network: "testnet", default_ttl_seconds: 30, assumed_ledger_time_seconds: 6 },
      networks: {
        testnet: { rpc_url: "https://rpc.invalid", network_passphrase: Networks.TESTNET },
      },
      smart_accounts: {},
    });

    await expect(run(["keys", "list", "--account", "treasury"])).rejects.toThrow(
      /Smart account 'treasury' not found/i,
    );
    await expect(run(["keys", "verify", "--account", "treasury"])).rejects.toThrow(
      /Smart account 'treasury' not found/i,
    );
  });

  it("wallet reconcile computes local/onchain deltas", async () => {
    mockListSignerConfig.mockReturnValue({
      account: "treasury",
      delegated: [{ name: "del", address: "GDEL", secret_ref: "op://d" }],
      external: [
        {
          name: "ext",
          verifier_contract_id: "CVER",
          public_key_hex: "aa",
          secret_ref: "op://e",
        },
      ],
    });
    mockListContractSigners.mockResolvedValue({
      contractId: CONTRACT_ID,
      signers: [
        { signer_type: "Delegated", signer_address: "GDEL" },
        { signer_type: "External", signer_address: "CVER", credential_id: "aa" },
        { signer_type: "Delegated", signer_address: "GONCHAIN" },
      ],
    });

    const res = await run(["wallet", "reconcile", "--account", "treasury"]);
    const out = JSON.parse(res.stdout);
    expect(out.matched).toContain("Delegated|GDEL");
    expect(out.only_onchain).toContain("Delegated|GONCHAIN");
  });

  it("wallet reconcile ignores incomplete external signer rows from indexer", async () => {
    mockListSignerConfig.mockReturnValue({
      account: "treasury",
      delegated: [],
      external: [
        {
          name: "ext",
          verifier_contract_id: "CVER",
          public_key_hex: "aa",
          secret_ref: "op://e",
        },
      ],
    });
    mockListContractSigners.mockResolvedValue({
      contractId: CONTRACT_ID,
      signers: [{ signer_type: "External", signer_address: "CVER", credential_id: null }],
    });

    const res = await run(["wallet", "reconcile", "--account", "treasury"]);
    const out = JSON.parse(res.stdout);
    expect(out.only_local).toContain("External|CVER|aa");
    expect(out.matched).not.toContain("External|CVER|aa");
  });

  it("wallet reconcile fails when account is absent", async () => {
    mockLoadConfig.mockReturnValue({
      app: { default_network: "testnet", default_ttl_seconds: 30, assumed_ledger_time_seconds: 6 },
      networks: {
        testnet: { rpc_url: "https://rpc.invalid", network_passphrase: Networks.TESTNET },
      },
      smart_accounts: {},
    });
    await expect(run(["wallet", "reconcile", "--account", "treasury"])).rejects.toThrow(
      /Smart account 'treasury' not found/i,
    );
  });

  it("wallet reconcile and signer mutation enforce account/network constraints", async () => {
    mockLoadConfig.mockReturnValue({
      app: { default_network: "testnet", default_ttl_seconds: 30, assumed_ledger_time_seconds: 6 },
      networks: {
        testnet: { rpc_url: "https://rpc.invalid", network_passphrase: Networks.TESTNET },
      },
      smart_accounts: {
        treasury: {
          network: "mainnet",
          contract_id: CONTRACT_ID,
          external_signers: [],
          delegated_signers: [],
        },
      },
    });

    await expect(run(["wallet", "reconcile", "--account", "treasury"])).rejects.toThrow(
      /belongs to network 'mainnet', not 'testnet'/i,
    );

    await expect(
      run([
        "wallet",
        "add-delegated-signer",
        "--account",
        "treasury",
        "--context-rule-id",
        "0",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/belongs to network 'mainnet', not 'testnet'/i);
  });

  it("signer mutation fails when account alias is not found", async () => {
    mockLoadConfig.mockReturnValue({
      app: { default_network: "testnet", default_ttl_seconds: 30, assumed_ledger_time_seconds: 6 },
      networks: {
        testnet: { rpc_url: "https://rpc.invalid", network_passphrase: Networks.TESTNET },
      },
      smart_accounts: {},
    });

    await expect(
      run([
        "wallet",
        "add-delegated-signer",
        "--account",
        "missing",
        "--context-rule-id",
        "0",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/Smart account 'missing' not found/i);
  });

  it("runs remove signer commands", async () => {
    await run([
      "wallet",
      "remove-delegated-signer",
      "--account",
      "treasury",
      "--context-rule-id",
      "0",
      "--delegated-address",
      Keypair.random().publicKey(),
      "--out",
      "out.json",
      "--latest-ledger",
      "100",
    ]);

    const ext = Keypair.random();
    await run([
      "wallet",
      "remove-external-ed25519-signer",
      "--account",
      "treasury",
      "--context-rule-id",
      "0",
      "--verifier-contract-id",
      CONTRACT_ID,
      "--public-key-hex",
      Buffer.from(ext.rawPublicKey()).toString("hex"),
      "--out",
      "out.json",
      "--latest-ledger",
      "100",
    ]);

    expect(mockBuildSignerMutationBundle).toHaveBeenCalledTimes(2);
  });

  it("uses ttl/ledger hard defaults when app defaults are absent", async () => {
    mockLoadConfig.mockReturnValue({
      app: { default_network: "testnet" },
      networks: {
        testnet: { rpc_url: "https://rpc.invalid", network_passphrase: Networks.TESTNET },
      },
      smart_accounts: {
        treasury: {
          network: "testnet",
          contract_id: CONTRACT_ID,
          external_signers: [],
          delegated_signers: [],
        },
      },
    });

    mockParseInputFile.mockReturnValue({ kind: "auth", auth: [] });
    mockResolveAccountForCommand.mockReturnValue({
      alias: "treasury",
      account: {
        network: "testnet",
        contract_id: CONTRACT_ID,
        external_signers: [],
        delegated_signers: [],
      },
    });

    await run(["sign", "--in", "in.xdr", "--out", "out.xdr"]);
    expect(mockComputeExpirationLedger).toHaveBeenCalledWith(expect.any(Object), 30, 6, undefined);

    await run([
      "wallet",
      "remove-delegated-signer",
      "--account",
      "treasury",
      "--context-rule-id",
      "0",
      "--delegated-address",
      Keypair.random().publicKey(),
      "--out",
      "out.json",
    ]);
    expect(mockComputeExpirationLedger).toHaveBeenLastCalledWith(
      expect.any(Object),
      30,
      6,
      undefined,
    );
  });

  it("wallet create validates incompatible options and invalid signer tuples", async () => {
    await expect(
      run([
        "wallet",
        "create",
        "--kit-raw-id",
        "raw-id",
        "--deployer-secret-ref",
        "op://v/i/s",
        "--wasm-hash",
        WASM_HASH,
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.xdr",
      ]),
    ).rejects.toThrow(/Do not pass --deployer-secret-ref with --kit-raw-id/i);

    await expect(
      run([
        "wallet",
        "create",
        "--kit-raw-id",
        "raw-id",
        "--salt-hex",
        "11".repeat(32),
        "--wasm-hash",
        WASM_HASH,
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.xdr",
      ]),
    ).rejects.toThrow(/Do not pass --salt-hex with --kit-raw-id/i);

    await expect(
      run([
        "wallet",
        "create",
        "--wasm-hash",
        WASM_HASH,
        "--delegated-address",
        Keypair.random().publicKey(),
        "--external-ed25519",
        "invalid",
        "--out",
        "out.xdr",
      ]),
    ).rejects.toThrow(/Invalid --external-ed25519 value/i);
  });

  it("wallet create rejects invalid deployer secret and supports submit-mode rpc", async () => {
    mockSecretResolve.mockResolvedValueOnce("not-a-seed");

    await expect(
      run([
        "wallet",
        "create",
        "--deployer-secret-ref",
        "op://v/i/deployer",
        "--wasm-hash",
        WASM_HASH,
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.xdr",
      ]),
    ).rejects.toThrow(/deployer secret must resolve to a valid Stellar secret seed/i);

    mockSecretResolve.mockResolvedValue(Keypair.random().secret());
    const out = await run([
      "wallet",
      "create",
      "--deployer-secret-ref",
      "op://v/i/deployer",
      "--wasm-hash",
      WASM_HASH,
      "--delegated-address",
      Keypair.random().publicKey(),
      "--out",
      "out.xdr",
      "--submit",
      "--submit-mode",
      "rpc",
    ]);

    expect(JSON.parse(out.stdout)).toMatchObject({ submitted: true });
    expect(mockSubmitTxXdrViaRpc).toHaveBeenCalled();
  });

  it("wallet create accepts valid external-ed25519 tuples and defaults submit mode to channels", async () => {
    const ext = Keypair.random();
    const out = await run([
      "wallet",
      "create",
      "--wasm-hash",
      WASM_HASH,
      "--delegated-address",
      Keypair.random().publicKey(),
      "--external-ed25519",
      `${CONTRACT_ID}:${Buffer.from(ext.rawPublicKey()).toString("hex")}`,
      "--out",
      "out.xdr",
      "--submit",
    ]);

    expect(mockMakeExternalSignerScVal).toHaveBeenCalledTimes(1);
    expect(mockSubmitViaChannels).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ submitted: true });
  });
});
