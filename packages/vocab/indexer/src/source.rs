//! Source bits on a names-v1 record. Higher-ranked sources win kind/location.

/// User vocabulary (`[words] protect`).
pub const SOURCE_USER: u8 = 1;
/// Manifests and path stems.
pub const SOURCE_MANIFEST: u8 = 2;
/// Tree-sitter tags and the regex fallback.
pub const SOURCE_TAGS: u8 = 4;
/// Opt-in LSP workspace/document symbols.
pub const SOURCE_LSP: u8 = 8;
/// README / docs / CLAUDE.md / AGENTS.md terms.
pub const SOURCE_DOCS: u8 = 16;

/// Lower is better: user > manifest > tags > lsp > docs.
pub fn source_rank(bits: u8) -> u8 {
    if bits & SOURCE_USER != 0 {
        0
    } else if bits & SOURCE_MANIFEST != 0 {
        1
    } else if bits & SOURCE_TAGS != 0 {
        2
    } else if bits & SOURCE_LSP != 0 {
        3
    } else if bits & SOURCE_DOCS != 0 {
        4
    } else {
        5
    }
}

/// Menu label when the winning source is not tags (`from docs`, `from LSP`).
pub fn source_label(bits: u8) -> &'static str {
    match source_rank(bits) {
        3 => "LSP",
        4 => "docs",
        _ => "",
    }
}
