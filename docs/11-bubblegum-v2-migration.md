# Bubblegum V2 migration plan — full closed marketplace

**Status:** architecture locked; phases 1–2 proof primitives are implemented. This document is a release gate, not a claim that the migration is complete.

Phases 1–2 currently include the admin-owned `BubblegumTreeMeta` binding, the client/backend PDA and decoder mirrors, the pinned `mpl-bubblegum 2.1.1` dependency, canonical V2 leaf reconstruction, a direct Account Compression `verify_leaf` CPI, one-time staged compressed-mint claims, strict V2 DAS hash/flags/proof normalization, negative transport checks, and a claim-bound `MintV2` CPI. Bubblegum transfer/freeze/thaw/burn CPIs and the production pack integration are still gated. The historical MPL-Core `open_pack` mint path now fails closed with `CompressedMigrationRequired`; it is retained only as migration-reference code, not as a fallback.

## Scope decision

The project will migrate every chip to Metaplex Bubblegum V2 compressed NFTs. The application will operate a **closed/custom marketplace** until external wallet and marketplace transfer support is verified. The project must not be advertised as production-ready while any migration gate below is open.

The current Core asset model is not retained as a second ownership source. `ChipState.asset` remains the logical cNFT asset identifier, but ownership is authoritative only when the current Bubblegum V2 leaf and proof are verified.

## Compatibility baseline

- The workspace currently targets Anchor `0.31.1` and the Solana 2.x dependency family. The Bubblegum crate must therefore be pinned to the last compatible V2 line (`mpl-bubblegum 2.1.1`) until the whole workspace is deliberately upgraded. Do not silently select the latest `3.x`: it requires Anchor 1.x and `solana-program 3.x`.
- All V2 trees use `LeafSchemaV2`, `createTreeV2`, and MPL-Core collections. V1 trees and legacy Core assets are not accepted by the new paths.
- Every operation that replaces a leaf obtains a fresh DAS asset and proof. A proof is single-use from the application's perspective: after transfer, freeze, thaw, delegate, burn, or update the indexer must refetch it.
- The deployed DAS provider is part of the trust and availability boundary. Its URL, commitment, timeout, response schema, and fail-closed behavior are configuration and release evidence.

## Tree and collection layout

The first production topology is one V2 tree per collection. This avoids mixing collection authorities, keeps proof/account lists bounded, and lets a collection pause independently. `create_bubblegum_tree` initializes each Bubblegum V2 TreeConfig through the chip_core CPI with the collection metadata PDA as both tree creator and delegate; the operations transaction only preallocates the Merkle storage account with Account Compression as owner. Initial parameters are:

| Parameter | Initial value | Rationale |
|---|---:|---|
| max depth | 20 | capacity of about 1,048,576 chips per collection |
| canopy | 13 | leaves room for proof accounts while keeping leaf replacement composable |
| collection | existing MPL-Core collection | Bubblegum V2 collection integration and permanent delegates |
| tree authority | collection administration PDA | only the controlled mint pipeline can mint |
| leaf owner | player wallet | the program never becomes the cNFT owner |
| leaf delegate | player wallet unless a deliberate delegate is configured | no implicit backend custody |

The exact depth/canopy pair is not final until the localnet transaction-size and CU benchmark is recorded. Smaller trees are valid for a staging tree. Tree rent is an upfront treasury liability and is reported separately from per-mint cost.

`CollectionMeta` will gain the tree config, merkle tree, tree authority, max depth, and canopy references. Existing `core_collection` remains the V2 collection reference; it is not an NFT account.

## On-chain state and proof contract

The new `CompressedChipState` projection carries the immutable location tuple (the legacy `ChipState` layout is not silently decoded as a compressed account):

- `asset` — Bubblegum asset id, used as the logical chip key and PDA seed;
- `merkle_tree` — the V2 tree account;
- `leaf_index` — the leaf index returned by DAS;
- `leaf_nonce` — the current leaf nonce;
- `data_hash`, `creator_hash`, `collection_hash`, `asset_data_hash`, `leaf_flags` — the commitments needed to reconstruct and authorize a V2 leaf replacement.

A `CompressedMintClaim` binds buyer, collection, rarity, level, and game index before registration and is closed only after proof verification. This prevents a permissionless cranker from registering an arbitrary valid cNFT as a high-rarity game item.

Current leaf owner/delegate are **not cached as authority**. They are read from the DAS response supplied by the transaction builder and checked against the signed owner/delegate and the Bubblegum CPI. A stale owner or stale root must fail closed.

Every replacement instruction carries:

1. the tree config and merkle tree accounts;
2. the current root, leaf index, nonce, data hash, creator hash, collection hash, and asset data hash;
3. the reconstructed V2 metadata args;
4. proof node accounts as remaining accounts, in the exact order expected by Bubblegum;
5. the owner/delegate signer or an explicitly configured permanent collection delegate.

The CPI, not a locally invented ownership parser, is the final proof check. The program additionally checks that the supplied tree, asset id, collection, and stored location match `ChipState`.

## Mint pipeline

Minting cannot assume that a CPI returns an asset account or a stable asset id. The migration uses a staged claim pipeline:

