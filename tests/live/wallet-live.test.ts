import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Asset, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { makeTempDir } from "../helpers/temp-dir.js";
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

const maybeDescribe = process.env.WALLETERM_LIVE === "1" ? describe : describe.skip;

maybeDescribe("walleterm live checks", () => {
  it("verifies expected account WASM hash is available on testnet and mainnet", async () => {
    const wasmHash = Buffer.from(DEFAULT_WASM_HASH, "hex");

    const testnetRpc = new rpc.Server("https://soroban-rpc.testnet.stellar.gateway.fm");
    const mainnetRpc = new rpc.Server("https://rpc.lightsail.network/");

    const testnetWasm = await testnetRpc.getContractWasmByHash(wasmHash);
    const mainnetWasm = await mainnetRpc.getContractWasmByHash(wasmHash);

    expect(Buffer.isBuffer(testnetWasm)).toBe(true);
    expect(Buffer.isBuffer(mainnetWasm)).toBe(true);
    expect(testnetWasm.length).toBeGreaterThan(0);
    expect(mainnetWasm.length).toBeGreaterThan(0);
    expect(mainnetWasm.length).toBe(testnetWasm.length);
  });

  it("verifies testnet and mainnet indexers return live data", { timeout: 20_000 }, async () => {
    const testnetStatsResp = await fetch(
      "https://smart-account-indexer.sdf-ecosystem.workers.dev/api/stats",
    );
    expect(testnetStatsResp.ok).toBe(true);
    const testnetStats = (await testnetStatsResp.json()) as {
      stats: { total_events: string; unique_contracts: string };
    };

    const mainnetStatsResp = await fetch(
      "https://smart-account-indexer-mainnet.sdf-ecosystem.workers.dev/api/stats",
    );
    expect(mainnetStatsResp.ok).toBe(true);
    const mainnetStats = (await mainnetStatsResp.json()) as {
      stats: { total_events: string; unique_contracts: string };
    };

    expect(Number(testnetStats.stats.total_events)).toBeGreaterThan(0);
    expect(Number(testnetStats.stats.unique_contracts)).toBeGreaterThan(0);
    expect(Number(mainnetStats.stats.total_events)).toBeGreaterThan(0);
    expect(Number(mainnetStats.stats.unique_contracts)).toBeGreaterThan(0);

    const credsResp = await fetch(
      "https://smart-account-indexer.sdf-ecosystem.workers.dev/api/credentials",
    );
    expect(credsResp.ok).toBe(true);
    const credsData = (await credsResp.json()) as {
      credentials: Array<{ credential_id: string }>;
    };
    expect(credsData.credentials.length).toBeGreaterThan(0);

    const credentialId = credsData.credentials[0]!.credential_id;
    const lookupResp = await fetch(
      `https://smart-account-indexer.sdf-ecosystem.workers.dev/api/lookup/${credentialId}`,
    );
    expect(lookupResp.ok).toBe(true);
    const lookupData = (await lookupResp.json()) as {
      count: number;
      contracts: Array<{ contract_id: string }>;
    };

    expect(lookupData.count).toBeGreaterThan(0);
    expect(lookupData.contracts[0]!.contract_id.startsWith("C")).toBe(true);
    console.log(`[live.wallet-live] indexer_contract_id=${lookupData.contracts[0]!.contract_id}`);
  });

  it(
    "submits a signed testnet tx through channels and confirms on-chain",
    { timeout: 120_000 },
    async () => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const keyResponse = await fetch("https://channels.openzeppelin.com/testnet/gen");
          expect(keyResponse.ok).toBe(true);
          const keyData = (await keyResponse.json()) as { apiKey?: string };
          expect(typeof keyData.apiKey).toBe("string");

          const rootDir = makeTempDir("walleterm-live-submit-");
          const configPath = join(rootDir, "walleterm.toml");
          const opBinDir = join(rootDir, "bin");
          const opBinPath = join(opBinDir, "op");
          const txPath = join(rootDir, "tx.xdr");
          const deployerRef = "op://vault/walleterm/deployer_seed";
          const deployer = Keypair.random();
          const delegated = Keypair.random();
          const saltHex = randomBytes(32).toString("hex");
          const cliEnv = {
            ...process.env,
            WALLETERM_OP_BIN: opBinPath,
          };

          await fundWithFriendbot(deployer.publicKey());
          mkdirSync(opBinDir, { recursive: true });
          writeFileSync(
            opBinPath,
            `#!/usr/bin/env node
const ref = process.argv[3];
const map = {
  ${JSON.stringify(deployerRef)}: ${JSON.stringify(deployer.secret())},
};
if (process.argv[2] !== 'read' || !map[ref]) process.exit(1);
process.stdout.write(map[ref]);
`,
            "utf8",
          );
          chmodSync(opBinPath, 0o755);

          writeFileSync(
            configPath,
            `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "sign-only"

[networks.testnet]
rpc_url = "https://soroban-rpc.testnet.stellar.gateway.fm"
network_passphrase = "${Networks.TESTNET}"

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
              "--network",
              "testnet",
              "--deployer-secret-ref",
              deployerRef,
              "--wasm-hash",
              DEFAULT_WASM_HASH,
              "--delegated-address",
              delegated.publicKey(),
              "--salt-hex",
              saltHex,
              "--out",
              txPath,
            ],
            { cwd: PROJECT_ROOT, env: cliEnv },
          );
          const createOut = JSON.parse(create.stdout) as { contract_id: string };
          expect(createOut.contract_id.startsWith("C")).toBe(true);
          console.log(`[live.wallet-live] tx_submit_contract_id=${createOut.contract_id}`);

          const cli = await execa(
            "bun",
            [
              "src/cli.ts",
              "submit",
              "--config",
              configPath,
              "--network",
              "testnet",
              "--in",
              txPath,
              "--channels-base-url",
              "https://channels.openzeppelin.com/testnet",
              "--channels-api-key",
              keyData.apiKey!,
            ],
            { cwd: PROJECT_ROOT, env: cliEnv },
          );

          const out = JSON.parse(cli.stdout) as {
            mode: string;
            request_kind: string;
            hash: string;
            status: string;
          };
          expect(out.mode).toBe("channels");
          expect(out.request_kind).toBe("tx");
          expect(typeof out.hash).toBe("string");
          expect(out.hash.length).toBeGreaterThan(10);
          expect(["pending", "confirmed"]).toContain(out.status);
          console.log(`[live.wallet-live] channels_tx_hash=${out.hash} status=${out.status}`);

          await waitForHorizonTransaction(out.hash);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await sleep(1_500 * attempt);
          }
        }
      }

      throw lastError;
    },
  );

  it(
    "submits a smart-account native payment bundle and verifies recipient balance increase",
    { timeout: 240_000 },
    async () => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const keyResponse = await fetch("https://channels.openzeppelin.com/testnet/gen");
          expect(keyResponse.ok).toBe(true);
          const keyData = (await keyResponse.json()) as { apiKey?: string };
          expect(typeof keyData.apiKey).toBe("string");

          const rootDir = makeTempDir("walleterm-live-payment-");
          const configPath = join(rootDir, "walleterm.toml");
          const opBinDir = join(rootDir, "bin");
          const opBinPath = join(opBinDir, "op");
          const deployTxPath = join(rootDir, "deploy.tx.xdr");
          const fundUnsignedPath = join(rootDir, "fund.bundle.json");
          const fundSignedPath = join(rootDir, "fund.signed.bundle.json");
          const paymentUnsignedPath = join(rootDir, "payment.bundle.json");
          const paymentSignedPath = join(rootDir, "payment.signed.bundle.json");
          const delegatedRef = "op://vault/walleterm/delegated_seed";
          const deployerRef = "op://vault/walleterm/deployer_seed";

          const deployer = Keypair.random();
          const delegated = Keypair.random();
          const recipient = Keypair.random();
          const saltHex = randomBytes(32).toString("hex");
          const cliEnv = {
            ...process.env,
            WALLETERM_OP_BIN: opBinPath,
          };

          await fundWithFriendbot(deployer.publicKey());
          await fundWithFriendbot(delegated.publicKey());
          await fundWithFriendbot(recipient.publicKey());

          mkdirSync(opBinDir, { recursive: true });
          writeFileSync(
            opBinPath,
            `#!/usr/bin/env node
const ref = process.argv[3];
const map = {
  ${JSON.stringify(delegatedRef)}: ${JSON.stringify(delegated.secret())},
  ${JSON.stringify(deployerRef)}: ${JSON.stringify(deployer.secret())},
};
if (process.argv[2] !== 'read' || !map[ref]) process.exit(1);
process.stdout.write(map[ref]);
`,
            "utf8",
          );
          chmodSync(opBinPath, 0o755);

          writeFileSync(
            configPath,
            `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "sign-only"

[networks.testnet]
rpc_url = "https://soroban-rpc.testnet.stellar.gateway.fm"
network_passphrase = "${Networks.TESTNET}"

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
              "--network",
              "testnet",
              "--deployer-secret-ref",
              deployerRef,
              "--wasm-hash",
              DEFAULT_WASM_HASH,
              "--delegated-address",
              delegated.publicKey(),
              "--salt-hex",
              saltHex,
              "--submit",
              "--submit-mode",
              "channels",
              "--channels-base-url",
              "https://channels.openzeppelin.com/testnet",
              "--channels-api-key",
              keyData.apiKey!,
              "--out",
              deployTxPath,
            ],
            { cwd: PROJECT_ROOT, env: cliEnv },
          );

          const createOut = JSON.parse(create.stdout) as {
            contract_id: string;
            submitted: boolean;
            submission?: { hash?: string; status?: string; mode?: string };
          };
          expect(createOut.contract_id.startsWith("C")).toBe(true);
          expect(createOut.submitted).toBe(true);
          expect(createOut.submission?.mode).toBe("channels");
          expect(typeof createOut.submission?.hash).toBe("string");
          expect(["pending", "confirmed"]).toContain(createOut.submission?.status ?? "");
          console.log(
            `[live.wallet-live] contract_id=${createOut.contract_id} deploy_tx_hash=${createOut.submission?.hash ?? "unknown"} status=${createOut.submission?.status ?? "unknown"}`,
          );
          await waitForHorizonTransaction(createOut.submission!.hash!);

          const lookupByContract = await waitForWalletLookup(
            [
              "--config",
              configPath,
              "--network",
              "testnet",
              "--contract-id",
              createOut.contract_id,
            ],
            cliEnv,
            (result) =>
              result.count === 1 &&
              result.wallets?.[0]?.contract_id === createOut.contract_id &&
              (result.wallets[0]?.onchain_signers?.length ?? 0) > 0,
          );
          expect(lookupByContract.wallets?.[0]?.contract_id).toBe(createOut.contract_id);

          const lookupBySecretRef = await waitForWalletLookup(
            ["--config", configPath, "--network", "testnet", "--secret-ref", delegatedRef],
            cliEnv,
            (result) =>
              (result.wallets ?? []).some(
                (wallet) =>
                  wallet.contract_id === createOut.contract_id &&
                  (wallet.lookup_types ?? []).includes("delegated") &&
                  (wallet.onchain_signers?.length ?? 0) > 0,
              ),
          );
          expect(
            lookupBySecretRef.wallets?.some(
              (wallet) => wallet.contract_id === createOut.contract_id,
            ),
          ).toBe(true);

          writeFileSync(
            configPath,
            `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "sign-only"

[networks.testnet]
rpc_url = "https://soroban-rpc.testnet.stellar.gateway.fm"
network_passphrase = "${Networks.TESTNET}"

[smart_accounts.live_wallet]
network = "testnet"
contract_id = "${createOut.contract_id}"
expected_wasm_hash = "${DEFAULT_WASM_HASH}"

[[smart_accounts.live_wallet.delegated_signers]]
name = "primary"
address = "${delegated.publicKey()}"
secret_ref = "${delegatedRef}"
enabled = true
`,
            "utf8",
          );

          const nativeAssetContractId = Asset.native().contractId(Networks.TESTNET);

          const fundBundle = buildNativeTransferBundle(
            nativeAssetContractId,
            delegated.publicKey(),
            createOut.contract_id,
            20_000_000n,
          );
          writeFileSync(fundUnsignedPath, JSON.stringify(fundBundle), "utf8");

          const fundSign = await execa(
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
            { cwd: PROJECT_ROOT, env: cliEnv },
          );
          const fundSignOut = JSON.parse(fundSign.stdout) as { summary: { signed: number } };
          expect(fundSignOut.summary.signed).toBeGreaterThan(0);

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
              "--channels-base-url",
              "https://channels.openzeppelin.com/testnet",
              "--channels-api-key",
              keyData.apiKey!,
            ],
            { cwd: PROJECT_ROOT, env: cliEnv },
          );
          const fundSubmitOut = JSON.parse(fundSubmit.stdout) as {
            mode: string;
            request_kind: string;
            hash: string;
            status: string;
          };
          expect(fundSubmitOut.mode).toBe("channels");
          expect(fundSubmitOut.request_kind).toBe("bundle");
          expect(typeof fundSubmitOut.hash).toBe("string");
          expect(["pending", "confirmed"]).toContain(fundSubmitOut.status);
          await waitForHorizonTransaction(fundSubmitOut.hash);

          const beforeBalance = await getNativeBalanceStroops(recipient.publicKey());
          const paymentBundle = buildNativeTransferBundle(
            nativeAssetContractId,
            createOut.contract_id,
            recipient.publicKey(),
            10_000_000n,
          );
          writeFileSync(paymentUnsignedPath, JSON.stringify(paymentBundle), "utf8");

          const paymentSign = await execa(
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
            { cwd: PROJECT_ROOT, env: cliEnv },
          );
          const paymentSignOut = JSON.parse(paymentSign.stdout) as { summary: { signed: number } };
          expect(paymentSignOut.summary.signed).toBeGreaterThan(0);

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
              "--channels-base-url",
              "https://channels.openzeppelin.com/testnet",
              "--channels-api-key",
              keyData.apiKey!,
            ],
            { cwd: PROJECT_ROOT, env: cliEnv },
          );
          const paymentSubmitOut = JSON.parse(paymentSubmit.stdout) as {
            mode: string;
            request_kind: string;
            hash: string;
            status: string;
          };
          expect(paymentSubmitOut.mode).toBe("channels");
          expect(paymentSubmitOut.request_kind).toBe("bundle");
          expect(typeof paymentSubmitOut.hash).toBe("string");
          expect(["pending", "confirmed"]).toContain(paymentSubmitOut.status);
          console.log(
            `[live.wallet-live] smart_account_payment_tx_hash=${paymentSubmitOut.hash} status=${paymentSubmitOut.status}`,
          );
          await waitForHorizonTransaction(paymentSubmitOut.hash);

          const afterBalance = await getNativeBalanceStroops(recipient.publicKey());
          expect(afterBalance - beforeBalance).toBeGreaterThanOrEqual(10_000_000n);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await sleep(1_500 * attempt);
          }
        }
      }

      throw lastError;
    },
  );
});
