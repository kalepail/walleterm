# walleterm

`walleterm` is a Bun CLI for OpenZeppelin Stellar smart-account operations.

It is not a long-running daemon/service. The default model is:
1. inspect unsigned payload
2. sign what you can with configured keys (`op://` from 1Password)
3. optionally submit via relayer (Channels) or RPC

## What It Does

- Signs Stellar transaction envelope XDR
- Signs Soroban auth entries / `{ func, auth[] }` bundles
- Supports OZ smart-account signer models:
  - delegated signers (`G...`)
  - external Ed25519 signer map entries
- Manages wallet/signer flows (discover, list-signers, reconcile, add/remove signers, deploy)
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

## Core Usage

Inspect payload:

```bash
bun run cli inspect --config ./walleterm.toml --in ./unsigned.json
```

Check signability:

```bash
bun run cli can-sign --config ./walleterm.toml --network testnet --account treasury --in ./unsigned.json
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

Deploy wallet tx:

```bash
bun run cli wallet create \
  --config ./walleterm.toml \
  --network testnet \
  --wasm-hash a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e \
  --delegated-address G... \
  --out ./deploy.tx.xdr
```

Signer reconciliation / discovery:

```bash
bun run cli wallet discover --config ./walleterm.toml --network testnet --address G...
bun run cli wallet list-signers --config ./walleterm.toml --network testnet --contract-id C...
bun run cli wallet reconcile --config ./walleterm.toml --network testnet --account treasury
```

## Commands and Help

```bash
bun run cli --help
bun run cli wallet --help
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

- CLI usage details: [docs/walleterm-cli.md](/Users/kalepail/Desktop/walleterm/docs/walleterm-cli.md)
- Architecture and signing model: [docs/walleterm-architecture.md](/Users/kalepail/Desktop/walleterm/docs/walleterm-architecture.md)

