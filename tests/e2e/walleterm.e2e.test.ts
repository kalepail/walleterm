import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { runCliInProcess } from "../helpers/run-cli.js";

type Fixture = {
  rootDir: string;
  configPath: string;
  inPath: string;
  outPath: string;
  env: NodeJS.ProcessEnv;
  network: string;
  passphrase: string;
  contractId: string;
  verifierId: string;
  external: Keypair;
  delegated: Keypair;
  unknown: Keypair;
};

function toHex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function signerKeyExternal(verifier: string, keyData: Buffer): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifier).toScAddress()),
    xdr.ScVal.scvBytes(keyData),
  ]);
}

function signerKeyDelegated(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    xdr.ScVal.scvAddress(Address.fromString(address).toScAddress()),
  ]);
}

function makeInvocation(contractId: string, fnName = "execute"): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: fnName,
        args: [],
      }),
    ),
    subInvocations: [],
  });
}

function makeSmartAccountEntry(
  contractId: string,
  verifierId: string,
  externalPubkey: Buffer,
  delegatedAddress: string,
  includeUnknownExternal = false,
): xdr.SorobanAuthorizationEntry {
  const entries: xdr.ScMapEntry[] = [
    new xdr.ScMapEntry({
      key: signerKeyExternal(verifierId, externalPubkey),
      val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
    }),
    new xdr.ScMapEntry({
      key: signerKeyDelegated(delegatedAddress),
      val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
    }),
  ];

  if (includeUnknownExternal) {
    const randomPk = Keypair.random().rawPublicKey();
    entries.push(
      new xdr.ScMapEntry({
        key: signerKeyExternal(verifierId, Buffer.from(randomPk)),
        val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
      }),
    );
  }

  entries.sort((a, b) => a.key().toXDR("hex").localeCompare(b.key().toXDR("hex")));

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(contractId).toScAddress(),
        nonce: xdr.Int64.fromString("1234"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([xdr.ScVal.scvMap(entries)]),
      }),
    ),
    rootInvocation: makeInvocation(contractId, "execute"),
  });
}

function makeDelegatedEntry(address: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString("200"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: makeInvocation(StrKey.encodeContract(Buffer.alloc(32, 13)), "transfer"),
  });
}

function makeFixture(): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), "walleterm-e2e-"));
  const inPath = join(rootDir, "in.txt");
  const outPath = join(rootDir, "out.txt");
  const configPath = join(rootDir, "walleterm.toml");
  const binDir = join(rootDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const external = Keypair.random();
  const delegated = Keypair.random();
  const unknown = Keypair.random();

  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  const verifierId = StrKey.encodeContract(Buffer.alloc(32, 9));

  const opBin = join(binDir, "op");
  const externalRef = "op://vault/external/seed";
  const delegatedRef = "op://vault/delegated/seed";

  writeFileSync(
    opBin,
    `#!/usr/bin/env node
const ref = process.argv[3];
const map = {
  ${JSON.stringify(externalRef)}: ${JSON.stringify(external.secret())},
  ${JSON.stringify(delegatedRef)}: ${JSON.stringify(delegated.secret())},
};
if (process.argv[2] !== 'read' || !map[ref]) {
  process.exit(1);
}
process.stdout.write(map[ref]);
`,
    "utf8",
  );
  chmodSync(opBin, 0o755);

  writeFileSync(
    configPath,
    `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "sign-only"

[networks.testnet]
rpc_url = "https://example.invalid"
network_passphrase = "${Networks.TESTNET}"

[smart_accounts.treasury]
network = "testnet"
contract_id = "${contractId}"
expected_wasm_hash = "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e"

[[smart_accounts.treasury.external_signers]]
name = "ext1"
verifier_contract_id = "${verifierId}"
public_key_hex = "${toHex(external.rawPublicKey())}"
secret_ref = "${externalRef}"
enabled = true

[[smart_accounts.treasury.delegated_signers]]
name = "del1"
address = "${delegated.publicKey()}"
secret_ref = "${delegatedRef}"
enabled = true
`,
    "utf8",
  );

  return {
    rootDir,
    configPath,
    inPath,
    outPath,
    env: {
      ...process.env,
      WALLETERM_OP_BIN: opBin,
    },
    network: "testnet",
    passphrase: Networks.TESTNET,
    contractId,
    verifierId,
    external,
    delegated,
    unknown,
  };
}

async function runCli(fx: Fixture, args: string[]) {
  return runCliInProcess(args, fx.env);
}

