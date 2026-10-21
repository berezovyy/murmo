//! Split stdin into scalar terminal events. Classify replies (DSR, OSC 10/11,
//! `CSI ?0u`) *before* key decoding so they never disable correction (r10-rust).

use crate::keys::{canonical, Key};

/// One complete event, with the exact bytes that must be forwarded if we pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub raw: Vec<u8>,
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// Printable scalar(s) the wrapper decoded outside bracketed paste.
    Char(String),
    Backspace,
    Enter,
    Newline,
    Tab,
    Escape,
    Undo,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    Kill,
    Suspend,
    Paste(String),
    /// Terminal replies: pass through, never a key (`CSI ?0u`, OSC 10/11, DSR).
    Reply,
    /// CSI-u key-release; pass through.
    Release,
    Mouse,
    Unknown,
}

impl Kind {
    pub fn key(&self) -> Option<Key> {
        canonical(self)
    }
}

/// Incremental parser. Incomplete UTF-8 / CSI / OSC / paste wait for more bytes.
#[derive(Debug, Default)]
pub struct Parser {
    buf: Vec<u8>,
    /// Bracketed paste started; waiting for `ESC[201~`.
    paste: bool,
    paste_parts: Vec<u8>,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    pub fn pending(&self) -> &[u8] {
        &self.buf
    }

    /// True when the only pending byte is a bare Escape (GNU screen ~320 ms).
    pub fn pending_escape(&self) -> bool {
        self.buf == [0x1b] && !self.paste
    }

    /// Take every complete event. `escape_due` flushes a lone ESC.
    pub fn drain(&mut self, escape_due: bool) -> Vec<Event> {
        let mut out = Vec::new();
        while let Some(n) = next_len(&self.buf, self.paste, escape_due) {
            let raw: Vec<u8> = self.buf.drain(..n).collect();
            if self.paste {
                if raw.windows(6).any(|w| w == b"\x1b[201~") {
                    // Drain includes the terminator only when we assembled it
                    // in `next_len`; the payload sits in paste_parts + prefix.
                    let mut payload = std::mem::take(&mut self.paste_parts);
                    let end = raw.windows(6).position(|w| w == b"\x1b[201~").unwrap_or(0);
                    payload.extend_from_slice(&raw[..end]);
                    self.paste = false;
                    let text = String::from_utf8_lossy(&payload).into_owned();
                    let mut wrapped = b"\x1b[200~".to_vec();
                    wrapped.extend_from_slice(&payload);
                    wrapped.extend_from_slice(b"\x1b[201~");
                    out.push(Event {
                        raw: wrapped,
                        kind: Kind::Paste(text),
                    });
                } else {
                    self.paste_parts.extend_from_slice(&raw);
                }
                continue;
            }
            if raw == b"\x1b[200~" {
                self.paste = true;
                continue;
            }
            out.push(Event {
                kind: decode(&raw),
                raw,
            });
        }
        out
    }
}

/// Bytes of the next complete event, or `None` if more input is needed.
pub fn next_len(buf: &[u8], in_paste: bool, escape_due: bool) -> Option<usize> {
    if buf.is_empty() {
        return None;
    }
    if in_paste {
        return buf
            .windows(6)
            .position(|w| w == b"\x1b[201~")
            .map(|i| i + 6);
    }
    if buf.starts_with(b"\x1b[200~") {
        return Some(6);
    }
    take_event(buf, escape_due)
}

/// Length of one non-paste event. Incomplete sequences return `None`.
pub fn take_event(b: &[u8], escape_due: bool) -> Option<usize> {
    if b.is_empty() {
        return None;
    }
    if b[0] == 0x1b {
        if b.len() == 1 {
            return escape_due.then_some(1);
        }
        // X10 mouse: ESC [ M Cb Cx Cy
        if b.starts_with(b"\x1b[M") {
            return (b.len() >= 6).then_some(6);
        }
        if b[1] == b']' {
            // OSC … BEL or OSC … ST
            if let Some(i) = b.iter().position(|c| *c == 7) {
                return Some(i + 1);
            }
            return b.windows(2).position(|w| w == b"\x1b\\").map(|i| i + 2);
        }
        if b[1] == b'[' {
            // SGR mouse: ESC [ < … M/m
            if b.len() > 2 && b[2] == b'<' {
                return b
                    .iter()
                    .enumerate()
                    .skip(3)
                    .find(|(_, c)| **c == b'M' || **c == b'm')
                    .map(|(i, _)| i + 1);
            }
            return b
                .iter()
                .enumerate()
                .skip(2)
                .find(|(_, c)| **c >= 0x40 && **c <= 0x7e)
                .map(|(i, _)| i + 1);
        }
        if b[1] == b'O' {
            return (b.len() >= 3).then_some(3);
        }
        // ESC + UTF-8 scalar (Alt+key) or two-byte sequence.
        let n = utf8_len(b[1]);
        return (b.len() > n).then_some(1 + n);
    }
    let n = utf8_len(b[0]);
    (b.len() >= n).then_some(n)
}

