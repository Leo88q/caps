import { getConnection, getEventParser, PROGRAM_ID } from './anchorSetup.js';
import { insertEvent } from './db.js';

// Real-time half of the indexer. Subscribes to the program's logs over the
// RPC websocket and decodes any Anchor events found in each transaction as
// it confirms. This only sees activity from the moment it starts — run
// `npm run backfill` first (or alongside) to pick up everything that
// happened before this process was listening.

async function main() {
  const connection = getConnection();
  const parser = getEventParser();

  console.log('Subscribing to program logs for', PROGRAM_ID.toBase58(), 'on', connection.rpcEndpoint);

  connection.onLogs(
    PROGRAM_ID,
    (logInfo, ctx) => {
      if (logInfo.err) return; // skip failed transactions — nothing to trust there
      const events = [...parser.parseLogs(logInfo.logs)];
      events.forEach((event, i) => {
        insertEvent({
          signature: logInfo.signature,
          event_index: i,
          slot: ctx.slot,
          block_time: null, // onLogs doesn't carry blockTime; backfill fills this in for historical rows
          event_name: event.name,
          data: JSON.stringify(event.data, (_key, value) =>
            typeof value === 'object' && value?.toBase58 ? value.toBase58() : value,
          ),
        });
        console.log(`[live] ${event.name}`, event.data);
      });
    },
    'confirmed',
  );

  // Keep the process alive — onLogs subscription runs for the lifetime of
  // this connection.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Listener crashed:', err);
  process.exit(1);
});
