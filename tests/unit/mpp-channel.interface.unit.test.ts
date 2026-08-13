import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const secretResolverMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock("../../src/secrets.js", () => ({
  isSshAgentRef: (ref: string) => ref.startsWith("ssh-agent://"),
  SecretResolver: class {
    resolve = secretResolverMocks.resolve;
    clearCache = secretResolverMocks.clearCache;
  },
}));

vi.mock("../../src/mpp-channel/lifecycle.js", () => ({
  openMppChannel: vi.fn(),
  topUpMppChannel: vi.fn(),
  getMppChannelStatus: vi.fn(),
  settleMppChannel: vi.fn(),
  closeMppChannel: vi.fn(),
  startMppChannelClose: vi.fn(),
  refundMppChannel: vi.fn(),
}));

import { executeMppChannelLifecycle } from "../../src/mpp-channel.js";
import {
  closeMppChannel,
  getMppChannelStatus,
  openMppChannel,
  refundMppChannel,
  settleMppChannel,
  startMppChannelClose,
  topUpMppChannel,
} from "../../src/mpp-channel/lifecycle.js";
import { applyMppChannelStateChange, resolveMppStatePath } from "../../src/mpp-channel/storage.js";

const openMock = vi.mocked(openMppChannel);
const topUpMock = vi.mocked(topUpMppChannel);
const statusMock = vi.mocked(getMppChannelStatus);
const settleMock = vi.mocked(settleMppChannel);
const closeMock = vi.mocked(closeMppChannel);
const closeStartMock = vi.mocked(startMppChannelClose);
const refundMock = vi.mocked(refundMppChannel);

function makeFixture() {
  const funder = Keypair.random();
  const recipient = Keypair.random();
  const directory = mkdtempSync(join(tmpdir(), "walleterm-mpp-interface-"));
  const configPath = join(directory, "walleterm.toml");
  writeFileSync(
    configPath,
    `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://rpc.example"
network_passphrase = "${Networks.TESTNET}"

[payments.mpp]
default_payer_secret_ref = "keychain://payer"

[payments.mpp.channel]
factory_contract_id = "CFACTORY"
token_contract_id = "CTOKEN"
recipient = "${recipient.publicKey()}"
recipient_secret_ref = "keychain://recipient"
default_deposit = "1000"
refund_waiting_period = 24
source_account = "${funder.publicKey()}"
state_file = ".state.json"

[smart_accounts]
`,
    "utf8",
  );

  const statePath = resolveMppStatePath(configPath, { state_file: ".state.json" });
  applyMppChannelStateChange(statePath, {
    type: "opened",
    channelId: "CCHANNEL",
    networkName: "testnet",
    networkPassphrase: Networks.TESTNET,
    sourceAccount: funder.publicKey(),
    secretRef: "keychain://payer",
    deposit: "1000",
    refundWaitingPeriod: 24,
    factoryContractId: "CFACTORY",
    tokenContractId: "CTOKEN",
    recipient: recipient.publicKey(),
    txHash: "tx-open",
  });
  const record = applyMppChannelStateChange(statePath, {
    type: "voucher-remembered",
    channelId: "CCHANNEL",
    networkName: "testnet",
    networkPassphrase: Networks.TESTNET,
    sourceAccount: funder.publicKey(),
    cumulativeAmount: "200",
    signatureHex: "a".repeat(128),
  });

  return { configPath, funder, recipient, record, statePath };
}

