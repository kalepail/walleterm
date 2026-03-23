import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { makeTempDir } from "../helpers/temp-dir.js";
import {
  ensureTestnetUsdcBalance,
  fundWithFriendbot,
  PROJECT_ROOT,
  TESTNET_HORIZON_URL,
  TESTNET_USDC_ISSUER,
  X402_NFT_BASE_URL,
} from "./helpers.js";
import {
  buildSshAgentRef,
  listAgentIdentities,
  resolveSocketPath,
} from "../../src/ssh-agent.js";
import { createSshAgentSigner } from "../../src/signer.js";

const BASE_ENABLED = process.env.WALLETERM_LIVE === "1" && process.env.WALLETERM_LIVE_X402 === "1";
const OP_ENABLED = BASE_ENABLED && process.env.WALLETERM_LIVE_OP === "1";
const KEYCHAIN_ENABLED = BASE_ENABLED && process.env.WALLETERM_LIVE_KEYCHAIN === "1";
const SSH_AGENT_ENABLED = BASE_ENABLED && process.env.WALLETERM_LIVE_SSH_AGENT === "1";
const SSH_AGENT_SYSTEM_ENABLED = SSH_AGENT_ENABLED && process.env.WALLETERM_LIVE_SSH_AGENT_SYSTEM === "1";
const SSH_AGENT_1P_ENABLED = SSH_AGENT_ENABLED && process.env.WALLETERM_LIVE_SSH_AGENT_1P === "1";

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

function uniqueSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

async function runPayJson(
  configPath: string,
  secretRef: string,
  url: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<LivePayResult> {
  const result = await execa(
    "bun",
    [
      "src/cli.ts",
      "pay",
      url,
      "--config",
      configPath,
      "--network",
      "testnet",
      "--secret-ref",
      secretRef,
      "--format",
      "json",
      ...extraArgs,
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
    },
  );
  return JSON.parse(result.stdout) as LivePayResult;
}

function makeBasicConfig(rpcUrl = "https://soroban-rpc.testnet.stellar.gateway.fm"): string {
  return `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "${rpcUrl}"
network_passphrase = "${Networks.TESTNET}"

[smart_accounts]
`;
}

async function ensureUsdcForSshAgentKey(
  stellarAddress: string,
  secretRef: string,
): Promise<string> {
  await fundWithFriendbot(stellarAddress);

  const horizon = new Horizon.Server(TESTNET_HORIZON_URL);
  const usdcAsset = new Asset("USDC", TESTNET_USDC_ISSUER);

  let account = await horizon.loadAccount(stellarAddress);
  const hasTrustline = account.balances.some(
    (balance) => "asset_code" in balance && balance.asset_code === "USDC",
  );

  const signer = await createSshAgentSigner(secretRef);

  if (!hasTrustline) {
    const trustlineTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: usdcAsset }))
      .setTimeout(30)
      .build();

    await signer.signTransaction(trustlineTx);
    const trustlineResult = await horizon.submitTransaction(trustlineTx);
    if (!trustlineResult.successful) {
      throw new Error("USDC trustline transaction failed for SSH agent key");
    }
  }

  account = await horizon.loadAccount(stellarAddress);
  const existingBalance = account.balances.find(
    (balance) => "asset_code" in balance && balance.asset_code === "USDC",
  );
  if (existingBalance && Number(existingBalance.balance) > 0) {
    return existingBalance.balance;
  }

  const paths = await horizon.strictSendPaths(Asset.native(), "25", [usdcAsset]).call();
  if (paths.records.length === 0) {
    throw new Error("No DEX path found for XLM -> USDC");
  }

  const bestPath = paths.records[0]!;
  account = await horizon.loadAccount(stellarAddress);
  const swapTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: "25",
        destination: stellarAddress,
        destAsset: usdcAsset,
        destMin: "0.0000001",
        path: bestPath.path.map((asset) =>
          asset.asset_type === "native"
            ? Asset.native()
            : new Asset(asset.asset_code!, asset.asset_issuer!),
        ),
      }),
    )
    .setTimeout(30)
    .build();

  await signer.signTransaction(swapTx);
  const swapResult = await horizon.submitTransaction(swapTx);
  if (!swapResult.successful) {
    throw new Error("USDC DEX swap failed for SSH agent key");
  }

  account = await horizon.loadAccount(stellarAddress);
  const usdcBalance = account.balances.find(
    (balance) => "asset_code" in balance && balance.asset_code === "USDC",
  );
  return usdcBalance?.balance ?? "0";
}

