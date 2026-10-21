//! A pass-through child receives the exact 1,061-byte probe (UTF-8, CSI-u,
//! mouse, paste). Catches lost or reordered input (E18).

use murmo_codex::decoder::{fidelity_probe, Parser};

#[test]
fn parser_round_trips_the_1061_byte_probe() {
    let probe = fidelity_probe();
    assert_eq!(probe.len(), 1061);
    let mut p = Parser::new();
    let mut out = Vec::new();
    for chunk in probe.chunks(7) {
        p.push(chunk);
        for ev in p.drain(false) {
            out.extend_from_slice(&ev.raw);
        }
    }
    for ev in p.drain(true) {
        out.extend_from_slice(&ev.raw);
    }
    assert_eq!(out, probe);
}
