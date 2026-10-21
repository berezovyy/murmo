//! Source-level work before and after the parser (port of `src/source.ts`,
//! line for line): normalization, the pre-parse nesting bound and the key
//! locator. The JS scanner walks UTF-16 units and this one walks UTF-8 bytes;
//! every decision is on an ASCII character, which is one unit in both, so the
//! two find the same keys at the same code point positions.

use std::collections::HashMap;

use crate::diagnostics::Position;
use crate::limits::{EXCERPT_CODE_POINTS, NESTING_DEPTH};

/// Strips one leading BOM and turns CRLF into LF.
pub fn normalize_toml(text: &str) -> String {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    if body.contains("\r\n") {
        body.replace("\r\n", "\n")
    } else {
        body.to_string()
    }
}

/// Code points in `bytes` (a slice of valid UTF-8, possibly cut mid-character).
fn code_points(bytes: &[u8]) -> usize {
    bytes.iter().filter(|b| (**b & 0xc0) != 0x80).count()
}

pub fn code_point_length(text: &str) -> usize {
    text.chars().count()
}

/// The first `max` code points of `text`, with `…` when it was cut.
pub fn clip_code_points(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}\u{2026}", &text[..i]),
        None => text.to_string(),
    }
}

/// The source line `line` (1-based), cut for a diagnostic excerpt.
pub fn excerpt_at(source: &str, line: usize) -> Option<String> {
    let mut start = 0;
    for _ in 1..line {
        let end = source[start..].find('\n')?;
        start += end + 1;
    }
    let text = match source[start..].find('\n') {
        Some(end) => &source[start..start + end],
        None => &source[start..],
    };
    Some(clip_code_points(text, EXCERPT_CODE_POINTS))
}

/// The position of byte `offset`, with the same end-of-file rule as JS
/// `parserPosition`: an error on the empty last line of a file that ends with
/// a newline is reported at the end of the last line with content.
pub fn parser_position(source: &str, offset: usize) -> Position {
    let offset = offset.min(source.len());
    let bytes = source.as_bytes();
    let line = 1 + bytes[..offset].iter().filter(|b| **b == b'\n').count();
    let line_start = bytes[..offset]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |i| i + 1);
    let lines: Vec<&str> = source.split('\n').collect();
    if line > 1 && line == lines.len() && lines[line - 1].is_empty() {
        return Position {
            line: line - 1,
            column: code_point_length(lines[line - 2]) + 1,
        };
    }
    Position {
        line,
        column: code_points(&bytes[line_start..offset]) + 1,
    }
}

#[derive(Clone, Copy)]
struct Mark {
    line: usize,
    line_index: usize,
    index: usize,
}

const NEWLINE: u8 = b'\n';
const SPACE: u8 = b' ';
const TAB: u8 = b'\t';
const HASH: u8 = b'#';
const QUOTE: u8 = b'"';
const APOSTROPHE: u8 = b'\'';
const OPEN_BRACKET: u8 = b'[';
const CLOSE_BRACKET: u8 = b']';
const OPEN_BRACE: u8 = b'{';
const CLOSE_BRACE: u8 = b'}';
const BACKSLASH: u8 = b'\\';
const DOT: u8 = b'.';
const EQUALS: u8 = b'=';

/// `charCodeAt` past the end gives NaN in JS, which equals nothing; 0 here
/// equals nothing the scanner compares with.
fn at(s: &[u8], i: usize) -> u8 {
    s.get(i).copied().unwrap_or(0)
}

fn is_bare_key(unit: u8) -> bool {
    unit.is_ascii_alphanumeric() || unit == b'_' || unit == b'-'
}

/// Index just past the string that starts at `i`, or the end of its line when unterminated.
fn skip_string(s: &[u8], i: usize) -> usize {
    let quote = at(s, i);
    let triple = at(s, i + 1) == quote && at(s, i + 2) == quote;
    let escapes = quote == QUOTE;
    if triple {
        let mut j = i + 3;
        while j < s.len() {
            let unit = s[j];
            if escapes && unit == BACKSLASH {
                j += 2;
                continue;
            }
            if unit == quote && at(s, j + 1) == quote && at(s, j + 2) == quote {
                j += 3;
                let mut extra = 0;
                while extra < 2 && at(s, j) == quote {
                    j += 1;
                    extra += 1;
                }
                return j.min(s.len());
            }
            j += 1;
        }
        return s.len();
    }
    let mut j = i + 1;
    while j < s.len() {
        let unit = s[j];
        if unit == NEWLINE {
            return j;
        }
        if escapes && unit == BACKSLASH {
            j += 2;
            continue;
        }
        if unit == quote {
            return j + 1;
        }
        j += 1;
    }
    s.len()
}

