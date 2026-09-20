/**
 * Metaplex DAS transport and fail-closed Bubblegum V2 proof normalization.
 *
 * DAS is an index, not an authority. This module never treats a missing, stale,
 * uncompressed, or malformed response as "not owned"; it throws a typed error
 * so callers can retry or leave the on-chain state pending.
 */
import { PublicKey } from '@solana/web3.js';

export const DAS_GET_ASSET = 'getAsset';
export const DAS_GET_ASSET_PROOF = 'getAssetProof';
export const DAS_MAX_PROOF_DEPTH = 30;

export class DasError extends Error {
  readonly code: 'transport' | 'rpc' | 'schema' | 'unsupported' | 'mismatch';
  constructor(code: DasError['code'], message: string) {
    super(message);
    this.name = 'DasError';
    this.code = code;
  }
}

export interface DasRpcError { code?: number; message?: string; data?: unknown }
export interface DasRpcResponse<T> { jsonrpc?: string; id?: number | string; result?: T; error?: DasRpcError }

export interface RawDasAsset {
  id: string;
  interface?: string;
  ownership?: { owner?: string; delegate?: string | null; frozen?: boolean };
  compression?: {
    compressed?: boolean;
    tree?: string;
    leaf_id?: number | string;
    seq?: number | string | null;
    data_hash?: string;
    creator_hash?: string;
    collection_hash?: string;
    asset_data_hash?: string;
  };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  content?: { json_uri?: string; metadata?: Record<string, unknown> };
}

export interface RawDasProof {
  root?: string;
  proof?: string[];
  node_index?: number | string;
  leaf_id?: number | string;
  tree_id?: string;
}

export interface NormalizedDasAsset {
  assetId: PublicKey;
  interface: string | undefined;
  owner: PublicKey;
  delegate: PublicKey;
  frozen: boolean;
  merkleTree: PublicKey;
  leafId: bigint;
  sequence: bigint | undefined;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  collectionHash: Uint8Array | undefined;
  assetDataHash: Uint8Array | undefined;
  jsonUri: string | undefined;
  raw: RawDasAsset;
}

export interface NormalizedDasProof {
  root: Uint8Array;
  treeId: PublicKey;
  nodeIndex: bigint;
  leafIndex: bigint;
  proof: PublicKey[];
  raw: RawDasProof;
}

export interface DasAssetWithProof {
  asset: NormalizedDasAsset;
  proof: NormalizedDasProof;
  /** Remaining accounts for Bubblegum leaf-replacing instructions. */
  proofAccounts: PublicKey[];
}

function fail(code: DasError['code'], message: string): never {
  throw new DasError(code, message);
}

function pk(value: unknown, label: string): PublicKey {
  if (typeof value !== 'string' || value.length === 0) fail('schema', `${label} must be a base58 public key`);
  try { return new PublicKey(value); } catch { fail('schema', `${label} is not a valid public key`); }
}

function hash32(value: unknown, label: string): Uint8Array {
  // PublicKey is deliberately used only as a strict base58/32-byte decoder; hashes
  // are not addresses and are never compared by PublicKey semantics.
  const p = pk(value, label);
  return Uint8Array.from(p.toBytes());
}

function integer(value: unknown, label: string): bigint {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') fail('schema', `${label} must be an integer`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('schema', `${label} must be a safe integer when encoded as a number`);
  try {
    const n = BigInt(value);
    if (n < 0n) fail('schema', `${label} must be non-negative`);
    return n;
  } catch { fail('schema', `${label} must be an integer`); }
}

function optionalHash(value: unknown, label: string): Uint8Array | undefined {
  return value == null ? undefined : hash32(value, label);
}

export function normalizeDasAsset(raw: unknown): NormalizedDasAsset {
  if (!raw || typeof raw !== 'object') fail('schema', 'DAS getAsset result must be an object');
  const a = raw as RawDasAsset;
  const c = a.compression;
  if (!c || c.compressed !== true) fail('unsupported', 'asset is not a compressed Bubblegum asset');
  // DAS currently reports compressed Bubblegum assets as `V1_NFT` as well as
  // provider-specific compressed interfaces. `compression.compressed` is the
  // portable discriminator; V1/V2 tree compatibility is proven by the on-chain
  // Bubblegum CPI and the configured collection/tree, not by this display field.
  const ownership = a.ownership;
  if (!ownership) fail('schema', 'DAS asset is missing ownership');
  const owner = pk(ownership.owner, 'ownership.owner');
  const delegate = ownership.delegate == null ? owner : pk(ownership.delegate, 'ownership.delegate');
  const assetId = pk(a.id, 'asset.id');
  const merkleTree = pk(c.tree, 'compression.tree');
  const leafId = integer(c.leaf_id, 'compression.leaf_id');
  const dataHash = hash32(c.data_hash, 'compression.data_hash');
  const creatorHash = hash32(c.creator_hash, 'compression.creator_hash');
  return {
    assetId,
    interface: a.interface,
    owner,
    delegate,
    frozen: ownership.frozen === true,
    merkleTree,
    leafId,
    sequence: c.seq == null ? undefined : integer(c.seq, 'compression.seq'),
    dataHash,
    creatorHash,
    collectionHash: optionalHash(c.collection_hash, 'compression.collection_hash'),
    assetDataHash: optionalHash(c.asset_data_hash, 'compression.asset_data_hash'),
    jsonUri: typeof a.content?.json_uri === 'string' ? a.content.json_uri : undefined,
    raw: a,
  };
}

