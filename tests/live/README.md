# Live Tests

The live suite is gated behind environment variables so `bun run check` stays deterministic by
default.

Current live coverage:

- `keychain-live.test.ts`: macOS Keychain-backed wallet deployment and native payment flow
- `mpp-live.test.ts`: live MPP charge plus MPP channel open/pay/reuse/close against real testnet
- `op-live.test.ts`: 1Password-backed wallet deployment and native payment flow
- `ssh-agent-live.test.ts`: SSH agent discovery, signing, and smart-account payment flow
- `wallet-live.test.ts`: network/indexer/channels health checks and direct live submission checks
- `x402-live.test.ts`: live x402 exact payment plus state-channel open/reuse against the deployed NFT service

Current env gates:

- `WALLETERM_LIVE=1` enables the shared live suite
- `WALLETERM_LIVE_KEYCHAIN=1` enables Keychain live tests
- `WALLETERM_LIVE_MPP=1` enables live MPP payment tests
- `WALLETERM_LIVE_OP=1` enables 1Password live tests
- `WALLETERM_LIVE_SSH_AGENT=1` enables SSH agent live tests
- `WALLETERM_LIVE_X402=1` enables live x402 payment tests

Highest-value next additions:

1. One negative live payment test per protocol for over-cap, invalid settlement, or insufficient
   balance behavior

Principles:

- Prefer a small number of high-signal live tests over many fragile ones.
- Exercise the real CLI surface, not internal helpers, whenever practical.
- Reuse the shared helpers in `tests/live/helpers.ts` instead of copying Horizon/funding logic into
  new files.
- The MPP live tests hit local ephemeral MPP servers but still use real testnet payments and the
  deployed one-way-channel factory/token contracts.
- The x402 live tests provision their own payer, establish a USDC trustline, and acquire testnet
  USDC via the DEX before paying.
