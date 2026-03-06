import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
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
  mockWriteOutput: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockResolveNetwork: vi.fn(),
  mockDefaultItemForNetwork: vi.fn(),
  mockSetupOnePasswordForWallet: vi.fn(),
  mockSubmitTxXdrViaRpc: vi.fn(),
  mockSubmitViaChannels: vi.fn(),
  mockBuildSignerMutationBundle: vi.fn(),
  mockCreateWalletDeployTx: vi.fn(),
  mockDiscoverContractsByCredentialId: vi.fn(),
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
  mockLoadConfig,
  mockResolveNetwork,
  mockDefaultItemForNetwork,
  mockSetupOnePasswordForWallet,
  mockSubmitTxXdrViaRpc,
  mockSubmitViaChannels,
  mockBuildSignerMutationBundle,
  mockCreateWalletDeployTx,
  mockDiscoverContractsByCredentialId,
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
  discoverContractsByCredentialId: mocks.mockDiscoverContractsByCredentialId,
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

import { runCli } from "../../src/cli.js";

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
  mockDiscoverContractsByCredentialId.mockResolvedValue({ count: 0, contracts: [] });
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
  it("runs review command with signability details", async () => {
    mockParseInputFile.mockReturnValue({ kind: "bundle", auth: [] });
    mockInspectInput.mockReturnValue({ kind: "bundle", operations: 1 });
    mockCanSignInput.mockReturnValue({ kind: "bundle", signableAuthEntries: 2 });

    const res = await run(["review", "--in", "in.txt", "--account", "treasury"]);
    expect(JSON.parse(res.stdout)).toMatchObject({
      inspection: { kind: "bundle", operations: 1 },
      signability: { kind: "bundle", signableAuthEntries: 2 },
      account: "treasury",
      contract_id: CONTRACT_ID,
    });
  });

  it("review command falls back to inspection-only output when no account resolves", async () => {
    mockParseInputFile.mockReturnValue({ kind: "bundle", auth: [] });
    mockInspectInput.mockReturnValue({ kind: "bundle", operations: 1 });
    mockResolveAccountForCommand.mockReturnValue(null);

    const res = await run(["review", "--in", "in.txt"]);
    expect(JSON.parse(res.stdout)).toMatchObject({
      inspection: { kind: "bundle", operations: 1 },
      signability: null,
      account: null,
    });
  });

  it("runCli stringifies non-Error parse failures", async () => {
    vi.spyOn(Command.prototype, "parseAsync").mockRejectedValueOnce("plain-failure");
    await expect(run(["review", "--in", "in.txt"])).rejects.toThrow(/plain-failure/i);
  });

  it("sign command errors when account cannot be resolved", async () => {
    mockParseInputFile.mockReturnValue({ kind: "auth", auth: [] });
    mockResolveAccountForCommand.mockReturnValue(null);

    await expect(
      run(["sign", "--in", "in.txt", "--out", "out.txt", "--ttl-seconds", "30"]),
    ).rejects.toThrow(/No smart account selected/i);
  });

  it("sign rejects invalid integer flags", async () => {
    await expect(
      run(["sign", "--in", "in.txt", "--out", "out.txt", "--ttl-seconds", "NaN"]),
    ).rejects.toThrow(/Invalid integer value 'NaN'/i);
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

  it("submit forwards explicit channels overrides", async () => {
    mockParseInputFile.mockReturnValueOnce({ kind: "bundle", auth: [] });

    await run([
      "submit",
      "--in",
      "in.json",
      "--channels-base-url",
      "https://channels.example",
      "--channels-api-key",
      "api-key",
      "--channels-api-key-ref",
      "op://Private/item/channels_api_key",
      "--plugin-id",
      "plugin-123",
    ]);

    expect(mockSubmitViaChannels).toHaveBeenCalledWith(
      { kind: "bundle", auth: [] },
      expect.any(Object),
      expect.any(Object),
      {
        channelsBaseUrl: "https://channels.example",
        channelsApiKey: "api-key",
        channelsApiKeyRef: "op://Private/item/channels_api_key",
        pluginId: "plugin-123",
      },
    );
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

  it("wallet signer generate outputs a valid keypair", async () => {
    const res = await run(["wallet", "signer", "generate"]);
    const out = JSON.parse(res.stdout);
    const kp = Keypair.fromSecret(out.secret_seed);
    expect(out.public_key).toBe(kp.publicKey());
    expect(out.public_key_hex).toBe(Buffer.from(kp.rawPublicKey()).toString("hex"));
  });

  it("wallet lookup requires exactly one selector", async () => {
    await expect(run(["wallet", "lookup"])).rejects.toThrow(
      /Pass exactly one of --account, --address, --contract-id, or --secret-ref/i,
    );
    await expect(
      run(["wallet", "lookup", "--account", "treasury", "--address", "GABC"]),
    ).rejects.toThrow(/Pass exactly one of --account, --address, --contract-id, or --secret-ref/i);
  });

  it("wallet lookup returns configured and onchain signers for an account alias", async () => {
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
      signers: [{ signer_type: "Delegated", signer_address: "GDEL", credential_id: null }],
    });

    const res = await run(["wallet", "lookup", "--account", "treasury"]);
    const out = JSON.parse(res.stdout);
    expect(out).toMatchObject({
      mode: "account",
      query: { account: "treasury" },
      count: 1,
    });
    expect(out.wallets[0].contract_id).toBe(CONTRACT_ID);
    expect(out.wallets[0].configured_signers.account).toBe("treasury");
    expect(out.wallets[0].onchain_signers).toHaveLength(1);
  });

  it("wallet lookup fails when account alias is absent", async () => {
    mockLoadConfig.mockReturnValue({
      app: { default_network: "testnet", default_ttl_seconds: 30, assumed_ledger_time_seconds: 6 },
      networks: {
        testnet: { rpc_url: "https://rpc.invalid", network_passphrase: Networks.TESTNET },
      },
      smart_accounts: {},
    });

    await expect(run(["wallet", "lookup", "--account", "treasury"])).rejects.toThrow(
      /Smart account 'treasury' not found/i,
    );
  });

  it("wallet lookup enforces account network match", async () => {
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

    await expect(run(["wallet", "lookup", "--account", "treasury"])).rejects.toThrow(
      /belongs to network 'mainnet', not 'testnet'/i,
    );
  });

  it("wallet lookup lists onchain signers for a contract address", async () => {
    mockListContractSigners.mockResolvedValue({
      contractId: CONTRACT_ID,
      signers: [{ signer_type: "Delegated", signer_address: "GDEL", credential_id: null }],
    });

    const res = await run(["wallet", "lookup", "--address", CONTRACT_ID]);
    const out = JSON.parse(res.stdout);
    expect(out).toMatchObject({
      mode: "contract",
      query: { contract_id: CONTRACT_ID },
      count: 1,
    });
    expect(out.wallets[0].onchain_signers).toHaveLength(1);
  });

  it("wallet lookup discovers contracts from a delegated address", async () => {
    mockDiscoverContractsByAddress.mockResolvedValue({
      count: 1,
      contracts: [{ contract_id: CONTRACT_ID }],
    });
    mockListContractSigners.mockResolvedValue({
      contractId: CONTRACT_ID,
      signers: [{ signer_type: "Delegated", signer_address: "GDEL", credential_id: null }],
    });

    const res = await run(["wallet", "lookup", "--address", "GDEL"]);
    const out = JSON.parse(res.stdout);
    expect(out).toMatchObject({
      mode: "address",
      query: { address: "GDEL" },
      count: 1,
    });
    expect(out.wallets[0].contract_id).toBe(CONTRACT_ID);
    expect(out.wallets[0].onchain_signers).toHaveLength(1);
    expect(out.wallets[0].lookup_types).toEqual(["delegated"]);
  });

  it("wallet lookup resolves a secret ref and merges delegated and external reverse lookups", async () => {
    const signer = Keypair.random();
    const externalOnly = StrKey.encodeContract(Buffer.alloc(32, 2));
    mockSecretResolve.mockResolvedValueOnce(signer.secret());
    mockDiscoverContractsByAddress.mockResolvedValueOnce({
      count: 1,
      contracts: [{ contract_id: CONTRACT_ID }],
    });
    mockDiscoverContractsByCredentialId.mockResolvedValueOnce({
      count: 2,
      contracts: [{ contract_id: CONTRACT_ID }, { contract_id: externalOnly }],
    });
    mockListContractSigners
      .mockResolvedValueOnce({
        contractId: CONTRACT_ID,
        signers: [
          { signer_type: "Delegated", signer_address: signer.publicKey(), credential_id: null },
        ],
      })
      .mockResolvedValueOnce({
        contractId: externalOnly,
        signers: [{ signer_type: "External", signer_address: "CVER", credential_id: "aa" }],
      });

    const res = await run(["wallet", "lookup", "--secret-ref", "op://vault/item/field"]);
    const out = JSON.parse(res.stdout);
    expect(out).toMatchObject({
      mode: "secret-ref",
      query: {
        secret_ref: "op://vault/item/field",
        derived_address: signer.publicKey(),
        credential_id: Buffer.from(signer.rawPublicKey()).toString("hex"),
      },
      count: 2,
    });
    expect(out.wallets[0].lookup_types.length).toBeGreaterThanOrEqual(1);
    expect(out.wallets.map((row: { contract_id: string }) => row.contract_id)).toEqual(
      expect.arrayContaining([CONTRACT_ID, externalOnly]),
    );
  });

  it("wallet lookup rejects secret refs that do not resolve to Stellar seeds", async () => {
    mockSecretResolve.mockResolvedValueOnce("not-a-seed");
    await expect(
      run(["wallet", "lookup", "--secret-ref", "op://vault/item/field"]),
    ).rejects.toThrow(/secret-ref must resolve to a valid Stellar secret seed/i);
  });

  it("wallet signer mutation enforces account/network constraints", async () => {
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

    await expect(
      run([
        "wallet",
        "signer",
        "add",
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
        "signer",
        "add",
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
      "signer",
      "remove",
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
      "signer",
      "remove",
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

  it("wallet signer add resolves delegated signer identity from secret-ref", async () => {
    const signer = Keypair.random();
    mockSecretResolve.mockResolvedValueOnce(signer.secret());

    await run([
      "wallet",
      "signer",
      "add",
      "--account",
      "treasury",
      "--context-rule-id",
      "0",
      "--secret-ref",
      "op://vault/item/delegated_seed",
      "--out",
      "out.json",
    ]);

    expect(mockMakeDelegatedSignerScVal).toHaveBeenCalledWith(signer.publicKey());
    expect(mockBuildSignerMutationBundle).toHaveBeenCalledTimes(1);
  });

  it("wallet signer add resolves external signer identity from secret-ref plus verifier", async () => {
    const signer = Keypair.random();
    mockSecretResolve.mockResolvedValueOnce(signer.secret());

    await run([
      "wallet",
      "signer",
      "add",
      "--account",
      "treasury",
      "--context-rule-id",
      "0",
      "--secret-ref",
      "op://vault/item/external_seed",
      "--verifier-contract-id",
      CONTRACT_ID,
      "--out",
      "out.json",
    ]);

    expect(mockMakeExternalSignerScVal).toHaveBeenCalledWith(
      CONTRACT_ID,
      Buffer.from(signer.rawPublicKey()).toString("hex"),
    );
  });

  it("wallet signer remove supports direct external parameters", async () => {
    const ext = Keypair.random();
    await run([
      "wallet",
      "signer",
      "remove",
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
    ]);

    expect(mockMakeExternalSignerScVal).toHaveBeenCalledWith(
      CONTRACT_ID,
      Buffer.from(ext.rawPublicKey()).toString("hex"),
    );
  });

  it("wallet signer add defaults context-rule-id to 0", async () => {
    const signer = Keypair.random();

    const res = await run([
      "wallet",
      "signer",
      "add",
      "--account",
      "treasury",
      "--delegated-address",
      signer.publicKey(),
      "--out",
      "out.json",
    ]);

    expect(mockBuildSignerMutationBundle).toHaveBeenCalledWith(
      CONTRACT_ID,
      "add_signer",
      0,
      expect.any(Object),
      999,
    );
    expect(JSON.parse(res.stdout)).toMatchObject({ context_rule_id: 0 });
  });

  it("wallet signer add rejects negative context-rule-id", async () => {
    await expect(
      run([
        "wallet",
        "signer",
        "add",
        "--account",
        "treasury",
        "--context-rule-id",
        "-1",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/context-rule-id must be a non-negative integer/i);
  });

  it("wallet signer add validates signer target shapes", async () => {
    await expect(
      run([
        "wallet",
        "signer",
        "add",
        "--account",
        "treasury",
        "--context-rule-id",
        "0",
        "--secret-ref",
        "op://vault/item/seed",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/Use either --secret-ref or direct signer identity flags/i);

    await expect(
      run([
        "wallet",
        "signer",
        "add",
        "--account",
        "treasury",
        "--context-rule-id",
        "0",
        "--public-key-hex",
        Buffer.from(Keypair.random().rawPublicKey()).toString("hex"),
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/require --verifier-contract-id/i);

    await expect(
      run([
        "wallet",
        "signer",
        "add",
        "--account",
        "treasury",
        "--context-rule-id",
        "0",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--verifier-contract-id",
        CONTRACT_ID,
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/accept only --delegated-address/i);

    await expect(
      run([
        "wallet",
        "signer",
        "add",
        "--account",
        "treasury",
        "--context-rule-id",
        "0",
        "--verifier-contract-id",
        CONTRACT_ID,
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/require either --public-key-hex or --secret-ref/i);

    mockSecretResolve.mockResolvedValueOnce("not-a-seed");
    await expect(
      run([
        "wallet",
        "signer",
        "add",
        "--account",
        "treasury",
        "--context-rule-id",
        "0",
        "--secret-ref",
        "op://vault/item/bad_seed",
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/must resolve to a valid Stellar secret seed/i);

    await expect(
      run([
        "wallet",
        "signer",
        "add",
        "--account",
        "treasury",
        "--context-rule-id",
        "0",
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/Pass a signer target using --secret-ref/i);
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
      "signer",
      "remove",
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

  it("removed legacy commands are rejected", async () => {
    await expect(run(["inspect", "--in", "in.txt"])).rejects.toThrow(/unknown command/i);
    await expect(run(["can-sign", "--in", "in.txt"])).rejects.toThrow(/unknown command/i);
    await expect(run(["keys", "create"])).rejects.toThrow(/unknown command/i);
    await expect(run(["wallet", "discover", "--address", "GABC"])).rejects.toThrow(
      /unknown command/i,
    );
    await expect(run(["wallet", "list-signers", "--contract-id", CONTRACT_ID])).rejects.toThrow(
      /unknown command/i,
    );
    await expect(run(["wallet", "reconcile", "--account", "treasury"])).rejects.toThrow(
      /unknown command/i,
    );
    await expect(run(["wallet", "signer", "verify", "--account", "treasury"])).rejects.toThrow(
      /unknown command/i,
    );
    await expect(
      run([
        "wallet",
        "add-delegated-signer",
        "--account",
        "treasury",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.json",
      ]),
    ).rejects.toThrow(/unknown command/i);
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
