import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCliInProcess } from "../helpers/run-cli.js";

vi.mock("../../src/payments/index.js", () => ({
  buildPaymentJsonResult: vi.fn(),
  executePaymentRequest: vi.fn(),
}));

vi.mock("../../src/mpp-channel.js", () => ({
  executeMppChannelLifecycle: vi.fn(async (request) => {
    switch (request.action) {
      case "open":
        return { channel_id: "COPENEDCHANNEL", tx_hash: "tx-open" };
      case "topup":
        return { channel_id: "CCHANNEL", tx_hash: "tx-topup", amount: request.amount };
      case "status":
        return { channel_id: "CCHANNEL", network: "testnet", stored: { channel_id: "CCHANNEL" } };
      case "settle":
        return { channel_id: "CCHANNEL", tx_hash: "tx-settle", amount: request.amount ?? "200" };
      case "close":
        return { channel_id: "CCHANNEL", tx_hash: "tx-close", amount: request.amount ?? "200" };
      case "close-start":
        return { channel_id: "CCHANNEL", tx_hash: "tx-close-start" };
      case "refund":
        return { channel_id: "CCHANNEL", tx_hash: "tx-refund" };
    }
  }),
  resolveMppStatePath: vi.fn((configPath: string) => `${configPath}.mpp-state.json`),
}));

const { executeMppChannelLifecycle } = await import("../../src/mpp-channel.js");
const executeLifecycleMock = vi.mocked(executeMppChannelLifecycle);

describe("walleterm channel caller interface", () => {
  beforeEach(() => {
    executeLifecycleMock.mockClear();
  });

  it("passes open inputs through the lifecycle seam and preserves JSON output", async () => {
    const result = await runCliInProcess([
      "channel",
      "open",
      "--config",
      "custom.toml",
      "--network",
      "testnet",
      "--secret-ref",
      "keychain://payer",
      "--deposit",
      "1000",
      "--factory-contract-id",
      "CFACTORY",
      "--token-contract-id",
      "CTOKEN",
      "--recipient",
      "GRECIPIENT",
      "--refund-waiting-period",
      "24",
    ]);

    expect(JSON.parse(result.stdout.trim())).toEqual({
      channel_id: "COPENEDCHANNEL",
      tx_hash: "tx-open",
    });
    expect(executeLifecycleMock).toHaveBeenCalledWith({
      action: "open",
      configPath: "custom.toml",
      network: "testnet",
      secretRef: "keychain://payer",
      deposit: "1000",
      factoryContractId: "CFACTORY",
      tokenContractId: "CTOKEN",
      recipient: "GRECIPIENT",
      refundWaitingPeriod: "24",
    });
  });

  it.each([
    {
      command: ["topup", "--amount", "5000", "--channel-id", "CCHANNEL"],
      action: "topup",
      expected: { amount: "5000" },
      txHash: "tx-topup",
    },
    {
      command: ["settle", "--amount", "200", "--signature", "a".repeat(128)],
      action: "settle",
      expected: { amount: "200", signature: "a".repeat(128) },
      txHash: "tx-settle",
    },
    {
      command: ["close", "--amount", "200", "--signature", "b".repeat(128)],
      action: "close",
      expected: { amount: "200", signature: "b".repeat(128) },
      txHash: "tx-close",
    },
    {
      command: ["close-start", "--secret-ref", "keychain://payer"],
      action: "close-start",
      expected: { secretRef: "keychain://payer" },
      txHash: "tx-close-start",
    },
    {
      command: ["refund", "--secret-ref", "keychain://payer"],
      action: "refund",
      expected: { secretRef: "keychain://payer" },
      txHash: "tx-refund",
    },
  ])(
    "delegates $action without CLI lifecycle order",
    async ({ command, action, expected, txHash }) => {
      const result = await runCliInProcess(["channel", ...command, "--config", "custom.toml"]);

      expect(JSON.parse(result.stdout.trim()).tx_hash).toBe(txHash);
      expect(executeLifecycleMock).toHaveBeenCalledWith({
        action,
        configPath: "custom.toml",
        network: undefined,
        channelId: action === "topup" ? "CCHANNEL" : undefined,
        secretRef: undefined,
        ...expected,
      });
    },
  );

  it("delegates status and preserves the stored record output", async () => {
    const result = await runCliInProcess([
      "channel",
      "status",
      "--config",
      "custom.toml",
      "--channel-id",
      "CCHANNEL",
    ]);

    expect(JSON.parse(result.stdout.trim())).toEqual({
      channel_id: "CCHANNEL",
      network: "testnet",
      stored: { channel_id: "CCHANNEL" },
    });
    expect(executeLifecycleMock).toHaveBeenCalledWith({
      action: "status",
      configPath: "custom.toml",
      network: undefined,
      channelId: "CCHANNEL",
    });
  });
});