1. Operations preallocate the Merkle storage account; the admin calls `create_bubblegum_tree`, which initializes the Bubblegum V2 TreeConfig and records the tree binding while signing as the collection PDA.
2. The migration foundation stages one `CompressedMintClaim` binding buyer, collection, rarity, level, and game index. The claim is bounded to seven days and has a one-time `minted` bit.
3. `mint_compressed_chip` validates the claim, configured tree/collection, Bubblegum TreeConfig PDA, fixed CPI program IDs, and collection/tree-delegate PDA policy, then invokes Bubblegum V2 `MintV2` with a collection CPI signer. The leaf owner and delegate are the buyer.
4. DAS indexing resolves the new asset id, leaf index, nonce, hashes, owner, and proof. DAS remains asynchronous: the mint CPI does not pretend to know the finalized leaf coordinates.
5. `register_compressed_chip` verifies the DAS-derived V2 leaf with Account Compression, checks the claim and player owner, creates `CompressedChipState`, and closes the claim only after successful verification.
6. The old MPL-Core `open_pack` route is explicitly disabled. `open_compressed_pack` now moves the roll/pending-pack settlement into a Bubblegum-aware asynchronous state machine; `CompressedPackSettlement` and its recovery protocol are described below. No release may use the gated route as a fallback.

A registration delay leaves a minted claim recoverable and retryable but does not mint another chip. An unminted claim can be cancelled only after its deadline. Replay protection is the `(pending, pack_no, slot)` claim PDA plus the asset id. This is intentionally not an optimistic “event says it minted” path.

## Lifecycle flows

- **Ownership / arena:** use the leaf proof and current leaf owner; never parse `BaseAssetV1` or read a nonexistent cNFT account.
- **Freeze / thaw:** call Bubblegum V2 freeze/thaw with the permanent collection delegate. Because this mutates the leaf, listing/staking/fusion transitions use a fresh proof on each transaction.
- **Transfer:** custom market settlement uses Bubblegum `transferV2` under the configured permanent transfer delegate. The buyer receives the leaf; the indexer waits for DAS convergence before marking ownership final.
- **Market:** the old one-transaction Core unfreeze + transfer flow is removed. Settlement becomes a two-phase state machine: reserve payment, perform Bubblegum transfer, then finalize only after the new owner/proof is observed. Expired or failed transfers are refundable by an explicit timeout policy.
- **Staking:** stake and unstake each submit their own leaf mutation; reward accounting never trusts a stale owner supplied by the client.
- **Fusion:** material proofs are fetched immediately before burn. A failed or stale proof aborts without consuming the material. Results are minted through the same register pipeline. Multiple-tree fusion is supported only after the proof/CU benchmark passes.
- **Arena:** squad membership is validated from cNFT leaf proofs and `ChipState`; a client cannot substitute an asset id for an owned leaf.
- **Burn:** all burns are explicit Bubblegum V2 burns and the projection waits for the DAS state transition before deleting ownership data.

## Backend and client

`backend/src/das.ts` is the only DAS transport surface. It must:

- issue `getAsset` and `getAssetProof` through the configured provider;
- validate owner, delegate, tree, root, hashes, leaf id, proof length, and base58 byte lengths;
- reject uncompressed responses and require the V2-only collection/asset-data hashes and exact flags byte;
- ensure the asset tree matches the proof tree;
- return normalized proof inputs to transaction builders;
- expose provider latency/errors without treating an unavailable indexer as “asset not owned”.

The client and backend transaction builders will use the same normalized proof schema. Account decoders will remove `decodeCoreAssetHeader`; Core fixtures and `mpl_core.so` are removed from the cNFT test path. The UI displays DAS content but never uses display JSON as an authority decision.

## Release gates

The migration is not complete until all of these are checked:

- Bubblegum V2 crate and IDL compile with the workspace toolchain;
- one localnet tree fixture and one collection fixture reproduce V2 mint/transfer/freeze/thaw/burn;
- adversarial tests reject foreign trees, foreign collections, stale roots, mismatched leaf indices/nonces/hashes, wrong owners/delegates, reused registration claims, forged DAS JSON, and proof truncation;
- market payment cannot be permanently captured by a failed or delayed transfer;
- fusion, staking, and arena use current proof data and cannot bypass frozen/listed/soulbound flags;
- DAS outage and reorg/reconciliation behavior is documented and tested;
- transaction-size/CU/rent benchmark is recorded for each tree topology;
- client decoder, backend projection, localnet fixtures, and devnet smoke test all use V2;
- security tests pass, oracle/randomness evidence is refreshed, and the external Solana/Metaplex audit is complete.

Until then, the previous Core implementation is not silently considered migrated, and the production gate remains red.

## Async pack settlement and recovery

A compressed pack is not settled in the `open_compressed_pack` transaction. The
handler creates one `CompressedMintClaim` per rolled chip and binds all claims
to `CompressedPackSettlement`. Bubblegum minting and DAS proof registration are
permissionless follow-up operations. `finalize_compressed_pack` may close the
purchase only when `registered_claims + cancelled_claims == total_claims`.

An unminted claim can be cancelled by the buyer after its claim deadline. A
minted claim is never refundable: its registration remains retryable after the
DAS SLA so the application cannot refund a buyer who already owns a compressed
leaf. Mixed outcomes settle pro-rata by claim count: the registered share keeps
normal revenue and `$CG` burn economics, while the cancelled share is refunded.
This is intentionally custom settlement behavior, not a claim of compatibility
with external marketplace transfer/trade flows.

The backend now stores `compressed_settlements` and `compressed_claims` as
rebuildable projections. They track claim-created, mint, registration,
cancellation, and final-settlement events without treating DAS display data as
authority.

Operational requirements before release:

- monitor claims nearing expiry and submit cancellation/finalization transactions;
- retry proof registration for minted claims after indexer delays;
- test SOL, USDC, SKR, and `$CG` refund paths, including mixed registered /
  cancelled claims;
- verify counters, liability release, account closure, and duplicate-cancel
  resistance on localnet.
