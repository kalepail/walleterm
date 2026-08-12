import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const mocks = vi.hoisted(() => ({
  listContractSigners: vi.fn(),
  reconcileContractSigners: vi.fn(),
  resolveIndexerUrl: vi.fn(),
}));

vi.mock("../../src/wallet.js", () => ({
  listContractSigners: mocks.listContractSigners,
  reconcileContractSigners: mocks.reconcileContractSigners,
  resolveIndexerUrl: mocks.resolveIndexerUrl,
}));

import { reviewConfiguredInput, signConfiguredInput } from "../../src/core.js";
import {
  CONTRACT,
  makeAddressEntry,
  makeConfig,
  makeSourceAccountCredEntry,
} from "../helpers/core-fixtures.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveIndexerUrl.mockReturnValue("https://indexer.invalid");
  mocks.listContractSigners.mockResolvedValue({ contractId: CONTRACT, signers: [] });
  mocks.reconcileContractSigners.mockReturnValue({
    mode: "subset",
    ok: true,
    configured: { delegated: [], external: [] },
    onchain: { delegated: [], external: [] },
    missing: { delegated: [], external: [] },
    extra: { delegated: [], external: [] },
  });
});

describe("configured signing engine interface", () => {
  it("owns selection, strict checks, expiration, input construction, and signing order", async () => {
    const order: string[] = [];
    mocks.reconcileContractSigners.mockImplementationOnce(() => {
      order.push("strict-check");
      return {
        mode: "subset",
        ok: true,
        configured: { delegated: [], external: [] },
        onchain: { delegated: [], external: [] },
        missing: { delegated: [], external: [] },
        extra: { delegated: [], external: [] },
      };
    });

    const result = await signConfiguredInput({
      config: makeConfig(),
      network: "testnet",
      account: "treasury",
      ttlSeconds: 30,
      latestLedger: 100,
      input: (context) => {
        order.push("build-input");
        expect(context).toEqual({
          contractId: CONTRACT,
          expirationLedger: 105,
        });
        return { kind: "bundle", func: "AAAA", auth: [] };
      },
    });

    expect(order).toEqual(["strict-check", "build-input"]);
    expect(result).toMatchObject({
      account: "treasury",
      contractId: CONTRACT,
      expirationLedger: 105,
      report: { kind: "bundle", summary: { signed: 0, skipped: 0 } },
    });
    expect(JSON.parse(result.output)).toEqual({ func: "AAAA", auth: [] });
  });

  it("rejects strict signer drift before it constructs or signs the input", async () => {
    const input = vi.fn(() => ({ kind: "bundle" as const, auth: [] }));
    const extraContract = StrKey.encodeContract(Buffer.alloc(32, 9));
    mocks.reconcileContractSigners.mockReturnValueOnce({
      mode: "exact",
      ok: false,
      configured: { delegated: [], external: [] },
      onchain: {
        delegated: [],
        external: [{ verifier_contract_id: extraContract, public_key_hex: "aa" }],
      },
      missing: { delegated: [Keypair.random().publicKey()], external: [] },
      extra: {
        delegated: [],
        external: [{ verifier_contract_id: extraContract, public_key_hex: "aa" }],
      },
    });

    await expect(
      signConfiguredInput({
        config: makeConfig(),
        account: "treasury",
        latestLedger: 100,
        input,
      }),
    ).rejects.toThrow(/missing delegated=\[G.*\]; extra external=\[C.*:aa\]/i);
    expect(input).not.toHaveBeenCalled();
  });

  it("returns review output through the same selection and signer-discovery seam", async () => {
    const result = await reviewConfiguredInput({
      config: makeConfig(),
      input: { kind: "bundle", auth: [makeAddressEntry(CONTRACT)] },
      account: "treasury",
    });

    expect(result).toMatchObject({
      inspection: { kind: "bundle" },
      signability: { kind: "bundle", signableAuthEntries: 0 },
      account: "treasury",
      contract_id: CONTRACT,
      signer_reconciliation: { ok: true, mode: "subset" },
      signer_reconciliation_error: null,
    });
    expect(mocks.resolveIndexerUrl).toHaveBeenCalledOnce();
    expect(mocks.reconcileContractSigners).toHaveBeenCalledWith(expect.any(Object), [], "subset");
  });

  it("keeps review usable when reconciliation fails or no account is selected", async () => {
    mocks.resolveIndexerUrl.mockImplementationOnce(() => {
      throw "indexer unavailable";
    });
    const failedReconciliation = await reviewConfiguredInput({
      config: makeConfig(),
      input: { kind: "bundle", auth: [] },
      account: "treasury",
    });
    expect(failedReconciliation).toMatchObject({
      signer_reconciliation: null,
      signer_reconciliation_error: "indexer unavailable",
    });

    const contractB = StrKey.encodeContract(Buffer.alloc(32, 10));
    const noAccount = await reviewConfiguredInput({
      config: makeConfig({
        a: { network: "testnet", contract_id: CONTRACT },
        b: { network: "testnet", contract_id: contractB },
      }),
      input: { kind: "auth", auth: [makeSourceAccountCredEntry()] },
    });
    expect(noAccount).toMatchObject({
      signability: null,
      account: null,
      note: expect.stringContaining("No smart account selected"),
    });
  });
});
