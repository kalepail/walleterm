import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, rpc, StrKey } from "@stellar/stellar-sdk";
import type { ParsedInput } from "../../src/core.js";
import {
  computeExpirationLedger,
  parseInputFile,
  resolveAccountForCommand,
  writeOutput,
} from "../../src/core.js";
import {
  PASS,
  makeAddressEntry,
  makeConfig,
  makeInvokeContractOperation,
  makeSourceAccountCredEntry,
  makeTxEnvelope,
  tempFile,
} from "../helpers/core-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core input", () => {
  it("parseInputFile validates bad and unsupported payloads", () => {
    expect(() => parseInputFile(tempFile("not xdr"))).toThrow(/neither base64 XDR nor JSON/i);
    expect(() => parseInputFile(tempFile("[]"))).toThrow(/must be an object/i);
    expect(() => parseInputFile(tempFile(JSON.stringify({ xdr: "abc" })))).toThrow(
      /not a recognized transaction\/auth XDR/i,
    );
    expect(() => parseInputFile(tempFile(JSON.stringify({ auth: [1] })))).toThrow(
      /bundle\.auth\[0\] must be a base64 XDR string/i,
    );
    expect(() => parseInputFile(tempFile(JSON.stringify({ auth: ["abc"] })))).toThrow(
      /bundle\.auth\[0\] is not a valid SorobanAuthorizationEntry XDR/i,
    );
    expect(() => parseInputFile(tempFile(JSON.stringify({ nope: true })))).toThrow(
      /Unsupported input JSON format/i,
    );
  });

  it("parseInputFile falls through to JSON parsing when valid base64 decodes to invalid XDR", () => {
    const garbageBase64 = Buffer.from("this is not XDR at all!").toString("base64");
    expect(() => parseInputFile(tempFile(garbageBase64))).toThrow(/neither base64 XDR nor JSON/i);
  });

  it("parseInputFile accepts tx/auth xdr forms and bundle json", () => {
    const delegated = Keypair.random().publicKey();
    const authEntry = makeAddressEntry(delegated);
    const txEnvelope = makeTxEnvelope([makeInvokeContractOperation()]);

    expect(parseInputFile(tempFile(txEnvelope.toXDR("base64"))).kind).toBe("tx");
    expect(parseInputFile(tempFile(authEntry.toXDR("base64"))).kind).toBe("auth");
    expect(parseInputFile(tempFile(JSON.stringify({ xdr: txEnvelope.toXDR("base64") }))).kind).toBe(
      "tx",
    );
    expect(parseInputFile(tempFile(JSON.stringify({ xdr: authEntry.toXDR("base64") }))).kind).toBe(
      "auth",
    );

    const bundle = parseInputFile(
      tempFile(JSON.stringify({ func: "AAAA", auth: [authEntry.toXDR("base64")] })),
    );
    expect(bundle.kind).toBe("bundle");
    if (bundle.kind !== "bundle") {
      throw new Error("Expected bundle input");
    }
    expect(bundle.func).toBe("AAAA");
    expect(bundle.auth).toHaveLength(1);

    const bundleNoFunc = parseInputFile(
      tempFile(JSON.stringify({ auth: [authEntry.toXDR("base64")] })),
    );
    expect(bundleNoFunc.kind).toBe("bundle");
    if (bundleNoFunc.kind !== "bundle") {
      throw new Error("Expected bundle input");
    }
    expect(bundleNoFunc.func).toBeUndefined();
    expect(bundleNoFunc.auth).toHaveLength(1);
  });

  it("resolveAccountForCommand finds smart account from auth C-address and fallback behavior", () => {
    const contractA = StrKey.encodeContract(Buffer.alloc(32, 1));
    const contractB = StrKey.encodeContract(Buffer.alloc(32, 2));

    const cfg = makeConfig({
      a: {
        network: "testnet",
        contract_id: contractA,
        external_signers: [],
        delegated_signers: [],
      },
      b: {
        network: "testnet",
        contract_id: contractB,
        external_signers: [],
        delegated_signers: [],
      },
    });

    const parsedAuth: ParsedInput = {
      kind: "auth",
      auth: [makeSourceAccountCredEntry(), makeAddressEntry(contractB, undefined)],
    };

    const found = resolveAccountForCommand(cfg, "testnet", undefined, parsedAuth);
    expect(found?.alias).toBe("b");

    const parsedNoMatch: ParsedInput = {
      kind: "auth",
      auth: [makeAddressEntry(StrKey.encodeContract(Buffer.alloc(32, 9)))],
    };
    expect(resolveAccountForCommand(cfg, "testnet", undefined, parsedNoMatch)).toBeNull();

    const parsedNonContract: ParsedInput = {
      kind: "auth",
      auth: [makeAddressEntry(Keypair.random().publicKey())],
    };
    expect(resolveAccountForCommand(cfg, "testnet", undefined, parsedNonContract)).toBeNull();

    const singleCfg = makeConfig({
      only: {
        network: "testnet",
        contract_id: contractA,
        external_signers: [],
        delegated_signers: [],
      },
    });
    expect(
      resolveAccountForCommand(singleCfg, "testnet", undefined, {
        kind: "tx",
        envelope: makeTxEnvelope([makeInvokeContractOperation(contractA, "exec")]),
      }),
    )?.toMatchObject({ alias: "only" });
  });

  it("resolveAccountForCommand returns null for tx when alias is omitted and config is ambiguous", () => {
    const contractA = StrKey.encodeContract(Buffer.alloc(32, 3));
    const contractB = StrKey.encodeContract(Buffer.alloc(32, 4));
    const cfg = makeConfig({
      a: {
        network: "testnet",
        contract_id: contractA,
        external_signers: [],
        delegated_signers: [],
      },
      b: {
        network: "testnet",
        contract_id: contractB,
        external_signers: [],
        delegated_signers: [],
      },
    });

    const out = resolveAccountForCommand(cfg, "testnet", undefined, {
      kind: "tx",
      envelope: makeTxEnvelope([makeInvokeContractOperation(contractA, "exec")]),
    });
    expect(out).toBeNull();
  });

  it("computeExpirationLedger uses override and rpc fallback; writeOutput appends newline", async () => {
    expect(
      await computeExpirationLedger(
        { rpc_url: "https://rpc.invalid", network_passphrase: PASS },
        30,
        6,
        100,
      ),
    ).toBe(105);

    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      id: "mock-ledger-id",
      sequence: 200,
      protocolVersion: "22",
    });
    expect(
      await computeExpirationLedger(
        { rpc_url: "https://rpc.invalid", network_passphrase: PASS },
        60,
        6,
      ),
    ).toBe(210);

    const p1 = tempFile("");
    writeOutput(p1, "abc");
    expect(readFileSync(p1, "utf8")).toBe("abc\n");

    const p2 = tempFile("");
    writeOutput(p2, "abc\n");
    expect(readFileSync(p2, "utf8")).toBe("abc\n");
  });
});
