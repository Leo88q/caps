import { getConnection, getEventParser, PROGRAM_ID } from './anchorSetup.js';
import { insertEvent, getBackfillCursor, setBackfillCursor } from './db.js';

// Historical half of the indexer. Walks getSignaturesForAddress backward
// from the most recent transaction, stopping either at the last signature
// this script already processed (tracked in backfill_cursor) or when it
// runs out of history. Safe to re-run — insertEvent is INSERT OR IGNORE
// keyed on (signature, event_index).

const PAGE_SIZE = 1000;

async function main() {
  const connection = getConnection();
  const parser = getEventParser();
  const stopAt = getBackfillCursor();

  let before: string | undefined;
  let newestSeen: string | null = null;
  let totalEvents = 0;
  let totalTx = 0;

  console.log('Backfilling from', PROGRAM_ID.toBase58(), stopAt ? `back to ${stopAt}` : '(no prior cursor — full history)');

  while (true) {
    const signatures = await connection.getSignaturesForAddress(PROGRAM_ID, { before, limit: PAGE_SIZE });
    if (signatures.length === 0) break;

    if (!newestSeen) newestSeen = signatures[0].signature;

    for (const sigInfo of signatures) {
      if (sigInfo.signature === stopAt) {
        await finish();
        return;
      }
      if (sigInfo.err) continue;

      const tx = await connection.getTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta?.logMessages) continue;

      const events = [...parser.parseLogs(tx.meta.logMessages)];
      events.forEach((event, i) => {
        insertEvent({
          signature: sigInfo.signature,
          event_index: i,
          slot: tx.slot,
          block_time: tx.blockTime ?? null,
          event_name: event.name,
          data: JSON.stringify(event.data, (_key, value) =>
            typeof value === 'object' && value?.toBase58 ? value.toBase58() : value,
          ),
        });
        totalEvents++;
      });
      totalTx++;
    }

    before = signatures[signatures.length - 1].signature;
    if (signatures.length < PAGE_SIZE) break; // reached the start of history
  }

  await finish();

  async function finish() {
    if (newestSeen) setBackfillCursor(newestSeen);
    console.log(`Backfill complete: ${totalTx} transactions scanned, ${totalEvents} events stored.`);
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