describe("MPP channel lifecycle interface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves open configuration and the funder credential behind the interface", async () => {
    const { configPath, funder, statePath } = makeFixture();
    secretResolverMocks.resolve.mockResolvedValue(funder.secret());
    openMock.mockImplementation(async (options) => ({
      channel_id: "COPENED",
      tx_hash: "tx-open",
      state_path: options.statePath,
      stored_channel: {
        channel_id: "COPENED",
        network_name: options.networkName,
        network_passphrase: options.networkPassphrase,
        source_account: options.keypair.publicKey(),
        updated_at: "2026-08-11T00:00:00.000Z",
      },
    }));

    const result = await executeMppChannelLifecycle({ action: "open", configPath });

    expect(result).toMatchObject({ tx_hash: "tx-open" });
    expect(secretResolverMocks.resolve).toHaveBeenCalledWith("keychain://payer");
    expect(secretResolverMocks.clearCache).toHaveBeenCalledOnce();
    expect(openMock).toHaveBeenCalledWith({
      rpcUrl: "https://rpc.example",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      keypair: expect.objectContaining({}),
      factoryContractId: "CFACTORY",
      tokenContractId: "CTOKEN",
      recipient: expect.any(String),
      deposit: 1000n,
      refundWaitingPeriod: 24,
      statePath,
      secretRef: "keychain://payer",
    });
  });

  it("selects the stored channel and remembered voucher for recipient settlement", async () => {
    const { configPath, recipient, record, statePath } = makeFixture();
    secretResolverMocks.resolve.mockResolvedValue(recipient.secret());
    settleMock.mockImplementation(async (options) => ({
      channel_id: options.channelId,
      tx_hash: "tx-settle",
      amount: options.amount.toString(),
      state_path: options.statePath,
      stored_channel: record,
    }));

    await executeMppChannelLifecycle({ action: "settle", configPath });

    expect(secretResolverMocks.resolve).toHaveBeenCalledWith("keychain://recipient");
    expect(settleMock).toHaveBeenCalledWith({
      rpcUrl: "https://rpc.example",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      keypair: expect.objectContaining({}),
      channelId: "CCHANNEL",
      amount: 200n,
      signatureHex: "a".repeat(128),
      statePath,
    });
  });

  it("checks the signer role before a funder transition", async () => {
    const { configPath, recipient } = makeFixture();
    secretResolverMocks.resolve.mockResolvedValue(recipient.secret());

    await expect(
      executeMppChannelLifecycle({
        action: "topup",
        configPath,
        amount: "50",
        secretRef: "keychain://wrong",
      }),
    ).rejects.toThrow(/does not match the channel funder/i);

    expect(topUpMock).not.toHaveBeenCalled();
    expect(secretResolverMocks.clearCache).toHaveBeenCalledOnce();
  });

  it("rejects an invalid seed before it starts an open transition", async () => {
    const { configPath } = makeFixture();
    secretResolverMocks.resolve.mockResolvedValue("not-a-seed");

    await expect(executeMppChannelLifecycle({ action: "open", configPath })).rejects.toThrow(
      /MPP channel credential must resolve to a valid Stellar secret seed/i,
    );

    expect(openMock).not.toHaveBeenCalled();
    expect(secretResolverMocks.clearCache).toHaveBeenCalledOnce();
  });

  it("returns status with the selected stored record", async () => {
    const { configPath, record } = makeFixture();
    statusMock.mockResolvedValue({
      channel_id: "CCHANNEL",
      network: "testnet",
      token: "CTOKEN",
      from: record.source_account,
      to: record.recipient!,
      deposited: "1000",
      withdrawn: "200",
      balance: "800",
      refund_waiting_period: 24,
      close_effective_at_ledger: null,
      current_ledger: 123,
    });

    const result = await executeMppChannelLifecycle({ action: "status", configPath });

    expect(result).toMatchObject({ channel_id: "CCHANNEL", stored: record });
    expect(statusMock).toHaveBeenCalledWith({
      rpcUrl: "https://rpc.example",
      networkPassphrase: Networks.TESTNET,
      channelId: "CCHANNEL",
      sourceAccount: record.source_account,
    });
    expect(secretResolverMocks.resolve).not.toHaveBeenCalled();
  });

  it("routes close, close-start, and refund through their required roles", async () => {
    const { configPath, funder, recipient, record } = makeFixture();
    secretResolverMocks.resolve.mockImplementation(async (ref: string) =>
      ref === "keychain://recipient" ? recipient.secret() : funder.secret(),
    );
    closeMock.mockImplementation(async (options) => ({
      channel_id: options.channelId,
      tx_hash: "tx-close",
      amount: options.amount.toString(),
      state_path: options.statePath,
      stored_channel: record,
    }));
    closeStartMock.mockImplementation(async (options) => ({
      channel_id: options.channelId,
      tx_hash: "tx-close-start",
      state_path: options.statePath,
      stored_channel: record,
    }));
    refundMock.mockImplementation(async (options) => ({
      channel_id: options.channelId,
      tx_hash: "tx-refund",
      state_path: options.statePath,
      stored_channel: record,
    }));

    await executeMppChannelLifecycle({ action: "close", configPath });
    await executeMppChannelLifecycle({ action: "close-start", configPath });
    await executeMppChannelLifecycle({ action: "refund", configPath });

    expect(closeMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 200n }));
    expect(closeStartMock).toHaveBeenCalledOnce();
    expect(refundMock).toHaveBeenCalledOnce();
    expect(secretResolverMocks.resolve.mock.calls.map(([ref]) => ref)).toEqual([
      "keychain://recipient",
      "keychain://payer",
      "keychain://payer",
    ]);
  });

  it("rejects an unknown lifecycle action instead of refunding", async () => {
    const { configPath, funder } = makeFixture();
    secretResolverMocks.resolve.mockResolvedValue(funder.secret());

    await expect(
      Reflect.apply(executeMppChannelLifecycle, undefined, [
        { action: "future-action", configPath },
      ]),
    ).rejects.toThrow("Unsupported MPP channel action.");

    expect(refundMock).not.toHaveBeenCalled();
  });
});
