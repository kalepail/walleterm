# walleterm

> [!WARNING]
> **Experimental software — use at your own risk.**
> This tool has not been formally audited by a third party. It interacts with live blockchain networks and manages cryptographic signing keys. Do not use it with funds you cannot afford to lose. Review the source code and security documentation before use.

`walleterm` is a Bun CLI for OpenZeppelin Stellar smart-account operations.

It is not a long-running daemon/service. The default model is:
1. review unsigned payload
2. sign what you can with configured keys from a supported secret store
3. optionally submit via relayer (Channels) or RPC
4. optionally pay x402-protected HTTP endpoints with a configured Stellar payer

## What It Does

- Signs Stellar transaction envelope XDR
- Signs Soroban auth entries / `{ func, auth[] }` bundles
- Supports OZ smart-account signer models:
  - delegated signers (`G...`)
  - external Ed25519 signer map entries
- Manages wallet/signer flows (lookup, deploy, add/remove signers)
- Pays x402-protected endpoints from a Stellar keypair
- Resolves key material from pluggable secret providers

## Prereqs

- [Bun](https://bun.com/)
- Optional:
  - [1Password CLI](https://developer.1password.com/docs/cli/)
  - macOS `security` CLI (built into macOS)
- Stellar testnet/mainnet RPC access (defaults are in config)

## Quick Start

```bash
git clone <repo-url>
cd walleterm
bun install
cp walleterm.example.toml walleterm.toml
```

If using 1Password refs:

```bash
op signin
bun run cli setup op --network testnet
```

If using the macOS keychain:

```bash
bun run cli setup keychain --network testnet
```

Then update `walleterm.toml` with your real contract IDs and signer configuration.

The simplest mental model is:
1. `setup op` or `setup keychain`
2. `wallet lookup`
3. `wallet create` or `wallet signer add/remove`
4. `review`
5. `sign`
6. `submit` if needed
7. `pay` for x402 endpoints if needed

## Core Usage

Review payload:

```bash
bun run cli review --config ./walleterm.toml --network testnet --account treasury --in ./unsigned.json
```

Sign:

```bash
bun run cli sign --config ./walleterm.toml --network testnet --account treasury --in ./unsigned.json --out ./signed.json
```

Submit (Channels):

```bash
bun run cli submit --config ./walleterm.toml --network testnet --in ./signed.json --mode channels
```

Submit (RPC):

```bash
bun run cli submit --config ./walleterm.toml --network testnet --in ./signed.tx.xdr --mode rpc
```

Pay an x402-protected endpoint:

```bash
bun run cli pay https://api.example.com/resource \
  --config ./walleterm.toml \
  --network testnet \
  --secret-ref keychain://walleterm-testnet/payer_seed \
  --format json
```

`pay` can also read the payer from `x402.default_payer_secret_ref` in `walleterm.toml`. `--out` writes the raw response body to disk and prints a JSON summary.

## Wallet Management

Preferred introspection flow:

```bash
bun run cli wallet lookup --config ./walleterm.toml --network testnet --secret-ref op://Private/walleterm-testnet/delegated_seed
bun run cli wallet lookup --config ./walleterm.toml --network testnet --secret-ref keychain://walleterm-testnet/delegated_seed
```

That command resolves the seed from the configured secret provider, derives the signer identity, reverse-lookups matching wallets, and returns the signers each wallet currently contains.

Other lookup selectors are also supported: `--account`, `--address`, and `--contract-id`.

Deploy wallet tx:

```bash
bun run cli wallet create \
  --config ./walleterm.toml \
  --network testnet \
  --wasm-hash a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e \
  --delegated-address G... \
  --out ./deploy.tx.xdr
```

Add a delegated signer from a secret provider:

```bash
bun run cli wallet signer add \
  --config ./walleterm.toml \
  --network testnet \
  --account treasury \
  --secret-ref op://Private/walleterm-testnet/delegated_seed \
  --out ./add-signer.bundle.json
```

Add an external Ed25519 signer from a secret provider:

```bash
bun run cli wallet signer add \
  --config ./walleterm.toml \
  --network testnet \
  --account treasury \
  --secret-ref op://Private/walleterm-testnet/external_seed \
  --verifier-contract-id CVERIFIER... \
  --out ./add-external.bundle.json
```

Generate a fresh signer keypair:

```bash
bun run cli wallet signer generate
```

Setup commands create `delegated_seed` and `channels_api_key` by default, plus optional `deployer_seed`. External signer seeds like `external_ops_1_seed` must still be provisioned manually in your secret store.

## Commands and Help

```bash
bun run cli --help
bun run cli wallet --help
bun run cli wallet signer --help
bun run cli pay --help
bun run cli setup op --help
bun run cli setup keychain --help
```

## Testing

```bash
bun run test
bun run test:live
bun run test:live:op
bun run test:live:all
```

## Docs

- TOML config reference: [docs/walleterm-config.md](docs/walleterm-config.md)
- CLI usage details: [docs/walleterm-cli.md](docs/walleterm-cli.md)
- Architecture and signing model: [docs/walleterm-architecture.md](docs/walleterm-architecture.md)
- Credential-provider design: [docs/credential-providers.md](docs/credential-providers.md)
- Security status: [docs/security-remediation-plan.md](docs/security-remediation-plan.md)
- Historical audit snapshot: [docs/security-audit.md](docs/security-audit.md)
