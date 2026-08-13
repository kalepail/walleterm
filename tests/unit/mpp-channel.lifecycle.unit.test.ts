import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  Address,
  Keypair,
  Networks,
  rpc,
  StrKey,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/mpp-channel/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/mpp-channel/rpc.js")>(
    "../../src/mpp-channel/rpc.js",
  );
  return {
    ...actual,
    sendAndPollTransaction: vi.fn(),
    simulateGetter: vi.fn(),
    readCloseEffectiveAtLedger: vi.fn(),
  };
});

vi.mock("stellar-mpp-sdk/channel/server", () => ({
  close: vi.fn(),
}));

import {
  closeMppChannel,
  getMppChannelStatus,
  openMppChannel,
  refundMppChannel,
  settleMppChannel,
  startMppChannelClose,
  topUpMppChannel,
} from "../../src/mpp-channel/lifecycle.js";
import {
  readCloseEffectiveAtLedger,
  sendAndPollTransaction,
  simulateGetter,
} from "../../src/mpp-channel/rpc.js";
import { applyMppChannelStateChange, resolveStoredChannel } from "../../src/mpp-channel/storage.js";
import { close as closeChannelOnChain } from "stellar-mpp-sdk/channel/server";

function makeStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "walleterm-mpp-channel-"));
  return join(dir, "state.json");
}

