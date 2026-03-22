import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { makeTempDir } from "../helpers/temp-dir.js";
import {
  agentSign,
  buildEd25519KeyBlob,
  buildSshAgentRef,
  listAgentIdentities,
} from "../../src/ssh-agent.js";
import {
  buildNativeTransferBundle,
  DEFAULT_WASM_HASH,
  fundWithFriendbot,
  getNativeBalanceStroops,
  PROJECT_ROOT,
  sleep,
  waitForHorizonTransaction,
  waitForWalletLookup,
} from "./helpers.js";

const LIVE_ENABLED =
  process.env.WALLETERM_LIVE === "1" && process.env.WALLETERM_LIVE_SSH_AGENT === "1";

describe.skipIf(!LIVE_ENABLED)("ssh-agent live", () => {
  it("lists Ed25519 identities from the system SSH agent and signs data", async () => {
    const socketPath = process.env.SSH_AUTH_SOCK;
    if (!socketPath) throw new Error("SSH_AUTH_SOCK not set");

    const identities = await listAgentIdentities(socketPath);
    expect(identities.length).toBeGreaterThan(0);

    const identity = identities[0]!;
    expect(identity.publicKey).toHaveLength(32);
    expect(identity.keyBlob.length).toBeGreaterThan(32);

    const stellarAddress = StrKey.encodeEd25519PublicKey(identity.publicKey);
    expect(stellarAddress.startsWith("G")).toBe(true);

    const data = Buffer.from("walleterm-live-test");
    const { signature } = await agentSign(socketPath, identity.keyBlob, data);
    expect(signature).toHaveLength(64);

    const keyBlob = buildEd25519KeyBlob(identity.publicKey);
    expect(keyBlob.equals(identity.keyBlob)).toBe(true);

    console.log(`[live.ssh-agent] identity=${stellarAddress} comment=${identity.comment}`);
  });

  it("discovers keys via CLI setup ssh-agent command", async () => {
    const setup = await execa(
      "bun",
      ["src/cli.ts", "setup", "ssh-agent", "--backend", "system", "--json"],
      { cwd: PROJECT_ROOT },
    );

    const out = JSON.parse(setup.stdout) as {
      backend: string;
      socket_path: string;
      keys: Array<{
        stellar_address: string;
        public_key_hex: string;
        comment: string;
        ref: string;
      }>;
      config_snippet: string;
    };

    expect(out.backend).toBe("system");
    expect(out.keys.length).toBeGreaterThan(0);
    expect(out.keys[0]!.stellar_address.startsWith("G")).toBe(true);
    expect(out.keys[0]!.ref.startsWith("ssh-agent://system/")).toBe(true);
    expect(out.config_snippet).toContain("delegated_signers");
    console.log(
      `[live.ssh-agent] setup found ${out.keys.length} key(s): ${out.keys.map((k) => k.stellar_address).join(", ")}`,
    );
  });

  it(
    "creates a smart account with SSH agent signer, signs a native payment, and verifies on-chain",
    { timeout: 240_000 },
    async () => {
      const socketPath = process.env.SSH_AUTH_SOCK;
      if (!socketPath) throw new Error("SSH_AUTH_SOCK not set");

      const identities = await listAgentIdentities(socketPath);
      expect(identities.length).toBeGreaterThan(0);
      const identity = identities[0]!;
      const sshStellarAddress = StrKey.encodeEd25519PublicKey(identity.publicKey);
      const sshAgentRef = buildSshAgentRef("system", sshStellarAddress);

      const rootDir = makeTempDir("walleterm-ssh-agent-live-");
      const configPath = join(rootDir, "walleterm.toml");
      const deployXdrPath = join(rootDir, "deploy.tx.xdr");
      const fundUnsignedPath = join(rootDir, "fund-smart-account.bundle.json");
      const fundSignedPath = join(rootDir, "fund-smart-account.signed.bundle.json");
      const paymentUnsignedPath = join(rootDir, "smart-payment.bundle.json");
      const paymentSignedPath = join(rootDir, "smart-payment.signed.bundle.json");

      const wasmHash = process.env.WALLETERM_SSH_AGENT_WASM_HASH ?? DEFAULT_WASM_HASH;
      const rpcUrl =
        process.env.WALLETERM_SSH_AGENT_TESTNET_RPC_URL ??
        "https://soroban-rpc.testnet.stellar.gateway.fm";
      const channelsBaseUrl =
        process.env.WALLETERM_SSH_AGENT_TESTNET_CHANNELS_BASE_URL ??
        "https://channels.openzeppelin.com/testnet";
      const recipient = Keypair.random();
      const saltHex = randomBytes(32).toString("hex");

      const keyResponse = await fetch("https://channels.openzeppelin.com/testnet/gen");
      expect(keyResponse.ok).toBe(true);
      const keyData = (await keyResponse.json()) as { apiKey?: string };
      expect(typeof keyData.apiKey).toBe("string");

      await fundWithFriendbot(sshStellarAddress);
      await fundWithFriendbot(recipient.publicKey());

      // Phase 1: Deploy a new smart account with the SSH agent key as delegated signer
      writeFileSync(
        configPath,
        `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "channels"

[networks.testnet]
rpc_url = "${rpcUrl}"
network_passphrase = "${Networks.TESTNET}"
channels_base_url = "${channelsBaseUrl}"

[smart_accounts]
`,
        "utf8",
      );

      let createOut:
        | {
            contract_id: string;
            submitted: boolean;
            submission?: { hash?: string; status?: string; mode?: string };
          }
        | undefined;
      let createError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const create = await execa(
            "bun",
            [
              "src/cli.ts",
              "wallet",
              "create",
              "--config",
              configPath,
              "--network",
              "testnet",
              "--wasm-hash",
              wasmHash,
              "--delegated-address",
              sshStellarAddress,
              "--salt-hex",
              saltHex,
              "--submit",
              "--submit-mode",
              "channels",
              "--channels-api-key",
              keyData.apiKey!,
              "--out",
              deployXdrPath,
            ],
            { cwd: PROJECT_ROOT },
          );
          createOut = JSON.parse(create.stdout) as {
            contract_id: string;
            submitted: boolean;
            submission?: { hash?: string; status?: string; mode?: string };
          };
          break;
        } catch (error) {
          createError = error;
          if (attempt < 3) {
            await sleep(1_500 * attempt);
          }
        }
      }
      if (!createOut) throw createError;

      expect(createOut.contract_id.startsWith("C")).toBe(true);
      expect(createOut.submitted).toBe(true);
      expect(createOut.submission?.mode).toBe("channels");
      expect(typeof createOut.submission?.hash).toBe("string");
      expect(["pending", "confirmed"]).toContain(createOut.submission?.status ?? "");
      console.log(
        `[live.ssh-agent] contract_id=${createOut.contract_id} deploy_tx_hash=${createOut.submission?.hash ?? "unknown"} status=${createOut.submission?.status ?? "unknown"}`,
      );

      await waitForHorizonTransaction(createOut.submission!.hash!);

      // Phase 2: Wait for indexer to pick up the contract
      const lookupResult = await waitForWalletLookup(
        ["--config", configPath, "--network", "testnet", "--contract-id", createOut.contract_id],
        process.env,
        (result) =>
          result.count === 1 &&
          result.wallets?.[0]?.contract_id === createOut.contract_id &&
          (result.wallets[0]?.onchain_signers?.length ?? 0) > 0,
      );
      expect(lookupResult.wallets?.[0]?.contract_id).toBe(createOut.contract_id);

      // Phase 3: Configure the wallet with ssh-agent:// ref and sign via SSH agent
      writeFileSync(
        configPath,
        `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "channels"

[networks.testnet]
rpc_url = "${rpcUrl}"
network_passphrase = "${Networks.TESTNET}"
channels_base_url = "${channelsBaseUrl}"

[smart_accounts.live_wallet]
network = "testnet"
contract_id = "${createOut.contract_id}"
expected_wasm_hash = "${wasmHash}"

[[smart_accounts.live_wallet.delegated_signers]]
name = "ssh_agent_signer"
address = "${sshStellarAddress}"
secret_ref = "${sshAgentRef}"
enabled = true
`,
        "utf8",
      );

      // Fund the smart account so it can send a payment
      const nativeAssetContractId = Asset.native().contractId(Networks.TESTNET);

      const fundBundle = buildNativeTransferBundle(
        nativeAssetContractId,
        sshStellarAddress,
        createOut.contract_id,
        20_000_000n,
      );
      writeFileSync(fundUnsignedPath, JSON.stringify(fundBundle), "utf8");

      // Sign the funding bundle using ssh-agent:// -- the SSH agent key IS the delegated signer
      // for the G-address auth entry (not the smart account), so this will use the agent
      const signedFund = await execa(
        "bun",
        [
          "src/cli.ts",
          "sign",
          "--config",
          configPath,
          "--network",
          "testnet",
          "--account",
          "live_wallet",
          "--in",
          fundUnsignedPath,
          "--out",
          fundSignedPath,
        ],
        { cwd: PROJECT_ROOT },
      );
      const signedFundOut = JSON.parse(signedFund.stdout) as {
        summary: { signed: number };
      };
      expect(signedFundOut.summary.signed).toBeGreaterThan(0);
      console.log(`[live.ssh-agent] fund_bundle signed=${signedFundOut.summary.signed}`);

      const fundSubmit = await execa(
        "bun",
        [
          "src/cli.ts",
          "submit",
          "--config",
          configPath,
          "--network",
          "testnet",
          "--in",
          fundSignedPath,
          "--channels-api-key",
          keyData.apiKey!,
        ],
        { cwd: PROJECT_ROOT },
      );
      const fundSubmitOut = JSON.parse(fundSubmit.stdout) as {
        hash: string;
        mode: string;
        request_kind: string;
        status: string;
      };
      expect(fundSubmitOut.mode).toBe("channels");
      expect(typeof fundSubmitOut.hash).toBe("string");
      expect(["pending", "confirmed"]).toContain(fundSubmitOut.status);
      console.log(
        `[live.ssh-agent] fund_tx_hash=${fundSubmitOut.hash} status=${fundSubmitOut.status}`,
      );
      await waitForHorizonTransaction(fundSubmitOut.hash);

      // Phase 4: Send a payment FROM the smart account, signed via SSH agent
      const recipientBalanceBefore = await getNativeBalanceStroops(recipient.publicKey());

      const paymentBundle = buildNativeTransferBundle(
        nativeAssetContractId,
        createOut.contract_id,
        recipient.publicKey(),
        10_000_000n,
      );
      writeFileSync(paymentUnsignedPath, JSON.stringify(paymentBundle), "utf8");

      const signedPayment = await execa(
        "bun",
        [
          "src/cli.ts",
          "sign",
          "--config",
          configPath,
          "--network",
          "testnet",
          "--account",
          "live_wallet",
          "--in",
          paymentUnsignedPath,
          "--out",
          paymentSignedPath,
        ],
        { cwd: PROJECT_ROOT },
      );
      const signedPaymentOut = JSON.parse(signedPayment.stdout) as {
        summary: { signed: number };
      };
      expect(signedPaymentOut.summary.signed).toBeGreaterThan(0);
      console.log(`[live.ssh-agent] payment_bundle signed=${signedPaymentOut.summary.signed}`);

      const paymentSubmit = await execa(
        "bun",
        [
          "src/cli.ts",
          "submit",
          "--config",
          configPath,
          "--network",
          "testnet",
          "--in",
          paymentSignedPath,
          "--channels-api-key",
          keyData.apiKey!,
        ],
        { cwd: PROJECT_ROOT },
      );
      const paymentSubmitOut = JSON.parse(paymentSubmit.stdout) as {
        hash: string;
        mode: string;
        request_kind: string;
        status: string;
      };
      expect(paymentSubmitOut.mode).toBe("channels");
      expect(typeof paymentSubmitOut.hash).toBe("string");
      expect(["pending", "confirmed"]).toContain(paymentSubmitOut.status);
      console.log(
        `[live.ssh-agent] payment_tx_hash=${paymentSubmitOut.hash} status=${paymentSubmitOut.status}`,
      );
      await waitForHorizonTransaction(paymentSubmitOut.hash);

      // Phase 5: Verify on-chain balance change
      const recipientBalanceAfter = await getNativeBalanceStroops(recipient.publicKey());
      expect(recipientBalanceAfter - recipientBalanceBefore).toBeGreaterThanOrEqual(10_000_000n);
      console.log(
        `[live.ssh-agent] recipient balance change: ${recipientBalanceAfter - recipientBalanceBefore} stroops`,
      );
    },
  );
});

