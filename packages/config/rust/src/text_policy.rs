//! The terminal and prompt text policy (port of `src/text-policy.ts`, r12 K3).
//! Rust strings can't hold unpaired surrogates, so that JS case can't arise.

fn unsafe_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

fn bidi_control(c: char) -> bool {
    matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// Why `text` must not reach a terminal or a prompt, or None when it may.
/// Tab, LF and CR stay allowed.
pub fn unsafe_text(text: &str) -> Option<&'static str> {
    if text.chars().any(unsafe_control) {
        return Some("control or terminal escape sequence");
    }
    if text.chars().any(bidi_control) {
        return Some("bidirectional override/isolate");
    }
    None
}

/// `value` with every refused character and every C0 control written as a
/// visible `\uXXXX` escape.
pub fn display_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}') || bidi_control(c) {
            out.push_str(&format!("\\u{:04x}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_reach_no_terminal_raw() {
        // A raw ESC or bidi override in a diagnostic would let a hostile
        // .murmo.toml repaint the terminal (r12 K3).
        assert_eq!(
            display_text("a\u{1b}[31m\u{202e}\n"),
            "a\\u001b[31m\\u202e\\u000a"
        );
        assert_eq!(unsafe_text("tab\tok\r\n"), None);
        assert_eq!(
            unsafe_text("\u{9b}"),
            Some("control or terminal escape sequence")
        );
        assert_eq!(
            unsafe_text("\u{2066}"),
            Some("bidirectional override/isolate")
        );
    }
}
