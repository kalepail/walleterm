import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Account,
  Address,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  makeFakeSecurityFixture,
  readSecurityCalls,
  securityStoreKey,
} from "../helpers/fake-security.js";
import { runCliInProcess } from "../helpers/run-cli.js";
import { makeTempDir } from "../helpers/temp-dir.js";

type WalletFixture = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  inPath: string;
  outPath: string;
  passphrase: string;
  delegated: Keypair;
  deployer: Keypair;
};

type SubmitFixture = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  inPath: string;
};

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
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(
            StrKey.encodeContract(Buffer.alloc(32, 31)),
          ).toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

function makeWalletFixture(indexerUrl: string): WalletFixture {
  const rootDir = makeTempDir("walleterm-keychain-e2e-");
  const inPath = join(rootDir, "in.txt");
  const outPath = join(rootDir, "out.txt");
  const configPath = join(rootDir, "walleterm.toml");

  const delegated = Keypair.random();
  const deployer = Keypair.random();
  const security = makeFakeSecurityFixture({
    [securityStoreKey("walleterm-testnet", "delegated_seed")]: delegated.secret(),
    [securityStoreKey("walleterm-testnet", "deployer_seed")]: deployer.secret(),
  });

  writeFileSync(
    configPath,
    `[app]
default_network = "testnet"
strict_onchain = false
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
contract_id = "${StrKey.encodeContract(Buffer.alloc(32, 7))}"
expected_wasm_hash = "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e"

[[smart_accounts.treasury.delegated_signers]]
name = "del1"
address = "${delegated.publicKey()}"
secret_ref = "keychain://walleterm-testnet/delegated_seed"
enabled = true
`,
    "utf8",
  );

  return {
    configPath,
    env: security.env,
    inPath,
    outPath,
    passphrase: Networks.TESTNET,
    delegated,
    deployer,
  };
}

function makeSubmitFixture(channelsBaseUrl: string): SubmitFixture {
  const rootDir = makeTempDir("walleterm-keychain-submit-e2e-");
  const inPath = join(rootDir, "in.txt");
  const configPath = join(rootDir, "walleterm.toml");
  const security = makeFakeSecurityFixture({
    [securityStoreKey("walleterm-testnet", "channels_api_key")]: "test-channels-key",
  });

  writeFileSync(
    configPath,
    `[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "channels"

[networks.testnet]
rpc_url = "https://example.invalid"
network_passphrase = "${Networks.TESTNET}"
channels_base_url = "${channelsBaseUrl}"
channels_api_key_ref = "keychain://walleterm-testnet/channels_api_key"

[smart_accounts.placeholder]
network = "testnet"
contract_id = "CB6DQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4"
`,
    "utf8",
  );

  return {
    configPath,
    env: security.env,
    inPath,
  };
}

async function runCli(env: NodeJS.ProcessEnv, args: string[]) {
  return runCliInProcess(args, env);
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
    externalContract: string;
    signerContract: string;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind mock indexer");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        externalContract,
        signerContract,
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

function startMockChannels(expectedApiKey: string) {
  const requests: Array<{ auth: string | undefined; body: unknown }> = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const auth = req.headers.authorization;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      params?: { xdr?: string };
    };

    requests.push({ auth, body });

    if (auth !== `Bearer ${expectedApiKey}`) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: false, error: "unauthorized" }));
      return;
    }

    const data = {
      hash: typeof body.params?.xdr === "string" ? "tx-hash-123" : "bundle-hash-456",
      status: "confirmed",
      transactionId: "tx-id-1",
    };
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, data }));
  });

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    requests: Array<{ auth: string | undefined; body: unknown }>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind mock channels server");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
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

