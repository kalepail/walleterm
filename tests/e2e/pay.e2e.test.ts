import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSecurityFixture } from "../helpers/fake-security.js";
import { runCliInProcess } from "../helpers/run-cli.js";
import { makeTempDir } from "../helpers/temp-dir.js";

vi.mock("../../src/x402.js", async () => {
  return {
    passphraseToX402Network: vi.fn(() => "stellar:testnet"),
    createWalletermSigner: vi.fn(() => ({ address: "GMOCK" })),
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

vi.mock("../../src/x402-channel.js", async () => {
  return {
    executeX402ChannelRequest: vi.fn(async () => ({
      kind: "channel",
      scheme: "channel",
      paid: true,
      status: 200,
      body: new TextEncoder().encode("paid via channel"),
      responseHeaders: {},
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [
          {
            scheme: "channel",
            network: "stellar:testnet",
            asset: "CTOKEN",
            amount: "10",
            payTo: "GRECIPIENT",
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
      },
      paymentPayload: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepted: {
          scheme: "channel",
          network: "stellar:testnet",
          asset: "CTOKEN",
          amount: "10",
          payTo: "GRECIPIENT",
          maxTimeoutSeconds: 60,
          extra: {},
        },
        payload: { action: "pay", channelId: "CCHANNEL" },
      },
      settlement: {
        success: true,
        channelId: "CCHANNEL",
        currentCumulative: "10",
        remainingBalance: "90",
      },
      channel: {
        action: "open+pay",
        mode: "demo",
        channel_id: "CCHANNEL",
        deposit: "100",
        current_cumulative: "10",
        remaining_balance: "90",
        state_path: "/tmp/x402-channels.json",
        opened: true,
      },
    })),
  };
});

vi.mock("../../src/mpp.js", async () => {
  return {
    passphraseToMppNetwork: vi.fn(() => "testnet"),
    createMppClientMethod: vi.fn(() => ({ name: "stellar", intent: "charge" })),
    executeMppRequest: vi.fn(async () => ({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("paid via mpp"),
      responseHeaders: {},
      challenge: {
        id: "challenge-1",
        realm: "api.example.com",
        method: "stellar",
        intent: "charge",
        request: { amount: "100", currency: "CUSDCTOKEN", recipient: "GRECIPIENT" },
      },
      paymentAttempt: {
        challenge: {
          id: "challenge-1",
          realm: "api.example.com",
          method: "stellar",
          intent: "charge",
          request: { amount: "100", currency: "CUSDCTOKEN", recipient: "GRECIPIENT" },
        },
        payload: { type: "transaction", xdr: "AAAA" },
      },
      settlement: {
        method: "stellar",
        reference: "txhash",
        status: "success",
        timestamp: "2026-03-20T00:00:00.000Z",
      },
    })),
  };
});

const { executeX402Request } = await import("../../src/x402.js");
const { executeX402ChannelRequest } = await import("../../src/x402-channel.js");
const { executeMppRequest } = await import("../../src/mpp.js");
const executeX402RequestMock = executeX402Request as ReturnType<typeof vi.fn>;
const executeX402ChannelRequestMock = executeX402ChannelRequest as ReturnType<typeof vi.fn>;
const executeMppRequestMock = executeMppRequest as ReturnType<typeof vi.fn>;
const PAYMENT_PAYLOAD = { x402Version: 2, accepted: {}, payload: {} };

type Fixture = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  keypair: Keypair;
};

function makeFixture(extraToml = "", secretOverride?: { ref: string; value: string }): Fixture {
  const keypair = Keypair.random();
  const rootDir = makeTempDir("walleterm-pay-e2e-");

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
    executeX402RequestMock.mockClear();
    executeX402ChannelRequestMock.mockClear();
    executeMppRequestMock.mockClear();
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

  it("executes pay command with --format body", async () => {
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
    // Default mock has no content-type header, so stderr should be empty
    expect(result.stderr).toBe("");
    expect(executeX402RequestMock).toHaveBeenCalledTimes(1);
  });

  it("--format body writes content-type to stderr when present", async () => {
    const { configPath, env } = makeFixture();

    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("image data"),
      responseHeaders: { "content-type": "image/png" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
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
      ],
      env,
    );
    expect(result.stdout).toBe("image data");
    expect(result.stderr).toBe("content-type: image/png\n");
  });

  it("executes pay command with --format json", async () => {
    const { configPath, env, keypair } = makeFixture();
    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--format",
        "json",
      ],
      env,
    );
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.protocol).toBe("x402");
    expect(parsed.paid).toBe(true);
    expect(parsed.status).toBe(200);
    expect(parsed.payer).toBe(keypair.publicKey());
    expect(parsed.body).toBe(Buffer.from("paid content").toString("base64"));
    expect(parsed.response_headers).toEqual({});
    expect(parsed.payment_required).toEqual({
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [],
    });
    expect(parsed.payment_payload).toEqual({ x402Version: 2, accepted: {}, payload: {} });
    expect(parsed.challenge).toEqual({
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [],
    });
    expect(parsed.payment_attempt).toEqual({ x402Version: 2, accepted: {}, payload: {} });
    expect(parsed.settlement).toEqual({
      success: true,
      transaction: "txhash",
      network: "stellar:testnet",
    });
    expect(parsed.settlement_error).toBeNull();
  });

  it("passes dry-run option to executeX402Request", async () => {
    const { configPath, env } = makeFixture();
    executeX402RequestMock.mockResolvedValueOnce({
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
        "--format",
        "json",
      ],
      env,
    );
    const callOpts = executeX402RequestMock.mock.calls[0]?.[1];
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
    const callOpts = executeX402RequestMock.mock.calls[0]?.[1];
    expect(callOpts?.method).toBe("POST");
    expect(callOpts?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Custom": "value",
    });
    expect(callOpts?.body).toBe('{"key":"val"}');
  });

  it("uses default_payer_secret_ref from config", async () => {
    const keypair = Keypair.random();
    const rootDir = makeTempDir("walleterm-pay-e2e-");
    const fake = makeFakeSecurityFixture();
    const storeKey = "walleterm-test::default_payer";
    writeFileSync(fake.storePath, JSON.stringify({ [storeKey]: keypair.secret() }), "utf8");

    const config = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[payments]
default_protocol = "x402"

[payments.x402]
default_payer_secret_ref = "keychain://walleterm-test/default_payer"

[smart_accounts]
`;
    const configPath = join(rootDir, "walleterm.toml");
    writeFileSync(configPath, config, "utf8");

    const result = await runCliInProcess(
      ["pay", "https://example.com/resource", "--config", configPath, "--format", "json"],
      fake.env,
    );
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.payer).toBe(keypair.publicKey());
  });

  it("does not fall back to MPP payer config for x402", async () => {
    const keypair = Keypair.random();
    const rootDir = makeTempDir("walleterm-pay-e2e-");
    const fake = makeFakeSecurityFixture();
    writeFileSync(
      fake.storePath,
      JSON.stringify({ "walleterm-test::default_payer": keypair.secret() }),
      "utf8",
    );

    const config = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[payments]
default_protocol = "x402"

[payments.mpp]
default_payer_secret_ref = "keychain://walleterm-test/default_payer"

[smart_accounts]
`;
    const configPath = join(rootDir, "walleterm.toml");
    writeFileSync(configPath, config, "utf8");

    await expect(
      runCliInProcess(["pay", "https://example.com/resource", "--config", configPath], fake.env),
    ).rejects.toThrow(/No payer specified/);
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
    const callOpts = executeX402RequestMock.mock.calls[0]?.[1];
    expect(callOpts?.headers).toBeUndefined();
  });

  it("writes body to file and prints JSON summary with --out", async () => {
    const { configPath, env, keypair } = makeFixture();
    const outDir = makeTempDir("walleterm-pay-out-");
    const outPath = join(outDir, "response.bin");

    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("paid content"),
      responseHeaders: { "content-type": "image/png" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
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
    expect(parsed.settlement_error).toBeNull();
  });

  it("--out writes binary data without corruption", async () => {
    const { configPath, env } = makeFixture();
    const outDir = makeTempDir("walleterm-pay-out-");
    const outPath = join(outDir, "binary.dat");

    // Create binary content with bytes that would corrupt in text mode
    const binaryBody = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: binaryBody,
      responseHeaders: { "content-type": "image/png" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
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
    expect(parsed.settlement_error).toBeNull();
  });

  it("--out with no content-type header outputs null content_type", async () => {
    const { configPath, env, keypair } = makeFixture();
    const outDir = makeTempDir("walleterm-pay-out-");
    const outPath = join(outDir, "output.bin");

    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("data"),
      responseHeaders: {},
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
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

    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.content_type).toBeNull();
    expect(parsed.payer).toBe(keypair.publicKey());
    expect(parsed.settlement_error).toBeNull();
    expect(readFileSync(outPath, "utf8")).toBe("data");
  });

  it("--out with no settlement outputs null settlement", async () => {
    const { configPath, env } = makeFixture();
    const outDir = makeTempDir("walleterm-pay-out-");
    const outPath = join(outDir, "output.bin");

    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("data"),
      responseHeaders: { "content-type": "text/plain" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
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

    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.settlement).toBeNull();
    expect(parsed.content_type).toBe("text/plain");
    expect(parsed.settlement_error).toBeNull();
  });

  it("--out takes priority over --format json", async () => {
    const { configPath, env, keypair } = makeFixture();
    const outDir = makeTempDir("walleterm-pay-out-");
    const outPath = join(outDir, "output.bin");

    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("file content"),
      responseHeaders: { "content-type": "application/octet-stream" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
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
        "--format",
        "json",
      ],
      env,
    );

    // --out summary format should be used, not --format json's full payload
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.file).toBe(outPath);
    expect(parsed.payer).toBe(keypair.publicKey());
    expect(parsed.settlement_error).toBeNull();
    expect(parsed).not.toHaveProperty("response_headers");
    expect(parsed).not.toHaveProperty("payment_required");
    expect(readFileSync(outPath, "utf8")).toBe("file content");
  });

  it("--out with empty body writes zero-byte file", async () => {
    const { configPath, env } = makeFixture();
    const outDir = makeTempDir("walleterm-pay-out-");
    const outPath = join(outDir, "empty.bin");

    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new Uint8Array(0),
      responseHeaders: { "content-type": "application/octet-stream" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
      settlement: null,
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

    const fileBytes = readFileSync(outPath);
    expect(fileBytes.length).toBe(0);

    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.size).toBe(0);
    expect(parsed.file).toBe(outPath);
    expect(parsed.settlement_error).toBeNull();
  });

  it("exposes settlement_error in JSON output when settlement parsing fails", async () => {
    const { configPath, env } = makeFixture();
    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("paid content"),
      responseHeaders: {},
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
      settlementError: "No PAYMENT-RESPONSE header",
    });

    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--format",
        "json",
      ],
      env,
    );

    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.settlement).toBeUndefined();
    expect(parsed.settlement_error).toBe("No PAYMENT-RESPONSE header");
  });

  it("exposes settlement_error in --out summary when settlement parsing fails", async () => {
    const { configPath, env } = makeFixture();
    const outDir = makeTempDir("walleterm-pay-out-");
    const outPath = join(outDir, "response.bin");

    executeX402RequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("paid content"),
      responseHeaders: { "content-type": "text/plain" },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [],
      },
      paymentPayload: PAYMENT_PAYLOAD,
      settlementError: "No PAYMENT-RESPONSE header",
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

    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.settlement).toBeNull();
    expect(parsed.settlement_error).toBe("No PAYMENT-RESPONSE header");
  });

  it("supports MPP when explicitly selected", async () => {
    const { configPath, env, keypair } = makeFixture();
    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--protocol",
        "mpp",
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--format",
        "json",
      ],
      env,
    );

    expect(executeMppRequestMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.protocol).toBe("mpp");
    expect(parsed.payer).toBe(keypair.publicKey());
    expect(parsed.challenge).toEqual({
      id: "challenge-1",
      realm: "api.example.com",
      method: "stellar",
      intent: "charge",
      request: { amount: "100", currency: "CUSDCTOKEN", recipient: "GRECIPIENT" },
    });
    expect(parsed.payment_attempt).toEqual({
      challenge: {
        id: "challenge-1",
        realm: "api.example.com",
        method: "stellar",
        intent: "charge",
        request: { amount: "100", currency: "CUSDCTOKEN", recipient: "GRECIPIENT" },
      },
      payload: { type: "transaction", xdr: "AAAA" },
    });
    expect(parsed.payment_required).toBeUndefined();
    expect(parsed.payment_payload).toBeUndefined();
  });

  it("uses payments.mpp defaults for protocol and payer", async () => {
    const keypair = Keypair.random();
    const rootDir = makeTempDir("walleterm-pay-e2e-");
    const fake = makeFakeSecurityFixture();
    const storeKey = "walleterm-test::default_payer";
    writeFileSync(fake.storePath, JSON.stringify({ [storeKey]: keypair.secret() }), "utf8");

    const config = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[payments]
default_protocol = "mpp"

[payments.mpp]
default_payer_secret_ref = "keychain://walleterm-test/default_payer"

[smart_accounts]
`;
    const configPath = join(rootDir, "walleterm.toml");
    writeFileSync(configPath, config, "utf8");

    const result = await runCliInProcess(
      ["pay", "https://example.com/resource", "--config", configPath, "--format", "json"],
      fake.env,
    );

    expect(executeMppRequestMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.protocol).toBe("mpp");
    expect(parsed.payer).toBe(keypair.publicKey());
  });

  it("rejects removed legacy x402 config when loading MPP config", async () => {
    const keypair = Keypair.random();
    const rootDir = makeTempDir("walleterm-pay-e2e-");
    const fake = makeFakeSecurityFixture();
    writeFileSync(
      fake.storePath,
      JSON.stringify({ "walleterm-test::default_payer": keypair.secret() }),
      "utf8",
    );

    const config = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[payments]
default_protocol = "mpp"

[x402]
default_payer_secret_ref = "keychain://walleterm-test/default_payer"

[smart_accounts]
`;
    const configPath = join(rootDir, "walleterm.toml");
    writeFileSync(configPath, config, "utf8");

    await expect(
      runCliInProcess(["pay", "https://example.com/resource", "--config", configPath], fake.env),
    ).rejects.toThrow(/Top-level \[x402\] is no longer supported/);
  });

  it("remembers the latest MPP channel voucher locally after a paid request", async () => {
    const keypair = Keypair.random();
    const rootDir = makeTempDir("walleterm-pay-e2e-");
    const fake = makeFakeSecurityFixture();
    const storeKey = "walleterm-test::default_payer";
    writeFileSync(fake.storePath, JSON.stringify({ [storeKey]: keypair.secret() }), "utf8");

    executeMppRequestMock.mockResolvedValueOnce({
      paid: true,
      status: 200,
      body: new TextEncoder().encode("paid via mpp"),
      responseHeaders: {},
      challenge: {
        id: "challenge-1",
        realm: "api.example.com",
        method: "stellar",
        intent: "channel",
        request: { amount: "100", channel: "CCHANNEL123" },
      },
      paymentAttempt: {
        challenge: {
          id: "challenge-1",
          realm: "api.example.com",
          method: "stellar",
          intent: "channel",
          request: { amount: "100", channel: "CCHANNEL123" },
        },
        payload: { action: "voucher", amount: "200", signature: "a".repeat(128) },
      },
      settlement: {
        method: "stellar",
        reference: "txhash",
        status: "success",
        timestamp: "2026-03-20T00:00:00.000Z",
      },
    });

    const config = `[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://example.test/rpc"
network_passphrase = "Test SDF Network ; September 2015"

[payments]
default_protocol = "mpp"

[payments.mpp]
default_intent = "channel"
default_payer_secret_ref = "keychain://walleterm-test/default_payer"

[payments.mpp.channel]
state_file = ".state.json"

[smart_accounts]
`;
    const configPath = join(rootDir, "walleterm.toml");
    writeFileSync(configPath, config, "utf8");

    await runCliInProcess(
      ["pay", "https://example.com/resource", "--config", configPath, "--format", "json"],
      fake.env,
    );

    const state = JSON.parse(readFileSync(join(rootDir, ".state.json"), "utf8")) as {
      active_channel_by_network: Record<string, string>;
      channels: Record<string, Record<string, unknown>>;
    };
    expect(state.active_channel_by_network.testnet).toBe("CCHANNEL123");
    expect(state.channels.CCHANNEL123?.last_voucher_amount).toBe("200");
  });

  it("uses experimental x402 channel flow when --x402-scheme channel is selected", async () => {
    const { configPath, env, keypair } = makeFixture();
    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--x402-scheme",
        "channel",
        "--x402-channel-deposit",
        "100",
        "--x402-channel-state-file",
        ".x402-state.json",
        "--x402-channel-commitment-secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--format",
        "json",
      ],
      env,
    );

    expect(executeX402ChannelRequestMock).toHaveBeenCalledTimes(1);
    expect(executeX402RequestMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.protocol).toBe("x402");
    expect(parsed.scheme).toBe("channel");
    expect(parsed.payer).toBe(keypair.publicKey());
    expect(parsed.channel).toEqual(
      expect.objectContaining({
        channel_id: "CCHANNEL",
        current_cumulative: "10",
        remaining_balance: "90",
      }),
    );
    expect(result.stderr).toBe("");
  });

  it("auto-falls back to exact x402 when channel executor requests exact", async () => {
    const { configPath, env } = makeFixture();
    executeX402ChannelRequestMock.mockResolvedValueOnce({ kind: "fallback-exact" });

    await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--x402-scheme",
        "auto",
      ],
      env,
    );

    expect(executeX402ChannelRequestMock).toHaveBeenCalledTimes(1);
    expect(executeX402RequestMock).toHaveBeenCalledTimes(1);
  });

  it("includes scheme and channel summary in --out output for x402 channel payments", async () => {
    const { configPath, env } = makeFixture();
    const outDir = makeTempDir("walleterm-pay-channel-out-");
    const outPath = join(outDir, "response.bin");

    const result = await runCliInProcess(
      [
        "pay",
        "https://example.com/resource",
        "--config",
        configPath,
        "--secret-ref",
        "keychain://walleterm-test/payer_seed",
        "--x402-scheme",
        "channel",
        "--out",
        outPath,
      ],
      env,
    );

    expect(readFileSync(outPath, "utf8")).toBe("paid via channel");
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.scheme).toBe("channel");
    expect(parsed.channel).toEqual(
      expect.objectContaining({
        channel_id: "CCHANNEL",
        state_path: "/tmp/x402-channels.json",
      }),
    );
    expect(result.stderr).toBe("");
  });
});
