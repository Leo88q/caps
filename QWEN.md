# guttercaps — Game Repo
gameId: guttercaps
Watchtower: Games-watchtower adapter knows guttercaps
Program ID: solana-keygen new -o target/deploy/guttercaps-keypair.json && solana address -k target/deploy/guttercaps-keypair.json
Paths: programs/guttercaps/src/lib.rs or programs/guttercaps-quests/
Audit: sentio scan ./programs --fail-on high
Fix: SW001 Signer, SW013 PDA has_one, SW016 init not init_if_needed, SW024 checked_div, SW025 map_err, SW022 close=owner
ENV: ANCHOR_PROVIDER_URL devnet, ANCHOR_WALLET ~/.config/solana/id.json
