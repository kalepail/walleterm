import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSecurityFixture } from "../helpers/fake-security.js";
import { runCliInProcess } from "../helpers/run-cli.js";

vi.mock("../../src/x402.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createX402HttpHandler: vi.fn(() => ({})),
    executeX402Request: vi.fn(async () => ({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("paid content"),
      responseHeaders: {},
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: { x402Version: 2, accepted: {}, payload: {} },
      settlement: {
        success: true,
        transaction: "txhash",
        network: "stellar:testnet",
      },
    })),
  };
});

const { executeX402Request } = await import("../../src/x402.js");

type Fixture = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  keypair: Keypair;
};

function makeFixture(extraToml = "", secretOverride?: { ref: string; value: string }): Fixture {
  const keypair = Keypair.random();
  const rootDir = mkdtempSync(join(tmpdir(), "walleterm-pay-e2e-"));

  const fake = makeFakeSecurityFixture();
  const value = secretOverride?.value ?? keypair.secret();
  const storeKey = "walleterm-test::payer_seed";
  writeFileSync(fake.storePath, JSON.stringify({ [storeKey]: value }), "utf8");

  const config = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts]
${extraToml}`;

  const configPath = join(rootDir, "walleterm.toml");
  writeFileSync(configPath, config, "utf8");

  return {
    configPath,
    env: { ...fake.env },
    keypair,
  };
}

describe("walleterm pay e2e", () => {
  beforeEach(() => {
    vi.mocked(executeX402Request).mockClear();
  });

  it("errors when no payer is specified", async () => {
    const { configPath } = makeFixture();
    await expect(
      runCliInProcess(["pay", "https://example.com/resource", "--config", configPath]),
    ).rejects.toThrow(/No payer specified/);
  });

  it("errors with invalid header format", async () => {
    const { configPath, env } = makeFixture();
    await expect(
      runCliInProcess(
        [
          "pay",
          "https://example.com/resource",
          "--config",
          configPath,
          "--secret-ref",
          "keychain://walleterm-test/payer_seed",
          "--header",
          "bad-header-no-colon",
        ],
        env,
      ),
    ).rejects.toThrow(/Invalid header format/);
  });

  it("errors when secret resolves to invalid seed", async () => {
    const { configPath, env } = makeFixture("", {
      ref: "keychain://walleterm-test/payer_seed",
      value: "not-a-valid-seed",
    });
    await expect(
      runCliInProcess(
        [
          "pay",
          "https://example.com/resource",
          "--config",
          configPath,
          "--secret-ref",
          "keychain://walleterm-test/payer_seed",
        ],
        env,
      ),
    ).rejects.toThrow(/secret-ref must resolve to a valid Stellar secret seed/);
  });

  it("executes pay command with --output body", async () => {
    const { configPath, env } = makeFixture();
    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
      ],
      env,
    );
    expect(result.stdout).toBe("paid content");
    expect(vi.mocked(executeX402Request)).toHaveBeenCalledTimes(1);
  });

  it("executes pay command with --output json", async () => {
    const { configPath, env, keypair } = makeFixture();
    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--output",
        "json",
      ],
      env,
    );
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.paid).toBe(true);
    expect(parsed.status).toBe(200);
    expect(parsed.payer).toBe(keypair.publicKey());
    expect(parsed.body).toBe(Buffer.from("paid content").toString("base64"));
  });

  it("passes dry-run option to executeX402Request", async () => {
    const { configPath, env } = makeFixture();
    vi.mocked(executeX402Request).mockResolvedValueOnce({
      paid: false,
      status: 402,
      body: new TextEncoder().encode("402 body"),
      responseHeaders: {},
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
    });
    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--dry-run",
        "--output",
        "json",
      ],
      env,
    );
    const callOpts = vi.mocked(executeX402Request).mock.calls[0]?.[1];
    expect(callOpts?.dryRun).toBe(true);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.paid).toBe(false);
  });

  it("passes method, headers, and body options", async () => {
    const { configPath, env } = makeFixture();
    await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--method",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--header",
        "X-Custom: value",
        "--data",
        '{"key":"val"}',
      ],
      env,
    );
    const callOpts = vi.mocked(executeX402Request).mock.calls[0]?.[1];
    expect(callOpts?.method).toBe("POST");
    expect(callOpts?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Custom": "value",
    });
    expect(callOpts?.body).toBe('{"key":"val"}');
  });

  it("uses default_payer_secret_ref from config", async () => {
    const keypair = Keypair.random();
    const rootDir = mkdtempSync(join(tmpdir(), "walleterm-pay-e2e-"));
    const fake = makeFakeSecurityFixture();
    const storeKey = "walleterm-test::default_payer";
    writeFileSync(fake.storePath, JSON.stringify({ [storeKey]: keypair.secret() }), "utf8");

    const config = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[x402]
default_payer_secret_ref = "keychain://walleterm-test/default_payer"

[smart_accounts]
`;
    const configPath = join(rootDir, "walleterm.toml");
    writeFileSync(configPath, config, "utf8");

    const result = await runCliInProcess(
      ["pay", "https://example.com/resource", "--config", configPath, "--output", "json"],
      fake.env,
    );
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.payer).toBe(keypair.publicKey());
  });

  it("omits headers when none specified", async () => {
    const { configPath, env } = makeFixture();
    await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
      ],
      env,
    );
    const callOpts = vi.mocked(executeX402Request).mock.calls[0]?.[1];
    expect(callOpts?.headers).toBeUndefined();
  });

  it("writes body to file and prints JSON summary with --out", async () => {
    const { configPath, env, keypair } = makeFixture();
    const outDir = mkdtempSync(join(tmpdir(), "walleterm-pay-out-"));
    const outPath = join(outDir, "response.bin");

    vi.mocked(executeX402Request).mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("paid content"),
      responseHeaders: { "content-type": "image/png" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: { x402Version: 2, accepted: {}, payload: {} } as never,
      settlement: {
        success: true,
        transaction: "txhash",
        network: "stellar:testnet",
      },
    });

    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--out",
        outPath,
      ],
      env,
    );

    // File should contain the raw body bytes
    const fileContents = readFileSync(outPath, "utf8");
    expect(fileContents).toBe("paid content");

    // Stdout should be a JSON summary
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.paid).toBe(true);
    expect(parsed.status).toBe(200);
    expect(parsed.payer).toBe(keypair.publicKey());
    expect(parsed.content_type).toBe("image/png");
    expect(parsed.size).toBe(12); // "paid content" is 12 bytes
    expect(parsed.file).toBe(outPath);
    expect(parsed.settlement).toEqual({
      success: true,
      transaction: "txhash",
      network: "stellar:testnet",
    });
  });

  it("--out writes binary data without corruption", async () => {
    const { configPath, env } = makeFixture();
    const outDir = mkdtempSync(join(tmpdir(), "walleterm-pay-out-"));
    const outPath = join(outDir, "binary.dat");

    // Create binary content with bytes that would corrupt in text mode
    const binaryBody = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

    vi.mocked(executeX402Request).mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: binaryBody,
      responseHeaders: { "content-type": "image/png" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: { x402Version: 2, accepted: {}, payload: {} } as never,
      settlement: {
        success: true,
        transaction: "txhash",
        network: "stellar:testnet",
      },
    });

    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--out",
        outPath,
      ],
      env,
    );

    // File should contain exact binary bytes
    const fileBytes = new Uint8Array(readFileSync(outPath));
    expect(fileBytes).toEqual(binaryBody);

    // Summary should report correct size
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.size).toBe(10);
    expect(parsed.content_type).toBe("image/png");
  });
});
