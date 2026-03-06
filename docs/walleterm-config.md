# Walleterm TOML Config Reference

This document defines every supported `walleterm.toml` setting.

Canonical schema is implemented in:
- `src/config.ts`

A full annotated template lives at:
- `walleterm.example.toml`

## 1) app section

```toml
[app]
default_network = "testnet"
strict_onchain = true
onchain_signer_mode = "subset"
default_ttl_seconds = 30
assumed_ledger_time_seconds = 6
default_submit_mode = "sign-only"
```

Fields:
- `default_network` (required): Name of network key under `[networks.<name>]`.
- `strict_onchain` (optional, default `true`): Enforce on-chain signer and account checks.
- `onchain_signer_mode` (optional, default `subset`): `subset` or `exact`.
- `default_ttl_seconds` (optional, default `30`): Used when signing auth entries.
- `assumed_ledger_time_seconds` (optional, default `6`): Ledger-time estimate for TTL to ledger conversion.
- `default_submit_mode` (optional, default `sign-only`): Preferred workflow mode (`sign-only` or `channels`).

## 2) networks section

Each network table requires RPC URL and passphrase.

```toml
[networks.testnet]
rpc_url = "https://soroban-rpc.testnet.stellar.gateway.fm"
network_passphrase = "Test SDF Network ; September 2015"
indexer_url = "https://smart-account-indexer.sdf-ecosystem.workers.dev"
channels_base_url = "https://channels.openzeppelin.com/testnet"
channels_api_key_ref = "op://Private/walleterm-testnet/channels_api_key"
# deployer_secret_ref = "op://Private/walleterm-testnet/deployer_seed"
```

Fields:
- `rpc_url` (required)
- `network_passphrase` (required)
- `indexer_url` (optional): Used for `wallet lookup` and signer introspection.
- `channels_base_url` (optional): Needed when submitting via Channels unless provided by CLI flags.
- `channels_api_key_ref` (optional): Can be either:
  - `op://...` reference, or
  - direct API key string.
- `deployer_secret_ref` (optional): `wallet create` override source. If omitted, CLI uses the smart-account-kit deterministic deployer.

## 3) smart_accounts section

Define one or more managed smart accounts by alias.

```toml
[smart_accounts.treasury_testnet]
network = "testnet"
contract_id = "C..."
expected_wasm_hash = "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e"
```

Fields:
- `network` (required): Must match a configured `[networks.<name>]` key.
- `contract_id` (required): Smart account contract address (`C...`).
- `expected_wasm_hash` (optional but recommended): Enforces expected contract wasm hash during strict checks.

### delegated_signers

```toml
[[smart_accounts.treasury_testnet.delegated_signers]]
name = "delegate_1"
address = "G..."
secret_ref = "op://Private/walleterm-testnet/delegated_seed"
enabled = true
```

Fields:
- `name` (required)
- `address` (required): Delegated signer Stellar account (`G...`).
- `secret_ref` (required): Currently expects a 1Password `op://...` reference that resolves to Stellar secret seed (`S...`).
- `enabled` (optional, default `true`)

### external_signers

```toml
[[smart_accounts.treasury_testnet.external_signers]]
name = "ops_1"
verifier_contract_id = "C..."
public_key_hex = "<32-byte-ed25519-pubkey-hex>"
secret_ref = "op://Private/walleterm-testnet/external_ops_1_seed"
enabled = true
```

Fields:
- `name` (required)
- `verifier_contract_id` (required): OZ verifier contract (`C...`).
- `public_key_hex` (required): 32-byte ed25519 public key in hex.
- `secret_ref` (required): 1Password `op://...` reference to corresponding Stellar seed (`S...`).
- `enabled` (optional, default `true`)

## 4) Minimal Valid Config

```toml
[app]
default_network = "testnet"

[networks.testnet]
rpc_url = "https://soroban-rpc.testnet.stellar.gateway.fm"
network_passphrase = "Test SDF Network ; September 2015"

[smart_accounts]
```

## 5) Practical Notes

- If you run `setup op`, default item names are:
  - `walleterm-testnet`
  - `walleterm-mainnet`
- `setup op` creates/stores by default:
  - `delegated_seed`
  - `channels_api_key`
- Storing `deployer_seed` is optional (`--include-deployer-seed`).
- For submission:
  - Channels mode requires `channels_base_url` and API key (from config or flags).
  - RPC mode only requires `rpc_url` and `network_passphrase`.
