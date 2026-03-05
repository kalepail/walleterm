import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Address, Asset, Keypair, Networks, rpc, xdr } from "@stellar/stellar-sdk";

const maybeDescribe = process.env.WALLETERM_LIVE === "1" ? describe : describe.skip;

const EXPECTED_WASM_HASH = "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e";
const PROJECT_ROOT = "/Users/kalepail/Desktop/walleterm";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHorizonTransaction(hash: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`);
    if (response.ok) {
      return;
    }
    if (response.status !== 404) {
      throw new Error(`Horizon transaction lookup failed (${response.status})`);
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for Horizon transaction ${hash}`);
}

function xlmStringToStroops(amount: string): bigint {
  const [wholePart, fracPart = ""] = amount.split(".");
  const fracPadded = `${fracPart}0000000`.slice(0, 7);
  return BigInt(wholePart) * 10_000_000n + BigInt(fracPadded);
}

async function getNativeBalanceStroops(address: string): Promise<bigint> {
  const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
  if (!response.ok) {
    throw new Error(`Failed to load horizon account ${address} (${response.status})`);
  }
  const data = (await response.json()) as {
    balances: Array<{ asset_type: string; balance: string }>;
  };
  const native = data.balances.find((b) => b.asset_type === "native");
  if (!native) {
    throw new Error(`No native balance found for ${address}`);
  }
  return xlmStringToStroops(native.balance);
}

async function fundWithFriendbot(address: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(
      `https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`,
    );
    if (response.ok) {
      return;
    }

    if (response.status === 400) {
      const horizon = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
      if (horizon.ok) {
        return;
      }
    }

    if (attempt < 3) {
      await sleep(1_000 * attempt);
      continue;
    }

    throw new Error(`Friendbot funding failed (${response.status})`);
  }
}

function positiveNonceInt64(): xdr.Int64 {
  const raw = randomBytes(8);
  const value = BigInt(`0x${raw.toString("hex")}`) & ((1n << 63n) - 1n);
  return xdr.Int64.fromString(value.toString());
}

function scvI128FromBigInt(value: bigint): xdr.ScVal {
  const loMask = (1n << 64n) - 1n;
  const hi = xdr.Int64.fromString((value >> 64n).toString());
  const lo = xdr.Uint64.fromString((value & loMask).toString());
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi, lo }));
}

function buildNativeTransferBundle(
  nativeAssetContractId: string,
  fromAddress: string,
  toAddress: string,
  amountStroops: bigint,
): { func: string; auth: string[] } {
  const args = [
    xdr.ScVal.scvAddress(Address.fromString(fromAddress).toScAddress()),
    xdr.ScVal.scvAddress(Address.fromString(toAddress).toScAddress()),
    scvI128FromBigInt(amountStroops),
  ];

  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(nativeAssetContractId).toScAddress(),
      functionName: "transfer",
      args,
    }),
  );

  const authEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(fromAddress).toScAddress(),
        nonce: positiveNonceInt64(),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(nativeAssetContractId).toScAddress(),
          functionName: "transfer",
          args,
        }),
      ),
      subInvocations: [],
    }),
  });

  return {
    func: hostFunction.toXDR("base64"),
    auth: [authEntry.toXDR("base64")],
  };
}

maybeDescribe("walleterm live checks", () => {
  it("verifies expected account WASM hash is available on testnet and mainnet", async () => {
    const wasmHash = Buffer.from(EXPECTED_WASM_HASH, "hex");

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

          const rootDir = mkdtempSync(join(tmpdir(), "walleterm-live-submit-"));
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
default_submit_mode = "channels"

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
              EXPECTED_WASM_HASH,
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

          const rootDir = mkdtempSync(join(tmpdir(), "walleterm-live-payment-"));
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
              EXPECTED_WASM_HASH,
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
expected_wasm_hash = "${EXPECTED_WASM_HASH}"

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
