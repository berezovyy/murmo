//! Ghost/menu paint inside DEC 2026 frames; restore cells before the next one
//! (lesson 39). Menu is on so the `;` picker can paint; ghost stays off.

use serde_json::Value;

use crate::screen::Screen;
use crate::STATUS_MAX_LENGTH;

#[derive(Debug, Clone)]
pub struct Overlay {
    pub ui: Value,
    pub rects: Vec<u16>,
    pub dirty: bool,
    /// On so the `;` shortcut picker can paint (live `murmo codex` request).
    pub menu: bool,
    pub ghost: bool,
}

impl Default for Overlay {
    fn default() -> Self {
        Self::new()
    }
}

impl Overlay {
    pub fn new() -> Self {
        Overlay {
            ui: serde_json::json!({}),
            rects: Vec::new(),
            dirty: false,
            menu: true,
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
        let (bytes, _) = self.paint_with_report(screen, idle, ascii);
        bytes
    }

    fn paint_with_report(&mut self, screen: &Screen, idle: bool, ascii: bool) -> (Vec<u8>, bool) {
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
        let mut menu_drawn = false;
        if self.menu {
            if let Some(items) = self.ui["menu"].as_array() {
                if !items.is_empty() {
                    if let Some(prompt_y) = screen.prompt_row() {
                        let (top, n) = menu_origin(prompt_y, items.len().min(8), rows);
                        let selected = self.ui["selected"].as_u64().unwrap_or(0) as usize;
                        for (i, item) in items.iter().take(n).enumerate() {
                            let yy = top + i as u16;
                            if yy >= rows || yy == prompt_y {
                                break;
                            }
                            let label = item["label"].as_str().unwrap_or("");
                            let label = sanitize(label, (cols / 2).saturating_sub(1) as usize);
                            out.extend(
                                format!(
                                    "\x1b[{};1H\x1b[0;{}m{label}",
                                    yy + 1,
                                    if i == selected { 7 } else { 2 }
                                )
                                .as_bytes(),
                            );
                            self.rects.push(yy);
                            menu_drawn = true;
                        }
                    }
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
        (out, menu_drawn)
    }

    pub fn frame(&mut self, screen: &mut Screen, raw: &[u8], idle: bool, ascii: bool) -> Vec<u8> {
        let restore = self.restore(screen);
        screen.process(raw);
        let (paint, _) = self.paint_with_report(screen, idle, ascii);
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
        let mut out = b"\x1b[?2026h".to_vec();
        out.extend(self.restore(screen));
        let (paint, menu_drawn) = self.paint_with_report(screen, idle, ascii);
        out.extend(paint);
        out.extend(b"\x1b[?2026l");
        let want_menu = self.menu
            && self.ui["menu"]
                .as_array()
                .is_some_and(|items| !items.is_empty());
        // A mid-frame Unknown screen used to clear dirty with no rows, so the
        // picker never retried until the next key.
        if !want_menu || menu_drawn {
            self.dirty = false;
        }
        out
    }
}

/// Place `count` menu rows above the prompt when there is room (composer is
/// at the bottom of the Codex TUI). Below only when the prompt is near home.
fn menu_origin(prompt_y: u16, count: usize, rows: u16) -> (u16, usize) {
    let count = count.min(8);
    if prompt_y >= count as u16 {
        (prompt_y - count as u16, count)
    } else {
        let below = rows.saturating_sub(prompt_y.saturating_add(1)) as usize;
        let n = count.min(below);
        (prompt_y.saturating_add(1), n)
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
    use crate::screen::Screen;

    #[test]
    fn menu_overlay_is_on_so_semicolon_picker_can_paint() {
        // Live `murmo codex` had caps.menu false; the ; picker never opened.
        let ov = Overlay::new();
        assert!(ov.menu);
        assert!(!ov.ghost);
    }

    #[test]
    fn escape_payloads_render_as_literal_text() {
        // OSC 52/8, cursor and bracketed-paste in status/overlay stay literal.
        let s = sanitize("hi\x1b]52;c;SECRET\x07\x1b[200~x\x1b[201~", 99);
        assert!(!s.contains('\u{1b}'));
        assert!(!s.contains('\u{7}'));
        assert!(s.contains("52;c;SECRET"));
    }

    fn prompt_at_row_cursor_home() -> Screen {
        let mut screen = Screen::new(24, 80);
        // Composer on row 21 (1-based); ratatui often ends a frame at home.
        let mut bytes = b"\x1b[21;1H".to_vec();
        bytes.extend("› hello".as_bytes());
        bytes.extend(b"\x1b[H");
        screen.process(&bytes);
        screen
    }

    #[test]
    fn menu_paints_above_prompt_when_cursor_is_home() {
        // Live picker sat at the top of the terminal because paint used vt100
        // cursor Y (0 after CUP home) instead of the › row.
        let screen = prompt_at_row_cursor_home();
        assert_eq!(screen.prompt_row(), Some(20));
        let (cy, _) = screen.vt.screen().cursor_position();
        assert_eq!(cy, 0);
        let mut ov = Overlay::new();
        ov.set_ui(serde_json::json!({
            "menu": [{"label": ";rvw  Review this change"}, {"label": ";tst  Run the tests"}],
            "selected": 0
        }));
        let out = String::from_utf8_lossy(&ov.paint(&screen, true, true)).into_owned();
        assert!(
            out.contains("\x1b[19;1H"),
            "two rows sit immediately above the prompt: {out:?}"
        );
        assert!(
            !out.contains("\x1b[1;1H;rvw") && !out.contains("\x1b[2;1H;rvw"),
            "must not paint at the top of the screen: {out:?}"
        );
        assert!(out.contains(";rvw"));
    }

    #[test]
    fn menu_stays_dirty_until_prompt_row_exists() {
        let screen = Screen::new(24, 80);
        let mut ov = Overlay::new();
        ov.set_ui(serde_json::json!({"menu": [{"label": ";rvw"}]}));
        assert!(ov.dirty);
        let _ = ov.redraw(&screen, true, true);
        assert!(
            ov.dirty,
            "retry on the next frame; clearing dirty dropped the picker"
        );
        let screen = prompt_at_row_cursor_home();
        let _ = ov.redraw(&screen, true, true);
        assert!(!ov.dirty);
    }
}
