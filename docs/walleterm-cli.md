# Walleterm CLI

## Install and run

```bash
git clone <repo-url>
cd walleterm
bun install
bun run build
```

Run commands with:

```bash
bun src/cli.ts <command>
```

Or link the Bun CLI command globally in your shell:

```bash
bun link
walleterm --help
```

Quality and tooling commands:

```bash
bun run format
bun run lint
bun run check
bun run bundle
bun run compile
bun run coverage
```

`bun run bundle` invokes Rolldown through Node (stable runtime for current Rolldown CLI bindings), while the wallet CLI itself remains Bun-first.

Live test commands:

```bash
bun run test:live
bun run test:live:op
bun run test:live:keychain
bun run test:live:ssh-agent
bun run test:live:ssh-agent:1p
bun run test:live:ssh-agent:system
bun run test:live:all
```

Config details are documented in `docs/walleterm-config.md` and the full annotated template `walleterm.example.toml`.

Supported secret-ref schemes:

- `op://...` for 1Password
- `keychain://...` for the macOS keychain

If using 1Password refs (`op://...`), sign in first:

```bash
eval "$(op signin)"
```

Or run with `op run --`.

## Core commands

If you want the smallest useful command set, start with:
- `setup op`
- `setup keychain`
- `setup ssh-agent`
- `wallet lookup`
- `wallet signer`
- `wallet create`
- `review`
- `sign`
- `submit`
- `pay`

### Review and signing flow

```bash
bun src/cli.ts review --in ./unsigned.json --config ./walleterm.toml --network testnet --account treasury
bun src/cli.ts sign --in ./unsigned.json --out ./signed.json --config ./walleterm.toml --network testnet --account treasury
```

### Submission / relayer flow

Submit a signed transaction XDR through OpenZeppelin Channels (default mode):

```bash
bun src/cli.ts submit \
  --config ./walleterm.toml --network testnet \
  --in ./signed.tx.xdr \
  --channels-base-url https://channels.openzeppelin.com/testnet \
  --channels-api-key <api-key>
```

Submit a signed tx directly to RPC (no relayer):

```bash
bun src/cli.ts submit \
  --config ./walleterm.toml --network testnet \
  --mode rpc \
  --in ./signed.tx.xdr
```

Submit a signed `{func,auth[]}` bundle through Channels:

```bash
bun src/cli.ts submit \
  --config ./walleterm.toml --network testnet \
  --in ./signed.bundle.json \
  --channels-base-url https://channels.openzeppelin.com/testnet \
  --channels-api-key <api-key>
```

Notes:
- `--plugin-id` is available for self-hosted Channels / relayer deployments.
- RPC mode only accepts signed transaction envelope XDR.
- Channels mode accepts signed transaction envelope XDR or signed `{func, auth[]}` bundle JSON.
- Submitting a standalone auth entry is not supported.

### x402 payment flow

Call an x402-protected endpoint and pay from a Stellar keypair:

```bash
bun src/cli.ts pay \
  https://api.example.com/resource \
  --config ./walleterm.toml \
  --network testnet \
  --secret-ref keychain://walleterm-testnet/payer_seed \
  --format json
```

Use config-driven payer selection instead of `--secret-ref`:

```toml
[x402]
default_payer_secret_ref = "keychain://walleterm-testnet/payer_seed"
max_payment_amount = "0.50"
```

Request options:
- `--method <method>`: HTTP method (default `GET`)
- `--header "Name: Value"`: repeatable header option
- `--data <body>`: request body
- `--format body|json`: raw response body to stdout or JSON metadata output
- `--out <path>`: write the raw response body to a file and print a JSON summary
- `--dry-run`: inspect the 402 challenge without paying
- `--yes`: bypass `x402.max_payment_amount`

Behavior notes:
- If `x402.max_payment_amount` is set, `pay` aborts when the requested amount exceeds that cap unless `--yes` is passed.
- `--format json` includes `payment_required`, `payment_payload`, `settlement`, and `settlement_error` fields.
- `--out` takes precedence over `--format json`; it writes the raw body to disk and prints a smaller JSON summary.
- x402 payment network mapping currently supports the standard Stellar testnet and mainnet passphrases only.

### 1Password bootstrap wizard