fn utf8_len(b: u8) -> usize {
    match b {
        0..=127 => 1,
        192..=223 => 2,
        224..=239 => 3,
        240..=247 => 4,
        _ => 1,
    }
}

pub fn decode(b: &[u8]) -> Kind {
    let Ok(s) = std::str::from_utf8(b) else {
        return Kind::Unknown;
    };
    if is_reply(s) {
        return Kind::Reply;
    }
    match s {
        "\x7f" | "\x08" => return Kind::Backspace,
        "\x1b[17~" => return Kind::Undo,
        "\r" => return Kind::Enter,
        "\n" | "\x1b\r" => return Kind::Newline,
        "\t" => return Kind::Tab,
        "\x15" => return Kind::Kill,
        "\x1a" => return Kind::Suspend,
        "\x1b" => return Kind::Escape,
        "\x1b[A" | "\x1bOA" => return Kind::Up,
        "\x1b[B" | "\x1bOB" => return Kind::Down,
        "\x1b[C" | "\x1bOC" => return Kind::Right,
        "\x1b[D" | "\x1bOD" => return Kind::Left,
        "\x1b[H" | "\x1bOH" | "\x01" => return Kind::Home,
        "\x1b[F" | "\x1bOF" | "\x05" => return Kind::End,
        _ => {}
    }
    if s.starts_with("\x1b[<") && (s.ends_with('M') || s.ends_with('m')) {
        return Kind::Mouse;
    }
    if s.starts_with("\x1b[M") && b.len() == 6 {
        return Kind::Mouse;
    }
    if s.starts_with("\x1b[") && s.ends_with('u') {
        return decode_csi_u(s).unwrap_or(Kind::Unknown);
    }
    // xterm modifyOtherKeys: ESC [ 27 ; modifier ; code ~
    if let Some(kind) = decode_modify_other(s) {
        return kind;
    }
    if !s.starts_with('\x1b') {
        if let Some(ch) = s.chars().next() {
            if ch >= ' ' {
                return Kind::Char(s.to_string());
            }
        }
    }
    Kind::Unknown
}

fn is_reply(s: &str) -> bool {
    // Device attributes, kitty flags, DSR cursor report, OSC colour answers.
    // `CSI ?0u` once disabled correction (r10-rust).
    s.starts_with("\x1b[?")
        || s.starts_with("\x1b[>")
        || s.starts_with("\x1b]")
        || (s.starts_with("\x1b[") && s.ends_with('R'))
}

fn decode_csi_u(s: &str) -> Option<Kind> {
    let inner = s.strip_prefix("\x1b[")?.strip_suffix('u')?;
    let mut parts = inner.split(';');
    let code = parts.next()?.split(':').next()?.parse::<u32>().ok()?;
    let m = parts.next().unwrap_or("1");
    if m.ends_with(":3") {
        return Some(Kind::Release);
    }
    let modifier = m.split(':').next()?.parse::<u32>().ok()?;
    if code == 122 && modifier == 5 {
        return Some(Kind::Suspend);
    }
    if modifier == 1 {
        return Some(match code {
            9 => Kind::Tab,
            13 => Kind::Enter,
            27 => Kind::Escape,
            127 => Kind::Backspace,
            57350 => Kind::Left,
            57351 => Kind::Right,
            57352 => Kind::Up,
            57353 => Kind::Down,
            57369 => Kind::Undo,
            57344..=63743 => Kind::Unknown,
            32..=0x10ffff => Kind::Char(char::from_u32(code)?.to_string()),
            _ => Kind::Unknown,
        });
    }
    // Shift/Alt+Enter and Ctrl+M as newline (tmux extended keys, lesson 61).
    if (code == 13 && (modifier == 2 || modifier == 3)) || (code == 109 && modifier == 5) {
        return Some(Kind::Newline);
    }
    Some(Kind::Unknown)
}

fn decode_modify_other(s: &str) -> Option<Kind> {
    let inner = s.strip_prefix("\x1b[")?.strip_suffix('~')?;
    let mut p = inner.split(';');
    if p.next()? != "27" {
        // CSI n ~ function keys: 15=F5, 17=F6, 18=F7, …
        return None;
    }
    let modifier = p.next()?.parse::<u32>().ok()?;
    let code = p.next()?.parse::<u32>().ok()?;
    if modifier == 1 {
        return Some(match code {
            9 => Kind::Tab,
            13 => Kind::Enter,
            127 => Kind::Backspace,
            32..=0x10ffff => Kind::Char(char::from_u32(code)?.to_string()),
            _ => Kind::Unknown,
        });
    }
    if code == 13 && (modifier == 2 || modifier == 3) {
        return Some(Kind::Newline);
    }
    Some(Kind::Unknown)
}

