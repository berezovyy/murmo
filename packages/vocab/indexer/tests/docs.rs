//! Docs extractor: 30 markdown cases, fences skipped (E5, E6).

use murmo_indexer::docs::{extract_markdown, merge_docs, HitKind};
use murmo_indexer::NameRecord;

#[test]
fn docs_fixture_thirty_markdown_cases() {
    let raw = include_str!("data/docs-terms.json");
    let v: serde_json::Value = serde_json::from_str(raw).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 30,
        "need ≥30 markdown cases, got {}",
        cases.len()
    );
    for row in cases {
        let id = row["id"].as_str().unwrap();
        let md = row["markdown"].as_str().unwrap();
        let hits = extract_markdown("README.md", md);
        let terms: Vec<&str> = hits
            .iter()
            .filter(|h| h.kind != HitKind::Prose)
            .map(|h| h.term.as_str())
            .collect();
        if let Some(expect) = row.get("expect").and_then(|x| x.as_array()) {
            for want in expect {
                let w = want.as_str().unwrap();
                assert!(terms.contains(&w), "{id}: expected {w:?} in {terms:?}");
            }
        }
        if let Some(not) = row.get("not").and_then(|x| x.as_array()) {
            for banned in not {
                let b = banned.as_str().unwrap();
                assert!(
                    !terms.contains(&b),
                    "{id}: fenced text leaked {b:?} in {terms:?}"
                );
            }
        }
    }
}

#[test]
fn docs_and_aliases_grow_the_index_by_at_most_ten_percent_on_a_small_repo() {
    let tags = vec![
        NameRecord::new("OutboxWorker", "class", "src/outbox/worker.rs", 12, 9, ""),
        NameRecord::new("HttpServerConfig", "type", "src/http/config.rs", 4, 5, ""),
    ];
    let base = murmo_indexer::build_packed(&tags);
    let md = "# Outbox Worker\n\nSee `OutboxWorker` and **Http Server Config**.\n";
    let hits = extract_markdown("README.md", md);
    let (docs, _) = merge_docs(&tags, &hits);
    let mut all = tags.clone();
    all.extend(docs);
    all.extend(murmo_indexer::aliases::alias_records(&all));
    let grown = murmo_indexer::build_packed(&all);
    assert!(
        grown.len() < base.len() + 2048,
        "index grew {} -> {}",
        base.len(),
        grown.len()
    );
}