Bootstrap 1Password secrets for wallet create/sign flows:

```bash
bun src/cli.ts setup op --json
```

Defaults:
- vault: `Private`
- item: `walleterm-testnet` for `testnet`, `walleterm-mainnet` for `mainnet`
- network: `testnet`
- generated fields in item:
  - `delegated_seed`
  - `channels_api_key`

The command will:
- verify `op` CLI is installed and signed in
- create missing vault/item (unless `--no-create-vault`)
- fail if the target item already exists unless you pass `--force`
- use smart-account-kit deterministic deployer by default
- generate delegated key if not provided
- auto-generate Channels API key for `testnet` and `mainnet` if not provided

Operational note:
- Secret values are briefly visible in process listings during storage. Avoid running setup flows on shared machines or CI runners you do not trust.

Optional: store a deployer seed in 1Password (not required in default mode):

```bash
bun src/cli.ts setup op --include-deployer-seed --json
```

If the item already exists and you intend to rotate/overwrite fields:

```bash
bun src/cli.ts setup op --network testnet --force --json
```

Use custom names/values:

```bash
bun src/cli.ts setup op \
  --vault Private \
  --network mainnet \
  --delegated-seed S... \
  --json
```

### macOS keychain bootstrap wizard

Bootstrap wallet secrets into the macOS keychain:

```bash
bun src/cli.ts setup keychain --json
```

Defaults:
- service: `walleterm-testnet` for `testnet`, `walleterm-mainnet` for `mainnet`
- network: `testnet`
- generated entries:
  - `delegated_seed`
  - `channels_api_key`

The command will:
- verify the macOS `security` CLI is available
- fail if the target service/account entries already exist unless you pass `--force`
- use smart-account-kit deterministic deployer by default
- generate delegated key if not provided
- auto-generate Channels API key for `testnet` and `mainnet` if not provided

Operational note:
- Secret values are briefly visible in process listings during storage. Avoid running setup flows on shared machines or CI runners you do not trust.

Optional: store deployer seed in the keychain:

```bash
bun src/cli.ts setup keychain --include-deployer-seed --json
```

Use a custom keychain file:

```bash
bun src/cli.ts setup keychain \
  --service walleterm-mainnet \
  --keychain /Users/me/Library/Keychains/login.keychain-db \
  --network mainnet \
  --json
```

### SSH agent setup and generation

Discover Ed25519 keys already loaded in an SSH agent:

```bash
bun src/cli.ts setup ssh-agent --backend system --json
bun src/cli.ts setup ssh-agent --backend 1password --json
```

Generate and register a new SSH-backed signer:

```bash
bun src/cli.ts setup ssh-agent \
  --backend system \
  --generate \
  --key-path ~/.ssh/walleterm_ed25519 \
  --json

bun src/cli.ts setup ssh-agent \
  --backend 1password \
  --generate \
  --vault Private \
  --title walleterm-ed25519 \
  --json
```

Notes:
- `--backend custom --socket <path>` is supported for discovery against nonstandard agent sockets.
- `--generate` currently supports `system` and `1password` backends only.
- System generation uses `ssh-keygen` and `ssh-add`, and expects the generated key to become visible in the target agent.
- 1Password generation creates an `SSH Key` item, appends an `[[ssh-keys]]` block to `~/.config/1Password/ssh/agent.toml` by default, and polls briefly for the key to appear in the agent.
- Returned `secret_ref` values use the `ssh-agent://...` scheme and can be placed directly in delegated signer config.

### Wallet discovery and signer inspection

Preferred one-shot lookup from a secret provider:

```bash
bun src/cli.ts wallet lookup \
  --config ./walleterm.toml \
  --network testnet \
  --secret-ref op://Private/walleterm-testnet/delegated_seed

bun src/cli.ts wallet lookup \
  --config ./walleterm.toml \
  --network testnet \
  --secret-ref keychain://walleterm-testnet/delegated_seed
```

Pass exactly one selector: `--account`, `--address`, `--contract-id`, or `--secret-ref`.

Other lookup modes:

```bash
bun src/cli.ts wallet lookup --config ./walleterm.toml --network testnet --account treasury
bun src/cli.ts wallet lookup --config ./walleterm.toml --network testnet --address G...
bun src/cli.ts wallet lookup --config ./walleterm.toml --network testnet --address C...
bun src/cli.ts wallet lookup --config ./walleterm.toml --network testnet --contract-id C...
```

