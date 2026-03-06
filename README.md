# walleterm

`walleterm` is a Bun CLI for OpenZeppelin Stellar smart-account operations.

It is not a long-running daemon/service. The default model is:
1. review unsigned payload
2. sign what you can with configured keys (`op://` from 1Password)
3. optionally submit via relayer (Channels) or RPC

## What It Does

- Signs Stellar transaction envelope XDR
- Signs Soroban auth entries / `{ func, auth[] }` bundles
- Supports OZ smart-account signer models:
  - delegated signers (`G...`)
  - external Ed25519 signer map entries
- Manages wallet/signer flows (lookup, deploy, add/remove signers)
- Integrates with 1Password CLI (`op`) for key material

## Prereqs

- [Bun](https://bun.com/)
- Optional but recommended: [1Password CLI](https://developer.1password.com/docs/cli/)
- Stellar testnet/mainnet RPC access (defaults are in config)

## Quick Start

```bash
cd /Users/kalepail/Desktop/walleterm
bun install
cp walleterm.example.toml walleterm.toml
```

If using 1Password refs:

```bash
op signin
bun run cli setup op --network testnet
```

Then update `walleterm.toml` with your real contract IDs and signer configuration.

The simplest mental model is:
1. `setup op`
2. `wallet lookup`
3. `wallet create` or `wallet signer add/remove`
4. `review`
5. `sign`
6. `submit` if needed

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

## Wallet Management

Preferred introspection flow:

```bash
bun run cli wallet lookup --config ./walleterm.toml --network testnet --secret-ref op://Private/walleterm-testnet/delegated_seed
```

That command resolves the seed from 1Password, derives the signer identity, reverse-lookups matching wallets, and returns the signers each wallet currently contains.

Deploy wallet tx:

```bash
bun run cli wallet create \
  --config ./walleterm.toml \
  --network testnet \
  --wasm-hash a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e \
  --delegated-address G... \
  --out ./deploy.tx.xdr
```

Add a delegated signer from 1Password:

```bash
bun run cli wallet signer add \
  --config ./walleterm.toml \
  --network testnet \
  --account treasury \
  --secret-ref op://Private/walleterm-testnet/delegated_seed \
  --out ./add-signer.bundle.json
```

Add an external Ed25519 signer from 1Password:

```bash
bun run cli wallet signer add \
  --config ./walleterm.toml \
  --network testnet \
  --account treasury \
  --secret-ref op://Private/walleterm-testnet/external_seed \
  --verifier-contract-id CVERIFIER... \
  --out ./add-external.bundle.json
```

## Commands and Help

```bash
bun run cli --help
bun run cli wallet --help
bun run cli wallet signer --help
bun run cli setup op --help
```

## Testing

```bash
bun run test
bun run test:live
bun run test:live:op
bun run test:live:all
```

## Docs

- TOML config reference: [docs/walleterm-config.md](/Users/kalepail/Desktop/walleterm/docs/walleterm-config.md)
- CLI usage details: [docs/walleterm-cli.md](/Users/kalepail/Desktop/walleterm/docs/walleterm-cli.md)
- Architecture and signing model: [docs/walleterm-architecture.md](/Users/kalepail/Desktop/walleterm/docs/walleterm-architecture.md)
