import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMppChannelStateChange,
  assertMppChannelStateChangeAllowed,
  rememberMppVoucher,
  resolveStoredChannel,
} from "../../src/mpp-channel/storage.js";
import type {
  MppChannelLifecycleState,
  MppChannelStateChange,
} from "../../src/mpp-channel/types.js";

function makeStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), "walleterm-mpp-state-")), "state.json");
}

function openStoredChannel(statePath: string, channelId = "CCHANNEL"): void {
  applyMppChannelStateChange(statePath, {
    type: "opened",
    channelId,
    networkName: "testnet",
    networkPassphrase: Networks.TESTNET,
    sourceAccount: "GFUNDER",
    secretRef: "keychain://payer",
    deposit: "100",
    refundWaitingPeriod: 24,
    factoryContractId: "CFACTORY",
    tokenContractId: "CTOKEN",
    recipient: "GRECIPIENT",
    txHash: "tx-open",
  });
}

function seedLifecycleState(statePath: string, lifecycleState: MppChannelLifecycleState): void {
  openStoredChannel(statePath);
  if (lifecycleState === "open") return;
  if (lifecycleState === "closing" || lifecycleState === "refunded") {
    applyMppChannelStateChange(statePath, makeStateChange("close-started"));
  }
  if (lifecycleState === "closed") {
    applyMppChannelStateChange(statePath, makeStateChange("closed"));
  }
  if (lifecycleState === "refunded") {
    applyMppChannelStateChange(statePath, makeStateChange("refunded"));
  }
}

function makeStateChange(type: Exclude<MppChannelStateChange["type"], "opened">) {
  switch (type) {
    case "topped-up":
      return {
        type,
        channelId: "CCHANNEL",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        sourceAccount: "GFUNDER",
        amount: "10",
        txHash: "tx-topup",
      } satisfies MppChannelStateChange;
    case "voucher-remembered":
      return {
        type,
        channelId: "CCHANNEL",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        sourceAccount: "GFUNDER",
        cumulativeAmount: "0",
        signatureHex: "a".repeat(128),
      } satisfies MppChannelStateChange;
    case "settled":
      return {
        type,
        channelId: "CCHANNEL",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        cumulativeAmount: "0",
        signatureHex: "b".repeat(128),
        txHash: "tx-settle",
      } satisfies MppChannelStateChange;
    case "close-started":
      return {
        type,
        channelId: "CCHANNEL",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        sourceAccount: "GFUNDER",
        txHash: "tx-close-start",
      } satisfies MppChannelStateChange;
    case "closed":
      return {
        type,
        channelId: "CCHANNEL",
        networkPassphrase: Networks.TESTNET,
        sourceAccount: "GFUNDER",
        cumulativeAmount: "0",
        signatureHex: "c".repeat(128),
        txHash: "tx-close",
      } satisfies MppChannelStateChange;
    case "refunded":
      return {
        type,
        channelId: "CCHANNEL",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        sourceAccount: "GFUNDER",
        txHash: "tx-refund",
      } satisfies MppChannelStateChange;
  }
}

function makeCumulativeStateChange(
  type: "voucher-remembered" | "settled" | "closed",
  cumulativeAmount: string,
): MppChannelStateChange {
  switch (type) {
    case "voucher-remembered":
      return {
        type,
        channelId: "CCHANNEL",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        sourceAccount: "GFUNDER",
        cumulativeAmount,
        signatureHex: "a".repeat(128),
      };
    case "settled":
      return {
        type,
        channelId: "CCHANNEL",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        cumulativeAmount,
        signatureHex: "b".repeat(128),
        txHash: "tx-settle",
      };
    case "closed":
      return {
        type,
        channelId: "CCHANNEL",
        networkPassphrase: Networks.TESTNET,
        sourceAccount: "GFUNDER",
        cumulativeAmount,
        signatureHex: "c".repeat(128),
        txHash: "tx-close",
      };
  }
}