Notes:
- `--indexer-url <url>` overrides the configured/default indexer.
- `--secret-ref` lookup derives both the public address and credential ID, then searches delegated and external signer matches.

### Signer management

Generate a new signer keypair:

```bash
bun src/cli.ts wallet signer generate
```

Add delegated signer from a secret provider:

```bash
bun src/cli.ts wallet signer add \
  --config ./walleterm.toml --network testnet --account treasury \
  --secret-ref op://Private/walleterm-testnet/delegated_seed \
  --out ./add-delegated.bundle.json
```

Add external Ed25519 signer from a secret provider:

```bash
bun src/cli.ts wallet signer add \
  --config ./walleterm.toml --network testnet --account treasury \
  --secret-ref op://Private/walleterm-testnet/external_seed \
  --verifier-contract-id CVERIFIER... \
  --out ./add-external.bundle.json
```

Add a delegated signer directly from its public address:

```bash
bun src/cli.ts wallet signer add \
  --config ./walleterm.toml --network testnet --account treasury \
  --delegated-address G... \
  --out ./add-delegated.bundle.json
```

Add an external Ed25519 signer directly from verifier + public key:

```bash
bun src/cli.ts wallet signer add \
  --config ./walleterm.toml --network testnet --account treasury \
  --verifier-contract-id CVERIFIER... \
  --public-key-hex <32-byte-ed25519-pubkey-hex> \
  --out ./add-external.bundle.json
```

Remove signer:

```bash
bun src/cli.ts wallet signer remove \
  --config ./walleterm.toml --network testnet --account treasury \
  --secret-ref op://Private/walleterm-testnet/delegated_seed \
  --out ./remove-signer.bundle.json
```

Notes:
- Pass one signer target using `--secret-ref`, `--delegated-address`, or `--verifier-contract-id` with `--public-key-hex`.
- `--context-rule-id` defaults to `0`.
- `--ttl-seconds` and `--latest-ledger` apply to signer-mutation bundles too.
- If `app.strict_onchain = true`, signer add/remove fails when configured delegated/external signers do not reconcile with indexer-reported on-chain signers for that account.

### Create/deploy a new wallet

Build and sign deployment transaction XDR:

```bash
bun src/cli.ts wallet create \
  --config ./walleterm.toml --network testnet \
  --wasm-hash a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e \
  --delegated-address G... \
  --out ./deploy.tx.xdr
```

Build with smart-account-kit deterministic address mode (no deployer secret needed):

```bash
bun src/cli.ts wallet create \
  --config ./walleterm.toml --network testnet \
  --kit-raw-id "user@example.com" \
  --wasm-hash a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e \
  --delegated-address G... \
  --out ./deploy.tx.xdr
```

Build, sign, and submit deployment transaction through Channels in one command:

```bash
bun src/cli.ts wallet create \
  --config ./walleterm.toml --network testnet \
  --wasm-hash a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e \
  --delegated-address G... \
  --submit --submit-mode channels \
  --channels-base-url https://channels.openzeppelin.com/testnet \
  --channels-api-key <api-key> \
  --out ./deploy.tx.xdr
```

Notes:
- `--delegated-address` and `--external-ed25519 verifier:pubkeyhex` are repeatable.
- At least one initial signer is required.
- `--account <alias>` lets `wallet create` use `smart_accounts.<alias>.expected_wasm_hash` from config when `--wasm-hash` is omitted.
- If both `--wasm-hash` and configured `expected_wasm_hash` are present, they must match.
- Default deployer is smart-account-kit deterministic deployer.
- That deployer is intentionally deterministic and public; it must not hold meaningful balances.
- If `networks.<name>.deployer_secret_ref` is set in config, `wallet create` uses that seed by default.
- Default wallet-create tx timeout is 60s (Channels-compatible).
- `--deployer-secret-ref` is an override; it cannot be combined with `--kit-raw-id`.
- `--kit-raw-id` uses smart-account-kit deterministic deployer and `salt = sha256(raw-id)`.
- `--kit-raw-id` cannot be combined with `--salt-hex`.
- If `app.default_submit_mode = "channels"`, `wallet create` auto-submits through Channels even without `--submit`.
- `--sequence` and `--fee` are available for advanced/manual transaction construction.
- `--skip-prepare` is available for offline/dry flows.
- Command prints derived `contract_id` in stdout JSON.