// ---------------------------------------------------------------------------
// 1. 1Password raw secret (op://)
// ---------------------------------------------------------------------------

describe.skipIf(!OP_ENABLED)("walleterm live x402 — 1Password raw secret (op://)", () => {
  let configPath: string;
  let secretRef: string;
  let payer: Keypair;
  let statePath: string;
  let rootDir: string;
  let opBinPath: string;

  beforeAll(async () => {
    payer = Keypair.random();
    rootDir = makeTempDir("walleterm-x402-op-");
    configPath = join(rootDir, "walleterm.toml");
    statePath = join(rootDir, "x402-state.json");
    secretRef = "op://vault/item/x402_op_raw_payer_seed";

    const opBinDir = join(rootDir, "bin");
    opBinPath = join(opBinDir, "op");
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

    writeFileSync(configPath, makeBasicConfig(), "utf8");

    const usdcBalance = await ensureTestnetUsdcBalance(payer);
    console.log(
      `[live.x402-op] payer=${payer.publicKey()} usdc_balance=${usdcBalance}`,
    );
  }, 180_000);

  afterAll(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it(
    "pays exact (direct) route with op:// raw secret",
    { timeout: 240_000 },
    async () => {
      const result = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        ["--x402-scheme", "exact"],
        { WALLETERM_OP_BIN: opBinPath },
      );

      expect(result.protocol).toBe("x402");
      expect(result.scheme).toBe("exact");
      expect(result.paid).toBe(true);
      expect(result.status).toBe(200);
      expect(result.payer).toBe(payer.publicKey());
      expect(result.response_headers["content-type"]).toBe("image/png");
      expect(typeof result.settlement?.transaction).toBe("string");
      expect(Buffer.from(result.body, "base64").length).toBeGreaterThan(100);
    },
  );

  it(
    "opens and reuses channel (session) route with op:// raw secret",
    { timeout: 240_000 },
    async () => {
      const sharedArgs = [
        "--x402-scheme",
        "channel",
        "--x402-channel-deposit",
        "1000000",
        "--x402-channel-state-file",
        statePath,
      ];

      const first = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        sharedArgs,
        { WALLETERM_OP_BIN: opBinPath },
      );
      const second = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        sharedArgs,
        { WALLETERM_OP_BIN: opBinPath },
      );

      expect(first.scheme).toBe("channel");
      expect(first.paid).toBe(true);
      expect(first.status).toBe(200);
      expect(first.channel?.action).toBe("open+pay");
      expect(first.channel?.opened).toBe(true);

      expect(second.scheme).toBe("channel");
      expect(second.paid).toBe(true);
      expect(second.status).toBe(200);
      expect(second.channel?.action).toBe("pay");
      expect(second.channel?.opened).toBe(false);
      expect(second.channel?.channel_id).toBe(first.channel?.channel_id);

      const firstRemaining = BigInt(String(first.channel?.remaining_balance));
      const secondRemaining = BigInt(String(second.channel?.remaining_balance));
      expect(secondRemaining).toBeLessThan(firstRemaining);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. macOS Keychain raw secret (keychain://)
// ---------------------------------------------------------------------------

describe.skipIf(!KEYCHAIN_ENABLED)("walleterm live x402 — macOS Keychain raw secret (keychain://)", () => {
  let configPath: string;
  let secretRef: string;
  let payer: Keypair;
  let statePath: string;
  let rootDir: string;
  let keychainPath: string;

  beforeAll(async () => {
    payer = Keypair.random();
    rootDir = makeTempDir("walleterm-x402-keychain-");
    configPath = join(rootDir, "walleterm.toml");
    statePath = join(rootDir, "x402-state.json");
    keychainPath = join(rootDir, "walleterm-x402-test.keychain-db");
    const keychainPassword = randomBytes(16).toString("hex");
    const service = `walleterm-x402-${randomBytes(6).toString("hex")}`;
    const account = "payer_seed";
    secretRef = `keychain://${service}/${account}?keychain=${keychainPath}`;

    await execa("security", ["create-keychain", "-p", keychainPassword, keychainPath], {
      cwd: PROJECT_ROOT,
    });
    await execa("security", ["unlock-keychain", "-p", keychainPassword, keychainPath], {
      cwd: PROJECT_ROOT,
    });
    await execa("security", ["set-keychain-settings", "-t", "3600", keychainPath], {
      cwd: PROJECT_ROOT,
    });
    await execa(
      "security",
      ["add-generic-password", "-s", service, "-a", account, "-w", payer.secret(), keychainPath],
      { cwd: PROJECT_ROOT },
    );

    writeFileSync(configPath, makeBasicConfig(), "utf8");

    const usdcBalance = await ensureTestnetUsdcBalance(payer);
    console.log(
      `[live.x402-keychain] payer=${payer.publicKey()} usdc_balance=${usdcBalance}`,
    );
  }, 180_000);

  afterAll(async () => {
    try {
      await execa("security", ["delete-keychain", keychainPath], { cwd: PROJECT_ROOT });
    } catch {
      // ignore
    }
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it(
    "pays exact (direct) route with keychain:// raw secret",
    { timeout: 240_000 },
    async () => {
      const result = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        ["--x402-scheme", "exact"],
      );

      expect(result.protocol).toBe("x402");
      expect(result.scheme).toBe("exact");
      expect(result.paid).toBe(true);
      expect(result.status).toBe(200);
      expect(result.payer).toBe(payer.publicKey());
      expect(result.response_headers["content-type"]).toBe("image/png");
      expect(typeof result.settlement?.transaction).toBe("string");
      expect(Buffer.from(result.body, "base64").length).toBeGreaterThan(100);
    },
  );

  it(
    "opens and reuses channel (session) route with keychain:// raw secret",
    { timeout: 240_000 },
    async () => {
      const sharedArgs = [
        "--x402-scheme",
        "channel",
        "--x402-channel-deposit",
        "1000000",
        "--x402-channel-state-file",
        statePath,
      ];

      const first = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        sharedArgs,
      );
      const second = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        sharedArgs,
      );

      expect(first.scheme).toBe("channel");
      expect(first.paid).toBe(true);
      expect(first.status).toBe(200);
      expect(first.channel?.action).toBe("open+pay");
      expect(first.channel?.opened).toBe(true);

      expect(second.scheme).toBe("channel");
      expect(second.paid).toBe(true);
      expect(second.status).toBe(200);
      expect(second.channel?.action).toBe("pay");
      expect(second.channel?.opened).toBe(false);
      expect(second.channel?.channel_id).toBe(first.channel?.channel_id);

      const firstRemaining = BigInt(String(first.channel?.remaining_balance));
      const secondRemaining = BigInt(String(second.channel?.remaining_balance));
      expect(secondRemaining).toBeLessThan(firstRemaining);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. System SSH agent (ssh-agent://system/)
// ---------------------------------------------------------------------------

describe.skipIf(!SSH_AGENT_SYSTEM_ENABLED)("walleterm live x402 — system SSH agent", () => {
  let configPath: string;
  let secretRef: string;
  let stellarAddress: string;
  let statePath: string;
  let rootDir: string;

  beforeAll(async () => {
    const socketPath = resolveSocketPath("system");
    const identities = await listAgentIdentities(socketPath);
    if (identities.length === 0) {
      throw new Error("No Ed25519 keys found in system SSH agent");
    }
    const identity = identities[0]!;
    stellarAddress = identity.comment.startsWith("G") && identity.comment.length === 56
      ? identity.comment
      : await (async () => {
          const { StrKey } = await import("@stellar/stellar-sdk");
          return StrKey.encodeEd25519PublicKey(identity.publicKey);
        })();
    secretRef = buildSshAgentRef("system", stellarAddress);

    rootDir = makeTempDir("walleterm-x402-ssh-system-");
    configPath = join(rootDir, "walleterm.toml");
    statePath = join(rootDir, "x402-state.json");

    writeFileSync(configPath, makeBasicConfig(), "utf8");

    const usdcBalance = await ensureUsdcForSshAgentKey(stellarAddress, secretRef);
    console.log(
      `[live.x402-ssh-system] payer=${stellarAddress} usdc_balance=${usdcBalance}`,
    );
  }, 300_000);

  afterAll(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it(
    "pays exact (direct) route with system SSH agent",
    { timeout: 240_000 },
    async () => {
      const result = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        ["--x402-scheme", "exact"],
      );

      expect(result.protocol).toBe("x402");
      expect(result.scheme).toBe("exact");
      expect(result.paid).toBe(true);
      expect(result.status).toBe(200);
      expect(result.payer).toBe(stellarAddress);
      expect(result.response_headers["content-type"]).toBe("image/png");
      expect(Buffer.from(result.body, "base64").length).toBeGreaterThan(100);
    },
  );

  it(
    "opens and reuses channel (session) route with system SSH agent",
    { timeout: 240_000 },
    async () => {
      const sharedArgs = [
        "--x402-scheme",
        "channel",
        "--x402-channel-deposit",
        "1000000",
        "--x402-channel-state-file",
        statePath,
      ];

      const first = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        sharedArgs,
      );
      const second = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        sharedArgs,
      );

      expect(first.scheme).toBe("channel");
      expect(first.paid).toBe(true);
      expect(first.status).toBe(200);
      expect(first.channel?.action).toBe("open+pay");
      expect(first.channel?.opened).toBe(true);
      expect(first.payer).toBe(stellarAddress);

      expect(second.scheme).toBe("channel");
      expect(second.paid).toBe(true);
      expect(second.status).toBe(200);
      expect(second.channel?.action).toBe("pay");
      expect(second.channel?.opened).toBe(false);
      expect(second.channel?.channel_id).toBe(first.channel?.channel_id);

      const firstRemaining = BigInt(String(first.channel?.remaining_balance));
      const secondRemaining = BigInt(String(second.channel?.remaining_balance));
      expect(secondRemaining).toBeLessThan(firstRemaining);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. 1Password SSH agent (ssh-agent://1password/)
// ---------------------------------------------------------------------------

describe.skipIf(!SSH_AGENT_1P_ENABLED)("walleterm live x402 — 1Password SSH agent", () => {
  let configPath: string;
  let secretRef: string;
  let stellarAddress: string;
  let statePath: string;
  let rootDir: string;

  beforeAll(async () => {
    const socketPath = resolveSocketPath("1password");
    const identities = await listAgentIdentities(socketPath);
    if (identities.length === 0) {
      throw new Error("No Ed25519 keys found in 1Password SSH agent");
    }
    const identity = identities[0]!;
    const { StrKey } = await import("@stellar/stellar-sdk");
    stellarAddress = StrKey.encodeEd25519PublicKey(identity.publicKey);
    secretRef = buildSshAgentRef("1password", stellarAddress);

    rootDir = makeTempDir("walleterm-x402-ssh-1p-");
    configPath = join(rootDir, "walleterm.toml");
    statePath = join(rootDir, "x402-state.json");

    writeFileSync(configPath, makeBasicConfig(), "utf8");

    const usdcBalance = await ensureUsdcForSshAgentKey(stellarAddress, secretRef);
    console.log(
      `[live.x402-ssh-1p] payer=${stellarAddress} usdc_balance=${usdcBalance}`,
    );
  }, 300_000);

  afterAll(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it(
    "pays exact (direct) route with 1Password SSH agent",
    { timeout: 240_000 },
    async () => {
      const result = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        ["--x402-scheme", "exact"],
      );

      expect(result.protocol).toBe("x402");
      expect(result.scheme).toBe("exact");
      expect(result.paid).toBe(true);
      expect(result.status).toBe(200);
      expect(result.payer).toBe(stellarAddress);
      expect(result.response_headers["content-type"]).toBe("image/png");
      expect(Buffer.from(result.body, "base64").length).toBeGreaterThan(100);
    },
  );

  it(
    "opens and reuses channel (session) route with 1Password SSH agent",
    { timeout: 240_000 },
    async () => {
      const sharedArgs = [
        "--x402-scheme",
        "channel",
        "--x402-channel-deposit",
        "1000000",
        "--x402-channel-state-file",
        statePath,
      ];

      const first = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        sharedArgs,
      );
      const second = await runPayJson(
        configPath,
        secretRef,
        `${X402_NFT_BASE_URL}/mint/attractor?size=64&seed=${uniqueSeed()}`,
        sharedArgs,
      );

      expect(first.scheme).toBe("channel");
      expect(first.paid).toBe(true);
      expect(first.status).toBe(200);
      expect(first.channel?.action).toBe("open+pay");
      expect(first.channel?.opened).toBe(true);
      expect(first.payer).toBe(stellarAddress);

      expect(second.scheme).toBe("channel");
      expect(second.paid).toBe(true);
      expect(second.status).toBe(200);
      expect(second.channel?.action).toBe("pay");
      expect(second.channel?.opened).toBe(false);
      expect(second.channel?.channel_id).toBe(first.channel?.channel_id);

      const firstRemaining = BigInt(String(first.channel?.remaining_balance));
      const secondRemaining = BigInt(String(second.channel?.remaining_balance));
      expect(secondRemaining).toBeLessThan(firstRemaining);
    },
  );
});
