import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { makeTempDir } from "../helpers/temp-dir.js";

type Fixture = {
  configPath: string;
  inPath: string;
  outPath: string;
  env: NodeJS.ProcessEnv;
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

function makeFixture(
  channelsBaseUrl: string,
  channelsRef = "op://vault/channels/api_key",
  channelsKey = "test-channels-key",
): Fixture {
  const rootDir = makeTempDir("walleterm-submit-e2e-");
  const inPath = join(rootDir, "in.txt");
  const outPath = join(rootDir, "out.txt");
  const configPath = join(rootDir, "walleterm.toml");
  const binDir = join(rootDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const opBin = join(binDir, "op");

  writeFileSync(
    opBin,
    `#!/usr/bin/env node
const ref = process.argv[3];
const map = {
  ${JSON.stringify(channelsRef)}: ${JSON.stringify(channelsKey)},
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
default_submit_mode = "channels"

[networks.testnet]
rpc_url = "https://example.invalid"
network_passphrase = "${Networks.TESTNET}"
channels_base_url = "${channelsBaseUrl}"
channels_api_key_ref = "${channelsRef}"

[smart_accounts.placeholder]
network = "testnet"
contract_id = "CB6DQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4"
`,
    "utf8",
  );

  return {
    configPath,
    inPath,
    outPath,
    env: {
      ...process.env,
      WALLETERM_OP_BIN: opBin,
    },
  };
}

async function runCli(fx: Fixture, args: string[]) {
  return runCliInProcess(args, fx.env);
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
      params?: { xdr?: string; func?: string; auth?: string[] };
    };

    requests.push({ auth, body });

    if (auth !== `Bearer ${expectedApiKey}`) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          success: false,
          error: "unauthorized",
          data: { code: "UNAUTHORIZED" },
        }),
      );
      return;
    }

    const isTx = typeof body.params?.xdr === "string";
    const data = {
      hash: isTx ? "tx-hash-123" : "bundle-hash-456",
      status: "confirmed",
      transactionId: isTx ? "tx-id-1" : "tx-id-2",
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, data }));
  });

  return new Promise<{
    baseUrl: string;
    requests: Array<{ auth: string | undefined; body: unknown }>;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("failed to bind mock channels server");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
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

describe("walleterm submit e2e", () => {
  it("submits signed tx xdr through channels", async () => {
    const mock = await startMockChannels("test-channels-key");
    const fx = makeFixture(mock.baseUrl);

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

    const res = await runCli(fx, [
      "submit",
      "--config",
      fx.configPath,
      "--network",
      "testnet",
      "--in",
      fx.inPath,
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.mode).toBe("channels");
    expect(out.request_kind).toBe("tx");
    expect(out.status).toBe("confirmed");
    expect(mock.requests.length).toBe(1);

    await mock.close();
  });

  it("submits func+auth bundle through channels", async () => {
    const mock = await startMockChannels("test-channels-key");
    const fx = makeFixture(mock.baseUrl);

    const auth = makeDelegatedEntry(Keypair.random().publicKey());
    writeFileSync(
      fx.inPath,
      JSON.stringify({
        func: "AAAA",
        auth: [auth.toXDR("base64")],
      }),
      "utf8",
    );

    const res = await runCli(fx, [
      "submit",
      "--config",
      fx.configPath,
      "--network",
      "testnet",
      "--in",
      fx.inPath,
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.mode).toBe("channels");
    expect(out.request_kind).toBe("bundle");
    expect(out.status).toBe("confirmed");
    expect(mock.requests.length).toBe(1);

    await mock.close();
  });

  it("creates and submits wallet deployment tx through channels", async () => {
    const mock = await startMockChannels("submit-key");
    const channelsRef = "op://vault/channels/api_key";
    const deployerRef = "op://vault/deployer/seed";
    const deployer = Keypair.random();

    const fx = makeFixture(mock.baseUrl, channelsRef, "submit-key");

    const opBin = fx.env.WALLETERM_OP_BIN!;
    writeFileSync(
      opBin,
      `#!/usr/bin/env node
const ref = process.argv[3];
const map = {
  ${JSON.stringify(channelsRef)}: "submit-key",
  ${JSON.stringify(deployerRef)}: ${JSON.stringify(deployer.secret())},
};
if (process.argv[2] !== 'read' || !map[ref]) process.exit(1);
process.stdout.write(map[ref]);
`,
      "utf8",
    );
    chmodSync(opBin, 0o755);

    const delegated = Keypair.random().publicKey();

    const res = await runCli(fx, [
      "wallet",
      "create",
      "--config",
      fx.configPath,
      "--network",
      "testnet",
      "--deployer-secret-ref",
      deployerRef,
      "--wasm-hash",
      "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      "--delegated-address",
      delegated,
      "--salt-hex",
      Buffer.alloc(32, 9).toString("hex"),
      "--sequence",
      "1",
      "--skip-prepare",
      "--submit",
      "--submit-mode",
      "channels",
      "--out",
      fx.outPath,
    ]);

    const out = JSON.parse(res.stdout);
    expect(out.submitted).toBe(true);
    expect(out.submission.mode).toBe("channels");
    expect(out.submission.request_kind).toBe("tx");

    const txXdr = readFileSync(fx.outPath, "utf8").trim();
    expect(txXdr.length).toBeGreaterThan(0);
    expect(mock.requests.length).toBe(1);

    await mock.close();
  });
});
