//! Tree-sitter tag extraction (r9 extract.py). Kinds, owners, locations; never source lines.

use std::collections::HashMap;
use std::sync::OnceLock;

use tree_sitter::{Language, Node, Parser, Query, QueryCursor, StreamingIterator};

use crate::exclude::{grammar_of, is_generated_header, MAX_FILE_BYTES, MAX_NAME_CHARS};
use crate::record::NameRecord;
use crate::regex_scan::{count_identifiers, regex_names};

const Q_RUST: &str = include_str!("../queries/rust.scm");
const Q_TS: &str = include_str!("../queries/typescript.scm");
const Q_TSX: &str = include_str!("../queries/tsx.scm");
const Q_PY: &str = include_str!("../queries/python.scm");
const Q_GO: &str = include_str!("../queries/go.scm");
const Q_JS: &str = include_str!("../queries/javascript.scm");

pub fn grammar_versions() -> &'static str {
    "rust=0.24.2,typescript=0.23.2,python=0.25.0,go=0.25.0,javascript=0.25.0,tree-sitter=0.25.10"
}

struct Lang {
    language: Language,
    query: Query,
    id: &'static str,
}

fn lang(id: &'static str, language: Language, source: &str) -> Lang {
    let query = Query::new(&language, source).unwrap_or_else(|e| panic!("query {id}: {e}"));
    Lang {
        language,
        query,
        id,
    }
}

fn languages() -> &'static HashMap<&'static str, Lang> {
    static LANGS: OnceLock<HashMap<&'static str, Lang>> = OnceLock::new();
    LANGS.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert(
            "rust",
            lang("rust", tree_sitter_rust::LANGUAGE.into(), Q_RUST),
        );
        m.insert(
            "typescript",
            lang(
                "typescript",
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
                Q_TS,
            ),
        );
        m.insert(
            "tsx",
            lang("tsx", tree_sitter_typescript::LANGUAGE_TSX.into(), Q_TSX),
        );
        m.insert(
            "python",
            lang("python", tree_sitter_python::LANGUAGE.into(), Q_PY),
        );
        m.insert("go", lang("go", tree_sitter_go::LANGUAGE.into(), Q_GO));
        m.insert(
            "javascript",
            lang("javascript", tree_sitter_javascript::LANGUAGE.into(), Q_JS),
        );
        m
    })
}

fn ident_in(text: &str) -> String {
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .find(|s| !s.is_empty() && s.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_'))
        .unwrap_or("")
        .to_string()
}

fn owner_of(node: Node, lang: &str, source: &[u8]) -> String {
    let mut n = node.parent();
    while let Some(cur) = n {
        if cur.kind() == "impl_item" {
            if let Some(ty) = cur.child_by_field_name("type") {
                let text = ty.utf8_text(source).unwrap_or("");
                return ident_in(text);
            }
            return String::new();
        }
        if matches!(
            cur.kind(),
            "class_declaration"
                | "abstract_class_declaration"
                | "class_definition"
                | "interface_declaration"
                | "trait_item"
                | "internal_module"
        ) {
            if let Some(name) = cur.child_by_field_name("name") {
                return name.utf8_text(source).unwrap_or("").to_string();
            }
            return String::new();
        }
        if lang == "python" && cur.kind() == "function_definition" {
            return String::new();
        }
        n = cur.parent();
    }
    if lang == "go" && node.kind() == "method_declaration" {
        if let Some(recv) = node.child_by_field_name("receiver") {
            let text = recv.utf8_text(source).unwrap_or("");
            let names: Vec<&str> = text
                .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .filter(|s| {
                    !s.is_empty() && s.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                })
                .collect();
            return names.last().copied().unwrap_or("").to_string();
        }
    }
    String::new()
}

fn capture<'tree>(
    query: &Query,
    m: &tree_sitter::QueryMatch<'_, 'tree>,
    name: &str,
) -> Option<Node<'tree>> {
    let names = query.capture_names();
    m.captures.iter().find_map(|c| {
        names
            .get(c.index as usize)
            .copied()
            .filter(|n| *n == name)
            .map(|_| c.node)
    })
}

