//! Rust half of the offset parity check (docs/plan/04 task 7). For every
//! `text.offsets` case in `fixtures/text/`, the code point, UTF-8 and grapheme
//! verdicts that `@murmo/text` gives in JavaScript must equal what Rust computes
//! natively with `unicode-segmentation` 1.13.3 (Unicode 17.0), the crate the
//! Codex wrapper pins. Codex counts UTF-8 bytes, so a disagreement here is an
//! edit that lands inside a character (Espanso's byte/character bug, E5).
//!
//! `MURMO_TEXT_CORPUS` names an extra file in the same format: the conformance
//! gate (`tools/test-conformance.mjs`) writes the seeded 4,000-draft unicode
//! corpus there with the JavaScript verdicts and runs this test on it.

use std::path::{Path, PathBuf};

use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

/// Files with lone surrogates, which a Rust `String` cannot hold: they exist
/// only in JavaScript strings, and the Codex wrapper only ever sees valid UTF-8.
/// Every other file must parse.
const JS_ONLY: &[&str] = &[
    "codepoints.json",
    "display.json",
    "surrogates.json",
    "unsafe.json",
];

type Row = Vec<Option<u64>>;

/// For each UTF-16 offset of `text`: its code point index, UTF-8 byte offset
/// and grapheme index, or `None` inside a character.
fn native(text: &str) -> [Row; 3] {
    let units = text.encode_utf16().count();
    let mut code_point = vec![None; units + 1];
    let mut utf8 = vec![None; units + 1];
    let mut grapheme = vec![None; units + 1];
    // UTF-16 offset of every char boundary, keyed by byte offset.
    let mut utf16_at_byte = vec![usize::MAX; text.len() + 1];
    let mut unit = 0;
    for (index, (byte, ch)) in text.char_indices().enumerate() {
        utf16_at_byte[byte] = unit;
        code_point[unit] = Some(index as u64);
        utf8[unit] = Some(byte as u64);
        unit += ch.len_utf16();
    }
    utf16_at_byte[text.len()] = units;
    code_point[units] = Some(text.chars().count() as u64);
    utf8[units] = Some(text.len() as u64);
    let mut count = 0;
    for (index, (byte, _)) in text.grapheme_indices(true).enumerate() {
        grapheme[utf16_at_byte[byte]] = Some(index as u64);
        count = index + 1;
    }
    grapheme[units] = Some(count as u64);
    [code_point, utf8, grapheme]
}

fn row(output: &Value, field: &str, case: &str) -> Row {
    output[field]
        .as_array()
        .unwrap_or_else(|| panic!("{case}: output.{field} is not an array"))
        .iter()
        .map(Value::as_u64)
        .collect()
}

/// Checks every `text.offsets` case of one fixture file; returns how many it compared.
fn check_file(path: &Path) -> usize {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let file: Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let file_fn = file["fn"].as_str();
    let mut compared = 0;
    for case in file["cases"].as_array().into_iter().flatten() {
        if case["fn"].as_str().or(file_fn) != Some("text.offsets") {
            continue;
        }
        let id = format!("{} {}", path.display(), case["id"].as_str().unwrap_or("?"));
        let input = case["input"]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("{id}: no input.text"));
        let [code_point, utf8, grapheme] = native(input);
        assert_eq!(
            row(&case["output"], "codePoint", &id),
            code_point,
            "{id}: code points"
        );
        assert_eq!(row(&case["output"], "utf8", &id), utf8, "{id}: UTF-8 bytes");
        assert_eq!(
            row(&case["output"], "grapheme", &id),
            grapheme,
            "{id}: graphemes"
        );
        compared += 1;
    }
    compared
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/text")
}

// The fixed offset cases (ZWJ, flags, keycaps, skin tones, NFC/NFD, CJK, CRLF,
// 4-byte UTF-8, Hangul, Indic conjuncts, tag flags) get the same verdicts in
// Rust as in every JavaScript runtime.
#[test]
fn fixed_offset_cases_match_unicode_segmentation() {
    let mut compared = 0;
    for entry in std::fs::read_dir(fixture_dir()).expect("fixtures/text") {
        let path = entry.expect("entry").path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".json") || JS_ONLY.contains(&name) {
            continue;
        }
        compared += check_file(&path);
    }
    // Anti-vacuity: offsets-r7.json (10) and offsets.json (17) at least.
    assert!(
        compared >= 27,
        "only {compared} text.offsets cases compared"
    );
}

// The seeded corpus from the conformance gate: every offset of 4,000 random
// drafts, with 0 differences between JavaScript and Rust.
#[test]
fn generated_corpus_matches_unicode_segmentation() {
    let Some(path) = std::env::var_os("MURMO_TEXT_CORPUS") else {
        eprintln!("MURMO_TEXT_CORPUS not set: the conformance gate runs this with its corpus");
        return;
    };
    let path = PathBuf::from(path);
    let declared = serde_json::from_str::<Value>(&std::fs::read_to_string(&path).expect("corpus"))
        .expect("corpus JSON")["cases"]
        .as_array()
        .map_or(0, Vec::len);
    let compared = check_file(&path);
    assert!(declared > 0, "the corpus is empty");
    assert_eq!(
        compared, declared,
        "every corpus case is a text.offsets case"
    );
    println!("text parity: {compared} generated drafts agree with unicode-segmentation");
}