### Network config for Channels + secret providers

You can store Channels credentials in config and resolve from 1Password:

```toml
[networks.testnet]
rpc_url = "https://soroban-rpc.testnet.stellar.gateway.fm"
network_passphrase = "Test SDF Network ; September 2015"
channels_base_url = "https://channels.openzeppelin.com/testnet"
channels_api_key_ref = "op://vault/oz-relayer/testnet_api_key"
# Optional deployer override:
# deployer_secret_ref = "op://vault/walleterm-testnet/deployer_seed"
```

Then `submit` or `wallet create --submit` can omit `--channels-*` flags.
`wallet create` will also automatically use `deployer_secret_ref` when present.

Config validation warns on non-HTTPS `rpc_url`, `indexer_url`, and `channels_base_url` values unless they target `localhost` or `127.0.0.1`.

The same network config can use the macOS keychain instead:

```toml
[networks.testnet]
rpc_url = "https://soroban-rpc.testnet.stellar.gateway.fm"
network_passphrase = "Test SDF Network ; September 2015"
channels_base_url = "https://channels.openzeppelin.com/testnet"
channels_api_key_ref = "keychain://walleterm-testnet/channels_api_key"
# Optional deployer override:
# deployer_secret_ref = "keychain://walleterm-testnet/deployer_seed"
```

## Tests

Run deterministic/local tests:

```bash
bun run test
```

Run full suite including live on-chain/indexer checks:

```bash
WALLETERM_LIVE=1 bun run test
```

Run SSH-agent live coverage by backend:

```bash
bun run test:live:ssh-agent
bun run test:live:ssh-agent:1p
bun run test:live:ssh-agent:system
```

SSH-agent live prerequisites:
- `test:live:ssh-agent` expects a reachable system SSH agent via `SSH_AUTH_SOCK` with at least one Ed25519 key loaded.
- `test:live:ssh-agent:1p` additionally expects 1Password CLI sign-in and the 1Password SSH agent to be enabled.
- `test:live:ssh-agent:system` generates a temporary key file, adds it to the system agent, deploys a wallet, signs a payment, and verifies the result on-chain.

Run real 1Password + testnet wallet-create live test:

```bash
WALLETERM_LIVE=1 \
WALLETERM_LIVE_OP=1 \
WALLETERM_OP_DELEGATED_REF='op://<vault>/<item>/delegated_seed' \
WALLETERM_OP_CHANNELS_API_KEY_REF='op://<vault>/<item>/channels_api_key' \
bun run test tests/live/op-live.test.ts
```

`<vault>` and `<item>` in `op://<vault>/<item>/<field>` mean:
- `<vault>`: your 1Password vault name or ID (for example `Private`)
- `<item>`: the item name or ID that stores the secret field (for example `walleterm-testnet`)
- `<field>`: the exact field name/ID (for example `delegated_seed`)

The OP live test now has defaults:
- `WALLETERM_OP_VAULT=Private`
- `WALLETERM_OP_ITEM=walleterm-testnet`
- field names:
  - `delegated_seed`
  - `channels_api_key`

So this also works if your item follows that naming:

```bash
WALLETERM_LIVE=1 WALLETERM_LIVE_OP=1 bun run test tests/live/op-live.test.ts
```

Optional overrides for the OP live test:
- `WALLETERM_OP_VAULT`
- `WALLETERM_OP_ITEM`
- `WALLETERM_OP_WASM_HASH` (defaults to `a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e`)
- `WALLETERM_OP_TESTNET_RPC_URL` (defaults to `https://soroban-rpc.testnet.stellar.gateway.fm`)
- `WALLETERM_OP_TESTNET_CHANNELS_BASE_URL` (defaults to `https://channels.openzeppelin.com/testnet`)
- `WALLETERM_OP_CONTEXT_RULE_ID` (defaults to `0`)
- `WALLETERM_OP_DELEGATED_REF`
- `WALLETERM_OP_CHANNELS_API_KEY_REF`