fn definition_kind<'tree>(
    query: &Query,
    m: &tree_sitter::QueryMatch<'_, 'tree>,
) -> Option<(String, Node<'tree>)> {
    let names = query.capture_names();
    for c in m.captures {
        if let Some(n) = names.get(c.index as usize) {
            if let Some(kind) = n.strip_prefix("definition.") {
                return Some((kind.to_string(), c.node));
            }
        }
    }
    None
}

fn scan_tree(lang: &Lang, source: &[u8], path: &str) -> Vec<NameRecord> {
    let mut parser = Parser::new();
    if parser.set_language(&lang.language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&lang.query, tree.root_node(), source);
    let mut rows = Vec::new();
    while let Some(m) = matches.next() {
        let Some((mut kind, node)) = definition_kind(&lang.query, m) else {
            continue;
        };
        let Some(nm) = capture(&lang.query, m, "name") else {
            continue;
        };
        let Ok(name) = nm.utf8_text(source) else {
            continue;
        };
        if name.contains('\n') || name.len() > MAX_NAME_CHARS {
            continue;
        }
        let own = owner_of(node, lang.id, source);
        if (lang.id == "typescript" || lang.id == "tsx" || lang.id == "javascript")
            && node.kind() == "variable_declarator"
        {
            if let Some(value) = node.child_by_field_name("value") {
                if matches!(value.kind(), "arrow_function" | "function_expression") {
                    kind = "function".into();
                }
            }
        }
        if lang.id == "go" && node.kind() == "type_spec" {
            if let Some(value) = node.child_by_field_name("type") {
                if value.kind() == "struct_type" {
                    kind = "class".into();
                }
            }
        }
        if kind == "constant" {
            if lang.id == "typescript" || lang.id == "tsx" || lang.id == "javascript" {
                let anc = node.parent();
                let ok = anc.is_some_and(|a| {
                    a.kind() == "lexical_declaration"
                        && a.utf8_text(source).unwrap_or("").starts_with("const ")
                });
                if !ok {
                    continue;
                }
            }
            if lang.id == "python" && name != name.to_ascii_uppercase() {
                continue;
            }
        }
        if kind == "function" && !own.is_empty() {
            kind = "method".into();
        }
        rows.push(NameRecord {
            name: name.to_string(),
            kind,
            file: path.to_string(),
            line: nm.start_position().row as u32 + 1,
            refs: 0,
            owner: own,
        });
    }
    rows
}

/// Scan one file. Tree-sitter when a grammar exists; regex/path fallback otherwise.
/// Returns None when the file is generated or unreadable. Never includes source text.
pub fn scan_file(path: &str, bytes: &[u8]) -> Option<(Vec<NameRecord>, HashMap<String, u32>)> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    if is_generated_header(&text) {
        return None;
    }
    let counts = count_identifiers(bytes);
    let mut rows = if let Some(g) = grammar_of(path) {
        if let Some(lang) = languages().get(g) {
            scan_tree(lang, bytes, path)
        } else {
            regex_names(path, bytes)
        }
    } else {
        regex_names(path, bytes)
    };
    for r in &mut rows {
        r.refs = counts.get(&r.name).copied().unwrap_or(0);
    }
    rows.insert(
        0,
        NameRecord {
            name: path.to_string(),
            kind: "path".into(),
            file: path.to_string(),
            line: 1,
            refs: 1,
            owner: String::new(),
        },
    );
    Some((rows, counts))
}

#[cfg(test)]
mod tests {
    use super::scan_file;

    #[test]
    fn rust_function_has_kind_and_line_not_body() {
        let src = b"pub fn drain_queue() {\n    let secret = \"API_KEY=shh\";\n}\n";
        let (rows, _) = scan_file("src/lib.rs", src).unwrap();
        let found = rows.iter().find(|r| r.name == "drain_queue").unwrap();
        assert_eq!(found.kind, "function");
        assert_eq!(found.line, 1);
        assert!(rows
            .iter()
            .all(|r| !r.name.contains("API_KEY") && !r.file.contains("shh")));
        let packed = crate::packed::build_packed(&rows);
        assert!(!packed.windows(b"API_KEY".len()).any(|w| w == b"API_KEY"));
    }
}
