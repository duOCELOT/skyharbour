# server/chain/

`config.json` holds the devnet operator's public identity — mint addresses for the six
resource tokens and the two Metaplex collection NFTs — written by `npm run chain:bootstrap`.
`registry.json` (if present) holds runtime mappings the server maintains at request time.
Neither file contains secrets.

The operator keypair does **not** live in this repo: it's generated on first run at
`SKYHARBOUR_KEYPAIR` (default `~/.config/skyharbour/devnet-keypair.json`, mode 0600) and
funded from the devnet faucet.

Commands: `npm run chain:bootstrap` (idempotent — creates the keypair/mints/collections
that don't exist yet, safe to rerun), `npm run chain:mint-ship` / `npm run chain:mint-crew`
(mint individual NFTs into those collections), `npm run chain:mint-batch` (mint a range of
the genesis manifest — see below).

## Buy GOLD with SOL

Chain-mode only. The player sends devnet SOL to the treasury (the operator pubkey from
`config.json`) via Phantom, then `POST /gold/buy { signature }`. The server fetches the
parsed transaction and verifies it: a confirmed `system` `transfer` whose source is the
caller's wallet and whose destination is the treasury, totaling at least 0.01 SOL. It
credits `floor(lamports / 1_000_000)` GOLD (0.1 SOL = 100 GOLD) to the caller's ledger
balance. Each signature is recorded in `sol_purchases` and can be redeemed at most once —
replaying the same signature returns an error instead of double-crediting. In dev mode
(no on-ramp configured) `/gold/buy` always returns 400 `chain mode only`.

## Batch minting (`chain:mint-batch`)

```
npm run chain:mint-batch -- --manifest ships --from 1 --to 10 [--to-wallet <pubkey>]
```

Loads `manifest-<ships|crew>.json`, takes the given 1-indexed **inclusive** range of manifest
positions, and mints each entry exactly like `chain:mint-ship` / `chain:mint-crew`: `createNft`
into the matching collection from `config.json`, `verifyCollectionV1`, and — if `--to-wallet`
is given — a `transferV1` to that address. Only entries with a per-entry `image` field get
artwork/metadata files written under `nft/` (see "Art" below); everything else mints with
`uri: ''`, same as the single-mint scripts.

Ids are derived from manifest **position**, not registry count, so they're stable across
reruns: `SH-<pos padded 3> <name>` for ships (e.g. `SH-001 Iron Wager`), `CR-<pos padded 4>
<name>` for crew (e.g. `CR-0001 Mara Voss`).

The registry entry is appended to `registry.json` **after each individual mint**, so the
script is crash-resumable: rerunning the same (or a wider) `--from`/`--to` range skips any
position whose derived id is already present in the registry and only mints the remainder.
On the first hard failure it stops immediately and prints the exact command to resume from
that position — it does not retry across positions, only within a single mint's chain
operations (create/verify/transfer), same retry-with-backoff pattern as `chain:bootstrap`.
If a batch mint fails between the on-chain mint and the registry write, verify the last
logged mint against `registry.json` before resuming to avoid minting a duplicate.

## Art (`--image`)

Pass `--image <path>` to `chain:mint-ship` / `chain:mint-crew` to attach artwork to the
mint. Accepted source extensions: `.png`, `.jpg`, `.jpeg`, `.webp`.

When `--image` is given, the script:

1. Slugs the generated id (e.g. `SH-001 Rustbucket` → `sh-001-rustbucket`).
2. Copies the source image to `<repoRoot>/nft/<slug><ext>` (creating `nft/` if needed).
3. Writes Metaplex-standard metadata to `<repoRoot>/nft/<slug>.json` — `name`, `symbol`
   (`SKYH`), `description`, an `image` pointing at the raw-GitHub URL for the copied file,
   and `attributes` (ship: `ENGINE`/`CARGO`/`CREW SLOTS`; crew: one trait per skill with a
   value greater than 0, trait name uppercased).
4. Mints with `uri` set to the raw-GitHub URL for the metadata JSON (validated ≤ 200 chars).

Without `--image`, behavior is unchanged: the NFT mints with `uri: ''` and no files are
written under `nft/`.

**The `nft/` directory must be pushed to GitHub** for wallets to resolve the art and
metadata — the `image`/`uri` fields are raw-GitHub URLs
(`https://raw.githubusercontent.com/duOCELOT/skyharbour/main/nft/...`), not on-chain or
IPFS storage. The script prints a reminder of this after minting with `--image`.
