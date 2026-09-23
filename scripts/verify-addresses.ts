// Operator script: Verify Gutter Caps on-chain addresses via Solana RPC
// Run by operator with network access:
//   npx tsx scripts/verify-addresses.ts --cluster devnet
//   npx tsx scripts/verify-addresses.ts --cluster mainnet-beta
import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

interface AddressEntry {
  id: string;
  label: string;
  expectedExecutable?: boolean;
}

const ADDRESSES_TO_VERIFY: Record<string, AddressEntry> = {
  GUTTERCAPS_CORE_PROGRAM_ID: {
    id: 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q',
    label: 'chip_core program',
    expectedExecutable: true,
  },
  GUTTERCAPS_MARKET_PROGRAM_ID: {
    id: 'GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz',
    label: 'market program',
    expectedExecutable: true,
  },
  GUTTERCAPS_STAKING_PROGRAM_ID: {
    id: 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA',
    label: 'staking program',
    expectedExecutable: true,
  },
  GUTTERCAPS_ARENA_PROGRAM_ID: {
    id: 'GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM',
    label: 'arena program',
    expectedExecutable: true,
  },
  TREASURY_PUBKEY: {
    id: '11111111111111111111111111111111',
    label: 'Squads Treasury Vault',
    expectedExecutable: false,
  },
  BUYBACK_PUBKEY: {
    id: '11111111111111111111111111111111',
    label: 'Buyback Wallet',
    expectedExecutable: false,
  },
  MERKLE_TREE: {
    id: 'Tree111111111111111111111111111111111111111',
    label: 'Bubblegum cNFT Merkle Tree',
    expectedExecutable: false,
  },
  CG_MINT: {
    id: '11111111111111111111111111111111',
    label: '$CG Mint Account',
    expectedExecutable: false,
  },
};

export async function verifyAll(rpcUrl: string) {
  console.log(`[verify-addresses] Connecting to RPC: ${rpcUrl}`);
  const connection = new Connection(rpcUrl, 'confirmed');

  const results: Record<string, { id: string; label: string; verified: boolean; executable?: boolean; status: string; lamports?: number }> = {};
  let allVerified = true;

  for (const [key, entry] of Object.entries(ADDRESSES_TO_VERIFY)) {
    try {
      const pubkey = new PublicKey(entry.id);
      const info = await connection.getAccountInfo(pubkey);

      if (!info) {
        results[key] = {
          id: entry.id,
          label: entry.label,
          verified: false,
          status: 'placeholder',
        };
        allVerified = false;
        console.log(`  [-] ${key} (${entry.id}): NOT FOUND on-chain (marked as placeholder)`);
      } else {
        const isExec = info.executable;
        const matchesExec = entry.expectedExecutable === undefined || entry.expectedExecutable === isExec;
        results[key] = {
          id: entry.id,
          label: entry.label,
          verified: matchesExec,
          executable: isExec,
          lamports: info.lamports,
          status: matchesExec ? 'verified' : 'unverified_executable_mismatch',
        };
        if (!matchesExec) allVerified = false;
        console.log(`  [+] ${key} (${entry.id}): FOUND (executable: ${isExec}, lamports: ${info.lamports})`);
      }
    } catch (err: any) {
      results[key] = {
        id: entry.id,
        label: entry.label,
        verified: false,
        status: `error: ${err.message}`,
      };
      allVerified = false;
      console.log(`  [!] ${key} (${entry.id}): ERROR ${err.message}`);
    }
  }

  const passportStatus = {
    gameId: 'guttercaps',
    dataQuality: allVerified ? 'complete' : 'partial',
    verifiedAt: new Date().toISOString(),
    rpc: rpcUrl,
    addresses: results,
  };

  const outPath = path.resolve(process.cwd(), 'reports/address-verification.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(passportStatus, null, 2));
  console.log(`[verify-addresses] Verification output saved to ${outPath}`);
  console.log(`[verify-addresses] Overall status: data_quality = ${passportStatus.dataQuality}`);

  return passportStatus;
}

if (process.argv[1] && process.argv[1].endsWith('verify-addresses.ts')) {
  const cluster = process.argv.includes('--cluster') ? process.argv[process.argv.indexOf('--cluster') + 1] : 'devnet';
  const rpc = process.env.SOLANA_RPC_URL || (cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
  verifyAll(rpc).catch((e) => {
    console.error('Execution failed:', e);
    process.exit(1);
  });
}
