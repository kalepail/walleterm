# Walleterm TOML Config Reference

This document covers the current user-facing `walleterm.toml` settings and notes where behavior is enforced at runtime.

Canonical schema is implemented in:
- `src/config.ts`

A full annotated template lives at:
- `walleterm.example.toml`

Secret refs are provider-backed URIs. Current supported schemes are:
- `op://...` for 1Password
- `keychain://...` for the macOS keychain

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
- `strict_onchain` (optional, default `true`): When enabled, `sign` and `wallet signer add/remove` fail if configured signers do not reconcile against current indexer-reported on-chain signers for the selected account.
- `onchain_signer_mode` (optional, default `subset`): `subset` or `exact`. Controls signer reconciliation behavior. `subset` requires all enabled configured signers to exist on-chain. `exact` also rejects extra on-chain delegated/external signers not present in config.
- `default_ttl_seconds` (optional, default `30`): Used when signing auth entries.
- `assumed_ledger_time_seconds` (optional, default `6`): Ledger-time estimate for TTL to ledger conversion.
- `default_submit_mode` (optional, default `sign-only`): Preferred `wallet create` behavior. `sign-only` writes the deployment transaction only. `channels` also auto-submits the created deployment transaction through Channels unless overridden by CLI flags.

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
  - provider-backed secret ref like `op://...` or `keychain://...`, or
  - direct API key string.
- `deployer_secret_ref` (optional): `wallet create` override source. If omitted, CLI uses the smart-account-kit deterministic deployer.
- `x402_facilitator_url` (optional): Parsed and validated for forward compatibility, but currently unused by the CLI runtime.

Notes:
- Config validation warns on non-HTTPS `rpc_url`, `indexer_url`, `channels_base_url`, and `x402_facilitator_url` values unless they target `localhost` or `127.0.0.1`.
- The default smart-account-kit deployer is intentionally deterministic and public. It should never hold meaningful balances.

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
- `expected_wasm_hash` (optional but recommended): Validated as a 32-byte hex string. `wallet create` can use this as the default WASM hash when `--account <alias>` is passed and `--wasm-hash` is omitted. If both are provided, they must match.

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
- `secret_ref` (required): Provider-backed secret ref that resolves to Stellar secret seed (`S...`), for example:
  - `op://Private/walleterm-testnet/delegated_seed`
  - `keychain://walleterm-testnet/delegated_seed`
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
- `secret_ref` (required): Provider-backed secret ref to corresponding Stellar seed (`S...`).
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

## 5) x402 section

Optional settings for `walleterm pay`:

```toml
[x402]
default_payer_secret_ref = "keychain://walleterm-testnet/payer_seed"
max_payment_amount = "0.50"
```

Fields:
- `default_payer_secret_ref` (optional): Default payer seed for `walleterm pay`. The value must resolve to a Stellar secret seed (`S...`).
- `max_payment_amount` (optional): Stringified numeric cap for x402 payments. `walleterm pay` aborts if the requested amount exceeds this cap unless `--yes` is passed.

Notes:
- `walleterm pay` can override `default_payer_secret_ref` with `--secret-ref`.
- x402 network mapping currently supports the standard Stellar testnet and mainnet passphrases only.
- `--dry-run` inspects the 402 challenge without paying.

## 6) Practical Notes

- If you run `setup op` or `setup keychain`, default logical container names are:
  - `walleterm-testnet`
  - `walleterm-mainnet`
- Both setup commands create/store by default:
  - `delegated_seed`
  - `channels_api_key`
- Storing `deployer_seed` is optional (`--include-deployer-seed`).
- External signer seed fields such as `external_ops_1_seed` are not created automatically; provision those separately in your secret store.
- `setup keychain` stores those values as macOS generic-password items where:
  - service = `walleterm-<network>`
  - account = field name like `delegated_seed`
- For submission:
  - Channels mode requires `channels_base_url` and API key (from config or flags).
  - RPC mode only requires `rpc_url` and `network_passphrase`.
- Setup commands briefly expose secret values in process listings while calling `op` or `security`. Avoid running setup flows on shared machines you do not trust.
