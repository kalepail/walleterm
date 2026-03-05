# Walleterm CLI

## Install and run

```bash
cd /Users/kalepail/Desktop/walleterm
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
bun run test:live:all
```

Config details are documented in `docs/walleterm-config.md` and the full annotated template `walleterm.example.toml`.

If using 1Password refs (`op://...`), sign in first:

```bash
eval "$(op signin)"
```

Or run with `op run --`.

## Core commands

### Existing signing flow

```bash
bun src/cli.ts inspect --in ./unsigned.json --config ./walleterm.toml
bun src/cli.ts can-sign --in ./unsigned.json --config ./walleterm.toml --network testnet --account treasury
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

### Key management

Generate a new seed/public keypair:

```bash
bun src/cli.ts keys create
```

Verify configured 1Password key refs match configured signer keys:

```bash
bun src/cli.ts keys verify --config ./walleterm.toml --account treasury
```

### Wallet discovery and signer inspection

Find wallets by signer address (`G...` or `C...`):

```bash
bun src/cli.ts wallet discover --config ./walleterm.toml --network testnet --address G...
```

List signers for a wallet contract:

```bash
bun src/cli.ts wallet list-signers --config ./walleterm.toml --network testnet --contract-id C...
```

Compare local config signers vs indexer signers for an account:

```bash
bun src/cli.ts wallet reconcile --config ./walleterm.toml --network testnet --account treasury
```

### Build signer-management bundles (sign-only output)

Add delegated signer:

```bash
bun src/cli.ts wallet add-delegated-signer \
  --config ./walleterm.toml --network testnet --account treasury \
  --context-rule-id 0 --delegated-address G... \
  --out ./add-delegated.bundle.json
```

Remove delegated signer:

```bash
bun src/cli.ts wallet remove-delegated-signer \
  --config ./walleterm.toml --network testnet --account treasury \
  --context-rule-id 0 --delegated-address G... \
  --out ./remove-delegated.bundle.json
```

Add external Ed25519 signer:

```bash
bun src/cli.ts wallet add-external-ed25519-signer \
  --config ./walleterm.toml --network testnet --account treasury \
  --context-rule-id 0 \
  --verifier-contract-id CVERIFIER... \
  --public-key-hex <32-byte-hex> \
  --out ./add-external.bundle.json
```

Remove external Ed25519 signer:

```bash
bun src/cli.ts wallet remove-external-ed25519-signer \
  --config ./walleterm.toml --network testnet --account treasury \
  --context-rule-id 0 \
  --verifier-contract-id CVERIFIER... \
  --public-key-hex <32-byte-hex> \
  --out ./remove-external.bundle.json
```

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
- Default deployer is smart-account-kit deterministic deployer.
- If `networks.<name>.deployer_secret_ref` is set in config, `wallet create` uses that seed by default.
- Default wallet-create tx timeout is 60s (Channels-compatible).
- `--deployer-secret-ref` is an override; it cannot be combined with `--kit-raw-id`.
- `--kit-raw-id` uses smart-account-kit deterministic deployer and `salt = sha256(raw-id)`.
- `--skip-prepare` is available for offline/dry flows.
- Command prints derived `contract_id` in stdout JSON.

### Network config for Channels + 1Password

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

## Tests

Run deterministic/local tests:

```bash
bun run test
```

Run full suite including live on-chain/indexer checks:

```bash
WALLETERM_LIVE=1 bun run test
```

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
