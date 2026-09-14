// Creating and funding a Switchboard VRF account is a one-time setup step
// per pack purchase — it has to exist and be funded with enough wSOL to pay
// oracle fees *before* the on-chain buy_pack instruction can request
// randomness against it. This wraps the official Switchboard JS SDK; see
// https://docs.switchboard.xyz/product-documentation/vrf for the queue
// address, escrow funding amount, and callback account layout on your
// target cluster (devnet vs mainnet queues differ).
//
// This file is intentionally left as a thin, documented stub rather than a
// finished implementation: Switchboard's queue addresses and minimum escrow
// amounts change over time and should be pulled from their current docs
// at integration time, not hardcoded here.

import type { Connection, Keypair, PublicKey } from '@solana/web3.js';

export interface VrfAccounts {
  vrf: PublicKey;
  oracleQueue: PublicKey;
  queueAuthority: PublicKey;
  dataBuffer: PublicKey;
  permission: PublicKey;
  escrow: PublicKey;
  programState: PublicKey;
  switchboardProgram: PublicKey;
}

export async function createVrfAccount(
  _connection: Connection,
  _payer: Keypair,
): Promise<VrfAccounts> {
  throw new Error(
    'Wire this up to @switchboard-xyz/solana.js VrfAccount.create() ' +
      'with your target queue — see docs.switchboard.xyz/product-documentation/vrf. ' +
      'Returns the account set that buy_pack in program.ts expects.',
  );
}