describe("walleterm e2e", () => {
  it("rejects removed wallet signer verify command", async () => {
    const fx = makeFixture();

    await expect(
      runCli(fx, [
        "wallet",
        "signer",
        "verify",
        "--config",
        fx.configPath,
        "--account",
        "treasury",
      ]),
    ).rejects.toThrow(/unknown command/i);
  });

  it("signs a standalone delegated auth entry", async () => {
    const fx = makeFixture();
    const entry = makeDelegatedEntry(fx.delegated.publicKey());

    writeFileSync(fx.inPath, entry.toXDR("base64"), "utf8");

    const res = await runCli(fx, [
      "sign",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--account",
      "treasury",
      "--in",
      fx.inPath,
      "--out",
      fx.outPath,
      "--latest-ledger",
      "1000",
    ]);

    const report = JSON.parse(res.stdout);
    expect(report.summary.signed).toBe(1);
    const outXdr = readFileSync(fx.outPath, "utf8").trim();
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(outXdr, "base64");
    const sig = signed.credentials().address().signature();
    expect(sig.switch().name).toBe("scvVec");
  });

  it("signs smart-account map entries and appends delegated auth entries in bundle mode", async () => {
    const fx = makeFixture();
    const smartAuth = makeSmartAccountEntry(
      fx.contractId,
      fx.verifierId,
      Buffer.from(fx.external.rawPublicKey()),
      fx.delegated.publicKey(),
    );

    writeFileSync(
      fx.inPath,
      JSON.stringify({
        func: "AAAA",
        auth: [smartAuth.toXDR("base64")],
      }),
      "utf8",
    );

    const res = await runCli(fx, [
      "sign",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--account",
      "treasury",
      "--in",
      fx.inPath,
      "--out",
      fx.outPath,
      "--latest-ledger",
      "2000",
    ]);

    const report = JSON.parse(res.stdout);
    expect(report.summary.signed).toBeGreaterThanOrEqual(2);

    const out = JSON.parse(readFileSync(fx.outPath, "utf8"));
    expect(out.auth.length).toBe(2);

    const smartSigned = xdr.SorobanAuthorizationEntry.fromXDR(out.auth[0], "base64");
    const mapEntries = smartSigned.credentials().address().signature().vec()?.[0].map() ?? [];
    const extEntry = mapEntries.find((entry) => {
      const k = entry.key();
      if (k.switch().name !== "scvVec") return false;
      const parts = k.vec() ?? [];
      return parts[0]?.switch().name === "scvSymbol" && parts[0].sym().toString() === "External";
    });
    expect(extEntry).toBeDefined();
    expect(extEntry?.val().bytes().length).toBe(64);

    const delegatedSigned = xdr.SorobanAuthorizationEntry.fromXDR(out.auth[1], "base64");
    const delegatedAddr = Address.fromScAddress(
      delegatedSigned.credentials().address().address(),
    ).toString();
    expect(delegatedAddr).toBe(fx.delegated.publicKey());
  });

  it("subset mode signs known signers and leaves unknown signer entries untouched", async () => {
    const fx = makeFixture();
    const smartAuth = makeSmartAccountEntry(
      fx.contractId,
      fx.verifierId,
      Buffer.from(fx.external.rawPublicKey()),
      fx.delegated.publicKey(),
      true,
    );

    writeFileSync(fx.inPath, smartAuth.toXDR("base64"), "utf8");

    const res = await runCli(fx, [
      "sign",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--account",
      "treasury",
      "--in",
      fx.inPath,
      "--out",
      fx.outPath,
      "--latest-ledger",
      "3000",
    ]);

    const report = JSON.parse(res.stdout);
    expect(report.summary.skipped).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(readFileSync(fx.outPath, "utf8"));
    expect(out.auth.length).toBe(2);

    const smartSigned = xdr.SorobanAuthorizationEntry.fromXDR(out.auth[0], "base64");
    const mapEntries = smartSigned.credentials().address().signature().vec()?.[0].map() ?? [];

    const extVals = mapEntries
      .filter((entry) => {
        const key = entry.key();
        if (key.switch().name !== "scvVec") return false;
        const parts = key.vec() ?? [];
        return parts[0]?.switch().name === "scvSymbol" && parts[0].sym().toString() === "External";
      })
      .map((entry) => entry.val().bytes().length);

    expect(extVals.some((n) => n === 64)).toBe(true);
    expect(extVals.some((n) => n === 0)).toBe(true);
  });

  it("signs transaction envelopes with matching local signer keys", async () => {
    const fx = makeFixture();

    const account = new Account(fx.external.publicKey(), "1");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: fx.passphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: fx.contractId,
          function: "transfer",
          args: [],
        }),
      )
      .setTimeout(30)
      .build();

    writeFileSync(fx.inPath, tx.toXDR(), "utf8");

    const res = await runCli(fx, [
      "sign",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--account",
      "treasury",
      "--in",
      fx.inPath,
      "--out",
      fx.outPath,
      "--latest-ledger",
      "4000",
    ]);

    const report = JSON.parse(res.stdout);
    expect(report.summary.signed).toBeGreaterThanOrEqual(1);

    const signedTx = TransactionBuilder.fromXDR(
      readFileSync(fx.outPath, "utf8").trim(),
      fx.passphrase,
    );
    expect(signedTx.signatures.length).toBe(1);
  });

  it("reviews a payload with signability details", async () => {
    const fx = makeFixture();
    const smartAuth = makeSmartAccountEntry(
      fx.contractId,
      fx.verifierId,
      Buffer.from(fx.external.rawPublicKey()),
      fx.delegated.publicKey(),
    );

    writeFileSync(
      fx.inPath,
      JSON.stringify({
        func: "AAAA",
        auth: [smartAuth.toXDR("base64")],
      }),
      "utf8",
    );

    const res = await runCli(fx, [
      "review",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--account",
      "treasury",
      "--in",
      fx.inPath,
    ]);

    const report = JSON.parse(res.stdout);
    expect(report.inspection.kind).toBe("bundle");
    expect(report.signability.kind).toBe("bundle");
    expect(report.signability.signableAuthEntries).toBeGreaterThanOrEqual(1);
    expect(report.account).toBe("treasury");
  });
});