/// Samples whose every split must reassemble to the same bytes (r10: 92 cases).
pub fn fragmentation_samples() -> Vec<Vec<u8>> {
    vec![
        "plain 日本語 🙂".as_bytes().to_vec(),
        {
            let mut v = b"\x1b[200~teh ".to_vec();
            v.extend("日本語".as_bytes());
            v.extend(b"\x1b[201~");
            v
        },
        b"\x1b[32u".to_vec(),
        b"\x1b[127;1:3u".to_vec(),
        b"\x1b[<0;100;40M".to_vec(),
        vec![27, 91, 77, 32, 150, 150],
        b"\x1b[57369u".to_vec(),
        b"\x1b[1;5D".to_vec(),
        b"\x1b[?0u".to_vec(),
        b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\".to_vec(),
        b"\x1b]11;rgb:0000/0000/0000\x07".to_vec(),
        b"\x1b[4;8R".to_vec(),
        b"hello".to_vec(),
        "👨‍👩‍👧‍👦".as_bytes().to_vec(),
    ]
}

/// UTF-8, CSI-u, mouse, paste, Ctrl+C/Z: the r10 probe (plan: 1,061 bytes).
pub fn fidelity_probe() -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"abc");
    out.extend_from_slice("日本語🙂".as_bytes());
    out.extend_from_slice(b"\x03\x1a");
    out.extend_from_slice(b"\x1b[32u\x1b[13u\x1b[127u\x1b[57369u");
    out.extend_from_slice(&[27, 91, 77, 32, 150, 150]);
    out.extend_from_slice(b"\x1b[<0;10;10M");
    out.extend_from_slice(b"\x1b[200~");
    out.extend_from_slice("paste 日本語 \u{1F600}".as_bytes());
    out.extend_from_slice(b"\x1b[201~");
    out.extend_from_slice(b"\x1b[?0u");
    out.extend_from_slice(b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
    out.extend_from_slice(b"\r\t\x1b[A\x1b[B\x1b[C\x1b[D");
    // Pad with distinct printable bytes so the total is 1,061.
    while out.len() < 1061 {
        out.push(b'X');
    }
    out.truncate(1061);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_replies_never_become_keys() {
        // r10: `CSI ?0u` once disabled correction.
        for b in [
            b"\x1b[?0u".as_slice(),
            b"\x1b[4;8R",
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            b"\x1b]11;rgb:0000/0000/0000\x07",
        ] {
            assert_eq!(decode(b), Kind::Reply, "{b:?}");
        }
    }

    #[test]
    fn osc_frame_survives_every_split() {
        let b = b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\";
        for n in 1..b.len() {
            assert_eq!(take_event(&b[..n], false), None);
        }
        assert_eq!(take_event(b, false), Some(b.len()));
    }

    #[test]
    fn fragmentation_preserves_every_byte() {
        // 92 cases in r10: every split of each sample concatenates to the input.
        let mut cases = 0;
        for sample in fragmentation_samples() {
            for split in 1..=sample.len() {
                let mut p = Parser::new();
                let mut out = Vec::new();
                for chunk in sample.chunks(split) {
                    p.push(chunk);
                    for ev in p.drain(false) {
                        out.extend_from_slice(&ev.raw);
                    }
                }
                if p.pending_escape() {
                    for ev in p.drain(true) {
                        out.extend_from_slice(&ev.raw);
                    }
                }
                assert_eq!(out, sample, "split {split} of {}", hex(&sample));
                cases += 1;
            }
        }
        assert!(cases >= 92, "expected ≥92 fragmentation cases, got {cases}");
    }

    #[test]
    fn fidelity_probe_is_1061_bytes() {
        assert_eq!(fidelity_probe().len(), 1061);
    }

    #[test]
    fn csi_u_and_f6() {
        assert_eq!(decode(b"\x1b[57369u"), Kind::Undo);
        assert_eq!(decode(b"\x1b[17~"), Kind::Undo);
        assert_eq!(decode(b"\x1b[127u"), Kind::Backspace);
        assert_eq!(decode(b"\x1b[13u"), Kind::Enter);
        assert_eq!(decode(b"\x1b[32u"), Kind::Char(" ".into()));
        assert_eq!(decode(b"\x1b[127;1:3u"), Kind::Release);
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
