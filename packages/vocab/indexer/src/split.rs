//! Identifier word splitting: must match `packages/vocab/src/split.ts` (E7).

use unicode_normalization::UnicodeNormalization;

fn is_lu(c: char) -> bool {
    c.is_uppercase()
}

fn is_ll(c: char) -> bool {
    c.is_lowercase()
}

fn is_lo(c: char) -> bool {
    c.is_alphabetic() && !c.is_uppercase() && !c.is_lowercase()
}

fn is_n(c: char) -> bool {
    c.is_numeric()
}

fn is_m(c: char) -> bool {
    matches!(c, '\u{0300}'..='\u{036f}' | '\u{1ab0}'..='\u{1aff}' | '\u{20d0}'..='\u{20ff}' | '\u{fe20}'..='\u{fe2f}')
}

fn is_letter_or_number(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || is_m(c)
}

fn is_keep(c: char) -> bool {
    c.is_alphabetic() || is_m(c) || is_n(c)
}

/// NFC, Unicode case boundaries, digit runs stay attached, all-uppercase
/// plural `URLs` becomes `URL`, separator punctuation is dropped.
pub fn split_words(input: &str) -> Vec<String> {
    let mut s: String = input.nfc().collect();
    s.retain(|c| c != '`');
    if s.ends_with("()") {
        s.truncate(s.len() - 2);
    }
    let chars: Vec<char> = s.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(chars.len() * 2);
    let n = chars.len();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        // `([\p{Lu}]{2,})s(?=$|[^\p{L}\p{N}])` → drop the plural s.
        if is_lu(c) {
            let mut j = i;
            while j < n && is_lu(chars[j]) {
                j += 1;
            }
            let run = j - i;
            if run >= 2 && j < n && chars[j] == 's' {
                let after = j + 1;
                if after == n || !is_letter_or_number(chars[after]) {
                    out.extend_from_slice(&chars[i..j]);
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    // `([\p{Lu}]+)([\p{Lu}][\p{Ll}])` then `([\p{Ll}\p{Lo}\p{M}\p{N}])([\p{Lu}])`.
    let chars = out;
    let mut spaced: Vec<char> = Vec::with_capacity(chars.len() * 2);
    let n = chars.len();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if is_lu(c) {
            let mut j = i;
            while j < n && is_lu(chars[j]) {
                j += 1;
            }
            if j < n && is_ll(chars[j]) && j - i >= 2 {
                spaced.extend_from_slice(&chars[i..j - 1]);
                spaced.push(' ');
                spaced.push(chars[j - 1]);
                i = j;
                continue;
            }
            spaced.push(c);
            i += 1;
            continue;
        }
        spaced.push(c);
        if i + 1 < n {
            let nxt = chars[i + 1];
            if (is_ll(c) || is_lo(c) || is_m(c) || is_n(c)) && is_lu(nxt) {
                spaced.push(' ');
            }
        }
        i += 1;
    }
    let mut words = Vec::new();
    let mut cur = String::new();
    for c in spaced {
        if is_keep(c) {
            cur.extend(c.to_lowercase());
        } else if !cur.is_empty() {
            words.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

pub fn word_key(input: &str) -> String {
    split_words(input).join(" ")
}

#[cfg(test)]
mod tests {
    use super::split_words;

    #[test]
    fn splitter_fixture_29() {
        let raw = include_str!("../../../../fixtures/names/splitter-fixture.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 29);
        for row in cases {
            let input = row["input"].as_str().unwrap();
            let want: Vec<String> = row["words"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_str().unwrap().to_string())
                .collect();
            assert_eq!(split_words(input), want, "{input}");
        }
    }
}
