import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FeeBumpTransaction,
  hash,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { deriveContractIdFromSalt, smartAccountKitDeployerKeypair } from "../../src/wallet.js";
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
  deployer: Keypair;
};

function toHex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function makeFixture(indexerUrl: string): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), "walleterm-wallet-e2e-"));
  const inPath = join(rootDir, "in.txt");
  const outPath = join(rootDir, "out.json");
  const configPath = join(rootDir, "walleterm.toml");
  const binDir = join(rootDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const external = Keypair.random();
  const delegated = Keypair.random();
  const deployer = Keypair.random();

  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  const verifierId = StrKey.encodeContract(Buffer.alloc(32, 9));

  const opBin = join(binDir, "op");
  const externalRef = "op://vault/external/seed";
  const delegatedRef = "op://vault/delegated/seed";
  const deployerRef = "op://vault/deployer/seed";

  writeFileSync(
    opBin,
    `#!/usr/bin/env node
const ref = process.argv[3];
const map = {
  ${JSON.stringify(externalRef)}: ${JSON.stringify(external.secret())},
  ${JSON.stringify(delegatedRef)}: ${JSON.stringify(delegated.secret())},
  ${JSON.stringify(deployerRef)}: ${JSON.stringify(deployer.secret())},
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
indexer_url = "${indexerUrl}"

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
    deployer,
  };
}

async function runCli(fx: Fixture, args: string[]) {
  return runCliInProcess(args, fx.env);
}

function startMockIndexer() {
  const delegatedAddress = Keypair.random().publicKey();
  const externalCredentialId = "1e4d40bc5f4f18b36d1ec4aa440f5d3a3cf7c35d089f95de5e7505cab6f3188a";
  const signerContract = StrKey.encodeContract(Buffer.alloc(32, 21));
  const externalContract = StrKey.encodeContract(Buffer.alloc(32, 23));
  const signerVerifier = StrKey.encodeContract(Buffer.alloc(32, 22));

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";

    if (path.startsWith("/api/lookup/address/")) {
      const address = decodeURIComponent(path.slice("/api/lookup/address/".length));
      const body = {
        signerAddress: address,
        contracts: [
          {
            contract_id: signerContract,
            context_rule_count: 1,
            external_signer_count: 1,
            delegated_signer_count: 1,
            native_signer_count: 0,
            first_seen_ledger: 100,
            last_seen_ledger: 200,
            context_rule_ids: [0],
          },
        ],
        count: 1,
      };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
      return;
    }

    if (path.startsWith("/api/lookup/")) {
      const body = {
        credentialId: externalCredentialId,
        contracts: [
          {
            contract_id: externalContract,
            context_rule_count: 1,
            external_signer_count: 1,
            delegated_signer_count: 0,
            native_signer_count: 0,
            first_seen_ledger: 150,
            last_seen_ledger: 250,
            context_rule_ids: [0],
          },
        ],
        count: 1,
      };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
      return;
    }

    if (path === `/api/contract/${signerContract}/signers`) {
      const body = {
        contractId: signerContract,
        signers: [
          {
            context_rule_id: 0,
            signer_type: "Delegated",
            signer_address: delegatedAddress,
            credential_id: null,
          },
          {
            context_rule_id: 0,
            signer_type: "External",
            signer_address: signerVerifier,
            credential_id: externalCredentialId,
          },
        ],
      };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
      return;
    }

    if (path === `/api/contract/${externalContract}/signers`) {
      const body = {
        contractId: externalContract,
        signers: [
          {
            context_rule_id: 0,
            signer_type: "External",
            signer_address: signerVerifier,
            credential_id: externalCredentialId,
          },
        ],
      };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  };

  const server = createServer(handler);

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    signerContract: string;
    externalContract: string;
    delegatedAddress: string;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind mock indexer");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        signerContract,
        externalContract,
        delegatedAddress,
        close: () =>
          new Promise<void>((done, reject) => {
            server.close((err) => {
              if (err) reject(err);
              else done();
            });
          }),
      });
    });
  });
}

describe("walleterm wallet management e2e", () => {
  it("generates a new keypair", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);

    const res = await runCli(fx, ["wallet", "signer", "generate"]);
    const out = JSON.parse(res.stdout);

    const kp = Keypair.fromSecret(out.secret_seed);
    expect(kp.publicKey()).toBe(out.public_key);
    expect(out.public_key_hex).toBe(Buffer.from(kp.rawPublicKey()).toString("hex"));

    await mock.close();
  });

  it("looks up wallets by signer address through indexer", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);

    const signerAddress = Keypair.random().publicKey();
    const res = await runCli(fx, [
      "wallet",
      "lookup",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--address",
      signerAddress,
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.mode).toBe("address");
    expect(out.count).toBe(1);
    expect(out.wallets[0].contract_id).toBe(mock.signerContract);

    await mock.close();
  });

  it("looks up wallets directly from an op secret ref and includes onchain signers", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);

    const res = await runCli(fx, [
      "wallet",
      "lookup",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--secret-ref",
      "op://vault/delegated/seed",
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.mode).toBe("secret-ref");
    expect(out.query.derived_address).toBe(fx.delegated.publicKey());
    expect(out.count).toBe(2);
    expect(out.wallets.map((row: { contract_id: string }) => row.contract_id)).toEqual(
      expect.arrayContaining([mock.signerContract, mock.externalContract]),
    );
    expect(
      out.wallets.every((row: { onchain_signers: unknown[] }) => row.onchain_signers.length > 0),
    ).toBe(true);

    await mock.close();
  });

  it("looks up wallet signers by contract id", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);

    const res = await runCli(fx, [
      "wallet",
      "lookup",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--contract-id",
      mock.signerContract,
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.mode).toBe("contract");
    expect(out.wallets[0].contract_id).toBe(mock.signerContract);
    expect(out.wallets[0].onchain_signers.length).toBe(2);

    await mock.close();
  });

  it("builds and signs add-delegated-signer bundle", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);

    const res = await runCli(fx, [
      "wallet",
      "signer",
      "add",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--account",
      "treasury",
      "--context-rule-id",
      "0",
      "--secret-ref",
      "op://vault/delegated/seed",
      "--latest-ledger",
      "1000",
      "--out",
      fx.outPath,
    ]);

    const report = JSON.parse(res.stdout);
    expect(report.operation).toBe("add_signer");
    expect(report.summary.signed).toBeGreaterThanOrEqual(2);

    const out = JSON.parse(readFileSync(fx.outPath, "utf8"));
    expect(out.func).toBeDefined();
    expect(out.auth.length).toBeGreaterThanOrEqual(2);

    const smartSigned = xdr.SorobanAuthorizationEntry.fromXDR(out.auth[0], "base64");
    const fn = smartSigned.rootInvocation().function().contractFn().functionName().toString();
    expect(fn).toBe("add_signer");

    await mock.close();
  });

  it("builds and signs add-external-ed25519-signer bundle", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);
    const verifier = StrKey.encodeContract(Buffer.alloc(32, 33));

    const res = await runCli(fx, [
      "wallet",
      "signer",
      "add",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--account",
      "treasury",
      "--context-rule-id",
      "0",
      "--secret-ref",
      "op://vault/external/seed",
      "--verifier-contract-id",
      verifier,
      "--latest-ledger",
      "1200",
      "--out",
      fx.outPath,
    ]);

    const report = JSON.parse(res.stdout);
    expect(report.operation).toBe("add_signer");
    expect(report.summary.signed).toBeGreaterThanOrEqual(2);

    const out = JSON.parse(readFileSync(fx.outPath, "utf8"));
    expect(out.func).toBeDefined();
    expect(out.auth.length).toBeGreaterThanOrEqual(2);

    await mock.close();
  });

  it("builds and signs deploy transaction for a new wallet", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);
    const delegated = Keypair.random().publicKey();
    const salt = Buffer.alloc(32, 11).toString("hex");
    const deployRef = "op://vault/deployer/seed";

    const res = await runCli(fx, [
      "wallet",
      "create",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--deployer-secret-ref",
      deployRef,
      "--wasm-hash",
      "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      "--delegated-address",
      delegated,
      "--salt-hex",
      salt,
      "--sequence",
      "1",
      "--skip-prepare",
      "--out",
      fx.inPath,
    ]);

    const info = JSON.parse(res.stdout);
    expect(info.contract_id.startsWith("C")).toBe(true);
    expect(info.deployer_public_key).toBe(fx.deployer.publicKey());

    const tx = TransactionBuilder.fromXDR(readFileSync(fx.inPath, "utf8").trim(), fx.passphrase);
    expect(tx instanceof FeeBumpTransaction).toBe(false);
    if (tx instanceof FeeBumpTransaction) {
      throw new Error("Expected envelopeTypeTx, got envelopeTypeTxFeeBump");
    }
    expect(tx.signatures.length).toBe(1);
    expect(String(tx.fee)).toBe("0");
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    const now = Math.floor(Date.now() / 1000);
    expect(maxTime - now).toBeGreaterThan(0);
    expect(maxTime - now).toBeLessThanOrEqual(60);

    await mock.close();
  });

  it("builds deterministic deploy transaction matching smart-account-kit derivation", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);
    const delegated = Keypair.random().publicKey();
    const rawId = "user@example.com";

    const res = await runCli(fx, [
      "wallet",
      "create",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--kit-raw-id",
      rawId,
      "--wasm-hash",
      "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      "--delegated-address",
      delegated,
      "--sequence",
      "1",
      "--skip-prepare",
      "--out",
      fx.inPath,
    ]);

    const info = JSON.parse(res.stdout) as {
      contract_id: string;
      deployer_public_key: string;
      salt_hex: string;
      deterministic_mode: string;
      deterministic_input?: string;
    };

    const expectedDeployer = smartAccountKitDeployerKeypair();
    const expectedSaltHex = hash(Buffer.from(rawId)).toString("hex");
    const expectedContractId = deriveContractIdFromSalt(
      fx.passphrase,
      expectedDeployer.publicKey(),
      Buffer.from(expectedSaltHex, "hex"),
    );

    expect(info.deployer_public_key).toBe(expectedDeployer.publicKey());
    expect(info.salt_hex).toBe(expectedSaltHex);
    expect(info.contract_id).toBe(expectedContractId);
    expect(info.deterministic_mode).toBe("smart-account-kit");
    expect(info.deterministic_input).toBe(rawId);

    const tx = TransactionBuilder.fromXDR(readFileSync(fx.inPath, "utf8").trim(), fx.passphrase);
    expect(tx.signatures.length).toBe(1);

    await mock.close();
  });

  it("uses networks.<name>.deployer_secret_ref when flag is omitted", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);
    const delegated = Keypair.random().publicKey();
    const deployerRef = "op://vault/deployer/seed";
    const salt = Buffer.alloc(32, 13).toString("hex");

    const original = readFileSync(fx.configPath, "utf8");
    const updated = original.replace(
      `network_passphrase = "${Networks.TESTNET}"\nindexer_url =`,
      `network_passphrase = "${Networks.TESTNET}"\ndeployer_secret_ref = "${deployerRef}"\nindexer_url =`,
    );
    writeFileSync(fx.configPath, updated, "utf8");

    const res = await runCli(fx, [
      "wallet",
      "create",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--wasm-hash",
      "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      "--delegated-address",
      delegated,
      "--salt-hex",
      salt,
      "--sequence",
      "1",
      "--skip-prepare",
      "--out",
      fx.inPath,
    ]);

    const info = JSON.parse(res.stdout) as {
      deployer_public_key: string;
      deterministic_mode: string;
    };

    expect(info.deployer_public_key).toBe(fx.deployer.publicKey());
    expect(info.deterministic_mode).toBe("custom");

    await mock.close();
  });

  it("defaults deployer to smart-account-kit deterministic deployer", async () => {
    const mock = await startMockIndexer();
    const fx = makeFixture(mock.baseUrl);
    const delegated = Keypair.random().publicKey();
    const salt = Buffer.alloc(32, 12).toString("hex");

    const res = await runCli(fx, [
      "wallet",
      "create",
      "--config",
      fx.configPath,
      "--network",
      fx.network,
      "--wasm-hash",
      "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      "--delegated-address",
      delegated,
      "--salt-hex",
      salt,
      "--sequence",
      "1",
      "--skip-prepare",
      "--out",
      fx.inPath,
    ]);

    const info = JSON.parse(res.stdout) as {
      deployer_public_key: string;
      deterministic_mode: string;
    };

    const expectedDeployer = smartAccountKitDeployerKeypair();
    expect(info.deployer_public_key).toBe(expectedDeployer.publicKey());
    expect(info.deterministic_mode).toBe("smart-account-kit-deployer");

    await mock.close();
  });
});
