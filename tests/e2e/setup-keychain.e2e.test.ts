import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  makeFakeSecurityFixture,
  readSecurityCalls,
  readSecurityStore,
  securityStoreKey,
} from "../helpers/fake-security.js";
import { runCliInProcess } from "../helpers/run-cli.js";

type Fixture = ReturnType<typeof makeFakeSecurityFixture>;

async function runCli(fx: Fixture, args: string[]) {
  return runCliInProcess(args, fx.env);
}

function hasCall(calls: string[][], prefix: string[]): boolean {
  return calls.some((row) => prefix.every((token, index) => row[index] === token));
}

describe("walleterm setup keychain e2e", () => {
  it("stores delegated seed and channels api key in macOS keychain refs", async () => {
    const fx = makeFakeSecurityFixture();
    const res = await runCli(fx, [
      "setup",
      "keychain",
      "--service",
      "walleterm-testnet",
      "--network",
      "testnet",
      "--channels-api-key",
      "test-api-key",
      "--json",
    ]);

    const out = JSON.parse(res.stdout) as {
      service: string;
      deployer_seed_stored: boolean;
      delegated_public_key: string;
      refs: {
        deployer_seed_ref?: string;
        delegated_seed_ref: string;
        channels_api_key_ref: string;
      };
      config_snippet: string;
    };

    expect(out.service).toBe("walleterm-testnet");
    expect(out.deployer_seed_stored).toBe(false);
    expect(out.delegated_public_key.startsWith("G")).toBe(true);
    expect(out.refs.deployer_seed_ref).toBeUndefined();
    expect(out.refs.delegated_seed_ref).toBe("keychain://walleterm-testnet/delegated_seed");
    expect(out.refs.channels_api_key_ref).toBe("keychain://walleterm-testnet/channels_api_key");
    expect(out.config_snippet.includes("deployer_secret_ref")).toBe(false);

    const store = readSecurityStore(fx.storePath);
    expect(store[securityStoreKey("walleterm-testnet", "delegated_seed")]).toMatch(/^S/);
    expect(store[securityStoreKey("walleterm-testnet", "channels_api_key")]).toBe("test-api-key");
    expect(store[securityStoreKey("walleterm-testnet", "deployer_seed")]).toBeUndefined();

    const calls = readSecurityCalls(fx.logPath);
    expect(hasCall(calls, ["help"])).toBe(true);
    expect(
      hasCall(calls, ["find-generic-password", "-a", "delegated_seed", "-s", "walleterm-testnet"]),
    ).toBe(true);
    expect(
      hasCall(calls, [
        "find-generic-password",
        "-a",
        "channels_api_key",
        "-s",
        "walleterm-testnet",
      ]),
    ).toBe(true);
    const addCalls = calls.filter((row) => row[0] === "add-generic-password");
    expect(addCalls).toHaveLength(2);
  }, 15000);

  it("overwrites existing entries with --force and stores deployer seed when requested", async () => {
    const deployer = Keypair.random();
    const delegated = Keypair.random();
    const fx = makeFakeSecurityFixture({
      [securityStoreKey("walleterm-testnet", "deployer_seed")]: Keypair.random().secret(),
      [securityStoreKey("walleterm-testnet", "delegated_seed")]: Keypair.random().secret(),
      [securityStoreKey("walleterm-testnet", "channels_api_key")]: "old-api-key",
    });

    const res = await runCli(fx, [
      "setup",
      "keychain",
      "--service",
      "walleterm-testnet",
      "--network",
      "testnet",
      "--force",
      "--include-deployer-seed",
      "--deployer-seed",
      deployer.secret(),
      "--delegated-seed",
      delegated.secret(),
      "--channels-api-key",
      "test-api-key",
      "--json",
    ]);

    const out = JSON.parse(res.stdout) as {
      deployer_seed_stored: boolean;
      deployer_public_key: string;
      delegated_public_key: string;
      refs: { deployer_seed_ref?: string };
    };

    expect(out.deployer_seed_stored).toBe(true);
    expect(out.deployer_public_key).toBe(deployer.publicKey());
    expect(out.delegated_public_key).toBe(delegated.publicKey());
    expect(out.refs.deployer_seed_ref).toBe("keychain://walleterm-testnet/deployer_seed");

    const store = readSecurityStore(fx.storePath);
    expect(store[securityStoreKey("walleterm-testnet", "deployer_seed")]).toBe(deployer.secret());
    expect(store[securityStoreKey("walleterm-testnet", "delegated_seed")]).toBe(delegated.secret());
    expect(store[securityStoreKey("walleterm-testnet", "channels_api_key")]).toBe("test-api-key");

    const calls = readSecurityCalls(fx.logPath);
    const addCalls = calls.filter((row) => row[0] === "add-generic-password");
    expect(addCalls).toHaveLength(3);
    expect(addCalls.every((row) => row.includes("-U"))).toBe(true);
  }, 15000);

  it("defaults service name from the selected network", async () => {
    const fx = makeFakeSecurityFixture();
    const res = await runCli(fx, [
      "setup",
      "keychain",
      "--network",
      "mainnet",
      "--channels-api-key",
      "test-api-key",
      "--json",
    ]);

    const out = JSON.parse(res.stdout) as { service: string };
    expect(out.service).toBe("walleterm-mainnet");
  });

  it("fails when keychain entries already exist and --force is not set", async () => {
    const fx = makeFakeSecurityFixture({
      [securityStoreKey("walleterm-testnet", "delegated_seed")]: Keypair.random().secret(),
    });

    await expect(
      runCli(fx, [
        "setup",
        "keychain",
        "--service",
        "walleterm-testnet",
        "--network",
        "testnet",
        "--channels-api-key",
        "test-api-key",
        "--json",
      ]),
    ).rejects.toThrow(/already contains delegated_seed/i);
  });
});
