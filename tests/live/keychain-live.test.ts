import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
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

const maybeDescribe =
  process.env.WALLETERM_LIVE === "1" && process.env.WALLETERM_LIVE_KEYCHAIN === "1"
    ? describe
    : describe.skip;

async function deleteKeychain(path: string): Promise<void> {
  try {
    await execa("security", ["delete-keychain", path], { cwd: PROJECT_ROOT });
  } catch {
    // Ignore cleanup failures; the main test result is more important.
  }
}

maybeDescribe("walleterm live macOS keychain integration", () => {
  it(
    "creates and submits a new wallet on testnet using keychain:// refs and sends a native payment via smart account",
    { timeout: 240_000 },
    async () => {
      const rootDir = makeTempDir("walleterm-keychain-live-");
      const configPath = join(rootDir, "walleterm.toml");
      const deployXdrPath = join(rootDir, "deploy.tx.xdr");
      const signerBundlePath = join(rootDir, "add-signer.bundle.json");
      const fundUnsignedPath = join(rootDir, "fund-smart-account.bundle.json");
      const fundSignedPath = join(rootDir, "fund-smart-account.signed.bundle.json");
      const paymentUnsignedPath = join(rootDir, "smart-payment.bundle.json");
      const paymentSignedPath = join(rootDir, "smart-payment.signed.bundle.json");
      const keychainPath = join(rootDir, "walleterm-live.keychain-db");
      const keychainPassword = randomBytes(16).toString("hex");
      const service = `walleterm-live-${randomBytes(6).toString("hex")}`;
      const wasmHash = process.env.WALLETERM_KEYCHAIN_WASM_HASH ?? DEFAULT_WASM_HASH;
      const rpcUrl =
        process.env.WALLETERM_KEYCHAIN_TESTNET_RPC_URL ??
        "https://soroban-rpc.testnet.stellar.gateway.fm";
      const channelsBaseUrl =
        process.env.WALLETERM_KEYCHAIN_TESTNET_CHANNELS_BASE_URL ??
        "https://channels.openzeppelin.com/testnet";
      const contextRuleId = process.env.WALLETERM_KEYCHAIN_CONTEXT_RULE_ID ?? "0";
      const newSignerAddress = Keypair.random().publicKey();
      const recipient = Keypair.random();
      const saltHex = randomBytes(32).toString("hex");

      try {
        await execa("security", ["create-keychain", "-p", keychainPassword, keychainPath], {
          cwd: PROJECT_ROOT,
        });
        await execa("security", ["unlock-keychain", "-p", keychainPassword, keychainPath], {
          cwd: PROJECT_ROOT,
        });
        await execa("security", ["set-keychain-settings", "-t", "3600", keychainPath], {
          cwd: PROJECT_ROOT,
        });

        const setup = await execa(
          "bun",
          [
            "src/cli.ts",
            "setup",
            "keychain",
            "--network",
            "testnet",
            "--service",
            service,
            "--keychain",
            keychainPath,
            "--json",
          ],
          { cwd: PROJECT_ROOT },
        );

        const setupOut = JSON.parse(setup.stdout) as {
          delegated_public_key: string;
          refs: {
            delegated_seed_ref: string;
            channels_api_key_ref: string;
          };
        };

        const delegatedRef = setupOut.refs.delegated_seed_ref;
        const channelsApiKeyRef = setupOut.refs.channels_api_key_ref;
        const delegatedAddress = setupOut.delegated_public_key;

        const delegatedSeed = await execa(
          "security",
          ["find-generic-password", "-a", "delegated_seed", "-s", service, "-w", keychainPath],
          { cwd: PROJECT_ROOT },
        );
        expect(Keypair.fromSecret(delegatedSeed.stdout.trim()).publicKey()).toBe(delegatedAddress);

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
channels_api_key_ref = "${channelsApiKeyRef}"

[smart_accounts]
`,
          "utf8",
        );

        let createOut:
          | {
              contract_id: string;
              submitted: boolean;
              submission?: { hash?: string; mode?: string; status?: string };
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
                delegatedAddress,
                "--salt-hex",
                saltHex,
                "--submit",
                "--submit-mode",
                "channels",
                "--out",
                deployXdrPath,
              ],
              { cwd: PROJECT_ROOT },
            );
            createOut = JSON.parse(create.stdout) as {
              contract_id: string;
              submitted: boolean;
              submission?: { hash?: string; mode?: string; status?: string };
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
          `[live.keychain-live] contract_id=${createOut.contract_id} deploy_tx_hash=${createOut.submission?.hash ?? "unknown"} status=${createOut.submission?.status ?? "unknown"}`,
        );
        expect(readFileSync(deployXdrPath, "utf8").trim().length).toBeGreaterThan(0);

        await waitForHorizonTransaction(createOut.submission!.hash!);

        const lookupBySecretRef = await waitForWalletLookup(
          ["--config", configPath, "--network", "testnet", "--secret-ref", delegatedRef],
          process.env,
          (result) =>
            (result.wallets ?? []).some(
              (wallet) =>
                wallet.contract_id === createOut.contract_id &&
                (wallet.lookup_types ?? []).includes("delegated") &&
                (wallet.onchain_signers?.length ?? 0) > 0,
            ),
        );
        expect(
          lookupBySecretRef.wallets?.some((wallet) => wallet.contract_id === createOut.contract_id),
        ).toBe(true);

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
channels_api_key_ref = "${channelsApiKeyRef}"

[smart_accounts.live_wallet]
network = "testnet"
contract_id = "${createOut.contract_id}"
expected_wasm_hash = "${wasmHash}"

[[smart_accounts.live_wallet.delegated_signers]]
name = "primary_delegated"
address = "${delegatedAddress}"
secret_ref = "${delegatedRef}"
enabled = true
`,
          "utf8",
        );

        const nativeAssetContractId = Asset.native().contractId(Networks.TESTNET);

        await fundWithFriendbot(delegatedAddress);
        await fundWithFriendbot(recipient.publicKey());

        const fundBundle = buildNativeTransferBundle(
          nativeAssetContractId,
          delegatedAddress,
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
        expect(fundSubmitOut.request_kind).toBe("bundle");
        expect(typeof fundSubmitOut.hash).toBe("string");
        expect(["pending", "confirmed"]).toContain(fundSubmitOut.status);
        console.log(
          `[live.keychain-live] smart_account_fund_tx_hash=${fundSubmitOut.hash} status=${fundSubmitOut.status}`,
        );
        await waitForHorizonTransaction(fundSubmitOut.hash);

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
        expect(paymentSubmitOut.request_kind).toBe("bundle");
        expect(typeof paymentSubmitOut.hash).toBe("string");
        expect(["pending", "confirmed"]).toContain(paymentSubmitOut.status);
        console.log(
          `[live.keychain-live] smart_account_payment_tx_hash=${paymentSubmitOut.hash} status=${paymentSubmitOut.status}`,
        );
        await waitForHorizonTransaction(paymentSubmitOut.hash);

        const recipientBalanceAfter = await getNativeBalanceStroops(recipient.publicKey());
        expect(recipientBalanceAfter - recipientBalanceBefore).toBeGreaterThanOrEqual(10_000_000n);

        const mutate = await execa(
          "bun",
          [
            "src/cli.ts",
            "wallet",
            "signer",
            "add",
            "--config",
            configPath,
            "--network",
            "testnet",
            "--account",
            "live_wallet",
            "--context-rule-id",
            contextRuleId,
            "--delegated-address",
            newSignerAddress,
            "--out",
            signerBundlePath,
          ],
          { cwd: PROJECT_ROOT },
        );

        const mutateOut = JSON.parse(mutate.stdout) as {
          operation: string;
          summary: { signed: number };
        };
        expect(mutateOut.operation).toBe("add_signer");
        expect(mutateOut.summary.signed).toBeGreaterThan(0);
      } finally {
        await deleteKeychain(keychainPath);
      }
    },
  );
});