fn simple_escape(c: char) -> Option<char> {
    Some(match c {
        'b' => '\u{8}',
        't' => '\t',
        'n' => '\n',
        'f' => '\u{c}',
        'r' => '\r',
        'e' => '\u{1b}',
        '"' => '"',
        '\\' => '\\',
        _ => return None,
    })
}

/// Decodes a basic-string key's escapes; an invalid escape keeps its raw text.
fn decode_basic(raw: &str) -> String {
    if !raw.contains('\\') {
        return raw.to_string();
    }
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\\' || i + 1 >= chars.len() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let kind = chars[i + 1];
        let digits = match kind {
            'u' => 4,
            'U' => 8,
            'x' => 2,
            _ => 0,
        };
        if digits > 0
            && i + 2 + digits <= chars.len()
            && chars[i + 2..i + 2 + digits]
                .iter()
                .all(char::is_ascii_hexdigit)
        {
            let hex: String = chars[i + 2..i + 2 + digits].iter().collect();
            match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                Some(c) => out.push(c),
                None => {
                    out.push('\\');
                    out.push(kind);
                    out.push_str(&hex);
                }
            }
            i += 2 + digits;
            continue;
        }
        match simple_escape(kind) {
            Some(c) => out.push(c),
            None => {
                out.push('\\');
                out.push(kind);
            }
        }
        i += 2;
    }
    out
}

fn skip_blank(s: &[u8], mut j: usize) -> usize {
    while j < s.len() && (s[j] == SPACE || s[j] == TAB) {
        j += 1;
    }
    j
}

/// A dotted key starting at `i`, or None when no key starts there.
fn read_key_path(source: &str, i: usize) -> Option<(Vec<String>, usize)> {
    let s = source.as_bytes();
    let mut path = Vec::new();
    let mut j = i;
    loop {
        j = skip_blank(s, j);
        let unit = at(s, j);
        if unit == QUOTE || unit == APOSTROPHE {
            let end = skip_string(s, j);
            if end < j + 2 || at(s, end - 1) != unit {
                return None;
            }
            let raw = &source[j + 1..end - 1];
            path.push(if unit == QUOTE {
                decode_basic(raw)
            } else {
                raw.to_string()
            });
            j = end;
        } else if is_bare_key(unit) {
            let start = j;
            while j < s.len() && is_bare_key(s[j]) {
                j += 1;
            }
            path.push(source[start..j].to_string());
        } else {
            return None;
        }
        j = skip_blank(s, j);
        if at(s, j) != DOT {
            return Some((path, j));
        }
        j += 1;
    }
}

/// Finds where a key path was written, for validation diagnostics.
pub struct Locator {
    marks: HashMap<String, Mark>,
    source: String,
}

impl Locator {
    fn position(&self, mark: Mark) -> Position {
        Position {
            line: mark.line,
            column: code_points(&self.source.as_bytes()[mark.line_index..mark.index]) + 1,
        }
    }

    /// The key's position, else its nearest written ancestor's, else line 1.
    pub fn locate<S: AsRef<str>>(&self, path: &[S]) -> Position {
        for n in (1..=path.len()).rev() {
            let id = path[..n]
                .iter()
                .map(AsRef::as_ref)
                .collect::<Vec<_>>()
                .join("\u{0}");
            if let Some(mark) = self.marks.get(&id) {
                return self.position(*mark);
            }
        }
        Position { line: 1, column: 1 }
    }
}

pub struct SourceScan {
    /// Where arrays and inline tables first nest past the limit.
    pub overflow: Option<Position>,
    pub locator: Locator,
}

