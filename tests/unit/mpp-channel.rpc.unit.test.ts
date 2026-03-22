import { Account, Keypair, StrKey, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCloseEffectiveAtLedger,
  scValToBigInt,
  sendAndPollTransaction,
  simulateGetter,
} from "../../src/mpp-channel/rpc.js";

describe("mpp-channel rpc helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries TRY_AGAIN_LATER and polls until the transaction succeeds", async () => {
    vi.useFakeTimers();
    const server = {
      sendTransaction: vi
        .fn()
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER" })
        .mockResolvedValueOnce({ status: "PENDING", hash: "tx-hash" }),
      getTransaction: vi
        .fn()
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "SUCCESS" }),
    } as unknown as rpc.Server;

    const pending = sendAndPollTransaction(
      server,
      {} as Parameters<rpc.Server["sendTransaction"]>[0],
    );
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe("tx-hash");
  });

  it("surfaces rejected transactions from sendTransaction", async () => {
    const server = {
      sendTransaction: vi.fn().mockResolvedValue({
        status: "ERROR",
        errorResult: {
          result: () => ({
            switch: () => ({ name: "txBadAuth" }),
          }),
        },
      }),
    } as unknown as rpc.Server;

    await expect(
      sendAndPollTransaction(server, {} as Parameters<rpc.Server["sendTransaction"]>[0]),
    ).rejects.toThrow(/txBadAuth/);
  });

  it("times out when the transaction never appears on-chain", async () => {
    vi.useFakeTimers();
    const server = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "tx-missing" }),
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
    } as unknown as rpc.Server;

    const pending = sendAndPollTransaction(
      server,
      {} as Parameters<rpc.Server["sendTransaction"]>[0],
    );
    void pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow(/not found after 60 polling attempts/i);
  });

  it("converts supported ScVal integer types to BigInt", () => {
    expect(scValToBigInt(xdr.ScVal.scvU32(7))).toBe(7n);
    expect(scValToBigInt(xdr.ScVal.scvI32(-3))).toBe(-3n);
    expect(scValToBigInt(xdr.ScVal.scvU64(new xdr.Uint64(11n)))).toBe(11n);
    expect(scValToBigInt(xdr.ScVal.scvI64(new xdr.Int64(-9n)))).toBe(-9n);
    expect(scValToBigInt(nativeToScVal((1n << 72n) + 5n, { type: "u128" }))).toBe((1n << 72n) + 5n);
    expect(scValToBigInt(nativeToScVal((1n << 71n) + 3n, { type: "i128" }))).toBe((1n << 71n) + 3n);
  });

  it("rejects unsupported ScVal types", () => {
    expect(() => scValToBigInt(xdr.ScVal.scvBool(true))).toThrow(/cannot convert/i);
  });

  it("returns simulated getter values when simulation succeeds", async () => {
    const isSimulationSuccessSpy = vi.spyOn(rpc.Api, "isSimulationSuccess").mockReturnValue(true);
    const server = {
      getAccount: vi.fn().mockResolvedValue(new Account(Keypair.random().publicKey(), "1")),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: xdr.ScVal.scvU32(42) },
      }),
    } as unknown as rpc.Server;

    await expect(
      simulateGetter(
        server,
        Keypair.random().publicKey(),
        "Test SDF Network ; September 2015",
        StrKey.encodeContract(Buffer.alloc(32, 1)),
        "balance",
      ),
    ).resolves.toEqual(xdr.ScVal.scvU32(42));

    expect(isSimulationSuccessSpy).toHaveBeenCalled();
  });

  it("surfaces simulation failures and missing retvals", async () => {
    const server = {
      getAccount: vi.fn().mockResolvedValue(new Account(Keypair.random().publicKey(), "1")),
      simulateTransaction: vi.fn(),
    } as unknown as rpc.Server;

    vi.spyOn(rpc.Api, "isSimulationSuccess").mockReturnValue(false);
    (server.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ error: "boom" });
    await expect(
      simulateGetter(
        server,
        Keypair.random().publicKey(),
        "Test SDF Network ; September 2015",
        StrKey.encodeContract(Buffer.alloc(32, 2)),
        "token",
      ),
    ).rejects.toThrow(/failed to simulate token: boom/i);

    vi.spyOn(rpc.Api, "isSimulationSuccess").mockReturnValue(true);
    (server.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ result: {} });
    await expect(
      simulateGetter(
        server,
        Keypair.random().publicKey(),
        "Test SDF Network ; September 2015",
        StrKey.encodeContract(Buffer.alloc(32, 3)),
        "token",
      ),
    ).rejects.toThrow(/returned no value/i);
  });

  it("reads CloseEffectiveAtLedger from contract instance storage and tolerates missing data", async () => {
    const server = {
      getLedgerEntries: vi
        .fn()
        .mockResolvedValueOnce({
          entries: [
            {
              val: {
                contractData: () => ({
                  val: () => ({
                    instance: () => ({
                      storage: () => [
                        {
                          key: () =>
                            xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CloseEffectiveAtLedger")]),
                          val: () => xdr.ScVal.scvU32(44),
                        },
                      ],
                    }),
                  }),
                }),
              },
            },
          ],
        })
        .mockResolvedValueOnce({ entries: [] }),
    } as unknown as rpc.Server;

    await expect(
      readCloseEffectiveAtLedger(server, StrKey.encodeContract(Buffer.alloc(32, 4))),
    ).resolves.toBe(44);
    await expect(
      readCloseEffectiveAtLedger(server, StrKey.encodeContract(Buffer.alloc(32, 5))),
    ).resolves.toBeNull();
    await expect(readCloseEffectiveAtLedger(server, "not-a-channel-id")).resolves.toBeNull();
  });
});
