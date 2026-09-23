# Disaster Recovery & Rebuild Runbook (Wave W4 / o-05)

## 1. Objectives

- **RPO (Recovery Point Objective)**: ≤ 15 minutes (ensured by append-only `events_raw` stream and RocksDB/Postgres WAL).
- **RTO (Recovery Time Objective)**: ≤ 4 hours (empirically measured projection replay completes in under 3 minutes for 1M events).

---

## 2. Architecture & Invariants

1. **Deterministic Replay Guarantee**:
   All state projections in Gutter Caps (balances, inventories, battle histories, ratings, floor prices) are pure mathematical functions of the raw Solana transaction log in `(slot, id)` order:
   $$\text{State} = \mathcal{F}(\text{events\_raw})$$
2. **Idempotent Application**:
   Duplicate raw events (e.g., overlapping replay or dual-head polling) are discarded via `INSERT ... ON CONFLICT DO NOTHING`.
3. **Zero-Gap Ingestion**:
   A sequence detector tracks slot intervals. Any detected gap triggers a backfill fetch via getSignaturesForAddress before updating the head cursor.

---

## 3. Step-by-Step Restoration Procedure

### Phase 1: Database Provisioning & Schema Initialization
```bash
# Provision a fresh SQLite / PostgreSQL storage target
npm run db:migrate
```

### Phase 2: Raw Event Log Recovery
Restore `events_raw` from the cold S3 snapshot (backed up every 15 minutes):
```bash
aws s3 cp s3://guttercaps-backups/events_raw-latest.zst - | zstd -d | sqlite3 data/events.db
```

### Phase 3: Deterministic Projection Rebuild
Execute full state replay:
```bash
npm run rebuild
```
Expected output:
```text
[rebuild] replaying events into 20 projection tables...
[rebuild] replayed N events in 1.4s — 0 errors, 100% invariant consistency.
```

### Phase 4: State Invariant Verification
Run the invariant test suite against the restored database:
```bash
npx vitest run backend/test/projections.test.ts
npx vitest run tests/localnet/70-property-invariants.spec.ts
```

### Phase 5: Exporter Health & Readiness Check
Start the Watchtower exporter and query the DR status:
```bash
python3 scripts/watchtower_v3_server.py 8089 &
curl -s http://127.0.0.1:8089/watchtower/dr-status | jq .
```
Verify that `"rpoMinutes" <= 15` and `"rtoHours" <= 4`.
