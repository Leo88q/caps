import http from 'node:http';

async function postEvent(port, event) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(event);
    const req = http.request(
      `http://127.0.0.1:${port}/api/ingest/solana`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let resData = '';
        res.on('data', (c) => (resData += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(resData) });
          } catch (e) {
            resolve({ status: res.statusCode, body: resData });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  const testSig = `guttercaps-sig-${Date.now()}`;
  const event = {
    cluster: 'devnet',
    slot: 312500120,
    signature: testSig,
    programId: 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q',
    eventType: 'ChipMinted',
    commitment: 'finalized',
    payload: {
      gameId: 'guttercaps',
      playerKey: 'player_test_01',
      sku: 'standard',
      rarity: 'Rare',
    },
  };

  console.log('Sending first event (expecting accepted: true)...');
  const res1 = await postEvent(8787, event);
  console.log('Response 1:', res1.status, res1.body);
  if (!res1.body.accepted) {
    throw new Error('Event was not accepted!');
  }

  console.log('Sending duplicate event (expecting duplicate: true)...');
  const res2 = await postEvent(8787, event);
  console.log('Response 2:', res2.status, res2.body);
  if (!res2.body.duplicate) {
    throw new Error('Duplicate was not detected!');
  }

  console.log('GutterCaps Ingest Test PASSED: accepted:true, duplicate:true verified!');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