/// One linear pass over the normalized source, before the parser runs.
pub fn scan_source(source: &str) -> SourceScan {
    let s = source.as_bytes();
    let mut marks: HashMap<String, Mark> = HashMap::new();
    let mut depth = 0usize;
    let mut line_start = true;
    let mut line = 1usize;
    let mut line_index = 0usize;
    let mut table: Vec<String> = Vec::new();
    let mut overflow = None;

    let mut i = 0;
    while i < s.len() {
        let unit = s[i];
        if unit == NEWLINE {
            line += 1;
            line_index = i + 1;
            line_start = true;
            i += 1;
            continue;
        }
        if unit == SPACE || unit == TAB {
            i += 1;
            continue;
        }
        if unit == HASH {
            i = source[i..].find('\n').map_or(s.len(), |e| i + e);
            continue;
        }
        if line_start && depth == 0 {
            line_start = false;
            if unit == OPEN_BRACKET {
                let array = at(s, i + 1) == OPEN_BRACKET;
                let header = read_key_path(source, i + if array { 2 } else { 1 });
                let mut j = i + 1;
                if let Some((path, end)) = header {
                    table = path;
                    marks.entry(table.join("\u{0}")).or_insert(Mark {
                        line,
                        line_index,
                        index: i,
                    });
                    j = end;
                }
                while j < s.len() && s[j] != NEWLINE {
                    let c = s[j];
                    if c == QUOTE || c == APOSTROPHE {
                        j = skip_string(s, j);
                        continue;
                    }
                    j += 1;
                    if c == CLOSE_BRACKET {
                        if array && at(s, j) == CLOSE_BRACKET {
                            j += 1;
                        }
                        break;
                    }
                }
                i = j;
                continue;
            }
            if let Some((path, end)) = read_key_path(source, i) {
                if at(s, end) == EQUALS {
                    let full: Vec<String> = table.iter().cloned().chain(path).collect();
                    marks.entry(full.join("\u{0}")).or_insert(Mark {
                        line,
                        line_index,
                        index: i,
                    });
                    i = end + 1;
                    continue;
                }
            }
        }
        line_start = false;
        if unit == QUOTE || unit == APOSTROPHE {
            let end = skip_string(s, i);
            // Strings may span lines; keep the line counters right.
            let mut k = i;
            while k < end {
                if s[k] == NEWLINE {
                    line += 1;
                    line_index = k + 1;
                }
                k += 1;
            }
            i = end;
            continue;
        }
        if unit == OPEN_BRACKET || unit == OPEN_BRACE {
            depth += 1;
            if depth > NESTING_DEPTH {
                overflow = Some(Mark {
                    line,
                    line_index,
                    index: i,
                });
                break;
            }
        } else if (unit == CLOSE_BRACKET || unit == CLOSE_BRACE) && depth > 0 {
            depth -= 1;
        }
        i += 1;
    }
    let locator = Locator {
        marks,
        source: source.to_string(),
    };
    SourceScan {
        overflow: overflow.map(|m| locator.position(m)),
        locator,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_found_at_code_point_columns() {
        // A validation diagnostic must point at the key, counted in code
        // points, or JS and Rust would print different columns.
        let src = "[replace]\n  \"\u{e9};x\" = 'a'\n\"a.b\".c = 1\n";
        let scan = scan_source(src);
        assert_eq!(
            scan.locator.locate(&["replace", "\u{e9};x"]),
            Position { line: 2, column: 3 }
        );
        assert_eq!(
            scan.locator.locate(&["replace", "a.b", "c"]),
            Position { line: 3, column: 1 }
        );
        assert_eq!(
            scan.locator.locate(&["nothing"]),
            Position { line: 1, column: 1 }
        );
    }

    #[test]
    fn deep_nesting_is_refused_before_parsing() {
        // 1200 nested arrays crashed nothing in r12 only because the broker
        // bounded them first; the bound must hold here too.
        let src = format!("words = {}", "[".repeat(1200));
        assert_eq!(
            scan_source(&src).overflow,
            Some(Position {
                line: 1,
                column: 41
            })
        );
    }

    #[test]
    fn eof_errors_move_to_the_last_line_with_content() {
        // smol-toml and toml report an unclosed inline table on different lines.
        let src = "a = 1\nb = { x = 1\n";
        assert_eq!(
            parser_position(src, src.len()),
            Position {
                line: 2,
                column: 12
            }
        );
    }
}
