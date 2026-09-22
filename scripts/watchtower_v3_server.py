import http.server
import socketserver
import json
import urllib.parse
from datetime import datetime, timezone
import sys
from watchtower_v3_registry import WATCHTOWER_V3_COMPONENTS

DEFAULT_PORT = 8787

class WatchtowerHandler(http.server.BaseHTTPRequestHandler):
    def send_json(self, status_code, data):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(json.dumps(data, indent=2).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # GET /api/os/config
        if path == '/api/os/config':
            return self.send_json(200, {
                "os": "Watchtower OS v3",
                "version": "3.0.0",
                "gameId": "guttercaps",
                "tenant": "guttercaps",
                "stack": "Ideal Free Stack",
                "totalComponents": len(WATCHTOWER_V3_COMPONENTS),
                "components": WATCHTOWER_V3_COMPONENTS,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "gaslessUx": True,
                "l2Router": {
                    "rule": "tps=low ux=gasless -> MagicBlock ER + Arcium privacy",
                    "target": "MagicBlock ER",
                    "privacy": "Arcium confidential privacy",
                    "storage": "Xandeum exabyte ideal free"
                }
            })

        # GET /api/l2/router?gameId=guttercaps&tps=low&ux=gasless
        if path == '/api/l2/router':
            game_id = query.get('gameId', ['guttercaps'])[0]
            tps = query.get('tps', ['low'])[0]
            ux = query.get('ux', ['gasless'])[0]
            return self.send_json(200, {
                "gameId": game_id,
                "tenant": "guttercaps",
                "requestedTps": tps,
                "requestedUx": ux,
                "selectedL2": "MagicBlock ER",
                "target": "MagicBlock ER",
                "latency": "<10ms",
                "gasless": True,
                "delegateInstruction": "executeGasless",
                "stateCommitment": "optimistic_settlement_fraud_proof",
                "magicActions": "auto_respawn_every_round",
                "settlementSequencer": "REPLA L3 Anchor settle MagicBlock sequencer",
                "privacyLayer": "Arcium confidential privacy",
                "privateState": "PST private state tree",
                "storageLayer": "Xandeum exabyte ideal free L2 privacy storage",
                "routeDecision": "MagicBlock ER + Arcium privacy",
                "status": "active"
            })

        # GET /api/sdk/...
        if path.startswith('/api/sdk/'):
            sdk_name = path[len('/api/sdk/'):]
            game_id = query.get('gameId', ['guttercaps'])[0]
            template = query.get('template', ['casual'])[0]
            
            sdk_info = {
                "godot-solana": {
                    "sdk": "godot-solana",
                    "version": "v3.0.0",
                    "bindings": ["SolanaClient", "WalletAdapter", "AnchorProgram", "SessionKeyManager"],
                    "sessionKeys": "pop-n-shoot shoot pop session key gasless UX via MagicBlock ER delegate executeGasless <10ms",
                    "identityStages": ["guest", "embedded_privy", "native_phantom", "linked_cross_game_pda"],
                    "tenant": "guttercaps",
                    "bestFree": True
                },
                "preset": {
                    "sdk": "preset",
                    "version": "v1.4.0",
                    "template": template,
                    "scaffold": "casual",
                    "purpose": "official scaffold casual best free official",
                    "tenant": "guttercaps",
                    "features": ["pop-n-shoot", "session-keys", "magicblock-er", "gasless-ux"],
                    "bestFree": True
                },
                "gamba": {
                    "sdk": "gamba",
                    "version": "v2.1.0",
                    "purpose": "cap shooting gamble, provably-fair wagering, wager NFT",
                    "minWagerCg": 5,
                    "maxWagerCg": 5000,
                    "bestFree": True
                },
                "ritarena": {
                    "sdk": "ritarena",
                    "version": "v3.0.0",
                    "purpose": "cap tournament lifecycle retry events, brackets, automated payouts",
                    "chosenOver": "aureus",
                    "bestFree": True
                },
                "xandeum": {
                    "sdk": "xandeum",
                    "version": "v1.0.0",
                    "purpose": "exabyte scalable decentralized storage, permanent replays, cap states",
                    "bestFree": True
                },
                "pst": {
                    "sdk": "pst",
                    "version": "v1.0.0",
                    "purpose": "private state tree for gasless private player state & stealth inventory",
                    "bestFree": True
                },
                "core-attributes": {
                    "sdk": "core-attributes",
                    "version": "v1.2.0",
                    "purpose": "on-chain key-value readable programs DAS 5ms best free on-chain stats (score, death rate)",
                    "bestFree": True
                },
                "access-protocol": {
                    "sdk": "access-protocol",
                    "version": "v2.0.0",
                    "purpose": "golden cap founder stake-to-access best free",
                    "bestFree": True
                },
                "idosgames-wallet": {
                    "sdk": "idosgames-wallet",
                    "version": "v2.0.0",
                    "purpose": "idosgames bridge & cross-game wallet best free",
                    "bestFree": True
                },
                "security-auditing-skill": {
                    "sdk": "security-auditing-skill",
                    "version": "v3.0.0",
                    "purpose": "systematic audit best free security skill",
                    "bestFree": True
                },
                "sentio-cli": {
                    "sdk": "sentio-cli",
                    "version": "v1.8.0",
                    "purpose": "real-time observability, event tracing, and alert triggers",
                    "bestFree": True
                },
                "solguard": {
                    "sdk": "solguard",
                    "version": "v2.0.0",
                    "purpose": "130+ Solana smart contract vulnerability detectors best free",
                    "bestFree": True
                },
                "solana-slam": {
                    "sdk": "solana-slam",
                    "version": "v1.0.0",
                    "purpose": "LiteSVM in-memory fast fuzzing and game simulation testing",
                    "bestFree": True
                },
                "arcium": {
                    "sdk": "arcium",
                    "version": "v1.0.0",
                    "purpose": "confidential smart contracts & MPC privacy",
                    "bestFree": True
                }
            }

            match = sdk_info.get(sdk_name)
            if match:
                return self.send_json(200, {
                    "gameId": game_id,
                    "sdk": match,
                    "idealFree": True,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
            else:
                return self.send_json(404, {"error": f"SDK '{sdk_name}' not found", "available": list(sdk_info.keys())})

        # GET /api/game-signals/config?gameId=guttercaps
        if path == '/api/game-signals/config':
            game_id = query.get('gameId', ['guttercaps'])[0]
            return self.send_json(200, {
                "gameId": game_id,
                "tenant": "guttercaps",
                "model": "Game Signals ML v3",
                "trainingSet": "60M+ Solana transactions across 12 games",
                "churnThreshold14d": 0.85,
                "retainedChurnSample": 0.20,
                "metrics": {
                    "retainedReplays": True,
                    "retainedPercentage": "20%",
                    "startupCrashScore": 0.002,
                    "deathRate": 0.38,
                    "leaderboardFilter": "cross-game-stats",
                    "ecsLeakStatus": {
                        "monitoredEntities": "8-12",
                        "memoryLeakFixed": True,
                        "leakRatio": "0%",
                        "previousLeakRate": "30% memory leaked 1m memref",
                        "leakResolution": "deterministic ref-counter + weakref pool in Godot/Actix ECS"
                    }
                },
                "funnel": {
                    "commonWallets": 48200,
                    "conversionRate": 0.142,
                    "predictedLtvSol": 1.85
                },
                "bestFree": True,
                "timestamp": datetime.now(timezone.utc).isoformat()
            })

        # GET /api/assets/strategy?gameId=guttercaps&itemType=common&rarity=common
        if path == '/api/assets/strategy':
            game_id = query.get('gameId', ['guttercaps'])[0]
            item_type = query.get('itemType', ['common'])[0]
            rarity = query.get('rarity', ['common'])[0]
            return self.send_json(200, {
                "gameId": game_id,
                "tenant": "guttercaps",
                "itemType": item_type,
                "rarity": rarity,
                "mintStandard": "Bubblegum v2 cNFT",
                "costPerMillionUsd": 110,
                "merkleTree": "Tree111111111111111111111111111111111111111",
                "mccVerified": True,
                "primaryMarket": "Tensor",
                "secondaryMarket": "MagicEden 120 QPM",
                "scoreTracking": "Core Attributes DAS 5ms",
                "statesStorage": "Xandeum exabyte scalable best free",
                "gambleIntegration": "Gamba cap shooting gamble",
                "fightersIntegration": "Husks cap fighters",
                "tournamentIntegration": "RitArena cap tournament lifecycle retry events",
                "bestFree": True,
                "timestamp": datetime.now(timezone.utc).isoformat()
            })

        # 404 fallback
        return self.send_json(404, {"error": "Endpoint not found", "path": path})

class DualServer:
    def __init__(self, ports):
        self.ports = ports
        self.servers = []

    def run(self):
        socketserver.TCPServer.allow_reuse_address = True
        import threading
        threads = []
        for p in self.ports:
            try:
                srv = socketserver.TCPServer(("0.0.0.0", p), WatchtowerHandler)
                self.servers.append(srv)
                t = threading.Thread(target=srv.serve_forever, daemon=True)
                t.start()
                threads.append(t)
                print(f"[Watchtower OS v3] Listening on port {p} (0.0.0.0:{p})...", flush=True)
            except Exception as e:
                print(f"[Watchtower OS v3] Warning: Could not bind port {p}: {e}", file=sys.stderr)
        
        for t in threads:
            t.join()

if __name__ == '__main__':
    ports = [8787, 8089]
    if len(sys.argv) > 1:
        ports = [int(p) for p in sys.argv[1:]]
    dual = DualServer(ports)
    dual.run()
