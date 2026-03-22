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
import { resolveStoredChannel, upsertStoredChannel } from "../../src/mpp-channel/storage.js";
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
    upsertStoredChannel(statePath, {
      channel_id: channelId,
      network_name: "testnet",
      network_passphrase: Networks.TESTNET,
      source_account: keypair.publicKey(),
      secret_ref: "keychain://payer",
      deposit: "100",
      cumulative_amount: "25",
      last_voucher_amount: "25",
      last_voucher_signature: "a".repeat(128),
      refund_waiting_period: 24,
      factory_contract_id: "CFACTORY",
      token_contract_id: "CTOKEN",
      recipient: Keypair.random().publicKey(),
      lifecycle_state: "open",
      opened_tx_hash: "tx-open",
      updated_at: new Date().toISOString(),
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

  it("closes, settles, starts close, and refunds while updating stored state", async () => {
    const keypair = Keypair.random();
    const statePath = makeStatePath();
    const channelId = StrKey.encodeContract(Buffer.alloc(32, 12));
    upsertStoredChannel(statePath, {
      channel_id: channelId,
      network_name: "testnet",
      network_passphrase: Networks.TESTNET,
      source_account: keypair.publicKey(),
      secret_ref: "keychain://payer",
      deposit: "1000",
      cumulative_amount: "100",
      last_voucher_amount: "100",
      last_voucher_signature: "a".repeat(128),
      refund_waiting_period: 24,
      lifecycle_state: "open",
      opened_tx_hash: "tx-open",
      updated_at: new Date().toISOString(),
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

    upsertStoredChannel(statePath, {
      ...closeResult.stored_channel,
      network_name: "testnet",
      lifecycle_state: "closing",
      updated_at: new Date().toISOString(),
    });
    const refundResult = await refundMppChannel({
      rpcUrl: "https://rpc.example",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      keypair,
      channelId,
      statePath,
    });
    expect(refundResult.stored_channel.lifecycle_state).toBe("refunded");
    expect(refundResult.stored_channel.refund_tx_hash).toBe("tx-refund");
    expect(resolveStoredChannel(statePath, "testnet")).toBeNull();
  });
});
