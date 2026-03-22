import { Address, Contract, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";

export async function sendAndPollTransaction(
  server: rpc.Server,
  tx: Parameters<rpc.Server["sendTransaction"]>[0],
): Promise<string> {
  let result = await server.sendTransaction(tx);
  if (result.status === "TRY_AGAIN_LATER") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = await server.sendTransaction(tx);
  }
  if (result.status === "ERROR") {
    throw new Error(
      `Transaction rejected: ${result.errorResult?.result()?.switch().name ?? "ERROR"}`,
    );
  }

  let txResult = await server.getTransaction(result.hash);
  let attempts = 0;
  while (txResult.status === "NOT_FOUND") {
    if (++attempts >= 60) {
      throw new Error(`Transaction not found after ${attempts} polling attempts.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    txResult = await server.getTransaction(result.hash);
  }

  if (txResult.status !== "SUCCESS") {
    throw new Error(`Transaction failed on-chain: ${txResult.status}`);
  }

  return result.hash;
}

export function scValToBigInt(val: xdr.ScVal): bigint {
  const switchValue = val.switch().value;
  if (switchValue === xdr.ScValType.scvU32().value) return BigInt(val.u32());
  if (switchValue === xdr.ScValType.scvI32().value) return BigInt(val.i32());
  if (switchValue === xdr.ScValType.scvU64().value) return BigInt(val.u64().toString());
  if (switchValue === xdr.ScValType.scvI64().value) return BigInt(val.i64().toString());
  if (switchValue === xdr.ScValType.scvU128().value) {
    const parts = val.u128();
    return (
      (BigInt(parts.hi().toString()) << 64n) | (BigInt(parts.lo().toString()) & 0xffffffffffffffffn)
    );
  }
  if (switchValue === xdr.ScValType.scvI128().value) {
    const parts = val.i128();
    return (
      (BigInt(parts.hi().toString()) << 64n) | (BigInt(parts.lo().toString()) & 0xffffffffffffffffn)
    );
  }
  throw new Error(`Cannot convert ScVal type ${switchValue} to BigInt`);
}

export async function simulateGetter(
  server: rpc.Server,
  sourceAccount: string,
  networkPassphrase: string,
  channelId: string,
  fnName: string,
): Promise<xdr.ScVal> {
  const contract = new Contract(channelId);
  const account = await server.getAccount(sourceAccount);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(contract.call(fnName))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(result)) {
    throw new Error(
      `Failed to simulate ${fnName}: ${"error" in result ? result.error : "unknown error"}`,
    );
  }
  if (!result.result?.retval) {
    throw new Error(`Simulation returned no value for ${fnName}`);
  }
  return result.result.retval;
}

function isEnumVariant(scVal: xdr.ScVal, name: string): boolean {
  try {
    if (scVal.switch().value !== xdr.ScValType.scvVec().value) return false;
    const vec = scVal.vec();
    if (!vec || vec.length !== 1) return false;
    return (
      vec[0]?.switch().value === xdr.ScValType.scvSymbol().value && vec[0].sym().toString() === name
    );
  } catch {
    return false;
  }
}

export async function readCloseEffectiveAtLedger(
  server: rpc.Server,
  channelId: string,
): Promise<number | null> {
  try {
    const contractId = Address.fromString(channelId);
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractId.toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const response = await server.getLedgerEntries(key);
    const entry = response.entries?.[0];
    if (!entry) return null;
    const storage = entry.val.contractData().val().instance().storage();
    if (!storage) return null;
    for (const row of storage) {
      if (isEnumVariant(row.key(), "CloseEffectiveAtLedger")) {
        return row.val().u32();
      }
    }
    return null;
  } catch {
    return null;
  }
}