export function normalizeDasProof(raw: unknown): NormalizedDasProof {
  if (!raw || typeof raw !== 'object') fail('schema', 'DAS getAssetProof result must be an object');
  const p = raw as RawDasProof;
  const proof = p.proof;
  if (!Array.isArray(proof) || proof.length === 0 || proof.length > DAS_MAX_PROOF_DEPTH) {
    fail('schema', `DAS proof length must be 1..${DAS_MAX_PROOF_DEPTH}`);
  }
  const treeId = pk(p.tree_id, 'proof.tree_id');
  const root = hash32(p.root, 'proof.root');
  const nodeIndex = integer(p.node_index, 'proof.node_index');
  // Bubblegum DAS documents leaf index as node_index - 2^max_depth, where the
  // proof path gives max_depth. Do this with bigint so a malformed large number
  // cannot pass through a JS safe-integer conversion.
  const base = 1n << BigInt(proof.length);
  if (nodeIndex < base) fail('schema', 'proof.node_index is below the tree leaf base');
  const leafIndex = nodeIndex - base;
  const proofAccounts = proof.map((node, i) => pk(node, `proof.proof[${i}]`));
  const leafId = p.leaf_id == null ? undefined : integer(p.leaf_id, 'proof.leaf_id');
  if (leafId != null && leafId !== leafIndex) fail('mismatch', 'proof.leaf_id does not match node_index');
  return { root, treeId, nodeIndex, leafIndex, proof: proofAccounts, raw: p };
}

export function combineDasAssetProof(assetRaw: unknown, proofRaw: unknown): DasAssetWithProof {
  const asset = normalizeDasAsset(assetRaw);
  const proof = normalizeDasProof(proofRaw);
  if (!asset.merkleTree.equals(proof.treeId)) fail('mismatch', 'asset tree does not match proof tree');
  if (asset.leafId !== proof.leafIndex) fail('mismatch', 'asset leaf_id does not match proof leaf index');
  return { asset, proof, proofAccounts: proof.proof };
}

export interface DasClientOptions {
  endpoint: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DasClient {
  readonly endpoint: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(options: DasClientOptions) {
    if (!options.endpoint) throw new DasError('transport', 'DAS endpoint is empty');
    this.endpoint = options.endpoint;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new DasError('transport', `DAS ${method} request failed: ${(e as Error).message}`);
    }
    if (!response.ok) throw new DasError('transport', `DAS ${method} returned HTTP ${response.status}`);
    let body: DasRpcResponse<T>;
    try { body = await response.json() as DasRpcResponse<T>; } catch { throw new DasError('rpc', `DAS ${method} returned invalid JSON`); }
    if (body.error) throw new DasError('rpc', `DAS ${method} RPC error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown error'}`.trim());
    if (body.result === undefined) throw new DasError('rpc', `DAS ${method} response has no result`);
    return body.result;
  }

  async getAsset(assetId: PublicKey | string): Promise<NormalizedDasAsset> {
    const id = typeof assetId === 'string' ? pk(assetId, 'assetId') : assetId;
    const asset = normalizeDasAsset(await this.rpc<RawDasAsset>(DAS_GET_ASSET, [id.toBase58(), { showFungible: false, showInscription: false }]));
    if (!asset.assetId.equals(id)) throw new DasError('mismatch', 'DAS returned a different asset id than requested');
    return asset;
  }

  async getAssetProof(assetId: PublicKey | string): Promise<NormalizedDasProof> {
    const id = typeof assetId === 'string' ? pk(assetId, 'assetId') : assetId;
    return normalizeDasProof(await this.rpc<RawDasProof>(DAS_GET_ASSET_PROOF, [id.toBase58()]));
  }

  async getAssetWithProof(assetId: PublicKey | string): Promise<DasAssetWithProof> {
    const id = typeof assetId === 'string' ? pk(assetId, 'assetId') : assetId;
    const [assetRaw, proof] = await Promise.all([
      this.rpc<RawDasAsset>(DAS_GET_ASSET, [id.toBase58(), { showFungible: false, showInscription: false }]),
      this.rpc<RawDasProof>(DAS_GET_ASSET_PROOF, [id.toBase58()]),
    ]);
    const combined = combineDasAssetProof(assetRaw, proof);
    if (!combined.asset.assetId.equals(id)) throw new DasError('mismatch', 'DAS returned a different asset id than requested');
    return combined;
  }
}