describe("walleterm keychain e2e", () => {
  it("signs delegated auth entries using keychain-backed signer refs", async () => {
    const mock = await startMockIndexer();
    const fx = makeWalletFixture(mock.baseUrl);
    const entry = makeDelegatedEntry(fx.delegated.publicKey());

    writeFileSync(fx.inPath, entry.toXDR("base64"), "utf8");

    const res = await runCli(fx.env, [
      "sign",
      "--config",
      fx.configPath,
      "--network",
      "testnet",
      "--account",
      "treasury",
      "--in",
      fx.inPath,
      "--out",
      fx.outPath,
      "--latest-ledger",
      "1000",
    ]);

    const report = JSON.parse(res.stdout) as { summary: { signed: number } };
    expect(report.summary.signed).toBe(1);
    const outXdr = readFileSync(fx.outPath, "utf8").trim();
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(outXdr, "base64");
    expect(signed.credentials().address().signature().switch().name).toBe("scvVec");

    const calls = readSecurityCalls(fx.env.WALLETERM_SECURITY_LOG_PATH!);
    expect(
      calls.some(
        (row) =>
          row[0] === "find-generic-password" &&
          row.includes("delegated_seed") &&
          row.includes("walleterm-testnet"),
      ),
    ).toBe(true);

    await mock.close();
  });

  it("looks up wallets from a keychain secret ref", async () => {
    const mock = await startMockIndexer();
    const fx = makeWalletFixture(mock.baseUrl);

    const res = await runCli(fx.env, [
      "wallet",
      "lookup",
      "--config",
      fx.configPath,
      "--network",
      "testnet",
      "--secret-ref",
      "keychain://walleterm-testnet/delegated_seed",
    ]);

    const out = JSON.parse(res.stdout) as {
      count: number;
      mode: string;
      query: { derived_address: string };
      wallets: Array<{ contract_id: string; onchain_signers: unknown[] }>;
    };

    expect(out.mode).toBe("secret-ref");
    expect(out.query.derived_address).toBe(fx.delegated.publicKey());
    expect(out.count).toBe(2);
    expect(out.wallets.map((row) => row.contract_id)).toEqual(
      expect.arrayContaining([mock.signerContract, mock.externalContract]),
    );
    expect(out.wallets.every((row) => row.onchain_signers.length > 0)).toBe(true);

    await mock.close();
  });

  it("builds deploy transactions from a keychain deployer ref", async () => {
    const mock = await startMockIndexer();
    const fx = makeWalletFixture(mock.baseUrl);
    const delegated = Keypair.random().publicKey();
    const salt = Buffer.alloc(32, 11).toString("hex");

    const res = await runCli(fx.env, [
      "wallet",
      "create",
      "--config",
      fx.configPath,
      "--network",
      "testnet",
      "--deployer-secret-ref",
      "keychain://walleterm-testnet/deployer_seed",
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
      contract_id: string;
      deployer_public_key: string;
    };

    expect(info.contract_id.startsWith("C")).toBe(true);
    expect(info.deployer_public_key).toBe(fx.deployer.publicKey());

    const tx = TransactionBuilder.fromXDR(readFileSync(fx.inPath, "utf8").trim(), fx.passphrase);
    expect(tx instanceof FeeBumpTransaction).toBe(false);
    if (tx instanceof FeeBumpTransaction) {
      throw new Error("Expected envelopeTypeTx, got envelopeTypeTxFeeBump");
    }
    expect(tx.signatures.length).toBe(1);

    const calls = readSecurityCalls(fx.env.WALLETERM_SECURITY_LOG_PATH!);
    expect(
      calls.some(
        (row) =>
          row[0] === "find-generic-password" &&
          row.includes("deployer_seed") &&
          row.includes("walleterm-testnet"),
      ),
    ).toBe(true);

    await mock.close();
  });

  it("submits through channels using a keychain-backed api key ref", async () => {
    const mock = await startMockChannels("test-channels-key");
    const fx = makeSubmitFixture(mock.baseUrl);

    const source = Keypair.random();
    const contract = StrKey.encodeContract(Buffer.alloc(32, 19));
    const tx = new TransactionBuilder(new Account(source.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract,
          function: "transfer",
          args: [],
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(source);
    writeFileSync(fx.inPath, tx.toXDR(), "utf8");

    const res = await runCli(fx.env, [
      "submit",
      "--config",
      fx.configPath,
      "--network",
      "testnet",
      "--in",
      fx.inPath,
    ]);

    const out = JSON.parse(res.stdout) as {
      mode: string;
      request_kind: string;
      status: string;
    };

    expect(out.mode).toBe("channels");
    expect(out.request_kind).toBe("tx");
    expect(out.status).toBe("confirmed");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.auth).toBe("Bearer test-channels-key");

    const calls = readSecurityCalls(fx.env.WALLETERM_SECURITY_LOG_PATH!);
    expect(
      calls.some(
        (row) =>
          row[0] === "find-generic-password" &&
          row.includes("channels_api_key") &&
          row.includes("walleterm-testnet"),
      ),
    ).toBe(true);

    await mock.close();
  });
});
