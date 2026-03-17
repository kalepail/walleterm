import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Address, Asset, Keypair, Networks, StrKey, xdr } from "@stellar/stellar-sdk";
import { makeTempDir } from "../helpers/temp-dir.js";
import {
  listAgentIdentities,
  agentSign,
  buildEd25519KeyBlob,
  buildSshAgentRef,
} from "../../src/ssh-agent.js";

const LIVE_ENABLED =
  process.env.WALLETERM_LIVE === "1" && process.env.WALLETERM_LIVE_SSH_AGENT === "1";

const PROJECT_ROOT = "/Users/kalepail/Desktop/walleterm";
const DEFAULT_WASM_HASH = "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    if (predicate(result)) return result;
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
    if (response.ok) return;

    if (response.status === 400) {
      const horizon = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
      if (horizon.ok) return;
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
