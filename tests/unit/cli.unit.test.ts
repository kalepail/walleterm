import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { Command, CommanderError } from "commander";

const mocks = {
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
  mockResolveAccount: vi.fn(),
  mockResolveNetwork: vi.fn(),
  mockDefaultServiceForNetwork: vi.fn(),
  mockSetupMacOSKeychainForWallet: vi.fn(),
  mockDefaultItemForNetwork: vi.fn(),
  mockSetupOnePasswordForWallet: vi.fn(),
  mockGenerateSshAgentKey: vi.fn(),
  mockSetupSshAgentForWallet: vi.fn(),
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
  mockReconcileContractSigners: vi.fn(),
  mockResolveIndexerUrl: vi.fn(),
  mockSmartAccountKitDeployerKeypair: vi.fn(),
  mockSecretResolve: vi.fn(),
};

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
  mockResolveAccount,
  mockResolveNetwork,
  mockDefaultServiceForNetwork,
  mockSetupMacOSKeychainForWallet,
  mockDefaultItemForNetwork,
  mockSetupOnePasswordForWallet,
  mockGenerateSshAgentKey,
  mockSetupSshAgentForWallet,
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
  mockReconcileContractSigners,
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
  resolveAccount: mocks.mockResolveAccount,
  resolveNetwork: mocks.mockResolveNetwork,
}));

vi.mock("../../src/keychain-setup.js", () => ({
  defaultServiceForNetwork: mocks.mockDefaultServiceForNetwork,
  setupMacOSKeychainForWallet: mocks.mockSetupMacOSKeychainForWallet,
}));

vi.mock("../../src/op-setup.js", () => ({
  defaultItemForNetwork: mocks.mockDefaultItemForNetwork,
  setupOnePasswordForWallet: mocks.mockSetupOnePasswordForWallet,
}));

vi.mock("../../src/ssh-agent-setup.js", () => ({
  generateSshAgentKey: mocks.mockGenerateSshAgentKey,
  setupSshAgentForWallet: mocks.mockSetupSshAgentForWallet,
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
  reconcileContractSigners: mocks.mockReconcileContractSigners,
  resolveIndexerUrl: mocks.mockResolveIndexerUrl,
  smartAccountKitDeployerKeypair: mocks.mockSmartAccountKitDeployerKeypair,
}));

vi.mock("../../src/secrets.js", () => {
  class SecretResolver {
    async resolve(ref: string): Promise<string> {
      return mocks.mockSecretResolve(ref);
    }
    clearCache(): void {}
  }
  return { SecretResolver };
});

