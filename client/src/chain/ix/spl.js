"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAtaIdempotentIx = createAtaIdempotentIx;
// SPL helpers we need in the same transaction as program instructions.
const web3_js_1 = require("@solana/web3.js");
const ids_1 = require("../ids");
const pdas_1 = require("../pdas");
/** `CreateIdempotent` (instruction 1) — safe to include even if the ATA exists. */
function createAtaIdempotentIx(payer, owner, mint) {
    return new web3_js_1.TransactionInstruction({
        programId: ids_1.ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: (0, pdas_1.ata)(mint, owner), isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: ids_1.SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ids_1.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
    });
}
