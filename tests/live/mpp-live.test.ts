import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { Mppx, Store } from "mppx/server";
import { XLM_SAC_TESTNET } from "stellar-mpp-sdk";
import { stellar as chargeServer } from "stellar-mpp-sdk/server";
import { stellar as channelServer } from "stellar-mpp-sdk/channel/server";
import { makeTempDir } from "../helpers/temp-dir.js";
import { fundWithFriendbot, PROJECT_ROOT } from "./helpers.js";

const maybeDescribe =
  process.env.WALLETERM_LIVE === "1" && process.env.WALLETERM_LIVE_MPP === "1"
    ? describe
    : describe.skip;

const TESTNET_RPC_URL = "https://soroban-rpc.testnet.stellar.gateway.fm";
const MPP_FACTORY_CONTRACT_ID = "CDT3EF73C25AIENBQMIH2PCMQWEXT4YE73ED5SJIARWF4QROL7N6NJ44";
const MPP_XLM_TOKEN_CONTRACT_ID = XLM_SAC_TESTNET;

interface LivePayResult {
  protocol: string;
  scheme: string | null;
  paid: boolean;
  status: number;
  payer: string;
  response_headers: Record<string, string>;
  challenge?: {
    request?: Record<string, unknown>;
  } | null;
  payment_attempt?: {
    payload?: Record<string, unknown>;
  } | null;
  settlement?: Record<string, unknown> | null;
  channel?: Record<string, unknown> | null;
  body: string;
}

interface MppFixture {
  configPath: string;
  opBinPath: string;
  payer: Keypair;
  recipient: Keypair;
  rootDir: string;
  secretRef: string;
  recipientSecretRef: string;
  statePath: string;
  cleanup: () => void;
}

interface LocalServerFixture {
  baseUrl: string;
  close: () => Promise<void>;
}

function createMppFixture(): MppFixture {
  const payer = Keypair.random();
  const recipient = Keypair.random();
  const rootDir = makeTempDir("walleterm-mpp-live-");
  const configPath = join(rootDir, "walleterm.toml");
  const opBinDir = join(rootDir, "bin");
  const opBinPath = join(opBinDir, "op");
  const statePath = join(rootDir, "mpp-state.json");
  const secretRef = "op://vault/item/mpp_payer_seed";
  const recipientSecretRef = "op://vault/item/mpp_recipient_seed";

  mkdirSync(opBinDir, { recursive: true });
  writeFileSync(
    opBinPath,
    `#!/usr/bin/env node
const ref = process.argv[3];
const map = {
  ${JSON.stringify(secretRef)}: ${JSON.stringify(payer.secret())},
  ${JSON.stringify(recipientSecretRef)}: ${JSON.stringify(recipient.secret())},
};
if (process.argv[2] !== "read" || !map[ref]) process.exit(1);
process.stdout.write(map[ref]);
`,
    { encoding: "utf8", mode: 0o700 },
  );
  chmodSync(opBinPath, 0o700);

  writeFileSync(
    configPath,
    `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "${TESTNET_RPC_URL}"
network_passphrase = "${Networks.TESTNET}"

[payments]
default_protocol = "mpp"

[payments.mpp]
default_payer_secret_ref = "${secretRef}"

[payments.mpp.channel]
factory_contract_id = "${MPP_FACTORY_CONTRACT_ID}"
token_contract_id = "${MPP_XLM_TOKEN_CONTRACT_ID}"
recipient = "${recipient.publicKey()}"
recipient_secret_ref = "${recipientSecretRef}"
default_deposit = "10000000"
refund_waiting_period = 24
source_account = "${payer.publicKey()}"
state_file = "${statePath}"

[smart_accounts]
`,
    "utf8",
  );

  return {
    configPath,
    opBinPath,
    payer,
    recipient,
    rootDir,
    secretRef,
    recipientSecretRef,
    statePath,
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

async function runCliJson(fixture: MppFixture, args: string[]): Promise<Record<string, unknown>> {
  const result = await execa("bun", ["src/cli.ts", ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, WALLETERM_OP_BIN: fixture.opBinPath },
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function runPayJson(
  fixture: MppFixture,
  url: string,
  extraArgs: string[],
): Promise<LivePayResult> {
  const result = await execa(
    "bun",
    [
      "src/cli.ts",
      "pay",
      url,
      "--config",
      fixture.configPath,
      "--network",
      "testnet",
      "--secret-ref",
      fixture.secretRef,
      "--format",
      "json",
      ...extraArgs,
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, WALLETERM_OP_BIN: fixture.opBinPath },
    },
  );

  return JSON.parse(result.stdout) as LivePayResult;
}

function decodeBodyJson(result: LivePayResult): Record<string, unknown> {
  return JSON.parse(Buffer.from(result.body, "base64").toString("utf8")) as Record<string, unknown>;
}

function toWebRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : new ReadableStream<Uint8Array>({
          start(controller) {
            req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            req.on("end", () => controller.close());
            req.on("error", (error) => controller.error(error));
          },
        });
  return new Request(url, { method: req.method, headers, body, duplex: "half" });
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await webRes.arrayBuffer()));
}

