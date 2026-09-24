"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DasClient = exports.DasError = exports.DAS_MAX_PROOF_DEPTH = exports.DAS_GET_ASSETS_BY_OWNER = exports.DAS_GET_ASSET_PROOF = exports.DAS_GET_ASSET = void 0;
exports.normalizeDasAsset = normalizeDasAsset;
exports.normalizeDasProof = normalizeDasProof;
exports.normalizeDasAssetSummary = normalizeDasAssetSummary;
/**
 * Minimal Metaplex DAS client for the browser (web3.js 1.x exposes no DAS
 * methods). Mirrors `backend/src/das.ts` normalization byte-for-byte; the only
 * difference is the output shape — `BubblegumProof` from `./bubblegum` instead
 * of the backend's `DasAssetWithProof`.
 *
 * DAS is an index, not an authority. This module never treats a missing, stale,
 * uncompressed, or malformed response as "not owned"; it throws a typed error
 * so the UI can retry or leave the on-chain state pending.
 */
const web3_js_1 = require("@solana/web3.js");
exports.DAS_GET_ASSET = 'getAsset';
exports.DAS_GET_ASSET_PROOF = 'getAssetProof';
exports.DAS_GET_ASSETS_BY_OWNER = 'getAssetsByOwner';
exports.DAS_MAX_PROOF_DEPTH = 30;
class DasError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'DasError';
        this.code = code;
    }
}
exports.DasError = DasError;
function fail(code, message) {
    throw new DasError(code, message);
}
function pk(value, label) {
    if (typeof value !== 'string' || value.length === 0)
        fail('schema', `${label} must be a base58 public key`);
    try {
        return new web3_js_1.PublicKey(value);
    }
    catch {
        fail('schema', `${label} is not a valid public key`);
    }
}
function hash32(value, label) {
    // PublicKey is deliberately used only as a strict base58/32-byte decoder; hashes
    // are not addresses and are never compared by PublicKey semantics.
    const p = pk(value, label);
    return Uint8Array.from(p.toBytes());
}
function integer(value, label) {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '')
        fail('schema', `${label} must be an integer`);
    if (typeof value === 'number' && !Number.isSafeInteger(value))
        fail('schema', `${label} must be a safe integer when encoded as a number`);
    try {
        const n = BigInt(value);
        if (n < 0n)
            fail('schema', `${label} must be non-negative`);
        return n;
    }
    catch {
        fail('schema', `${label} must be an integer`);
    }
}
function requiredHash(value, label) {
    if (value == null)
        fail('schema', `${label} is required for Bubblegum V2 leaf reconstruction`);
    return hash32(value, label);
}
function byte(value, label) {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '')
        fail('schema', `${label} must be an integer byte`);
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 255)
        fail('schema', `${label} must be an integer in 0..255`);
    return n;
}
function normalizeDasAsset(raw) {
    if (!raw || typeof raw !== 'object')
        fail('schema', 'DAS getAsset result must be an object');
    const a = raw;
    const c = a.compression;
    if (!c || c.compressed !== true)
        fail('unsupported', 'asset is not a compressed Bubblegum asset');
    const ownership = a.ownership;
    if (!ownership)
        fail('schema', 'DAS asset is missing ownership');
    const owner = pk(ownership.owner, 'ownership.owner');
    return {
        assetId: pk(a.id, 'asset.id'),
        owner,
        delegate: ownership.delegate == null ? owner : pk(ownership.delegate, 'ownership.delegate'),
        merkleTree: pk(c.tree, 'compression.tree'),
        leafId: integer(c.leaf_id, 'compression.leaf_id'),
        dataHash: hash32(c.data_hash, 'compression.data_hash'),
        creatorHash: hash32(c.creator_hash, 'compression.creator_hash'),
        collectionHash: requiredHash(c.collection_hash, 'compression.collection_hash'),
        assetDataHash: requiredHash(c.asset_data_hash, 'compression.asset_data_hash'),
        flags: byte(c.flags, 'compression.flags'),
    };
}
function normalizeDasProof(raw) {
    if (!raw || typeof raw !== 'object')
        fail('schema', 'DAS getAssetProof result must be an object');
    const p = raw;
    const proof = p.proof;
    // A fully-canopied tree legitimately returns no remote proof nodes. The
    // compression program fills the path from the canopy; zero is therefore a
    // valid proof length, not an absent proof.
    if (!Array.isArray(proof) || proof.length > exports.DAS_MAX_PROOF_DEPTH) {
        fail('schema', `DAS proof length must be 0..${exports.DAS_MAX_PROOF_DEPTH}`);
    }
    const treeId = pk(p.tree_id, 'proof.tree_id');
    const root = hash32(p.root, 'proof.root');
    const nodeIndex = integer(p.node_index, 'proof.node_index');
    if (nodeIndex < 1n)
        fail('schema', 'proof.node_index must be positive');
    const base = 1n << BigInt(proof.length);
    const proofLeafIndex = nodeIndex >= base ? nodeIndex - base : undefined;
    const proofAccounts = proof.map((node, i) => pk(node, `proof.proof[${i}]`));
    const leafId = p.leaf_id == null ? undefined : integer(p.leaf_id, 'proof.leaf_id');
    const leafIndex = leafId ?? proofLeafIndex;
    if (leafIndex == null)
        fail('schema', 'proof.leaf_id is required for a canopy-truncated proof');
    if (leafId != null && proofLeafIndex != null && proof.length > 0 && leafId !== proofLeafIndex) {
        const exactNodeIndex = base + leafId;
        if (nodeIndex < (base << 1n) && nodeIndex !== exactNodeIndex)
            fail('mismatch', 'proof.leaf_id does not match node_index');
    }
    return { root, treeId, leafIndex, proof: proofAccounts };
}
function normalizeDasAssetSummary(raw) {
    if (!raw || typeof raw !== 'object')
        fail('schema', 'DAS asset item must be an object');
    const a = raw;
    const assetId = pk(a.id, 'asset.id');
    const grouping = Array.isArray(a.grouping) ? a.grouping : [];
    const col = grouping.find((g) => g?.group_key === 'collection')?.group_value;
    let collection;
    if (typeof col === 'string' && col.length > 0) {
        try {
            collection = new web3_js_1.PublicKey(col);
        }
        catch {
            collection = undefined;
        }
    }
    const content = a.content;
    const name = typeof content?.metadata?.name === 'string' ? content.metadata.name : undefined;
    return { assetId, collection, name, compressed: a.compression?.compressed === true };
}
class DasClient {
    endpoint;
    timeoutMs;
    fetchImpl;
    nextId = 1;
    constructor(options) {
        if (!options.endpoint)
            throw new DasError('transport', 'DAS endpoint is empty');
        this.endpoint = options.endpoint;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    async rpc(method, params) {
        const id = this.nextId++;
        let response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (e) {
            throw new DasError('transport', `DAS ${method} request failed: ${e.message}`);
        }
        if (!response.ok)
            throw new DasError('transport', `DAS ${method} returned HTTP ${response.status}`);
        let body;
        try {
            body = await response.json();
        }
        catch {
            throw new DasError('rpc', `DAS ${method} returned invalid JSON`);
        }
        if (body.error)
            throw new DasError('rpc', `DAS ${method} RPC error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown error'}`.trim());
        if (body.result === undefined)
            throw new DasError('rpc', `DAS ${method} response has no result`);
        return body.result;
    }
    async getAssetWithProof(assetId) {
        const id = typeof assetId === 'string' ? pk(assetId, 'assetId') : assetId;
        const [assetRaw, proofRaw] = await Promise.all([
            this.rpc(exports.DAS_GET_ASSET, [id.toBase58(), { showFungible: false, showInscription: false }]),
            this.rpc(exports.DAS_GET_ASSET_PROOF, [id.toBase58()]),
        ]);
        const asset = normalizeDasAsset(assetRaw);
        const proof = normalizeDasProof(proofRaw);
        if (!asset.merkleTree.equals(proof.treeId))
            fail('mismatch', 'asset tree does not match proof tree');
        if (asset.leafId !== proof.leafIndex)
            fail('mismatch', 'asset leaf_id does not match proof leaf index');
        if (!asset.assetId.equals(id))
            fail('mismatch', 'DAS returned a different asset id than requested');
        return {
            assetId: asset.assetId, leafOwner: asset.owner, leafDelegate: asset.delegate, merkleTree: asset.merkleTree,
            root: proof.root, dataHash: asset.dataHash, creatorHash: asset.creatorHash, collectionHash: asset.collectionHash,
            assetDataHash: asset.assetDataHash, flags: asset.flags, leafNonce: asset.leafId, leafIndex: asset.leafId, proof: proof.proof,
        };
    }
    async getAssetsByOwner(owner, page = 1, limit = 1000) {
        const id = typeof owner === 'string' ? pk(owner, 'owner') : owner;
        const res = await this.rpc(exports.DAS_GET_ASSETS_BY_OWNER, [
            id.toBase58(),
            { sortBy: { sortBy: 'created', sortDirection: 'desc' }, limit, page, options: { showUnverifiedCollections: true, showCollectionMetadata: false } },
        ]);
        const items = Array.isArray(res.items) ? res.items.map(normalizeDasAssetSummary) : [];
        return { total: Number(res.total ?? items.length), items };
    }
    /**
     * Resolve the Bubblegum leaf of a freshly minted claim by its unique name
     * (`{symbol} #{game_index}`) and return a `BubblegumProof` for it. `leafNonce`
     * is seeded with the fresh-mint `nonce == leaf_index` invariant — callers
     * must run `discoverLeafNonce` before signing a register transaction.
     * Matching is transport only: `register_compressed_chip` re-verifies
     * collection, owner and the live Merkle proof on chain.
     */
    async resolveClaimAsset(owner, coreCollection, expectedName, opts = {}) {
        const tries = opts.tries ?? 12;
        const delayMs = opts.delayMs ?? 2500;
        const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        let lastTotal = 0;
        for (let attempt = 0; attempt < tries; attempt++) {
            if (attempt > 0)
                await sleep(delayMs);
            const page = await this.getAssetsByOwner(owner);
            lastTotal = page.total;
            const hit = page.items.find((a) => a.compressed && a.name === expectedName && a.collection?.equals(coreCollection));
            if (hit)
                return this.getAssetWithProof(hit.assetId);
        }
        throw new DasError('transport', `DAS did not index ${expectedName} for this owner within ${(tries * delayMs) / 1000}s (owner holds ${lastTotal} assets)`);
    }
}
exports.DasClient = DasClient;