const LIVE_1P_ENABLED = LIVE_ENABLED && process.env.WALLETERM_LIVE_SSH_AGENT_1P === "1";

describe.skipIf(!LIVE_1P_ENABLED)("ssh-agent 1password generate live", () => {
  it(
    "generates a key in 1Password, deploys a wallet, signs a payment via SSH agent, and verifies on-chain",
    { timeout: 240_000 },
    async () => {
      const uniqueTitle = `walleterm-live-${randomBytes(6).toString("hex")}`;

      try {
        // Phase 1: Generate SSH key in 1Password via CLI
        const setup = await execa(
          "bun",
          [
            "src/cli.ts",
            "setup",
            "ssh-agent",
            "--backend",
            "1password",
            "--generate",
            "--title",
            uniqueTitle,
            "--json",
          ],
          { cwd: PROJECT_ROOT },
        );

        const setupOut = JSON.parse(setup.stdout) as {
          generated: boolean;
          key: { stellar_address: string; ref: string };
          op_item_id: string;
          agent_toml_updated: boolean;
          config_snippet: string;
        };

        expect(setupOut.generated).toBe(true);
        expect(setupOut.key.stellar_address.startsWith("G")).toBe(true);
        expect(setupOut.key.ref.startsWith("ssh-agent://1password/")).toBe(true);
        expect(setupOut.agent_toml_updated).toBe(true);

        const sshStellarAddress = setupOut.key.stellar_address;
        const sshAgentRef = setupOut.key.ref;
        console.log(`[live.ssh-agent-1p] generated key: ${sshStellarAddress} item=${uniqueTitle}`);

        // Phase 2: Deploy a wallet with this key as delegated signer
        const rootDir = makeTempDir("walleterm-ssh-agent-1p-live-");
        const configPath = join(rootDir, "walleterm.toml");
        const deployXdrPath = join(rootDir, "deploy.tx.xdr");
        const fundUnsignedPath = join(rootDir, "fund.bundle.json");
        const fundSignedPath = join(rootDir, "fund.signed.bundle.json");
        const paymentUnsignedPath = join(rootDir, "payment.bundle.json");
        const paymentSignedPath = join(rootDir, "payment.signed.bundle.json");

        const wasmHash = DEFAULT_WASM_HASH;
        const rpcUrl = "https://soroban-rpc.testnet.stellar.gateway.fm";
        const channelsBaseUrl = "https://channels.openzeppelin.com/testnet";
        const recipient = Keypair.random();
        const saltHex = randomBytes(32).toString("hex");

        const keyResponse = await fetch("https://channels.openzeppelin.com/testnet/gen");
        expect(keyResponse.ok).toBe(true);
        const keyData = (await keyResponse.json()) as { apiKey?: string };

        await fundWithFriendbot(sshStellarAddress);
        await fundWithFriendbot(recipient.publicKey());

        writeFileSync(
          configPath,
          `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "channels"

[networks.testnet]
rpc_url = "${rpcUrl}"
network_passphrase = "${Networks.TESTNET}"
channels_base_url = "${channelsBaseUrl}"

[smart_accounts]
`,
          "utf8",
        );

        const create = await execa(
          "bun",
          [
            "src/cli.ts",
            "wallet",
            "create",
            "--config",
            configPath,
            "--wasm-hash",
            wasmHash,
            "--delegated-address",
            sshStellarAddress,
            "--salt-hex",
            saltHex,
            "--submit",
            "--channels-api-key",
            keyData.apiKey!,
            "--out",
            deployXdrPath,
          ],
          { cwd: PROJECT_ROOT },
        );

        const createOut = JSON.parse(create.stdout) as {
          contract_id: string;
          submitted: boolean;
          submission?: { hash?: string; status?: string };
        };
        expect(createOut.contract_id.startsWith("C")).toBe(true);
        console.log(
          `[live.ssh-agent-1p] contract_id=${createOut.contract_id} deploy_hash=${createOut.submission?.hash}`,
        );
        await waitForHorizonTransaction(createOut.submission!.hash!);

        // Wait for indexer to pick up the contract before strict_onchain reconciliation
        await waitForWalletLookup(
          ["--config", configPath, "--network", "testnet", "--contract-id", createOut.contract_id],
          process.env,
          (result) => result.count === 1 && (result.wallets?.[0]?.onchain_signers?.length ?? 0) > 0,
        );

        // Phase 3: Configure wallet with ssh-agent:// ref and sign via 1Password SSH agent
        writeFileSync(
          configPath,
          `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "channels"

[networks.testnet]
rpc_url = "${rpcUrl}"
network_passphrase = "${Networks.TESTNET}"
channels_base_url = "${channelsBaseUrl}"

[smart_accounts.live_wallet]
network = "testnet"
contract_id = "${createOut.contract_id}"
expected_wasm_hash = "${wasmHash}"

[[smart_accounts.live_wallet.delegated_signers]]
name = "ssh_1p_signer"
address = "${sshStellarAddress}"
secret_ref = "${sshAgentRef}"
enabled = true
`,
          "utf8",
        );

        const nativeAssetContractId = Asset.native().contractId(Networks.TESTNET);

        // Fund smart account
        const fundBundle = buildNativeTransferBundle(
          nativeAssetContractId,
          sshStellarAddress,
          createOut.contract_id,
          20_000_000n,
        );
        writeFileSync(fundUnsignedPath, JSON.stringify(fundBundle), "utf8");

        const signedFund = await execa(
          "bun",
          [
            "src/cli.ts",
            "sign",
            "--config",
            configPath,
            "--account",
            "live_wallet",
            "--in",
            fundUnsignedPath,
            "--out",
            fundSignedPath,
          ],
          { cwd: PROJECT_ROOT },
        );
        expect(
          (JSON.parse(signedFund.stdout) as { summary: { signed: number } }).summary.signed,
        ).toBeGreaterThan(0);

        const fundSubmit = await execa(
          "bun",
          [
            "src/cli.ts",
            "submit",
            "--config",
            configPath,
            "--in",
            fundSignedPath,
            "--channels-api-key",
            keyData.apiKey!,
          ],
          { cwd: PROJECT_ROOT },
        );
        const fundSubmitOut = JSON.parse(fundSubmit.stdout) as { hash: string; status: string };
        console.log(
          `[live.ssh-agent-1p] fund_hash=${fundSubmitOut.hash} status=${fundSubmitOut.status}`,
        );
        await waitForHorizonTransaction(fundSubmitOut.hash);

        // Phase 4: Send payment from smart account via SSH agent signing
        const recipientBalanceBefore = await getNativeBalanceStroops(recipient.publicKey());

        const paymentBundle = buildNativeTransferBundle(
          nativeAssetContractId,
          createOut.contract_id,
          recipient.publicKey(),
          10_000_000n,
        );
        writeFileSync(paymentUnsignedPath, JSON.stringify(paymentBundle), "utf8");

        const signedPayment = await execa(
          "bun",
          [
            "src/cli.ts",
            "sign",
            "--config",
            configPath,
            "--account",
            "live_wallet",
            "--in",
            paymentUnsignedPath,
            "--out",
            paymentSignedPath,
          ],
          { cwd: PROJECT_ROOT },
        );
        expect(
          (JSON.parse(signedPayment.stdout) as { summary: { signed: number } }).summary.signed,
        ).toBeGreaterThan(0);

        const paymentSubmit = await execa(
          "bun",
          [
            "src/cli.ts",
            "submit",
            "--config",
            configPath,
            "--in",
            paymentSignedPath,
            "--channels-api-key",
            keyData.apiKey!,
          ],
          { cwd: PROJECT_ROOT },
        );
        const paymentSubmitOut = JSON.parse(paymentSubmit.stdout) as {
          hash: string;
          status: string;
        };
        console.log(
          `[live.ssh-agent-1p] payment_hash=${paymentSubmitOut.hash} status=${paymentSubmitOut.status}`,
        );
        await waitForHorizonTransaction(paymentSubmitOut.hash);

        const recipientBalanceAfter = await getNativeBalanceStroops(recipient.publicKey());
        expect(recipientBalanceAfter - recipientBalanceBefore).toBeGreaterThanOrEqual(10_000_000n);
        console.log(
          `[live.ssh-agent-1p] balance change: ${recipientBalanceAfter - recipientBalanceBefore} stroops`,
        );
      } finally {
        try {
          await execa("op", ["item", "delete", uniqueTitle, "--vault", "Private"], {
            cwd: PROJECT_ROOT,
          });
        } catch {
          // cleanup best-effort
        }
      }
    },
  );
});