async function startLocalServer(
  handler: (request: Request) => Promise<Response>,
): Promise<LocalServerFixture> {
  const server = createServer(async (req, res) => {
    try {
      const webReq = toWebRequest(req);
      await sendWebResponse(await handler(webReq), res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve local test server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createChargeServer(recipient: Keypair): Promise<LocalServerFixture> {
  const mppx = Mppx.create({
    secretKey: `mpp-live-charge-${randomBytes(8).toString("hex")}`,
    methods: [
      chargeServer.charge({
        recipient: recipient.publicKey(),
        currency: MPP_XLM_TOKEN_CONTRACT_ID,
        network: "testnet",
        rpcUrl: TESTNET_RPC_URL,
        store: Store.memory(),
      }),
    ],
  });

  return startLocalServer(async (request) => {
    const result = await mppx.charge({
      amount: "0.5",
      description: "Live MPP charge test",
    })(request);

    if (result.status === 402) return result.challenge;

    return result.withReceipt(
      Response.json({
        ok: true,
        method: "charge",
      }),
    );
  });
}

function createChannelServer(channelId: string, payer: Keypair, recipient: Keypair) {
  const mppx = Mppx.create({
    secretKey: `mpp-live-channel-${randomBytes(8).toString("hex")}`,
    methods: [
      channelServer.channel({
        channel: channelId,
        commitmentKey: payer.publicKey(),
        closeKey: recipient,
        checkOnChainState: true,
        network: "testnet",
        rpcUrl: TESTNET_RPC_URL,
        sourceAccount: payer.publicKey(),
        store: Store.memory(),
      }),
    ],
  });

  return startLocalServer(async (request) => {
    const result = await mppx.channel({
      amount: "0.1",
      description: "Live MPP channel test",
    })(request);

    if (result.status === 402) return result.challenge;

    return result.withReceipt(
      Response.json({
        ok: true,
        method: "channel",
        channelId,
      }),
    );
  });
}

maybeDescribe("walleterm live mpp pay", () => {
  let fixture: MppFixture;

  beforeAll(async () => {
    fixture = createMppFixture();
    await fundWithFriendbot(fixture.payer.publicKey());
    await fundWithFriendbot(fixture.recipient.publicKey());
    console.log(
      `[live.mpp-live] payer=${fixture.payer.publicKey()} recipient=${fixture.recipient.publicKey()}`,
    );
  }, 120_000);

  afterAll(() => {
    fixture?.cleanup();
  });

  it(
    "pays a live MPP charge endpoint and returns a verified receipt",
    { timeout: 240_000 },
    async () => {
      const server = await createChargeServer(fixture.recipient);
      try {
        const result = await runPayJson(fixture, `${server.baseUrl}/charge`, [
          "--protocol",
          "mpp",
          "--intent",
          "charge",
        ]);

        expect(result.protocol).toBe("mpp");
        expect(result.scheme).toBeNull();
        expect(result.paid).toBe(true);
        expect(result.status).toBe(200);
        expect(result.response_headers["content-type"]).toContain("application/json");
        expect(result.challenge?.request?.amount).toBe("5000000");
        expect(result.settlement?.method).toBe("stellar");
        expect(typeof result.settlement?.reference).toBe("string");
        expect(decodeBodyJson(result)).toEqual({
          ok: true,
          method: "charge",
        });
      } finally {
        await server.close();
      }
    },
  );

  it(
    "opens an MPP channel, reuses it for repeated payments, and closes it on-chain",
    { timeout: 300_000 },
    async () => {
      const open = await runCliJson(fixture, [
        "channel",
        "open",
        "--config",
        fixture.configPath,
        "--network",
        "testnet",
        "--secret-ref",
        fixture.secretRef,
      ]);

      const channelId = String(open.channel_id);
      expect(channelId.startsWith("C")).toBe(true);
      expect(typeof open.tx_hash).toBe("string");

      const server = await createChannelServer(channelId, fixture.payer, fixture.recipient);
      try {
        const first = await runPayJson(fixture, `${server.baseUrl}/channel`, [
          "--protocol",
          "mpp",
          "--intent",
          "channel",
          "--source-account",
          fixture.payer.publicKey(),
        ]);

        const second = await runPayJson(fixture, `${server.baseUrl}/channel`, [
          "--protocol",
          "mpp",
          "--intent",
          "channel",
          "--source-account",
          fixture.payer.publicKey(),
        ]);

        expect(first.protocol).toBe("mpp");
        expect(first.paid).toBe(true);
        expect(first.status).toBe(200);
        expect(first.challenge?.request?.channel).toBe(channelId);
        expect(first.challenge?.request?.amount).toBe("1000000");
        expect(first.settlement?.method).toBe("stellar");
        expect(first.payment_attempt?.payload?.amount).toBe("1000000");
        expect(decodeBodyJson(first)).toEqual({
          ok: true,
          method: "channel",
          channelId,
        });

        expect(second.protocol).toBe("mpp");
        expect(second.paid).toBe(true);
        expect(second.status).toBe(200);
        expect(second.challenge?.request?.channel).toBe(channelId);
        expect(second.challenge?.request?.amount).toBe("1000000");
        expect(second.settlement?.method).toBe("stellar");
        expect(second.payment_attempt?.payload?.amount).toBe("2000000");
        expect(decodeBodyJson(second)).toEqual({
          ok: true,
          method: "channel",
          channelId,
        });

        const stateFile = JSON.parse(readFileSync(fixture.statePath, "utf8")) as {
          active_channel_by_network?: Record<string, string>;
          channels?: Record<
            string,
            {
              channel_id?: string;
              cumulative_amount?: string;
              last_voucher_amount?: string;
              last_voucher_signature?: string;
              lifecycle_state?: string;
            }
          >;
        };
        expect(stateFile.active_channel_by_network?.testnet).toBe(channelId);
        expect(stateFile.channels?.[channelId]?.channel_id).toBe(channelId);
        expect(stateFile.channels?.[channelId]?.cumulative_amount).toBe("2000000");
        expect(stateFile.channels?.[channelId]?.last_voucher_amount).toBe("2000000");
        expect(typeof stateFile.channels?.[channelId]?.last_voucher_signature).toBe("string");

        const close = await runCliJson(fixture, [
          "channel",
          "close",
          "--config",
          fixture.configPath,
          "--network",
          "testnet",
          "--channel-id",
          channelId,
        ]);
        expect(close.channel_id).toBe(channelId);
        expect(close.amount).toBe("2000000");
        expect(typeof close.tx_hash).toBe("string");

        const closedState = JSON.parse(readFileSync(fixture.statePath, "utf8")) as {
          active_channel_by_network?: Record<string, string>;
          channels?: Record<
            string,
            {
              lifecycle_state?: string;
              close_tx_hash?: string;
              cumulative_amount?: string;
            }
          >;
        };
        expect(closedState.active_channel_by_network?.testnet).toBeUndefined();
        expect(closedState.channels?.[channelId]?.lifecycle_state).toBe("closed");
        expect(closedState.channels?.[channelId]?.cumulative_amount).toBe("2000000");
        expect(closedState.channels?.[channelId]?.close_tx_hash).toBe(String(close.tx_hash));
      } finally {
        await server.close();
      }
    },
  );
});
