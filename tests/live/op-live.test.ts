import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Address, Asset, Keypair, Networks, xdr } from "@stellar/stellar-sdk";

const maybeDescribe =
  process.env.WALLETERM_LIVE === "1" && process.env.WALLETERM_LIVE_OP === "1"
    ? describe
    : describe.skip;

const PROJECT_ROOT = "/Users/kalepail/Desktop/walleterm";
const DEFAULT_WASM_HASH = "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOpRef(field: string): string {
  const vault = process.env.WALLETERM_OP_VAULT ?? "Private";
  const item = process.env.WALLETERM_OP_ITEM ?? "walleterm-testnet";
  return `op://${vault}/${item}/${field}`;
}

async function opRead(ref: string): Promise<string> {
  const result = await execa("op", ["read", ref], { cwd: PROJECT_ROOT });
  return result.stdout.trim();
}

async function assertOpSession(): Promise<void> {
  try {
    await execa("op", ["whoami"], { cwd: PROJECT_ROOT });
    return;
  } catch {
    // Always attempt signin for live OP tests when whoami fails.
    try {
      await execa("op", ["signin"], {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
      });
      await execa("op", ["whoami"], { cwd: PROJECT_ROOT });
    } catch {
      throw new Error(
        "op is not signed in. Signin was attempted but failed. Run `op signin` and retry.",
      );
    }
  }
}

async function waitForHorizonTransaction(hash: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`);
    if (response.ok) return;
    if (response.status !== 404) {
      throw new Error(`Horizon transaction lookup failed (${response.status})`);
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for Horizon transaction ${hash}`);
}

async function waitForWalletLookup(
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  predicate: (result: {
    count?: number;
    wallets?: Array<{ contract_id?: string; lookup_types?: string[]; onchain_signers?: unknown[] }>;
  }) => boolean,
): Promise<{
  count?: number;
  wallets?: Array<{ contract_id?: string; lookup_types?: string[]; onchain_signers?: unknown[] }>;
}> {
  let lastResult:
    | {
        count?: number;
        wallets?: Array<{
          contract_id?: string;
          lookup_types?: string[];
          onchain_signers?: unknown[];
        }>;
      }
    | undefined;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const lookup = await execa("bun", ["src/cli.ts", "wallet", "lookup", ...args], {
      cwd: PROJECT_ROOT,
      env,
    });
    const result = JSON.parse(lookup.stdout) as {
      count?: number;
      wallets?: Array<{
        contract_id?: string;
        lookup_types?: string[];
        onchain_signers?: unknown[];
      }>;
    };
    lastResult = result;
    if (predicate(result)) {
      return result;
    }
    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for wallet lookup to match: ${JSON.stringify(lastResult)}`);
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

maybeDescribe("walleterm live 1Password integration", () => {
  it(
    "creates and submits a new wallet on testnet using op:// refs and sends a native payment via smart account",
    { timeout: 240_000 },
    async () => {
      await assertOpSession();

      const delegatedRef = process.env.WALLETERM_OP_DELEGATED_REF ?? defaultOpRef("delegated_seed");
      const channelsApiKeyRef =
        process.env.WALLETERM_OP_CHANNELS_API_KEY_REF ?? defaultOpRef("channels_api_key");

      const wasmHash = process.env.WALLETERM_OP_WASM_HASH ?? DEFAULT_WASM_HASH;
      const rpcUrl =
        process.env.WALLETERM_OP_TESTNET_RPC_URL ??
        "https://soroban-rpc.testnet.stellar.gateway.fm";
      const channelsBaseUrl =
        process.env.WALLETERM_OP_TESTNET_CHANNELS_BASE_URL ??
        "https://channels.openzeppelin.com/testnet";
      const contextRuleId = process.env.WALLETERM_OP_CONTEXT_RULE_ID ?? "0";

      const delegatedSeed = await opRead(delegatedRef);
      const delegatedSigner = Keypair.fromSecret(delegatedSeed);

      const rootDir = mkdtempSync(join(tmpdir(), "walleterm-op-live-"));
      const configPath = join(rootDir, "walleterm.toml");
      const deployXdrPath = join(rootDir, "deploy.tx.xdr");
      const signerBundlePath = join(rootDir, "add-signer.bundle.json");
      const fundUnsignedPath = join(rootDir, "fund-smart-account.bundle.json");
      const fundSignedPath = join(rootDir, "fund-smart-account.signed.bundle.json");
      const paymentUnsignedPath = join(rootDir, "smart-payment.bundle.json");
      const paymentSignedPath = join(rootDir, "smart-payment.signed.bundle.json");
      const newSignerAddress = Keypair.random().publicKey();
      const saltHex = randomBytes(32).toString("hex");

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
          delegatedSigner.publicKey(),
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
        `[live.op-live] contract_id=${createOut.contract_id} deploy_tx_hash=${createOut.submission?.hash ?? "unknown"} status=${createOut.submission?.status ?? "unknown"}`,
      );
      expect(readFileSync(deployXdrPath, "utf8").trim().length).toBeGreaterThan(0);

      await waitForHorizonTransaction(createOut.submission!.hash!);

      const lookupByContract = await waitForWalletLookup(
        ["--config", configPath, "--network", "testnet", "--contract-id", createOut.contract_id],
        process.env,
        (result) =>
          result.count === 1 &&
          result.wallets?.[0]?.contract_id === createOut.contract_id &&
          (result.wallets[0]?.onchain_signers?.length ?? 0) > 0,
      );
      expect(lookupByContract.wallets?.[0]?.contract_id).toBe(createOut.contract_id);

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
address = "${delegatedSigner.publicKey()}"
secret_ref = "${delegatedRef}"
enabled = true
`,
        "utf8",
      );

      const nativeAssetContractId = Asset.native().contractId(Networks.TESTNET);
      const recipient = Keypair.random();

      await fundWithFriendbot(delegatedSigner.publicKey());
      await fundWithFriendbot(recipient.publicKey());

      const fundBundle = buildNativeTransferBundle(
        nativeAssetContractId,
        delegatedSigner.publicKey(),
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
        mode: string;
        request_kind: string;
        hash: string;
        status: string;
      };
      expect(fundSubmitOut.mode).toBe("channels");
      expect(fundSubmitOut.request_kind).toBe("bundle");
      expect(typeof fundSubmitOut.hash).toBe("string");
      expect(["pending", "confirmed"]).toContain(fundSubmitOut.status);
      console.log(
        `[live.op-live] smart_account_fund_tx_hash=${fundSubmitOut.hash} status=${fundSubmitOut.status}`,
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
        `[live.op-live] smart_account_payment_tx_hash=${paymentSubmitOut.hash} status=${paymentSubmitOut.status}`,
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

      const bundle = JSON.parse(readFileSync(signerBundlePath, "utf8")) as {
        func?: string;
        auth?: unknown[];
      };
      expect(typeof bundle.func).toBe("string");
      expect(Array.isArray(bundle.auth)).toBe(true);
      expect((bundle.auth ?? []).length).toBeGreaterThan(0);
    },
  );
});
