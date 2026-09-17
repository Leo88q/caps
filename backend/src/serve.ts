import { API_HOST, API_PORT, DB_PATH, RPC_URL } from './config.ts';
import { db } from './db.ts';
import { createApp } from './server.ts';

const app = createApp(db());
app.listen(API_PORT, API_HOST, () => {
  console.log(`[api] listening on http://${API_HOST}:${API_PORT}/v1  (db ${DB_PATH}, rpc ${RPC_URL})`);
});
