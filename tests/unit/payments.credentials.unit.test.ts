import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, hash } from "@stellar/stellar-sdk";
import type { NetworkConfig, WalletermConfig } from "../../src/config.js";
import { SecretResolver } from "../../src/secrets.js";
import { makeFakeSshAgentFixture, type FakeSshAgentFixture } from "../helpers/fake-ssh-agent.js";

vi.mock("../../src/payments/x402.js", () => ({
  executeX402Payment: vi.fn(),
}));

vi.mock("../../src/mpp-channel.js", () => ({
  rememberMppVoucher: vi.fn(),
}));

vi.mock("../../src/mpp.js", () => ({
  passphraseToMppNetwork: vi.fn(() => "testnet"),
  createMppClientMethod: vi.fn(),
  executeMppRequest: vi.fn(),
}));

const { executePaymentRequest } = await import("../../src/payments/index.js");
const { executeX402Payment } = await import("../../src/payments/x402.js");
const { createMppClientMethod, executeMppRequest } = await import("../../src/mpp.js");

const executeX402PaymentMock = executeX402Payment as ReturnType<typeof vi.fn>;
const createMppClientMethodMock = createMppClientMethod as ReturnType<typeof vi.fn>;
const executeMppRequestMock = executeMppRequest as ReturnType<typeof vi.fn>;

const network: NetworkConfig = {
  rpc_url: "https://example.test/rpc",
  network_passphrase: "Test SDF Network ; September 2015",
};

const config: WalletermConfig = {
  app: { default_network: "testnet" },
  networks: { testnet: network },
  smart_accounts: {},
};

describe("payment credential capabilities", () => {
  let fixture: FakeSshAgentFixture | undefined;

  beforeEach(() => {
    createMppClientMethodMock.mockReturnValue({ name: "stellar", intent: "charge" });
    executeMppRequestMock.mockResolvedValue({
      paid: true,
      status: 200,
      body: new Uint8Array(),
      responseHeaders: {},
    });
    executeX402PaymentMock.mockResolvedValue({
      paid: true,
      status: 200,
      body: new Uint8Array(),
      responseHeaders: {},
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("uses a provider-backed signer for MPP through its secret-seed capability", async () => {
    const keypair = Keypair.random();
    const resolver = new SecretResolver({
      providers: [{ scheme: "test", resolve: async () => keypair.secret() }],
    });

    const execution = await executePaymentRequest(config, "testnet", network, resolver, {
      url: "https://example.com/resource",
      method: "GET",
      rawHeaders: [],
      protocol: "mpp",
      secretRef: "test://payer",
      dryRun: false,
      yes: true,
      fetchFn: vi.fn(),
    });

    expect(execution.payer).toBe(keypair.publicKey());
    expect(createMppClientMethodMock).toHaveBeenCalledWith(
      expect.objectContaining({ secret: keypair.secret() }),
    );
  });

  it("rejects an MPP payment when the signer cannot provide a secret seed", async () => {
    fixture = await makeFakeSshAgentFixture();
    const secretRef = `ssh-agent://custom/${fixture.stellarAddress}?socket=${encodeURIComponent(fixture.socketPath)}`;

    await expect(
      executePaymentRequest(config, "testnet", network, new SecretResolver({ providers: [] }), {
        url: "https://example.com/resource",
        method: "GET",
        rawHeaders: [],
        protocol: "mpp",
        secretRef,
        dryRun: false,
        yes: true,
        fetchFn: vi.fn(),
      }),
    ).rejects.toThrow("MPP payments require a signer with secret-seed capability");
  });

  it("keeps SSH agent credentials usable for x402 auth-entry signing", async () => {
    fixture = await makeFakeSshAgentFixture();
    const secretRef = `ssh-agent://custom/${fixture.stellarAddress}?socket=${encodeURIComponent(fixture.socketPath)}`;

    await executePaymentRequest(config, "testnet", network, new SecretResolver({ providers: [] }), {
      url: "https://example.com/resource",
      method: "GET",
      rawHeaders: [],
      protocol: "x402",
      secretRef,
      dryRun: false,
      yes: true,
      fetchFn: vi.fn(),
    });

    const exactSigner = executeX402PaymentMock.mock.calls[0]?.[0].exactSigner;
    const authEntry = Buffer.from("auth-entry");
    const signed = await exactSigner.signAuthEntry(authEntry.toString("base64"));

    expect(exactSigner.address).toBe(fixture.stellarAddress);
    expect(signed.signerAddress).toBe(fixture.stellarAddress);
    expect(
      fixture.keypair.verify(hash(authEntry), Buffer.from(signed.signedAuthEntry, "base64")),
    ).toBe(true);
  });
});
