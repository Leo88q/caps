import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, EventParser, type Idl } from '@coral-xyz/anchor';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same IDL the client uses — copy target/idl/chip_game.json here (or
// point this at the client's copy) after `anchor build`. Not committed
// for the same reason client/src/lib/chip_game.idl.json isn't: it's
// generated, not hand-written.
const idlPath = path.join(__dirname, '..', 'chip_game.idl.json');

export function loadIdl(): Idl {
  return JSON.parse(readFileSync(idlPath, 'utf-8'));
}

export const PROGRAM_ID = new PublicKey('ChpGame1111111111111111111111111111111111');

export const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

export function getConnection() {
  return new Connection(RPC_URL, 'confirmed');
}

export function getEventParser() {
  const idl = loadIdl();
  const coder = new BorshCoder(idl);
  return new EventParser(PROGRAM_ID, coder);
}
