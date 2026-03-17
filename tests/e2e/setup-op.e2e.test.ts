import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { smartAccountKitDeployerKeypair } from "../../src/wallet.js";
import { runCliInProcess } from "../helpers/run-cli.js";
import { makeTempDir } from "../helpers/temp-dir.js";

type Fixture = {
  env: NodeJS.ProcessEnv;
  logPath: string;
  opBin: string;
};

function makeFixture(mode: "create" | "edit", signedIn = true): Fixture {
  const rootDir = makeTempDir("walleterm-setup-op-e2e-");
  const binDir = join(rootDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = join(rootDir, "op.log");
  const opBin = join(binDir, "op");

  writeFileSync(
    opBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.OP_MODE || "create";
const signedIn = process.env.OP_SIGNED_IN !== "0";
const logPath = process.env.OP_LOG_PATH;

if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
}

const out = (value) => process.stdout.write(String(value));
const fail = (msg) => {
  process.stderr.write(String(msg));
  process.exit(1);
};

if (args[0] === "--version") {
  out("2.32.1");
  process.exit(0);
}

if (args[0] === "whoami") {
  if (!signedIn) fail("account is not signed in");
  out("tester@example.com");
  process.exit(0);
}

if (args[0] === "vault" && args[1] === "get") {
  if (mode === "edit") {
    out("{}");
    process.exit(0);
  }
  fail("vault not found");
}

if (args[0] === "vault" && args[1] === "create") {
  out("{}");
  process.exit(0);
}

if (args[0] === "item" && args[1] === "get") {
  if (mode === "edit") {
    out("{}");
    process.exit(0);
  }
  fail("item not found");
}

if (args[0] === "item" && args[1] === "create") {
  out('{"id":"item1"}');
  process.exit(0);
}

if (args[0] === "item" && args[1] === "edit") {
  out('{"id":"item1"}');
  process.exit(0);
}

fail("unexpected op invocation: " + args.join(" "));
`,
    "utf8",
  );
  chmodSync(opBin, 0o755);

  return {
    env: {
      ...process.env,
      WALLETERM_OP_BIN: opBin,
      OP_MODE: mode,
      OP_SIGNED_IN: signedIn ? "1" : "0",
      OP_LOG_PATH: logPath,
    },
    logPath,
    opBin,
  };
}

async function runCli(fx: Fixture, args: string[]) {
  return runCliInProcess(args, fx.env);
}

function readOpCalls(logPath: string): string[][] {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function hasCall(calls: string[][], prefix: string[]): boolean {
  return calls.some((row) => prefix.every((token, i) => row[i] === token));
}

describe("walleterm setup op e2e", () => {
  it("creates missing vault/item and stores required fields", async () => {
    const fx = makeFixture("create");
    const res = await runCli(fx, [
      "setup",
      "op",
      "--vault",
      "Private",
      "--item",
      "walleterm-testnet",
      "--network",
      "testnet",
      "--channels-api-key",
      "test-api-key",
      "--json",
    ]);

    const out = JSON.parse(res.stdout) as {
      created_vault: boolean;
      created_item: boolean;
      deployer_seed_stored: boolean;
      deployer_public_key: string;
      delegated_public_key: string;
      config_snippet: string;
      refs: {
        deployer_seed_ref?: string;
        delegated_seed_ref: string;
        channels_api_key_ref: string;
      };
    };

    expect(out.created_vault).toBe(true);
    expect(out.created_item).toBe(true);
    expect(out.deployer_seed_stored).toBe(false);
    expect(out.deployer_public_key).toBe(smartAccountKitDeployerKeypair().publicKey());
    expect(out.delegated_public_key.startsWith("G")).toBe(true);
    expect(out.refs.deployer_seed_ref).toBeUndefined();
    expect(out.config_snippet.includes("deployer_secret_ref")).toBe(false);
    expect(out.refs.delegated_seed_ref).toBe("op://Private/walleterm-testnet/delegated_seed");
    expect(out.refs.channels_api_key_ref).toBe("op://Private/walleterm-testnet/channels_api_key");
    expect(res.stderr.includes("warning: item")).toBe(false);

    const calls = readOpCalls(fx.logPath);
    expect(hasCall(calls, ["vault", "create", "Private"])).toBe(true);
    expect(
      hasCall(calls, [
        "item",
        "create",
        "--vault",
        "Private",
        "--category",
        "password",
        "--title",
        "walleterm-testnet",
      ]),
    ).toBe(true);
    const createCall = calls.find((row) => row[0] === "item" && row[1] === "create");
    expect(createCall?.some((token) => token.startsWith("deployer_seed[password]="))).toBe(false);
    expect(createCall?.some((token) => token.startsWith("delegated_seed[password]="))).toBe(true);
    expect(createCall?.includes("channels_api_key[password]=test-api-key")).toBe(true);
  }, 15000);

  it("edits existing item and keeps provided seed public keys", async () => {
    const fx = makeFixture("edit");
    const deployer = Keypair.random();
    const delegated = Keypair.random();

    const res = await runCli(fx, [
      "setup",
      "op",
      "--vault",
      "Private",
      "--item",
      "walleterm-testnet",
      "--network",
      "testnet",
      "--force",
      "--deployer-seed",
      deployer.secret(),
      "--delegated-seed",
      delegated.secret(),
      "--channels-api-key",
      "test-api-key",
      "--json",
    ]);

    const out = JSON.parse(res.stdout) as {
      created_vault: boolean;
      created_item: boolean;
      deployer_seed_stored: boolean;
      deployer_public_key: string;
      delegated_public_key: string;
      config_snippet: string;
      refs: { deployer_seed_ref?: string };
    };

    expect(out.created_vault).toBe(false);
    expect(out.created_item).toBe(false);
    expect(out.deployer_seed_stored).toBe(true);
    expect(out.deployer_public_key).toBe(deployer.publicKey());
    expect(out.delegated_public_key).toBe(delegated.publicKey());
    expect(out.refs.deployer_seed_ref).toBe("op://Private/walleterm-testnet/deployer_seed");
    expect(
      out.config_snippet.includes(
        'deployer_secret_ref = "op://Private/walleterm-testnet/deployer_seed"',
      ),
    ).toBe(true);
    expect(
      res.stderr.includes(
        "warning: item 'walleterm-testnet' already exists in vault 'Private'. Overwriting fields:",
      ),
    ).toBe(true);

    const calls = readOpCalls(fx.logPath);
    expect(hasCall(calls, ["item", "edit", "walleterm-testnet", "--vault", "Private"])).toBe(true);
    expect(hasCall(calls, ["item", "create"])).toBe(false);
  }, 15000);

  it("defaults item name to walleterm-testnet for testnet", async () => {
    const fx = makeFixture("edit");
    const res = await runCli(fx, [
      "setup",
      "op",
      "--vault",
      "Private",
      "--network",
      "testnet",
      "--force",
      "--channels-api-key",
      "test-api-key",
      "--json",
    ]);

    const out = JSON.parse(res.stdout) as { item: string };
    expect(out.item).toBe("walleterm-testnet");

    const calls = readOpCalls(fx.logPath);
    expect(hasCall(calls, ["item", "edit", "walleterm-testnet", "--vault", "Private"])).toBe(true);
  });

  it("defaults item name to walleterm-mainnet for mainnet", async () => {
    const fx = makeFixture("edit");
    const res = await runCli(fx, [
      "setup",
      "op",
      "--vault",
      "Private",
      "--network",
      "mainnet",
      "--force",
      "--channels-api-key",
      "test-api-key",
      "--json",
    ]);

    const out = JSON.parse(res.stdout) as { item: string };
    expect(out.item).toBe("walleterm-mainnet");

    const calls = readOpCalls(fx.logPath);
    expect(hasCall(calls, ["item", "edit", "walleterm-mainnet", "--vault", "Private"])).toBe(true);
  });

  it("fails when vault is missing and --no-create-vault is used", async () => {
    const fx = makeFixture("create");

    await expect(
      runCli(fx, [
        "setup",
        "op",
        "--vault",
        "Private",
        "--item",
        "walleterm-testnet",
        "--network",
        "testnet",
        "--channels-api-key",
        "test-api-key",
        "--no-create-vault",
        "--json",
      ]),
    ).rejects.toThrow(/does not exist/i);
  });

  it("fails when item exists and --force is not set", async () => {
    const fx = makeFixture("edit");

    await expect(
      runCli(fx, [
        "setup",
        "op",
        "--vault",
        "Private",
        "--item",
        "walleterm-testnet",
        "--network",
        "testnet",
        "--channels-api-key",
        "test-api-key",
        "--json",
      ]),
    ).rejects.toThrow(/already exists/i);
  });
});