async function run(args: string[]) {
  const { runCli } = await import("../../src/cli.js");
  let stdout = "";
  let stderr = "";
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const originalThrowOnCliError = process.env.WALLETERM_THROW_ON_CLI_ERROR;
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  process.env.WALLETERM_THROW_ON_CLI_ERROR = "1";
  let caughtError: unknown;
  let exitCode = 0;

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
    exitCode = process.exitCode ?? 0;
  } catch (error) {
    caughtError = error;
    exitCode = process.exitCode ?? 0;
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (originalThrowOnCliError === undefined) {
      delete process.env.WALLETERM_THROW_ON_CLI_ERROR;
    } else {
      process.env.WALLETERM_THROW_ON_CLI_ERROR = originalThrowOnCliError;
    }
    process.exitCode = originalExitCode;
  }

  if (caughtError !== undefined) {
    if (caughtError instanceof Error) {
      const errorWithOutput = caughtError as Error & {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      errorWithOutput.stdout ??= stdout;
      errorWithOutput.stderr ??= stderr;
      errorWithOutput.exitCode ??= exitCode;
    }
    throw caughtError;
  }

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
      strict_onchain: true,
      onchain_signer_mode: "subset",
      default_ttl_seconds: 30,
      assumed_ledger_time_seconds: 6,
      default_submit_mode: "sign-only",
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

  mockResolveAccount.mockImplementation((config: any, networkName: string, explicit?: string) => {
    if (!explicit) return null;
    const account = config.smart_accounts[explicit];
    if (!account || account.network !== networkName) return null;
    return { alias: explicit, account };
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
  mockDefaultServiceForNetwork.mockReturnValue("walleterm-testnet");
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
  mockSetupMacOSKeychainForWallet.mockResolvedValue({
    service: "walleterm-testnet",
    network: "testnet",
    security_bin: "security",
    deployer_seed_stored: false,
    deployer_public_key: Keypair.random().publicKey(),
    delegated_public_key: Keypair.random().publicKey(),
    refs: {
      delegated_seed_ref: "keychain://walleterm-testnet/delegated_seed",
      channels_api_key_ref: "keychain://walleterm-testnet/channels_api_key",
    },
    config_snippet: "[networks.testnet]",
  });
  mockGenerateSshAgentKey.mockResolvedValue({
    backend: "system",
    socket_path: "/tmp/agent.sock",
    generated: true,
    key: {
      stellar_address: Keypair.random().publicKey(),
      public_key_hex: "11".repeat(32),
      comment: "generated",
      ref: "ssh-agent://system/GTEST",
    },
    config_snippet: "[[smart_accounts.<alias>.delegated_signers]]",
    key_path: "/tmp/test_ed25519",
  });
  mockSetupSshAgentForWallet.mockResolvedValue({
    backend: "system",
    socket_path: "/tmp/agent.sock",
    keys: [
      {
        stellar_address: Keypair.random().publicKey(),
        public_key_hex: "22".repeat(32),
        comment: "fixture",
        ref: "ssh-agent://system/GFIXTURE",
      },
    ],
    config_snippet: "[[smart_accounts.<alias>.delegated_signers]]",
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
  mockReconcileContractSigners.mockReturnValue({
    mode: "subset",
    ok: true,
    configured: { delegated: [], external: [] },
    onchain: { delegated: [], external: [] },
    missing: { delegated: [], external: [] },
    extra: { delegated: [], external: [] },
  });
  mockCreateWalletDeployTx.mockResolvedValue({
    contractId: CONTRACT_ID,
    txXdr: "AAAA",
    saltHex: "00".repeat(32),
  });
  mockDeriveSaltHexFromRawString.mockReturnValue("11".repeat(32));
  mockSmartAccountKitDeployerKeypair.mockReturnValue(deployer);

  mockSecretResolve.mockResolvedValue(Keypair.random().secret());
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

afterAll(() => {
  process.exitCode = 0;
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
      signer_reconciliation: expect.objectContaining({ ok: true, mode: "subset" }),
      signer_reconciliation_error: null,
    });
  });

  it("review surfaces signer reconciliation lookup failures without failing the command", async () => {
    mockResolveIndexerUrl.mockImplementationOnce(() => {
      throw new Error("missing indexer");
    });

    const res = await run(["review", "--in", "in.txt", "--account", "treasury"]);
    expect(JSON.parse(res.stdout)).toMatchObject({
      signer_reconciliation: null,
      signer_reconciliation_error: "missing indexer",
    });
  });

  it("review defaults signer reconciliation mode to subset when config omits it", async () => {
    mockLoadConfig.mockImplementation(() => ({
      app: {
        default_network: "testnet",
        strict_onchain: true,
        onchain_signer_mode: undefined,
        default_ttl_seconds: 30,
        assumed_ledger_time_seconds: 6,
        default_submit_mode: "sign-only",
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
    }));

    const res = await run(["review", "--in", "in.txt", "--account", "treasury"]);
    expect(JSON.parse(res.stdout)).toMatchObject({
      signer_reconciliation: expect.objectContaining({ ok: true, mode: "subset" }),
      signer_reconciliation_error: null,
    });
    expect(mockReconcileContractSigners).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "subset",
    );
  });

  it("review stringifies non-Error signer reconciliation failures", async () => {
    mockResolveIndexerUrl.mockImplementationOnce(() => {
      throw "plain-failure";
    });

    const res = await run(["review", "--in", "in.txt", "--account", "treasury"]);
    expect(JSON.parse(res.stdout)).toMatchObject({
      signer_reconciliation: null,
      signer_reconciliation_error: "plain-failure",
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

  it("runCli ignores Commander help exits", async () => {
    const { runCli } = await import("../../src/cli.js");
    vi.spyOn(Command.prototype, "parseAsync").mockRejectedValueOnce(
      new CommanderError(0, "commander.help", "help"),
    );

    await expect(runCli(["bun", "walleterm", "--help"])).resolves.toBeUndefined();
  });

  it("runCli writes stderr and exitCode when throw-on-error is disabled", async () => {
    const { runCli } = await import("../../src/cli.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prev = process.env.WALLETERM_THROW_ON_CLI_ERROR;
    delete process.env.WALLETERM_THROW_ON_CLI_ERROR;
    process.exitCode = 0;
    vi.spyOn(Command.prototype, "parseAsync").mockRejectedValueOnce(new Error("plain failure"));

    try {
      await runCli(["bun", "walleterm", "review", "--in", "in.txt"]);
      expect(stderrSpy).toHaveBeenCalledWith("plain failure\n");
      expect(process.exitCode).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.WALLETERM_THROW_ON_CLI_ERROR;
      else process.env.WALLETERM_THROW_ON_CLI_ERROR = prev;
      stderrSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("sign command errors when account cannot be resolved", async () => {
    mockParseInputFile.mockReturnValue({ kind: "auth", auth: [] });
    mockResolveAccountForCommand.mockReturnValue(null);

    await expect(
      run(["sign", "--in", "in.txt", "--out", "out.txt", "--ttl-seconds", "30"]),
    ).rejects.toThrow(/No smart account selected/i);
  });

  it("sign command fails when strict onchain reconciliation fails", async () => {
    mockReconcileContractSigners.mockReturnValueOnce({
      mode: "exact",
      ok: false,
      configured: { delegated: ["GA"], external: [] },
      onchain: { delegated: [], external: [] },
      missing: { delegated: ["GA"], external: [] },
      extra: { delegated: [], external: [] },
    });

    await expect(run(["sign", "--in", "in.txt", "--out", "out.txt"])).rejects.toThrow(
      /Strict on-chain signer reconciliation failed/i,
    );
  });

  it("sign command includes extra signer details in exact reconciliation mode", async () => {
    mockReconcileContractSigners.mockReturnValueOnce({
      mode: "exact",
      ok: false,
      configured: { delegated: [], external: [] },
      onchain: {
        delegated: [],
        external: [{ verifier_contract_id: CONTRACT_ID, public_key_hex: "aa".repeat(32) }],
      },
      missing: { delegated: [], external: [] },
      extra: {
        delegated: [],
        external: [{ verifier_contract_id: CONTRACT_ID, public_key_hex: "aa".repeat(32) }],
      },
    });

    await expect(run(["sign", "--in", "in.txt", "--out", "out.txt"])).rejects.toThrow(
      /extra external=\[/i,
    );
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

  it("setup keychain uses service defaults and prints verbose output", async () => {
    const res = await run(["setup", "keychain", "--network", "testnet"]);
    expect(mockDefaultServiceForNetwork).toHaveBeenCalledWith("testnet");
    expect(mockSetupMacOSKeychainForWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "walleterm-testnet",
        network: "testnet",
      }),
    );
    expect(res.stderr).toContain("macOS keychain wallet bootstrap complete.");
    expect(JSON.parse(res.stdout).service).toBe("walleterm-testnet");
  });

  it("setup keychain forwards explicit options", async () => {
    await run([
      "setup",
      "keychain",
      "--service",
      "custom-service",
      "--keychain",
      "/tmp/custom.keychain-db",
      "--include-deployer-seed",
      "--json",
    ]);
    expect(mockSetupMacOSKeychainForWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "custom-service",
        keychain: "/tmp/custom.keychain-db",
        includeDeployerSeed: true,
      }),
    );
  });

  it("setup ssh-agent discovery prints verbose output and supports json", async () => {
    const res = await run([
      "setup",
      "ssh-agent",
      "--backend",
      "system",
      "--socket",
      "/tmp/custom.sock",
    ]);

    expect(mockSetupSshAgentForWallet).toHaveBeenCalledWith({
      backend: "system",
      socketPath: "/tmp/custom.sock",
    });
    expect(res.stderr).toContain("SSH agent discovery complete (system).");
    expect(res.stderr).toContain("found 1 Ed25519 key(s)");
    expect(JSON.parse(res.stdout)).toMatchObject({ backend: "system" });
  });

  it("setup ssh-agent generate forwards backend-specific options", async () => {
    const res = await run([
      "setup",
      "ssh-agent",
      "--backend",
      "1password",
      "--generate",
      "--vault",
      "Private",
      "--title",
      "walleterm-generated",
      "--socket",
      "/tmp/1p.sock",
      "--json",
    ]);

    expect(mockGenerateSshAgentKey).toHaveBeenCalledWith({
      backend: "1password",
      socketPath: "/tmp/1p.sock",
      vault: "Private",
      title: "walleterm-generated",
      keyPath: undefined,
    });
    expect(JSON.parse(res.stdout)).toMatchObject({ generated: true, backend: "system" });
  });

  it("setup ssh-agent generate prints verbose output for system backend", async () => {
    mockGenerateSshAgentKey.mockResolvedValueOnce({
      backend: "system",
      socket_path: "/tmp/agent.sock",
      generated: true,
      key: {
        stellar_address: Keypair.random().publicKey(),
        public_key_hex: "33".repeat(32),
        comment: "generated",
        ref: "ssh-agent://system/GGENERATED",
      },
      config_snippet: "[[smart_accounts.<alias>.delegated_signers]]",
      key_path: "/tmp/test_ed25519",
      public_key_path: "/tmp/test_ed25519.pub",
    });

    const res = await run(["setup", "ssh-agent", "--backend", "system", "--generate"]);
    expect(res.stderr).toContain("SSH agent key generated (system).");
    expect(res.stderr).toContain("key_path: /tmp/test_ed25519");
    expect(JSON.parse(res.stdout)).toMatchObject({ generated: true });
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
    const legacyCommands = [
      ["inspect", "--in", "in.txt"],
      ["can-sign", "--in", "in.txt"],
      ["keys", "create"],
      ["wallet", "discover", "--address", "GABC"],
      ["wallet", "list-signers", "--contract-id", CONTRACT_ID],
      ["wallet", "reconcile", "--account", "treasury"],
      ["wallet", "signer", "verify", "--account", "treasury"],
      [
        "wallet",
        "add-delegated-signer",
        "--account",
        "treasury",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.json",
      ],
    ];

    for (const commandArgs of legacyCommands) {
      await expect(run(commandArgs)).rejects.toThrow(/unknown command/i);
    }
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

  it("wallet create uses expected_wasm_hash from selected account when --wasm-hash is omitted", async () => {
    mockLoadConfig.mockReturnValue({
      app: {
        default_network: "testnet",
        strict_onchain: true,
        onchain_signer_mode: "subset",
        default_ttl_seconds: 30,
        assumed_ledger_time_seconds: 6,
        default_submit_mode: "sign-only",
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
          expected_wasm_hash: WASM_HASH,
          external_signers: [],
          delegated_signers: [],
        },
      },
    });

    await run([
      "wallet",
      "create",
      "--account",
      "treasury",
      "--delegated-address",
      Keypair.random().publicKey(),
      "--out",
      "out.xdr",
    ]);

    expect(mockCreateWalletDeployTx).toHaveBeenCalledWith(
      expect.objectContaining({ wasmHashHex: WASM_HASH }),
    );
  });

  it("wallet create rejects missing wasm hash when no explicit or configured value exists", async () => {
    mockResolveAccount.mockReturnValue(null);

    await expect(
      run([
        "wallet",
        "create",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.xdr",
      ]),
    ).rejects.toThrow(/No wasm hash provided\. Pass --wasm-hash or select\/configure an account/i);
  });

  it("wallet create rejects missing wasm hash for selected account without expected_wasm_hash", async () => {
    mockResolveAccount.mockReturnValue({
      alias: "treasury",
      account: {
        network: "testnet",
        contract_id: CONTRACT_ID,
        external_signers: [],
        delegated_signers: [],
      },
    });

    await expect(
      run([
        "wallet",
        "create",
        "--account",
        "treasury",
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.xdr",
      ]),
    ).rejects.toThrow(
      /No wasm hash provided\. Pass --wasm-hash or set smart_accounts\.treasury\.expected_wasm_hash/i,
    );
  });

  it("wallet create rejects mismatched expected_wasm_hash and auto-submits when default_submit_mode is channels", async () => {
    mockLoadConfig.mockReturnValue({
      app: {
        default_network: "testnet",
        strict_onchain: true,
        onchain_signer_mode: "subset",
        default_ttl_seconds: 30,
        assumed_ledger_time_seconds: 6,
        default_submit_mode: "channels",
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
          expected_wasm_hash: "11".repeat(32),
          external_signers: [],
          delegated_signers: [],
        },
      },
    });

    await expect(
      run([
        "wallet",
        "create",
        "--account",
        "treasury",
        "--wasm-hash",
        WASM_HASH,
        "--delegated-address",
        Keypair.random().publicKey(),
        "--out",
        "out.xdr",
      ]),
    ).rejects.toThrow(/wasm hash mismatch/i);

    mockLoadConfig.mockReturnValue({
      app: {
        default_network: "testnet",
        strict_onchain: true,
        onchain_signer_mode: "subset",
        default_ttl_seconds: 30,
        assumed_ledger_time_seconds: 6,
        default_submit_mode: "channels",
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
          expected_wasm_hash: WASM_HASH,
          external_signers: [],
          delegated_signers: [],
        },
      },
    });

    const out = await run([
      "wallet",
      "create",
      "--account",
      "treasury",
      "--delegated-address",
      Keypair.random().publicKey(),
      "--out",
      "out.xdr",
    ]);

    expect(mockSubmitViaChannels).toHaveBeenCalled();
    expect(JSON.parse(out.stdout)).toMatchObject({ submitted: true });
  });
});
