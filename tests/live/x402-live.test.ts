import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { makeTempDir } from "../helpers/temp-dir.js";
import { ensureTestnetUsdcBalance, PROJECT_ROOT, X402_NFT_BASE_URL } from "./helpers.js";

const maybeDescribe =
  process.env.WALLETERM_LIVE === "1" && process.env.WALLETERM_LIVE_X402 === "1"
    ? describe
    : describe.skip;

interface LivePayResult {
  protocol: string;
  scheme: string | null;
  paid: boolean;
  status: number;
  payer: string;
  response_headers: Record<string, string>;
  settlement?: Record<string, unknown> | null;
  payment_attempt?: Record<string, unknown> | null;
  channel?: Record<string, unknown> | null;
  body: string;
}

interface LivePayerFixture {
  configPath: string;
  opBinPath: string;
  payer: Keypair;
  rootDir: string;
  secretRef: string;
  statePath: string;
  cleanup: () => void;
}

function createLivePayerFixture(): LivePayerFixture {
  const payer = Keypair.random();
  const rootDir = makeTempDir("walleterm-x402-live-");
  const configPath = join(rootDir, "walleterm.toml");
  const opBinDir = join(rootDir, "bin");
  const opBinPath = join(opBinDir, "op");
  const statePath = join(rootDir, "x402-state.json");
  const secretRef = "op://vault/item/payer_seed";

  mkdirSync(opBinDir, { recursive: true });
  writeFileSync(
    opBinPath,
    `#!/usr/bin/env node
const ref = process.argv[3];
if (process.argv[2] === "read" && ref === "${secretRef}") {
  process.stdout.write("${payer.secret()}");
  process.exit(0);
}
process.exit(1);
`,
    { encoding: "utf8", mode: 0o700 },
  );
  chmodSync(opBinPath, 0o700);

  writeFileSync(
    configPath,
    `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://soroban-rpc.testnet.stellar.gateway.fm"
network_passphrase = "${Networks.TESTNET}"

[smart_accounts]
`,
    "utf8",
  );

  return {
    configPath,
    opBinPath,
    payer,
    rootDir,
    secretRef,
    statePath,
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

async function runPayJson(
  fixture: LivePayerFixture,
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

function uniqueSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

maybeDescribe("walleterm live x402 pay", () => {
  let fixture: LivePayerFixture;

  beforeAll(async () => {
    fixture = createLivePayerFixture();
    const usdcBalance = await ensureTestnetUsdcBalance(fixture.payer);
    console.log(`[live.x402-live] payer=${fixture.payer.publicKey()} usdc_balance=${usdcBalance}`);
  }, 180_000);

  afterAll(() => {
    fixture?.cleanup();
  });

  it(
    "pays a live exact x402 endpoint and returns PNG data plus settlement metadata",
    { timeout: 240_000 },
    async () => {
      const result = await runPayJson(
        fixture,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        ["--x402-scheme", "exact"],
      );

      expect(result.protocol).toBe("x402");
      expect(result.scheme).toBe("exact");
      expect(result.paid).toBe(true);
      expect(result.status).toBe(200);
      expect(result.payer).toBe(fixture.payer.publicKey());
      expect(result.response_headers["content-type"]).toBe("image/png");
      expect(typeof result.settlement?.transaction).toBe("string");
      expect(Buffer.from(result.body, "base64").length).toBeGreaterThan(100);
    },
  );

  it(
    "opens and reuses a live x402 state channel on repeated requests to the same endpoint",
    { timeout: 240_000 },
    async () => {
      const first = await runPayJson(
        fixture,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        [
          "--x402-scheme",
          "channel",
          "--x402-channel-deposit",
          "1000000",
          "--x402-channel-state-file",
          fixture.statePath,
        ],
      );

      const second = await runPayJson(
        fixture,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        [
          "--x402-scheme",
          "channel",
          "--x402-channel-deposit",
          "1000000",
          "--x402-channel-state-file",
          fixture.statePath,
        ],
      );

      expect(first.scheme).toBe("channel");
      expect(first.paid).toBe(true);
      expect(first.status).toBe(200);
      expect(first.response_headers["content-type"]).toBe("image/png");
      expect(first.channel?.action).toBe("open+pay");
      expect(first.channel?.opened).toBe(true);
      expect(typeof first.channel?.channel_id).toBe("string");

      expect(second.scheme).toBe("channel");
      expect(second.paid).toBe(true);
      expect(second.status).toBe(200);
      expect(second.response_headers["content-type"]).toBe("image/png");
      expect(second.channel?.action).toBe("pay");
      expect(second.channel?.opened).toBe(false);
      expect(second.channel?.channel_id).toBe(first.channel?.channel_id);

      const firstCumulative = BigInt(String(first.channel?.current_cumulative));
      const secondCumulative = BigInt(String(second.channel?.current_cumulative));
      const firstRemaining = BigInt(String(first.channel?.remaining_balance));
      const secondRemaining = BigInt(String(second.channel?.remaining_balance));

      expect(secondCumulative).toBeGreaterThan(firstCumulative);
      expect(secondRemaining).toBeLessThan(firstRemaining);

      const stateFile = JSON.parse(readFileSync(fixture.statePath, "utf8")) as {
        active_channel_by_key?: Record<string, string>;
        channels?: Record<string, { channel_id?: string; current_cumulative?: string }>;
      };
      const storedChannels = Object.values(stateFile.channels ?? {});
      expect(storedChannels).toHaveLength(1);
      expect(stateFile.active_channel_by_key).toBeTruthy();
      expect(storedChannels[0]?.channel_id).toBe(first.channel?.channel_id);
      expect(storedChannels[0]?.current_cumulative).toBe(second.channel?.current_cumulative);
    },
  );
});
