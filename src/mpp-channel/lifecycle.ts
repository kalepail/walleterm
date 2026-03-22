import { randomBytes } from "node:crypto";
import { Address, Contract, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { close as closeChannelOnChain } from "stellar-mpp-sdk/channel/server";
import { passphraseToMppNetwork } from "../mpp.js";
import {
  readCloseEffectiveAtLedger,
  scValToBigInt,
  sendAndPollTransaction,
  simulateGetter,
} from "./rpc.js";
import { resolveStoredChannel, upsertStoredChannel } from "./storage.js";
import type {
  MppChannelStatus,
  MppChannelStatusOptions,
  MppCloseChannelOptions,
  MppOpenChannelOptions,
  MppRefundChannelOptions,
  MppSettleChannelOptions,
  MppStartCloseChannelOptions,
  MppTopUpChannelOptions,
} from "./types.js";

export async function openMppChannel(opts: MppOpenChannelOptions): Promise<{
  channel_id: string;
  tx_hash: string;
  state_path: string;
  stored_channel: ReturnType<typeof upsertStoredChannel>;
}> {
  const server = new rpc.Server(opts.rpcUrl);
  const account = await server.getAccount(opts.keypair.publicKey());
  const factory = new Contract(opts.factoryContractId);
  const salt = randomBytes(32);
  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(
      factory.call(
        "open",
        nativeToScVal(salt),
        new Address(opts.tokenContractId).toScVal(),
        new Address(opts.keypair.publicKey()).toScVal(),
        nativeToScVal(opts.keypair.rawPublicKey()),
        new Address(opts.recipient).toScVal(),
        nativeToScVal(opts.deposit, { type: "i128" }),
        nativeToScVal(opts.refundWaitingPeriod, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(opts.keypair);
  const txHash = await sendAndPollTransaction(server, prepared);
  const txResult = await server.getTransaction(txHash);
  const returnValue = txResult.status === "SUCCESS" ? txResult.returnValue : null;
  if (!returnValue) {
    throw new Error("open() returned no channel address");
  }
  const channelId = Address.fromScVal(returnValue).toString();

  const stored = upsertStoredChannel(opts.statePath, {
    channel_id: channelId,
    network_name: opts.networkName,
    network_passphrase: opts.networkPassphrase,
    source_account: opts.keypair.publicKey(),
    secret_ref: opts.secretRef,
    deposit: opts.deposit.toString(),
    cumulative_amount: "0",
    refund_waiting_period: opts.refundWaitingPeriod,
    factory_contract_id: opts.factoryContractId,
    token_contract_id: opts.tokenContractId,
    recipient: opts.recipient,
    lifecycle_state: "open",
    opened_tx_hash: txHash,
    updated_at: new Date().toISOString(),
  });

  return {
    channel_id: channelId,
    tx_hash: txHash,
    state_path: opts.statePath,
    stored_channel: stored,
  };
}

export async function topUpMppChannel(opts: MppTopUpChannelOptions): Promise<{
  channel_id: string;
  tx_hash: string;
  amount: string;
  state_path: string;
  stored_channel: ReturnType<typeof upsertStoredChannel>;
}> {
  const server = new rpc.Server(opts.rpcUrl);
  const account = await server.getAccount(opts.keypair.publicKey());
  const contract = new Contract(opts.channelId);
  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(contract.call("top_up", nativeToScVal(opts.amount, { type: "i128" })))
    .setTimeout(30)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(opts.keypair);
  const txHash = await sendAndPollTransaction(server, prepared);

  const existing = resolveStoredChannel(opts.statePath, opts.networkName, opts.channelId);
  const nextDeposit = existing?.deposit
    ? (BigInt(existing.deposit) + opts.amount).toString()
    : undefined;
  const stored = upsertStoredChannel(opts.statePath, {
    channel_id: opts.channelId,
    network_name: opts.networkName,
    network_passphrase: opts.networkPassphrase,
    source_account: opts.keypair.publicKey(),
    secret_ref: opts.secretRef ?? existing?.secret_ref,
    deposit: nextDeposit ?? opts.amount.toString(),
    cumulative_amount: existing?.cumulative_amount ?? "0",
    last_voucher_amount: existing?.last_voucher_amount,
    last_voucher_signature: existing?.last_voucher_signature,
    refund_waiting_period: existing?.refund_waiting_period,
    factory_contract_id: existing?.factory_contract_id,
    token_contract_id: existing?.token_contract_id,
    recipient: existing?.recipient,
    lifecycle_state: existing?.lifecycle_state ?? "open",
    opened_tx_hash: existing?.opened_tx_hash,
    last_topup_tx_hash: txHash,
    last_settle_tx_hash: existing?.last_settle_tx_hash,
    close_start_tx_hash: existing?.close_start_tx_hash,
    close_tx_hash: existing?.close_tx_hash,
    refund_tx_hash: existing?.refund_tx_hash,
    updated_at: new Date().toISOString(),
  });

  return {
    channel_id: opts.channelId,
    tx_hash: txHash,
    amount: opts.amount.toString(),
    state_path: opts.statePath,
    stored_channel: stored,
  };
}

export async function getMppChannelStatus(
  opts: MppChannelStatusOptions,
): Promise<MppChannelStatus> {
  const server = new rpc.Server(opts.rpcUrl);
  const [token, from, to, deposited, withdrawn, balance, refundWaitingPeriod] = await Promise.all([
    simulateGetter(server, opts.sourceAccount, opts.networkPassphrase, opts.channelId, "token"),
    simulateGetter(server, opts.sourceAccount, opts.networkPassphrase, opts.channelId, "from"),
    simulateGetter(server, opts.sourceAccount, opts.networkPassphrase, opts.channelId, "to"),
    simulateGetter(server, opts.sourceAccount, opts.networkPassphrase, opts.channelId, "deposited"),
    simulateGetter(server, opts.sourceAccount, opts.networkPassphrase, opts.channelId, "withdrawn"),
    simulateGetter(server, opts.sourceAccount, opts.networkPassphrase, opts.channelId, "balance"),
    simulateGetter(
      server,
      opts.sourceAccount,
      opts.networkPassphrase,
      opts.channelId,
      "refund_waiting_period",
    ),
  ]);
  const closeEffectiveAtLedger = await readCloseEffectiveAtLedger(server, opts.channelId);
  const latestLedger = await server.getLatestLedger();
  return {
    channel_id: opts.channelId,
    network: passphraseToMppNetwork(opts.networkPassphrase),
    token: Address.fromScVal(token).toString(),
    from: Address.fromScVal(from).toString(),
    to: Address.fromScVal(to).toString(),
    deposited: scValToBigInt(deposited).toString(),
    withdrawn: scValToBigInt(withdrawn).toString(),
    balance: scValToBigInt(balance).toString(),
    refund_waiting_period: refundWaitingPeriod.u32(),
    close_effective_at_ledger: closeEffectiveAtLedger,
    current_ledger: latestLedger.sequence,
  };
}

export async function closeMppChannel(opts: MppCloseChannelOptions): Promise<{
  channel_id: string;
  tx_hash: string;
  amount: string;
  state_path: string;
  stored_channel: ReturnType<typeof upsertStoredChannel>;
}> {
  if (!/^[0-9a-f]{128}$/i.test(opts.signatureHex)) {
    throw new Error("signature must be a 64-byte hex string");
  }
  const txHash = await closeChannelOnChain({
    channel: opts.channelId,
    amount: opts.amount,
    signature: Buffer.from(opts.signatureHex, "hex"),
    closeKey: opts.keypair,
    network: passphraseToMppNetwork(opts.networkPassphrase),
    rpcUrl: opts.rpcUrl,
  });

  const existing = resolveStoredChannel(opts.statePath, "", opts.channelId);
  const stored = upsertStoredChannel(
    opts.statePath,
    {
      channel_id: opts.channelId,
      network_name: existing?.network_name ?? "",
      network_passphrase: existing?.network_passphrase ?? opts.networkPassphrase,
      source_account: existing?.source_account ?? opts.keypair.publicKey(),
      secret_ref: existing?.secret_ref,
      deposit: existing?.deposit,
      cumulative_amount: opts.amount.toString(),
      last_voucher_amount: opts.amount.toString(),
      last_voucher_signature: opts.signatureHex,
      refund_waiting_period: existing?.refund_waiting_period,
      factory_contract_id: existing?.factory_contract_id,
      token_contract_id: existing?.token_contract_id,
      recipient: existing?.recipient,
      lifecycle_state: "closed",
      opened_tx_hash: existing?.opened_tx_hash,
      last_topup_tx_hash: existing?.last_topup_tx_hash,
      last_settle_tx_hash: existing?.last_settle_tx_hash,
      close_start_tx_hash: existing?.close_start_tx_hash,
      close_tx_hash: txHash,
      refund_tx_hash: existing?.refund_tx_hash,
      updated_at: new Date().toISOString(),
    },
    { makeActive: false, clearActive: true },
  );

  return {
    channel_id: opts.channelId,
    tx_hash: txHash,
    amount: opts.amount.toString(),
    state_path: opts.statePath,
    stored_channel: stored,
  };
}

export async function settleMppChannel(opts: MppSettleChannelOptions): Promise<{
  channel_id: string;
  tx_hash: string;
  amount: string;
  state_path: string;
  stored_channel: ReturnType<typeof upsertStoredChannel>;
}> {
  if (!/^[0-9a-f]{128}$/i.test(opts.signatureHex)) {
    throw new Error("signature must be a 64-byte hex string");
  }

  const server = new rpc.Server(opts.rpcUrl);
  const account = await server.getAccount(opts.keypair.publicKey());
  const contract = new Contract(opts.channelId);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "settle",
        nativeToScVal(opts.amount, { type: "i128" }),
        nativeToScVal(Buffer.from(opts.signatureHex, "hex"), { type: "bytes" }),
      ),
    )
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(opts.keypair);
  const txHash = await sendAndPollTransaction(server, prepared);

  const existing = resolveStoredChannel(opts.statePath, "", opts.channelId);
  const stored = upsertStoredChannel(opts.statePath, {
    channel_id: opts.channelId,
    network_name: existing?.network_name ?? opts.networkName,
    network_passphrase: existing?.network_passphrase ?? opts.networkPassphrase,
    source_account: existing?.source_account ?? "",
    secret_ref: existing?.secret_ref,
    deposit: existing?.deposit,
    cumulative_amount: opts.amount.toString(),
    last_voucher_amount: opts.amount.toString(),
    last_voucher_signature: opts.signatureHex,
    refund_waiting_period: existing?.refund_waiting_period,
    factory_contract_id: existing?.factory_contract_id,
    token_contract_id: existing?.token_contract_id,
    recipient: existing?.recipient,
    lifecycle_state: existing?.lifecycle_state ?? "open",
    opened_tx_hash: existing?.opened_tx_hash,
    last_topup_tx_hash: existing?.last_topup_tx_hash,
    last_settle_tx_hash: txHash,
    close_start_tx_hash: existing?.close_start_tx_hash,
    close_tx_hash: existing?.close_tx_hash,
    refund_tx_hash: existing?.refund_tx_hash,
    updated_at: new Date().toISOString(),
  });

  return {
    channel_id: opts.channelId,
    tx_hash: txHash,
    amount: opts.amount.toString(),
    state_path: opts.statePath,
    stored_channel: stored,
  };
}

export async function startMppChannelClose(opts: MppStartCloseChannelOptions): Promise<{
  channel_id: string;
  tx_hash: string;
  state_path: string;
  stored_channel: ReturnType<typeof upsertStoredChannel>;
}> {
  const server = new rpc.Server(opts.rpcUrl);
  const account = await server.getAccount(opts.keypair.publicKey());
  const contract = new Contract(opts.channelId);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(contract.call("close_start"))
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(opts.keypair);
  const txHash = await sendAndPollTransaction(server, prepared);

  const existing = resolveStoredChannel(opts.statePath, "", opts.channelId);
  const stored = upsertStoredChannel(opts.statePath, {
    channel_id: opts.channelId,
    network_name: existing?.network_name ?? opts.networkName,
    network_passphrase: existing?.network_passphrase ?? opts.networkPassphrase,
    source_account: existing?.source_account ?? opts.keypair.publicKey(),
    secret_ref: existing?.secret_ref,
    deposit: existing?.deposit,
    cumulative_amount: existing?.cumulative_amount,
    last_voucher_amount: existing?.last_voucher_amount,
    last_voucher_signature: existing?.last_voucher_signature,
    refund_waiting_period: existing?.refund_waiting_period,
    factory_contract_id: existing?.factory_contract_id,
    token_contract_id: existing?.token_contract_id,
    recipient: existing?.recipient,
    lifecycle_state: "closing",
    opened_tx_hash: existing?.opened_tx_hash,
    last_topup_tx_hash: existing?.last_topup_tx_hash,
    last_settle_tx_hash: existing?.last_settle_tx_hash,
    close_start_tx_hash: txHash,
    close_tx_hash: existing?.close_tx_hash,
    refund_tx_hash: existing?.refund_tx_hash,
    updated_at: new Date().toISOString(),
  });

  return {
    channel_id: opts.channelId,
    tx_hash: txHash,
    state_path: opts.statePath,
    stored_channel: stored,
  };
}

export async function refundMppChannel(opts: MppRefundChannelOptions): Promise<{
  channel_id: string;
  tx_hash: string;
  state_path: string;
  stored_channel: ReturnType<typeof upsertStoredChannel>;
}> {
  const server = new rpc.Server(opts.rpcUrl);
  const account = await server.getAccount(opts.keypair.publicKey());
  const contract = new Contract(opts.channelId);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(contract.call("refund"))
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(opts.keypair);
  const txHash = await sendAndPollTransaction(server, prepared);

  const existing = resolveStoredChannel(opts.statePath, "", opts.channelId);
  const stored = upsertStoredChannel(
    opts.statePath,
    {
      channel_id: opts.channelId,
      network_name: existing?.network_name ?? opts.networkName,
      network_passphrase: existing?.network_passphrase ?? opts.networkPassphrase,
      source_account: existing?.source_account ?? opts.keypair.publicKey(),
      secret_ref: existing?.secret_ref,
      deposit: existing?.deposit,
      cumulative_amount: existing?.cumulative_amount,
      last_voucher_amount: existing?.last_voucher_amount,
      last_voucher_signature: existing?.last_voucher_signature,
      refund_waiting_period: existing?.refund_waiting_period,
      factory_contract_id: existing?.factory_contract_id,
      token_contract_id: existing?.token_contract_id,
      recipient: existing?.recipient,
      lifecycle_state: "refunded",
      opened_tx_hash: existing?.opened_tx_hash,
      last_topup_tx_hash: existing?.last_topup_tx_hash,
      last_settle_tx_hash: existing?.last_settle_tx_hash,
      close_start_tx_hash: existing?.close_start_tx_hash,
      close_tx_hash: existing?.close_tx_hash,
      refund_tx_hash: txHash,
      updated_at: new Date().toISOString(),
    },
    { makeActive: false, clearActive: true },
  );

  return {
    channel_id: opts.channelId,
    tx_hash: txHash,
    state_path: opts.statePath,
    stored_channel: stored,
  };
}
