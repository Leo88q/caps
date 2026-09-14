//! Cross-language golden test: the TS economy package writes
//! packages/economy/golden/pack_expand.json; this test replays every vector
//! through the on-chain `expand` and asserts identical output.
//! Run with `cargo test -p chip_core --test golden` (host, no BPF).

use chip_core::economy::{effective_odds, expand, uniform_bps, DEFAULT_PACKS};

fn parse_int_array(s: &str) -> Vec<i64> {
    s.trim_matches(|c| c == '[' || c == ']').split(',').filter(|t| !t.trim().is_empty()).map(|t| t.trim().parse().unwrap()).collect()
}

/// Extract `"key":[ ... ]` (flat) or `"key":[[..],[..]]` (nested) as raw text after a given offset.
fn field<'a>(obj: &'a str, key: &str) -> &'a str {
    let k = format!("\"{key}\":");
    let start = obj.find(&k).unwrap() + k.len();
    let rest = &obj[start..];
    if rest.starts_with('[') {
        let mut depth = 0;
        for (i, c) in rest.char_indices() {
            match c { '[' => depth += 1, ']' => { depth -= 1; if depth == 0 { return &rest[..=i]; } } _ => {} }
        }
        unreachable!()
    } else {
        let end = rest.find(|c| c == ',' || c == '}').unwrap();
        &rest[..end]
    }
}

#[test]
fn ts_and_rust_expand_agree() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/economy/golden/pack_expand.json");
    let json = std::fs::read_to_string(path).expect("run `npm run golden` in packages/economy first");
    let body = &json[json.find("\"vectors\":[").unwrap() + 10..];
    // split top-level objects
    let mut objs = Vec::new();
    let mut depth = 0; let mut start = 0;
    for (i, c) in body.char_indices() {
        match c { '{' => { if depth == 0 { start = i; } depth += 1; } '}' => { depth -= 1; if depth == 0 { objs.push(&body[start..=i]); } } _ => {} }
    }
    assert!(objs.len() >= 32, "expected ≥32 vectors, got {}", objs.len());

    for (n, o) in objs.iter().enumerate() {
        let sku: usize = field(o, "sku").trim().parse().unwrap();
        let pity: u16 = field(o, "pity").trim().parse().unwrap();
        let pool_n: u8 = field(o, "pool").trim().parse().unwrap();
        let vrf: Vec<u8> = parse_int_array(field(o, "vrf")).into_iter().map(|v| v as u8).collect();
        let mut bytes = [0u8; 32]; bytes.copy_from_slice(&vrf);
        let uniform = parse_int_array(field(o, "uniform"));
        let odds = parse_int_array(field(o, "odds"));
        let out_raw = field(o, "out");
        let pairs: Vec<Vec<i64>> = out_raw.trim_matches(|c| c == '[' || c == ']').split("],[").map(parse_int_array).collect();

        let def = &DEFAULT_PACKS[sku];
        for s in 0..5 { assert_eq!(uniform_bps(&bytes, s) as i64, uniform[s], "vector {n} uniform slot {s}"); }
        let eo = effective_odds(def, pity);
        assert_eq!(eo.iter().map(|&b| b as i64).collect::<Vec<_>>(), odds, "vector {n} odds");
        let pool: Vec<u8> = (0..pool_n).collect();
        let got = expand(&bytes, def, pity, &pool);
        for (i, p) in pairs.iter().enumerate() {
            let r = got[i].unwrap();
            assert_eq!(r.rarity.index() as i64, p[0], "vector {n} slot {i} rarity");
            assert_eq!(r.collection_idx as i64, p[1], "vector {n} slot {i} collection");
        }
        assert!(got[pairs.len()..].iter().all(|x| x.is_none()), "vector {n} extra slots");
    }
}
