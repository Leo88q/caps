"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyAll = verifyAll;
// Operator script: Verify Gutter Caps on-chain addresses via Solana RPC
// Run by operator with network access:
//   npx tsx scripts/verify-addresses.ts --cluster devnet
//   npx tsx scripts/verify-addresses.ts --cluster mainnet-beta
const web3_js_1 = require("@solana/web3.js");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ADDRESSES_TO_VERIFY = {
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
async function verifyAll(rpcUrl) {
    console.log(`[verify-addresses] Connecting to RPC: ${rpcUrl}`);
    const connection = new web3_js_1.Connection(rpcUrl, 'confirmed');
    const results = {};
    let allVerified = true;
    for (const [key, entry] of Object.entries(ADDRESSES_TO_VERIFY)) {
        try {
            const pubkey = new web3_js_1.PublicKey(entry.id);
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
            }
            else {
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
                if (!matchesExec)
                    allVerified = false;
                console.log(`  [+] ${key} (${entry.id}): FOUND (executable: ${isExec}, lamports: ${info.lamports})`);
            }
        }
        catch (err) {
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
