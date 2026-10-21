//! Inline packet: Backspaces + one bracketed paste (and the boundary).
//! Long inserts go in ≤ 800-character pieces, each after the previous echo.

use serde_json::{json, Value};
use unicode_segmentation::UnicodeSegmentation;

use crate::draft::{graphemes, utf16_to_byte, Ledger};
use crate::pty::write_all;
use crate::screen::Ui;
use crate::{PACKET_BYTE_CAP, PACKET_SCALAR_CAP};

pub fn paste_chunks(s: &str, limit: usize) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut chunk = String::new();
    let mut n = 0;
    for c in s.chars() {
        if n == limit {
            out.push(bracketed(&chunk));
            chunk.clear();
            n = 0;
        }
        chunk.push(c);
        n += 1;
    }
    if !chunk.is_empty() {
        out.push(bracketed(&chunk));
    }
    out
}

pub fn bracketed(s: &str) -> Vec<u8> {
    let mut out = b"\x1b[200~".to_vec();
    out.extend_from_slice(s.as_bytes());
    out.extend_from_slice(b"\x1b[201~");
    out
}

/// Apply an inline replace as one logical packet. `answer` is the JS plan.
pub fn inline_apply(led: &mut Ledger, fd: i32, answer: &Value, base: u64) -> Value {
    if base != led.version || !led.known || led.ui != Ui::Idle {
        return json!({"ok": false, "why": "stale-state"});
    }
    let new = answer["text"].as_str().unwrap_or("");
    let u = answer["cursor"].as_u64().unwrap_or(0) as usize;
    let Some(cursor) = utf16_to_byte(new, u) else {
        return json!({"ok": false, "why": "offset"});
    };
    if new.get(cursor..) != Some(&led.text[led.cursor..]) {
        return json!({"ok": false, "why": "suffix"});
    }
    let mut shared = led
        .text
        .as_bytes()
        .iter()
        .zip(new.as_bytes())
        .take(led.cursor.min(cursor))
        .take_while(|(a, b)| a == b)
        .count();
    while shared > 0 && (!led.text.is_char_boundary(shared) || !new.is_char_boundary(shared)) {
        shared -= 1;
    }
    let start = led.text[..led.cursor]
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .take_while(|i| *i <= shared)
        .last()
        .unwrap_or(0);
    let insert = &new[start..cursor];
    if insert.chars().count() > PACKET_SCALAR_CAP || insert.len() > PACKET_BYTE_CAP {
        return json!({"ok": false, "why": "large"});
    }
    let erased = graphemes(&led.text[start..led.cursor]);
    let mut packet = vec![127; erased];
    if !insert.is_empty() {
        packet.extend(bracketed(insert));
    }
    let splice = json!({
        "from": led.text[..start].encode_utf16().count(),
        "to": led.text[..led.cursor].encode_utf16().count(),
        "length": insert.encode_utf16().count(),
    });
    write_all(fd, &packet);
    led.set_text(new.to_owned(), cursor);
    json!({"ok": true, "splice": splice, "snapshot": led.draft_json()})
}

/// Restore cursor after a full-buffer rewrite: Right then Backspace-all, paste, Left.
pub struct LongInsert {
    pub prefix: Vec<u8>,
    pub chunks: Vec<Vec<u8>>,
    pub suffix_left: usize,
}

pub fn plan_edit(
    led: &Ledger,
    from_utf16: usize,
    to_utf16: usize,
    insert: &str,
) -> Result<LongInsert, &'static str> {
    let a = utf16_to_byte(&led.text, from_utf16).ok_or("offset")?;
    let b = utf16_to_byte(&led.text, to_utf16).ok_or("offset")?;
    if a > b {
        return Err("offset");
    }
    let new = format!("{}{}{}", &led.text[..a], insert, &led.text[b..]);
    let new_cursor = if led.cursor >= b {
        led.cursor - (b - a) + insert.len()
    } else if led.cursor > a {
        a + insert.len()
    } else {
        led.cursor
    };
    let right = graphemes(&led.text[led.cursor..]);
    let mut prefix = b"\x1b[C".repeat(right);
    prefix.extend(std::iter::repeat_n(127, led.physical));
    let chunks = paste_chunks(&new, PACKET_SCALAR_CAP);
    let left = graphemes(&new[new_cursor.min(new.len())..]);
    Ok(LongInsert {
        prefix,
        chunks,
        suffix_left: left,
    })
}

pub fn apply_planned(
    led: &mut Ledger,
    from_utf16: usize,
    to_utf16: usize,
    insert: &str,
) -> Result<(), &'static str> {
    let a = utf16_to_byte(&led.text, from_utf16).ok_or("offset")?;
    let b = utf16_to_byte(&led.text, to_utf16).ok_or("offset")?;
    let suffix = led.text[b..].to_owned();
    let new = format!("{}{}{}", &led.text[..a], insert, suffix);
    let new_cursor = if led.cursor >= b {
        led.cursor - (b - a) + insert.len()
    } else if led.cursor > a {
        a + insert.len()
    } else {
        led.cursor
    };
    led.set_text(new, new_cursor);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_chunks_count_scalars_not_bytes() {
        let value = "👨‍👩‍👧‍👦".repeat(300);
        let p = paste_chunks(&value, 800);
        let mut restored = String::new();
        for chunk in &p {
            let n = chunk.len();
            let s = std::str::from_utf8(&chunk[6..n - 6]).unwrap();
            assert!(s.chars().count() <= 800);
            restored.push_str(s);
        }
        assert_eq!(restored, value);
        assert_eq!(p.len(), 3);
    }

    #[test]
    fn packet_refuses_over_800_scalars() {
        let mut led = Ledger::new();
        led.text = "teh".into();
        led.cursor = 3;
        led.version = 1;
        led.known = true;
        led.ui = Ui::Idle;
        let big = "x".repeat(801);
        let answer = json!({"text": format!("{big} "), "cursor": 802});
        let r = inline_apply(&mut led, -1, &answer, 1);
        assert_eq!(r["ok"], false);
        assert_eq!(r["why"], "large");
    }
}
