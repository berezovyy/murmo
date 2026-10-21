//! Ghost/menu paint inside DEC 2026 frames; restore cells before the next one
//! (lesson 39). Ghost and menu ship **off**; status is one bounded line.

use serde_json::Value;

use crate::screen::Screen;
use crate::STATUS_MAX_LENGTH;

#[derive(Debug, Clone, Default)]
pub struct Overlay {
    pub ui: Value,
    pub rects: Vec<u16>,
    pub dirty: bool,
    /// Off until prompt detection is hardened (phase 23 hand-off).
    pub menu: bool,
    pub ghost: bool,
}

impl Overlay {
    pub fn new() -> Self {
        Overlay {
            ui: serde_json::json!({}),
            rects: Vec::new(),
            dirty: true,
            menu: false,
            ghost: false,
        }
    }

    pub fn set_ui(&mut self, ui: Value) {
        if self.ui != ui {
            self.ui = ui;
            self.dirty = true;
        }
    }

    pub fn set_status(&mut self, text: &str) {
        let clean = sanitize(text, STATUS_MAX_LENGTH);
        if self.ui["status"].as_str() != Some(&clean) {
            self.ui["status"] = Value::String(clean);
            self.dirty = true;
        }
    }

    /// Bytes that restore previously painted rows from the vt100 model.
    pub fn restore(&mut self, screen: &Screen) -> Vec<u8> {
        let mut out = Vec::new();
        let (_, cols) = screen.vt.screen().size();
        let rows: Vec<_> = screen.vt.screen().rows_formatted(0, cols).collect();
        for y in self.rects.drain(..) {
            out.extend(format!("\x1b[{};1H\x1b[2K", y + 1).as_bytes());
            if let Some(row) = rows.get(y as usize) {
                out.extend(row);
            }
        }
        out.extend(screen.vt.screen().attributes_formatted());
        let (y, x) = screen.vt.screen().cursor_position();
        out.extend(format!("\x1b[{};{}H", y + 1, x + 1).as_bytes());
        out
    }

    pub fn paint(&mut self, screen: &Screen, idle: bool, ascii: bool) -> Vec<u8> {
        let mut out = Vec::new();
        let (y, x) = screen.vt.screen().cursor_position();
        let (rows, cols) = screen.vt.screen().size();
        let status = self.ui["status"].as_str().unwrap_or("").to_owned();
        if idle && self.ghost && ascii {
            if let Some(g) = self.ui["ghost"].as_str() {
                let g = sanitize(g, (cols as usize).saturating_sub(x as usize + 1));
                if !g.is_empty() && (x as usize) + g.len() < (cols as usize).saturating_sub(1) {
                    out.extend(format!("\x1b[{};{}H\x1b[0;2m{g}", y + 1, x + 1).as_bytes());
                    self.rects.push(y);
                }
            }
        }
        if idle && self.menu {
            if let Some(items) = self.ui["menu"].as_array() {
                let top = if y >= 6 { y - 6 } else { y + 1 };
                let selected = self.ui["selected"].as_u64().unwrap_or(0) as usize;
                for (i, item) in items.iter().take(5).enumerate() {
                    let yy = top + i as u16;
                    if yy >= rows {
                        break;
                    }
                    let label = format!(
                        "{} {}",
                        item["label"].as_str().unwrap_or(""),
                        item["detail"]
                            .as_str()
                            .unwrap_or("")
                            .lines()
                            .next()
                            .unwrap_or("")
                    );
                    let label = sanitize(&label, (cols / 2).saturating_sub(1) as usize);
                    out.extend(
                        format!(
                            "\x1b[{};1H\x1b[0;{}m{label}",
                            yy + 1,
                            if i == selected { 7 } else { 2 }
                        )
                        .as_bytes(),
                    );
                    self.rects.push(yy);
                }
            }
        }
        if !status.is_empty()
            && (idle || status.starts_with("Guard") || status.contains("disabled"))
        {
            let label = sanitize(&status, (cols as usize).saturating_sub(1));
            out.extend(format!("\x1b[{};1H\x1b[0;2m{label}", rows).as_bytes());
            self.rects.push(rows.saturating_sub(1));
        }
        out.extend(screen.vt.screen().attributes_formatted());
        out.extend(format!("\x1b[{};{}H", y + 1, x + 1).as_bytes());
        out
    }

    pub fn frame(&mut self, screen: &mut Screen, raw: &[u8], idle: bool, ascii: bool) -> Vec<u8> {
        let restore = self.restore(screen);
        screen.process(raw);
        let paint = self.paint(screen, idle, ascii);
        let mut out = b"\x1b[?2026h".to_vec();
        out.extend(restore);
        if let Some(e) = raw.windows(8).rposition(|w| w == b"\x1b[?2026l") {
            out.extend(&raw[..e]);
            out.extend(paint);
            out.extend(&raw[e..]);
        } else {
            out.extend(raw);
            out.extend(paint);
            out.extend(b"\x1b[?2026l");
        }
        out
    }

    pub fn redraw(&mut self, screen: &Screen, idle: bool, ascii: bool) -> Vec<u8> {
        self.dirty = false;
        let mut out = b"\x1b[?2026h".to_vec();
        out.extend(self.restore(screen));
        out.extend(self.paint(screen, idle, ascii));
        out.extend(b"\x1b[?2026l");
        out
    }
}

/// Control bytes become spaces so OSC 52/8, cursor and paste payloads cannot
/// hijack the terminal (r14 S3, E15). Width is a cell cap, not string length.
pub fn sanitize(s: &str, max_chars: usize) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max_chars)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_payloads_render_as_literal_text() {
        // OSC 52/8, cursor and bracketed-paste in status/overlay stay literal.
        let s = sanitize("hi\x1b]52;c;SECRET\x07\x1b[200~x\x1b[201~", 99);
        assert!(!s.contains('\u{1b}'));
        assert!(!s.contains('\u{7}'));
        assert!(s.contains("52;c;SECRET"));
    }
}