describe("mpp-channel lifecycle", () => {
  const getAccountSpy = vi.spyOn(rpc.Server.prototype, "getAccount");
  const prepareTransactionSpy = vi.spyOn(rpc.Server.prototype, "prepareTransaction");
  const getTransactionSpy = vi.spyOn(rpc.Server.prototype, "getTransaction");
  const getLatestLedgerSpy = vi.spyOn(rpc.Server.prototype, "getLatestLedger");

  const sendAndPollTransactionMock = vi.mocked(sendAndPollTransaction);
  const simulateGetterMock = vi.mocked(simulateGetter);
  const readCloseEffectiveAtLedgerMock = vi.mocked(readCloseEffectiveAtLedger);
  const closeChannelOnChainMock = vi.mocked(closeChannelOnChain);

  beforeEach(() => {
    getAccountSpy.mockImplementation(async (accountId) => new Account(String(accountId), "1"));
    prepareTransactionSpy.mockImplementation(
      async (tx) => tx as Awaited<ReturnType<(typeof rpc.Server.prototype)["prepareTransaction"]>>,
    );
    getTransactionSpy.mockReset();
    getLatestLedgerSpy.mockReset();
    sendAndPollTransactionMock.mockReset();
    simulateGetterMock.mockReset();
    readCloseEffectiveAtLedgerMock.mockReset();
    closeChannelOnChainMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens a channel and persists the returned channel id", async () => {
    const keypair = Keypair.random();
    const statePath = makeStatePath();
    const channelId = StrKey.encodeContract(Buffer.alloc(32, 9));

    sendAndPollTransactionMock.mockResolvedValue("tx-open");
    getTransactionSpy.mockResolvedValue({
      status: "SUCCESS",
      returnValue: new Address(channelId).toScVal(),
    } as Awaited<ReturnType<(typeof rpc.Server.prototype)["getTransaction"]>>);

    const result = await openMppChannel({
      rpcUrl: "https://rpc.example",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      keypair,
      factoryContractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
      tokenContractId: StrKey.encodeContract(Buffer.alloc(32, 2)),
      recipient: Keypair.random().publicKey(),
      deposit: 1000n,
      refundWaitingPeriod: 24,
      statePath,
      secretRef: "keychain://payer",
    });

    expect(result.channel_id).toBe(channelId);
    expect(result.stored_channel.deposit).toBe("1000");
    expect(resolveStoredChannel(statePath, "testnet")?.channel_id).toBe(channelId);
  });

  it("tops up an existing channel and preserves prior metadata", async () => {
    const keypair = Keypair.random();
    const statePath = makeStatePath();
    const channelId = StrKey.encodeContract(Buffer.alloc(32, 6));
    applyMppChannelStateChange(statePath, {
      type: "opened",
      channelId,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      secretRef: "keychain://payer",
      deposit: "100",
      refundWaitingPeriod: 24,
      factoryContractId: "CFACTORY",
      tokenContractId: "CTOKEN",
      recipient: Keypair.random().publicKey(),
      txHash: "tx-open",
    });
    applyMppChannelStateChange(statePath, {
      type: "voucher-remembered",
      channelId,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      cumulativeAmount: "25",
      signatureHex: "a".repeat(128),
    });
    sendAndPollTransactionMock.mockResolvedValue("tx-topup");

    const result = await topUpMppChannel({
      rpcUrl: "https://rpc.example",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      keypair,
      channelId,
      amount: 50n,
      statePath,
    });

    expect(result.amount).toBe("50");
    expect(result.stored_channel.deposit).toBe("150");
    expect(result.stored_channel.secret_ref).toBe("keychain://payer");
    expect(result.stored_channel.last_topup_tx_hash).toBe("tx-topup");
  });

  it("builds MPP channel status from contract getters and ledger state", async () => {
    const token = StrKey.encodeContract(Buffer.alloc(32, 7));
    const from = Keypair.random().publicKey();
    const to = Keypair.random().publicKey();

    simulateGetterMock.mockImplementation(
      async (_server, _account, _passphrase, _channelId, fnName) => {
        switch (fnName) {
          case "token":
            return new Address(token).toScVal();
          case "from":
            return new Address(from).toScVal();
          case "to":
            return new Address(to).toScVal();
          case "deposited":
            return nativeToScVal(1000n, { type: "i128" });
          case "withdrawn":
            return nativeToScVal(250n, { type: "i128" });
          case "balance":
            return nativeToScVal(750n, { type: "i128" });
          case "refund_waiting_period":
            return nativeToScVal(24, { type: "u32" });
          default:
            throw new Error(`unexpected getter ${fnName}`);
        }
      },
    );
    readCloseEffectiveAtLedgerMock.mockResolvedValue(99);
    getLatestLedgerSpy.mockResolvedValue({ sequence: 12345 } as Awaited<
      ReturnType<(typeof rpc.Server.prototype)["getLatestLedger"]>
    >);

    const result = await getMppChannelStatus({
      rpcUrl: "https://rpc.example",
      networkPassphrase: Networks.TESTNET,
      channelId: StrKey.encodeContract(Buffer.alloc(32, 8)),
      sourceAccount: from,
    });

    expect(result).toEqual({
      channel_id: StrKey.encodeContract(Buffer.alloc(32, 8)),
      network: "testnet",
      token,
      from,
      to,
      deposited: "1000",
      withdrawn: "250",
      balance: "750",
      refund_waiting_period: 24,
      close_effective_at_ledger: 99,
      current_ledger: 12345,
    });
  });

  it("rejects invalid signatures before closing or settling", async () => {
    const keypair = Keypair.random();

    await expect(
      closeMppChannel({
        rpcUrl: "https://rpc.example",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: StrKey.encodeContract(Buffer.alloc(32, 10)),
        amount: 10n,
        signatureHex: "deadbeef",
        statePath: makeStatePath(),
      }),
    ).rejects.toThrow(/64-byte hex/i);

    await expect(
      settleMppChannel({
        rpcUrl: "https://rpc.example",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: StrKey.encodeContract(Buffer.alloc(32, 11)),
        amount: 10n,
        signatureHex: "deadbeef",
        statePath: makeStatePath(),
      }),
    ).rejects.toThrow(/64-byte hex/i);
  });

  it("rejects invalid state before any RPC submission", async () => {
    const keypair = Keypair.random();
    const statePath = makeStatePath();
    const storeOpenChannel = (channelId: string) => {
      applyMppChannelStateChange(statePath, {
        type: "opened",
        channelId,
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        sourceAccount: keypair.publicKey(),
        deposit: "1000",
        refundWaitingPeriod: 24,
        factoryContractId: "CFACTORY",
        tokenContractId: "CTOKEN",
        recipient: Keypair.random().publicKey(),
        txHash: "tx-open",
      });
    };

    const closingChannelId = StrKey.encodeContract(Buffer.alloc(32, 13));
    storeOpenChannel(closingChannelId);
    applyMppChannelStateChange(statePath, {
      type: "close-started",
      channelId: closingChannelId,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      txHash: "tx-close-start",
    });

    await expect(
      topUpMppChannel({
        rpcUrl: "https://rpc.example",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: closingChannelId,
        amount: 10n,
        statePath,
      }),
    ).rejects.toThrow(/not allowed from lifecycle state 'closing'/);
    await expect(
      settleMppChannel({
        rpcUrl: "https://rpc.example",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: closingChannelId,
        amount: 10n,
        signatureHex: "a".repeat(128),
        statePath,
      }),
    ).rejects.toThrow(/not allowed from lifecycle state 'closing'/);
    await expect(
      startMppChannelClose({
        rpcUrl: "https://rpc.example",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: closingChannelId,
        statePath,
      }),
    ).rejects.toThrow(/not allowed from lifecycle state 'closing'/);

    const openChannelId = StrKey.encodeContract(Buffer.alloc(32, 14));
    storeOpenChannel(openChannelId);
    await expect(
      refundMppChannel({
        rpcUrl: "https://rpc.example",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: openChannelId,
        statePath,
      }),
    ).rejects.toThrow(/not allowed from lifecycle state 'open'/);

    const closedChannelId = StrKey.encodeContract(Buffer.alloc(32, 15));
    storeOpenChannel(closedChannelId);
    applyMppChannelStateChange(statePath, {
      type: "closed",
      channelId: closedChannelId,
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      cumulativeAmount: "0",
      signatureHex: "b".repeat(128),
      txHash: "tx-close",
    });
    await expect(
      closeMppChannel({
        rpcUrl: "https://rpc.example",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: closedChannelId,
        amount: 0n,
        signatureHex: "b".repeat(128),
        statePath,
      }),
    ).rejects.toThrow(/not allowed from lifecycle state 'closed'/);

    await expect(
      topUpMppChannel({
        rpcUrl: "https://rpc.example",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: StrKey.encodeContract(Buffer.alloc(32, 16)),
        amount: 10n,
        statePath,
      }),
    ).rejects.toThrow(/does not exist/);

    const regressionChannelId = StrKey.encodeContract(Buffer.alloc(32, 17));
    storeOpenChannel(regressionChannelId);
    applyMppChannelStateChange(statePath, {
      type: "voucher-remembered",
      channelId: regressionChannelId,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      cumulativeAmount: "100",
      signatureHex: "c".repeat(128),
    });
    await expect(
      settleMppChannel({
        rpcUrl: "https://rpc.example",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        keypair,
        channelId: regressionChannelId,
        amount: 99n,
        signatureHex: "d".repeat(128),
        statePath,
      }),
    ).rejects.toThrow(/is below stored amount/);

    expect(getAccountSpy).not.toHaveBeenCalled();
    expect(prepareTransactionSpy).not.toHaveBeenCalled();
    expect(sendAndPollTransactionMock).not.toHaveBeenCalled();
    expect(closeChannelOnChainMock).not.toHaveBeenCalled();
  });

  it("closes, settles, starts close, and refunds while updating stored state", async () => {
    const keypair = Keypair.random();
    const statePath = makeStatePath();
    const channelId = StrKey.encodeContract(Buffer.alloc(32, 12));
    applyMppChannelStateChange(statePath, {
      type: "opened",
      channelId,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      secretRef: "keychain://payer",
      deposit: "1000",
      refundWaitingPeriod: 24,
      factoryContractId: "CFACTORY",
      tokenContractId: "CTOKEN",
      recipient: Keypair.random().publicKey(),
      txHash: "tx-open",
    });
    applyMppChannelStateChange(statePath, {
      type: "voucher-remembered",
      channelId,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      cumulativeAmount: "100",
      signatureHex: "a".repeat(128),
    });

    sendAndPollTransactionMock
      .mockResolvedValueOnce("tx-settle")
      .mockResolvedValueOnce("tx-close-start")
      .mockResolvedValueOnce("tx-refund");
    closeChannelOnChainMock.mockResolvedValue("tx-close");

    const settleResult = await settleMppChannel({
      rpcUrl: "https://rpc.example",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      keypair,
      channelId,
      amount: 250n,
      signatureHex: "b".repeat(128),
      statePath,
    });
    expect(settleResult.stored_channel.last_settle_tx_hash).toBe("tx-settle");
    expect(settleResult.stored_channel.cumulative_amount).toBe("250");

    const closeStartResult = await startMppChannelClose({
      rpcUrl: "https://rpc.example",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      keypair,
      channelId,
      statePath,
    });
    expect(closeStartResult.stored_channel.lifecycle_state).toBe("closing");
    expect(closeStartResult.stored_channel.close_start_tx_hash).toBe("tx-close-start");

    const closeResult = await closeMppChannel({
      rpcUrl: "https://rpc.example",
      networkPassphrase: Networks.TESTNET,
      keypair,
      channelId,
      amount: 300n,
      signatureHex: "c".repeat(128),
      statePath,
    });
    expect(closeResult.stored_channel.lifecycle_state).toBe("closed");
    expect(resolveStoredChannel(statePath, "testnet")).toBeNull();

    const refundChannelId = StrKey.encodeContract(Buffer.alloc(32, 18));
    applyMppChannelStateChange(statePath, {
      type: "opened",
      channelId: refundChannelId,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      deposit: "1000",
      refundWaitingPeriod: 24,
      factoryContractId: "CFACTORY",
      tokenContractId: "CTOKEN",
      recipient: Keypair.random().publicKey(),
      txHash: "tx-open-refund",
    });
    applyMppChannelStateChange(statePath, {
      type: "close-started",
      channelId: refundChannelId,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: keypair.publicKey(),
      txHash: "tx-close-start-refund",
    });
    const refundResult = await refundMppChannel({
      rpcUrl: "https://rpc.example",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      keypair,
      channelId: refundChannelId,
      statePath,
    });
    expect(refundResult.stored_channel.lifecycle_state).toBe("refunded");
    expect(refundResult.stored_channel.refund_tx_hash).toBe("tx-refund");
    expect(resolveStoredChannel(statePath, "testnet")).toBeNull();
  });
});
