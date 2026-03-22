import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSecurityFixture } from "../helpers/fake-security.js";
import { runCliInProcess } from "../helpers/run-cli.js";
import { makeTempDir } from "../helpers/temp-dir.js";

vi.mock("../../src/mpp-channel.js", async () => {
  return {
    resolveMppStatePath: vi.fn((configPath: string) => `${configPath}.mpp-state.json`),
    resolveStoredChannel: vi.fn((_statePath: string, networkName: string, channelId?: string) =>
      channelId
        ? {
            channel_id: channelId,
            network_name: networkName,
            network_passphrase: "Test SDF Network ; September 2015",
            secret_ref: "keychain://walleterm-test/default_payer",
            deposit: "10000000",
            cumulative_amount: "200",
            last_voucher_amount: "200",
            last_voucher_signature: "a".repeat(128),
            updated_at: "2026-03-20T00:00:00.000Z",
          }
        : {
            channel_id: "CDEFAULTCHANNEL",
            network_name: networkName,
            network_passphrase: "Test SDF Network ; September 2015",
            secret_ref: "keychain://walleterm-test/default_payer",
            deposit: "10000000",
            cumulative_amount: "200",
            last_voucher_amount: "200",
            last_voucher_signature: "a".repeat(128),
            updated_at: "2026-03-20T00:00:00.000Z",
          },
    ),
    rememberMppVoucher: vi.fn(),
    openMppChannel: vi.fn(async (opts) => ({
      channel_id: "COPENEDCHANNEL",
      tx_hash: "tx-open",
      state_path: opts.statePath,
      stored_channel: {
        channel_id: "COPENEDCHANNEL",
        network_name: opts.networkName,
        network_passphrase: opts.networkPassphrase,
        source_account: opts.keypair.publicKey(),
        secret_ref: opts.secretRef,
        deposit: opts.deposit.toString(),
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    })),
    topUpMppChannel: vi.fn(async (opts) => ({
      channel_id: opts.channelId,
      tx_hash: "tx-topup",
      amount: opts.amount.toString(),
      state_path: opts.statePath,
      stored_channel: {
        channel_id: opts.channelId,
        network_name: opts.networkName,
        network_passphrase: opts.networkPassphrase,
        source_account: opts.keypair.publicKey(),
        secret_ref: opts.secretRef,
        deposit: opts.amount.toString(),
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    })),
    getMppChannelStatus: vi.fn(async (opts) => ({
      channel_id: opts.channelId,
      network: "testnet",
      token: "CTOKEN",
      from: "GFUNDER",
      to: "GRECIPIENT",
      deposited: "10000000",
      withdrawn: "200",
      balance: "9999800",
      refund_waiting_period: 24,
      close_effective_at_ledger: null,
      current_ledger: 123,
    })),
    closeMppChannel: vi.fn(async (opts) => ({
      channel_id: opts.channelId,
      tx_hash: "tx-close",
      amount: opts.amount.toString(),
      state_path: opts.statePath,
      stored_channel: {
        channel_id: opts.channelId,
        network_name: "testnet",
        network_passphrase: opts.networkPassphrase,
        source_account: opts.keypair.publicKey(),
        cumulative_amount: opts.amount.toString(),
        last_voucher_amount: opts.amount.toString(),
        last_voucher_signature: opts.signatureHex,
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    })),
    settleMppChannel: vi.fn(async (opts) => ({
      channel_id: opts.channelId,
      tx_hash: "tx-settle",
      amount: opts.amount.toString(),
      state_path: opts.statePath,
      stored_channel: {
        channel_id: opts.channelId,
        network_name: opts.networkName,
        network_passphrase: opts.networkPassphrase,
        source_account: "GFUNDER",
        recipient: opts.keypair.publicKey(),
        cumulative_amount: opts.amount.toString(),
        last_voucher_amount: opts.amount.toString(),
        last_voucher_signature: opts.signatureHex,
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    })),
    startMppChannelClose: vi.fn(async (opts) => ({
      channel_id: opts.channelId,
      tx_hash: "tx-close-start",
      state_path: opts.statePath,
      stored_channel: {
        channel_id: opts.channelId,
        network_name: opts.networkName,
        network_passphrase: opts.networkPassphrase,
        source_account: opts.keypair.publicKey(),
        lifecycle_state: "closing",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    })),
    refundMppChannel: vi.fn(async (opts) => ({
      channel_id: opts.channelId,
      tx_hash: "tx-refund",
      state_path: opts.statePath,
      stored_channel: {
        channel_id: opts.channelId,
        network_name: opts.networkName,
        network_passphrase: opts.networkPassphrase,
        source_account: opts.keypair.publicKey(),
        lifecycle_state: "refunded",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    })),
  };
});

const mppChannelModule = await import("../../src/mpp-channel.js");
const openMppChannelMock = mppChannelModule.openMppChannel as ReturnType<typeof vi.fn>;
const topUpMppChannelMock = mppChannelModule.topUpMppChannel as ReturnType<typeof vi.fn>;
const getMppChannelStatusMock = mppChannelModule.getMppChannelStatus as ReturnType<typeof vi.fn>;
const closeMppChannelMock = mppChannelModule.closeMppChannel as ReturnType<typeof vi.fn>;
const settleMppChannelMock = mppChannelModule.settleMppChannel as ReturnType<typeof vi.fn>;
const startMppChannelCloseMock = mppChannelModule.startMppChannelClose as ReturnType<typeof vi.fn>;
const refundMppChannelMock = mppChannelModule.refundMppChannel as ReturnType<typeof vi.fn>;

function makeFixture(extraToml = "") {
  const funderKeypair = Keypair.random();
  const recipientKeypair = Keypair.random();
  const rootDir = makeTempDir("walleterm-mpp-channel-e2e-");
  const fake = makeFakeSecurityFixture();
  writeFileSync(
    fake.storePath,
    JSON.stringify({
      "walleterm-test::default_payer": funderKeypair.secret(),
      "walleterm-test::recipient_signer": recipientKeypair.secret(),
    }),
    "utf8",
  );
  const configPath = join(rootDir, "walleterm.toml");
  writeFileSync(
    configPath,
    `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[payments]
default_protocol = "mpp"

[payments.mpp]
default_intent = "channel"
default_payer_secret_ref = "keychain://walleterm-test/default_payer"

[payments.mpp.channel]
factory_contract_id = "CFACTORY"
token_contract_id = "CTOKEN"
recipient = "${recipientKeypair.publicKey()}"
recipient_secret_ref = "keychain://walleterm-test/recipient_signer"
default_deposit = "10000000"
refund_waiting_period = 24
source_account = "${funderKeypair.publicKey()}"
state_file = ".state.json"

[smart_accounts]
${extraToml}`,
    "utf8",
  );
  return { configPath, env: fake.env, funderKeypair, recipientKeypair };
}

describe("walleterm channel e2e", () => {
  beforeEach(() => {
    openMppChannelMock.mockClear();
    topUpMppChannelMock.mockClear();
    getMppChannelStatusMock.mockClear();
    closeMppChannelMock.mockClear();
    settleMppChannelMock.mockClear();
    startMppChannelCloseMock.mockClear();
    refundMppChannelMock.mockClear();
  });

  it("opens a channel using config defaults", async () => {
    const { configPath, env, funderKeypair } = makeFixture();
    const result = await runCliInProcess(["channel", "open", "--config", configPath], env);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.channel_id).toBe("COPENEDCHANNEL");
    const call = openMppChannelMock.mock.calls[0]?.[0];
    expect(call.factoryContractId).toBe("CFACTORY");
    expect(call.tokenContractId).toBe("CTOKEN");
    expect(call.keypair.publicKey()).toBe(funderKeypair.publicKey());
  });

  it("tops up the active channel", async () => {
    const { configPath, env } = makeFixture();
    const result = await runCliInProcess(
      ["channel", "topup", "--config", configPath, "--amount", "5000"],
      env,
    );
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.tx_hash).toBe("tx-topup");
    expect(topUpMppChannelMock.mock.calls[0]?.[0].channelId).toBe("CDEFAULTCHANNEL");
  });

  it("shows status for the active channel", async () => {
    const { configPath, env } = makeFixture();
    const result = await runCliInProcess(["channel", "status", "--config", configPath], env);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.channel_id).toBe("CDEFAULTCHANNEL");
    expect(parsed.stored).toBeDefined();
    expect(getMppChannelStatusMock).toHaveBeenCalledTimes(1);
  });

  it("closes a channel using the remembered voucher", async () => {
    const { configPath, env } = makeFixture();
    const result = await runCliInProcess(["channel", "close", "--config", configPath], env);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.tx_hash).toBe("tx-close");
    const call = closeMppChannelMock.mock.calls[0]?.[0];
    expect(call.amount).toBe(200n);
    expect(call.signatureHex).toBe("a".repeat(128));
  });

  it("settles a channel using the remembered voucher", async () => {
    const { configPath, env, recipientKeypair } = makeFixture();
    const result = await runCliInProcess(["channel", "settle", "--config", configPath], env);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.tx_hash).toBe("tx-settle");
    const call = settleMppChannelMock.mock.calls[0]?.[0];
    expect(call.amount).toBe(200n);
    expect(call.signatureHex).toBe("a".repeat(128));
    expect(call.keypair.publicKey()).toBe(recipientKeypair.publicKey());
  });

  it("starts close from the funder side", async () => {
    const { configPath, env, funderKeypair } = makeFixture();
    const result = await runCliInProcess(["channel", "close-start", "--config", configPath], env);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.tx_hash).toBe("tx-close-start");
    expect(startMppChannelCloseMock.mock.calls[0]?.[0].keypair.publicKey()).toBe(
      funderKeypair.publicKey(),
    );
  });

  it("refunds a channel from the funder side", async () => {
    const { configPath, env, funderKeypair } = makeFixture();
    const result = await runCliInProcess(["channel", "refund", "--config", configPath], env);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.tx_hash).toBe("tx-refund");
    expect(refundMppChannelMock.mock.calls[0]?.[0].keypair.publicKey()).toBe(
      funderKeypair.publicKey(),
    );
  });
});