const LIVE_SYSTEM_ENABLED = LIVE_ENABLED && process.env.WALLETERM_LIVE_SSH_AGENT_SYSTEM === "1";

describe.skipIf(!LIVE_SYSTEM_ENABLED)("ssh-agent system generate live", () => {
  it(
    "generates a key file, deploys a wallet, signs a payment via system SSH agent, and verifies on-chain",
    { timeout: 240_000 },
    async () => {
      const rootDir = makeTempDir("walleterm-ssh-agent-system-live-");
      const keyPath = join(rootDir, "test_ed25519");

      try {
        // Phase 1: Generate SSH key via CLI
        const setup = await execa(
          "bun",
          [
            "src/cli.ts",
            "setup",
            "ssh-agent",
            "--backend",
            "system",
            "--generate",
            "--key-path",
            keyPath,
            "--json",
          ],
          { cwd: PROJECT_ROOT },
        );

        const setupOut = JSON.parse(setup.stdout) as {
          generated: boolean;
          key: { stellar_address: string; ref: string };
          key_path: string;
          public_key_path: string;
        };

        expect(setupOut.generated).toBe(true);
        expect(setupOut.key.stellar_address.startsWith("G")).toBe(true);
        expect(setupOut.key.ref.startsWith("ssh-agent://system/")).toBe(true);
        expect(existsSync(setupOut.key_path)).toBe(true);
        expect(existsSync(setupOut.public_key_path)).toBe(true);
        expect(statSync(setupOut.key_path).mode & 0o777).toBe(0o600);

        const sshStellarAddress = setupOut.key.stellar_address;
        const sshAgentRef = setupOut.key.ref;
        console.log(`[live.ssh-agent-system] generated key: ${sshStellarAddress} at ${keyPath}`);

        // Phase 2: Deploy a wallet with this key as delegated signer
        const configPath = join(rootDir, "walleterm.toml");
        const deployXdrPath = join(rootDir, "deploy.tx.xdr");
        const fundUnsignedPath = join(rootDir, "fund.bundle.json");
        const fundSignedPath = join(rootDir, "fund.signed.bundle.json");
        const paymentUnsignedPath = join(rootDir, "payment.bundle.json");
        const paymentSignedPath = join(rootDir, "payment.signed.bundle.json");

        const wasmHash = DEFAULT_WASM_HASH;
        const rpcUrl = "https://soroban-rpc.testnet.stellar.gateway.fm";
        const channelsBaseUrl = "https://channels.openzeppelin.com/testnet";
        const recipient = Keypair.random();
        const saltHex = randomBytes(32).toString("hex");

        const keyResponse = await fetch("https://channels.openzeppelin.com/testnet/gen");
        expect(keyResponse.ok).toBe(true);
        const keyData = (await keyResponse.json()) as { apiKey?: string };

        await fundWithFriendbot(sshStellarAddress);
        await fundWithFriendbot(recipient.publicKey());

        writeFileSync(
          configPath,
          `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "channels"

[networks.testnet]
rpc_url = "${rpcUrl}"
network_passphrase = "${Networks.TESTNET}"
channels_base_url = "${channelsBaseUrl}"

[smart_accounts]
`,
          "utf8",
        );

        const create = await execa(
          "bun",
          [
            "src/cli.ts",
            "wallet",
            "create",
            "--config",
            configPath,
            "--wasm-hash",
            wasmHash,
            "--delegated-address",
            sshStellarAddress,
            "--salt-hex",
            saltHex,
            "--submit",
            "--channels-api-key",
            keyData.apiKey!,
            "--out",
            deployXdrPath,
          ],
          { cwd: PROJECT_ROOT },
        );

        const createOut = JSON.parse(create.stdout) as {
          contract_id: string;
          submission?: { hash?: string; status?: string };
        };
        expect(createOut.contract_id.startsWith("C")).toBe(true);
        console.log(
          `[live.ssh-agent-system] contract_id=${createOut.contract_id} deploy_hash=${createOut.submission?.hash}`,
        );
        await waitForHorizonTransaction(createOut.submission!.hash!);

        // Wait for indexer to pick up the contract before strict_onchain reconciliation
        await waitForWalletLookup(
          ["--config", configPath, "--network", "testnet", "--contract-id", createOut.contract_id],
          process.env,
          (result) => result.count === 1 && (result.wallets?.[0]?.onchain_signers?.length ?? 0) > 0,
        );

        // Phase 3: Configure and sign via system SSH agent
        writeFileSync(
          configPath,
          `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "channels"

[networks.testnet]
rpc_url = "${rpcUrl}"
network_passphrase = "${Networks.TESTNET}"
channels_base_url = "${channelsBaseUrl}"

[smart_accounts.live_wallet]
network = "testnet"
contract_id = "${createOut.contract_id}"
expected_wasm_hash = "${wasmHash}"

[[smart_accounts.live_wallet.delegated_signers]]
name = "ssh_system_signer"
address = "${sshStellarAddress}"
secret_ref = "${sshAgentRef}"
enabled = true
`,
          "utf8",
        );

        const nativeAssetContractId = Asset.native().contractId(Networks.TESTNET);

        // Fund smart account
        const fundBundle = buildNativeTransferBundle(
          nativeAssetContractId,
          sshStellarAddress,
          createOut.contract_id,
          20_000_000n,
        );
        writeFileSync(fundUnsignedPath, JSON.stringify(fundBundle), "utf8");

        const signedFund = await execa(
          "bun",
          [
            "src/cli.ts",
            "sign",
            "--config",
            configPath,
            "--account",
            "live_wallet",
            "--in",
            fundUnsignedPath,
            "--out",
            fundSignedPath,
          ],
          { cwd: PROJECT_ROOT },
        );
        expect(
          (JSON.parse(signedFund.stdout) as { summary: { signed: number } }).summary.signed,
        ).toBeGreaterThan(0);

        const fundSubmit = await execa(
          "bun",
          [
            "src/cli.ts",
            "submit",
            "--config",
            configPath,
            "--in",
            fundSignedPath,
            "--channels-api-key",
            keyData.apiKey!,
          ],
          { cwd: PROJECT_ROOT },
        );
        const fundSubmitOut = JSON.parse(fundSubmit.stdout) as { hash: string; status: string };
        console.log(
          `[live.ssh-agent-system] fund_hash=${fundSubmitOut.hash} status=${fundSubmitOut.status}`,
        );
        await waitForHorizonTransaction(fundSubmitOut.hash);

        // Phase 4: Payment from smart account
        const recipientBalanceBefore = await getNativeBalanceStroops(recipient.publicKey());

        const paymentBundle = buildNativeTransferBundle(
          nativeAssetContractId,
          createOut.contract_id,
          recipient.publicKey(),
          10_000_000n,
        );
        writeFileSync(paymentUnsignedPath, JSON.stringify(paymentBundle), "utf8");

        const signedPayment = await execa(
          "bun",
          [
            "src/cli.ts",
            "sign",
            "--config",
            configPath,
            "--account",
            "live_wallet",
            "--in",
            paymentUnsignedPath,
            "--out",
            paymentSignedPath,
          ],
          { cwd: PROJECT_ROOT },
        );
        expect(
          (JSON.parse(signedPayment.stdout) as { summary: { signed: number } }).summary.signed,
        ).toBeGreaterThan(0);

        const paymentSubmit = await execa(
          "bun",
          [
            "src/cli.ts",
            "submit",
            "--config",
            configPath,
            "--in",
            paymentSignedPath,
            "--channels-api-key",
            keyData.apiKey!,
          ],
          { cwd: PROJECT_ROOT },
        );
        const paymentSubmitOut = JSON.parse(paymentSubmit.stdout) as {
          hash: string;
          status: string;
        };
        console.log(
          `[live.ssh-agent-system] payment_hash=${paymentSubmitOut.hash} status=${paymentSubmitOut.status}`,
        );
        await waitForHorizonTransaction(paymentSubmitOut.hash);

        const recipientBalanceAfter = await getNativeBalanceStroops(recipient.publicKey());
        expect(recipientBalanceAfter - recipientBalanceBefore).toBeGreaterThanOrEqual(10_000_000n);
        console.log(
          `[live.ssh-agent-system] balance change: ${recipientBalanceAfter - recipientBalanceBefore} stroops`,
        );
      } finally {
        try {
          await execa("ssh-add", ["-d", keyPath], { cwd: PROJECT_ROOT });
        } catch {
          // cleanup best-effort
        }
        try {
          if (existsSync(keyPath)) unlinkSync(keyPath);
          if (existsSync(`${keyPath}.pub`)) unlinkSync(`${keyPath}.pub`);
        } catch {
          // cleanup best-effort
        }
      }
    },
  );
});