describe("MPP channel state interface", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges channel changes and owns lifecycle timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-12T12:00:00.000Z");
    const statePath = makeStatePath();

    const opened = applyMppChannelStateChange(statePath, {
      type: "opened",
      channelId: "CCHANNEL",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      secretRef: "keychain://payer",
      deposit: "100",
      refundWaitingPeriod: 24,
      factoryContractId: "CFACTORY",
      tokenContractId: "CTOKEN",
      recipient: "GRECIPIENT",
      txHash: "tx-open",
    });

    expect(opened).toMatchObject({
      deposit: "100",
      cumulative_amount: "0",
      lifecycle_state: "open",
      opened_tx_hash: "tx-open",
      updated_at: "2026-08-12T12:00:00.000Z",
    });

    vi.setSystemTime("2026-08-12T12:01:00.000Z");
    const toppedUp = applyMppChannelStateChange(statePath, {
      type: "topped-up",
      channelId: "CCHANNEL",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      amount: "50",
      txHash: "tx-topup",
    });

    expect(toppedUp).toMatchObject({
      secret_ref: "keychain://payer",
      deposit: "150",
      recipient: "GRECIPIENT",
      last_topup_tx_hash: "tx-topup",
      updated_at: "2026-08-12T12:01:00.000Z",
    });

    const voucher = rememberMppVoucher(statePath, {
      channelId: "CCHANNEL",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      cumulativeAmount: "40",
      signatureHex: "a".repeat(128),
    });
    expect(voucher).toMatchObject({
      deposit: "150",
      cumulative_amount: "40",
      last_voucher_amount: "40",
      last_voucher_signature: "a".repeat(128),
    });

    const settled = applyMppChannelStateChange(statePath, {
      type: "settled",
      channelId: "CCHANNEL",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      cumulativeAmount: "60",
      signatureHex: "b".repeat(128),
      txHash: "tx-settle",
    });
    expect(settled).toMatchObject({
      deposit: "150",
      cumulative_amount: "60",
      last_voucher_signature: "b".repeat(128),
      last_settle_tx_hash: "tx-settle",
      lifecycle_state: "open",
    });

    const closing = applyMppChannelStateChange(statePath, {
      type: "close-started",
      channelId: "CCHANNEL",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      txHash: "tx-close-start",
    });
    expect(closing).toMatchObject({
      lifecycle_state: "closing",
      close_start_tx_hash: "tx-close-start",
    });

    const closed = applyMppChannelStateChange(statePath, {
      type: "closed",
      channelId: "CCHANNEL",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      cumulativeAmount: "75",
      signatureHex: "c".repeat(128),
      txHash: "tx-close",
    });
    expect(closed).toMatchObject({
      deposit: "150",
      cumulative_amount: "75",
      lifecycle_state: "closed",
      close_tx_hash: "tx-close",
    });
    expect(resolveStoredChannel(statePath, "testnet")).toBeNull();
    expect(resolveStoredChannel(statePath, "testnet", "CCHANNEL")).toEqual(closed);
  });

  it("clears only the active channel for a terminal change", () => {
    const statePath = makeStatePath();
    const openedChange = {
      type: "opened" as const,
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      deposit: "100",
      refundWaitingPeriod: 24,
      factoryContractId: "CFACTORY",
      tokenContractId: "CTOKEN",
      recipient: "GRECIPIENT",
      txHash: "tx-open",
    };

    applyMppChannelStateChange(statePath, { ...openedChange, channelId: "CFIRST" });
    applyMppChannelStateChange(statePath, { ...openedChange, channelId: "CSECOND" });
    applyMppChannelStateChange(statePath, {
      type: "closed",
      channelId: "CFIRST",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      cumulativeAmount: "25",
      signatureHex: "a".repeat(128),
      txHash: "tx-close",
    });

    expect(resolveStoredChannel(statePath, "testnet")?.channel_id).toBe("CSECOND");

    applyMppChannelStateChange(statePath, {
      type: "close-started",
      channelId: "CSECOND",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      txHash: "tx-close-start",
    });
    const refunded = applyMppChannelStateChange(statePath, {
      type: "refunded",
      channelId: "CSECOND",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      txHash: "tx-refund",
    });

    expect(refunded.lifecycle_state).toBe("refunded");
    expect(resolveStoredChannel(statePath, "testnet")).toBeNull();
  });

  const transitionCases = [
    ["open", "topped-up", true],
    ["open", "voucher-remembered", true],
    ["open", "settled", true],
    ["open", "close-started", true],
    ["open", "closed", true],
    ["open", "refunded", false],
    ["closing", "topped-up", false],
    ["closing", "voucher-remembered", false],
    ["closing", "settled", false],
    ["closing", "close-started", false],
    ["closing", "closed", true],
    ["closing", "refunded", true],
    ["closed", "topped-up", false],
    ["closed", "voucher-remembered", false],
    ["closed", "settled", false],
    ["closed", "close-started", false],
    ["closed", "closed", false],
    ["closed", "refunded", false],
    ["refunded", "topped-up", false],
    ["refunded", "voucher-remembered", false],
    ["refunded", "settled", false],
    ["refunded", "close-started", false],
    ["refunded", "closed", false],
    ["refunded", "refunded", false],
  ] as const;

  it.each(transitionCases.filter(([, , allowed]) => allowed))(
    "allows %s -> %s",
    (lifecycleState, changeType) => {
      const statePath = makeStatePath();
      seedLifecycleState(statePath, lifecycleState);
      expect(() =>
        applyMppChannelStateChange(statePath, makeStateChange(changeType)),
      ).not.toThrow();
    },
  );

  it.each(transitionCases.filter(([, , allowed]) => !allowed))(
    "rejects %s -> %s",
    (lifecycleState, changeType) => {
      const statePath = makeStatePath();
      seedLifecycleState(statePath, lifecycleState);
      expect(() => applyMppChannelStateChange(statePath, makeStateChange(changeType))).toThrow(
        `MPP channel change '${changeType}' is not allowed from lifecycle state '${lifecycleState}'`,
      );
    },
  );

  it.each(["topped-up", "settled", "close-started", "closed", "refunded"] as const)(
    "requires an existing record for %s",
    (changeType) => {
      expect(() =>
        applyMppChannelStateChange(makeStatePath(), makeStateChange(changeType)),
      ).toThrow("MPP channel CCHANNEL does not exist");
    },
  );

  it("bootstraps a newly observed channel from its first valid voucher", () => {
    const statePath = makeStatePath();
    const cumulativeAmount = "900719925474099312345678901234567890";

    const channel = rememberMppVoucher(statePath, {
      channelId: "COBSERVED",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      sourceAccount: "GFUNDER",
      secretRef: "keychain://payer",
      cumulativeAmount,
      signatureHex: "a".repeat(128),
    });

    expect(channel).toMatchObject({
      channel_id: "COBSERVED",
      network_name: "testnet",
      network_passphrase: Networks.TESTNET,
      source_account: "GFUNDER",
      secret_ref: "keychain://payer",
      cumulative_amount: cumulativeAmount,
      last_voucher_amount: cumulativeAmount,
      last_voucher_signature: "a".repeat(128),
      lifecycle_state: "open",
    });
    expect(resolveStoredChannel(statePath, "testnet")).toEqual(channel);
  });

  it.each(["-1", "1.5", "1e3"])(
    "rejects invalid cumulative amount %s when bootstrapping an observed channel",
    (cumulativeAmount) => {
      const statePath = makeStatePath();

      expect(() =>
        rememberMppVoucher(statePath, {
          channelId: "COBSERVED",
          networkName: "testnet",
          networkPassphrase: Networks.TESTNET,
          sourceAccount: "GFUNDER",
          cumulativeAmount,
          signatureHex: "a".repeat(128),
        }),
      ).toThrow(/MPP channel cumulative amount must be a non-negative integer string/);
      expect(resolveStoredChannel(statePath, "testnet", "COBSERVED")).toBeNull();
    },
  );

  it.each(["closed", "refunded"] as const)(
    "does not reactivate a %s channel through voucher storage",
    (lifecycleState) => {
      const statePath = makeStatePath();
      seedLifecycleState(statePath, lifecycleState);

      expect(() =>
        rememberMppVoucher(statePath, {
          channelId: "CCHANNEL",
          networkName: "testnet",
          networkPassphrase: Networks.TESTNET,
          sourceAccount: "GFUNDER",
          cumulativeAmount: "1",
          signatureHex: "a".repeat(128),
        }),
      ).toThrow(
        `MPP channel change 'voucher-remembered' is not allowed from lifecycle state '${lifecycleState}'`,
      );
      expect(resolveStoredChannel(statePath, "testnet", "CCHANNEL")?.lifecycle_state).toBe(
        lifecycleState,
      );
    },
  );

  it("does not replace an existing record with an opened change", () => {
    const statePath = makeStatePath();
    openStoredChannel(statePath);

    expect(() => openStoredChannel(statePath)).toThrow("MPP channel CCHANNEL already exists");
  });

  it("validates the current state again when applying a preflighted change", () => {
    const statePath = makeStatePath();
    openStoredChannel(statePath);
    assertMppChannelStateChangeAllowed(statePath, {
      type: "topped-up",
      channelId: "CCHANNEL",
    });
    applyMppChannelStateChange(statePath, makeStateChange("close-started"));

    expect(() => applyMppChannelStateChange(statePath, makeStateChange("topped-up"))).toThrow(
      /not allowed from lifecycle state 'closing'/,
    );
  });

  it.each(["voucher-remembered", "settled", "closed"] as const)(
    "rejects a regressing %s cumulative amount with exact integer comparison",
    (changeType) => {
      const statePath = makeStatePath();
      const storedAmount = "900719925474099312345678901234567890";
      openStoredChannel(statePath);
      applyMppChannelStateChange(
        statePath,
        makeCumulativeStateChange("voucher-remembered", storedAmount),
      );

      expect(() =>
        applyMppChannelStateChange(
          statePath,
          makeCumulativeStateChange(changeType, (BigInt(storedAmount) - 1n).toString()),
        ),
      ).toThrow(/is below stored amount/);
      expect(resolveStoredChannel(statePath, "testnet")?.cumulative_amount).toBe(storedAmount);
    },
  );

  it("accepts equal and increasing cumulative amounts", () => {
    const statePath = makeStatePath();
    const storedAmount = "900719925474099312345678901234567890";
    openStoredChannel(statePath);

    expect(
      applyMppChannelStateChange(
        statePath,
        makeCumulativeStateChange("voucher-remembered", storedAmount),
      ).cumulative_amount,
    ).toBe(storedAmount);
    expect(
      applyMppChannelStateChange(statePath, makeCumulativeStateChange("settled", storedAmount))
        .cumulative_amount,
    ).toBe(storedAmount);
    expect(
      applyMppChannelStateChange(
        statePath,
        makeCumulativeStateChange("closed", (BigInt(storedAmount) + 1n).toString()),
      ).cumulative_amount,
    ).toBe((BigInt(storedAmount) + 1n).toString());
  });
});
