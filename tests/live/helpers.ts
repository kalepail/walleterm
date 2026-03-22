import { execa } from "execa";
import { randomBytes } from "node:crypto";
import {
  Address,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

export const PROJECT_ROOT = "/Users/kalepail/Desktop/walleterm";
export const DEFAULT_WASM_HASH = "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e";
export const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
export const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const X402_NFT_BASE_URL = "https://x402-nft.stellar.buzz";

export interface LiveWalletLookupResult {
  count?: number;
  wallets?: Array<{
    contract_id?: string;
    lookup_types?: string[];
    onchain_signers?: unknown[];
  }>;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForHorizonTransaction(hash: string): Promise<void> {
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

export async function waitForWalletLookup(
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  predicate: (result: LiveWalletLookupResult) => boolean,
): Promise<LiveWalletLookupResult> {
  let lastResult: LiveWalletLookupResult | undefined;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const lookup = await execa("bun", ["src/cli.ts", "wallet", "lookup", ...args], {
      cwd: PROJECT_ROOT,
      env,
    });
    const result = JSON.parse(lookup.stdout) as LiveWalletLookupResult;
    lastResult = result;
    if (predicate(result)) return result;
    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for wallet lookup to match: ${JSON.stringify(lastResult)}`);
}

export function xlmStringToStroops(amount: string): bigint {
  const [wholePart, fracPart = ""] = amount.split(".");
  const fracPadded = `${fracPart}0000000`.slice(0, 7);
  return BigInt(wholePart) * 10_000_000n + BigInt(fracPadded);
}

export async function getNativeBalanceStroops(address: string): Promise<bigint> {
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

export async function fundWithFriendbot(address: string): Promise<void> {
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

export async function ensureTestnetUsdcBalance(
  keypair: Keypair,
  sendAmount = "25",
): Promise<string> {
  await fundWithFriendbot(keypair.publicKey());

  const horizon = new Horizon.Server(TESTNET_HORIZON_URL);
  const usdcAsset = new Asset("USDC", TESTNET_USDC_ISSUER);

  let account = await horizon.loadAccount(keypair.publicKey());
  const hasTrustline = account.balances.some(
    (balance) => "asset_code" in balance && balance.asset_code === "USDC",
  );

  if (!hasTrustline) {
    const trustlineTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: usdcAsset }))
      .setTimeout(30)
      .build();

    trustlineTx.sign(keypair);
    const trustlineResult = await horizon.submitTransaction(trustlineTx);
    if (!trustlineResult.successful) {
      throw new Error("USDC trustline transaction failed");
    }
  }

  account = await horizon.loadAccount(keypair.publicKey());
  const existingBalance = account.balances.find(
    (balance) => "asset_code" in balance && balance.asset_code === "USDC",
  );
  if (existingBalance && Number(existingBalance.balance) > 0) {
    return existingBalance.balance;
  }

  const paths = await horizon.strictSendPaths(Asset.native(), sendAmount, [usdcAsset]).call();
  if (paths.records.length === 0) {
    throw new Error(`No DEX path found for XLM -> USDC using send amount ${sendAmount}`);
  }

  const bestPath = paths.records[0]!;
  account = await horizon.loadAccount(keypair.publicKey());
  const swapTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount,
        destination: keypair.publicKey(),
        destAsset: usdcAsset,
        destMin: "0.0000001",
        path: bestPath.path.map((asset) =>
          asset.asset_type === "native"
            ? Asset.native()
            : new Asset(asset.asset_code!, asset.asset_issuer!),
        ),
      }),
    )
    .setTimeout(30)
    .build();

  swapTx.sign(keypair);
  const swapResult = await horizon.submitTransaction(swapTx);
  if (!swapResult.successful) {
    throw new Error("USDC DEX swap transaction failed");
  }

  account = await horizon.loadAccount(keypair.publicKey());
  const usdcBalance = account.balances.find(
    (balance) => "asset_code" in balance && balance.asset_code === "USDC",
  );
  if (!usdcBalance) {
    throw new Error("USDC balance still missing after trustline and swap");
  }

  return usdcBalance.balance;
}

export function positiveNonceInt64(): xdr.Int64 {
  const raw = randomBytes(8);
  const value = BigInt(`0x${raw.toString("hex")}`) & ((1n << 63n) - 1n);
  return xdr.Int64.fromString(value.toString());
}

export function scvI128FromBigInt(value: bigint): xdr.ScVal {
  const loMask = (1n << 64n) - 1n;
  const hi = xdr.Int64.fromString((value >> 64n).toString());
  const lo = xdr.Uint64.fromString((value & loMask).toString());
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi, lo }));
}

export function buildNativeTransferBundle(
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
