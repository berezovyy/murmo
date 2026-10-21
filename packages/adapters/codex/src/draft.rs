//! Tracked draft ledger. Certainty is `tracked`, never `authoritative`.
//! Recovery from `unknown` only when the composer is empty and OSC Ready (E25).

use serde_json::{json, Value};
use unicode_segmentation::UnicodeSegmentation;

use crate::decoder::{Event, Kind};
use crate::screen::{classify, opaque_paste, Screen, Ui};

#[derive(Debug, Clone)]
pub struct Ledger {
    pub text: String,
    /// UTF-8 byte offset of the cursor.
    pub cursor: usize,
    pub version: u64,
    pub known: bool,
    pub physical: usize,
    pub ui: Ui,
    /// Set after history / opaque paste / mouse / unknown modified key.
    reason: &'static str,
}

impl Ledger {
    pub fn new() -> Self {
        Ledger {
            text: String::new(),
            cursor: 0,
            version: 0,
            known: true,
            physical: 0,
            ui: Ui::Idle,
            reason: "new",
        }
    }

    pub fn utf16_cursor(&self) -> usize {
        self.text[..self.cursor].encode_utf16().count()
    }

    pub fn draft_json(&self) -> Value {
        json!({
            "text": self.text,
            "cursor": self.utf16_cursor(),
            "version": self.version,
        })
    }

    pub fn snapshot(&self, screen: &Screen, probed: bool) -> Value {
        json!({
            "draft": self.draft_json(),
            "state": self.ui.as_str(),
            "known": self.known,
            "title": screen.title,
            "probed": probed,
            "reason": self.reason,
        })
    }

    pub fn refresh_from(&mut self, contents: &str, title_busy: bool) {
        self.ui = classify(contents, &self.text, self.cursor, self.known, title_busy);
    }

    /// Empty composer + OSC Ready is the only measured route back to tracked.
    pub fn try_recover_from(&mut self, composer_empty: bool, title_ready: bool) {
        if self.known {
            return;
        }
        if self.text.is_empty() && composer_empty && title_ready {
            self.known = true;
            self.ui = Ui::Idle;
            self.reason = "recovered";
            self.version += 1;
        }
    }

    pub fn apply_event(&mut self, ev: &Event, screen_text: &str) {
        self.version += 1;
        match &ev.kind {
            Kind::Reply | Kind::Release => {}
            Kind::Paste(s) => {
                self.insert(s);
                if opaque_paste(s.chars().count()) {
                    self.known = false;
                    self.ui = Ui::Opaque;
                    self.physical = 1;
                    self.reason = "opaque";
                }
            }
            Kind::Char(ch) => self.insert(ch),
            Kind::Backspace => self.backspace(),
            Kind::Newline => self.insert("\n"),
            Kind::Kill => {
                let start = self.text[..self.cursor]
                    .rfind('\n')
                    .map(|i| i + 1)
                    .unwrap_or(0);
                self.text.replace_range(start..self.cursor, "");
                self.cursor = start;
                self.physical = graphemes(&self.text);
                if self.text.is_empty() && self.reason != "opaque" {
                    self.known = true;
                    self.ui = Ui::Idle;
                    self.reason = "cleared";
                }
            }
            Kind::Enter => {
                self.text.clear();
                self.cursor = 0;
                self.physical = 0;
                self.known = false;
                self.ui = Ui::Busy;
                self.reason = "submit";
            }
            Kind::Up | Kind::Down => {
                self.known = false;
                self.ui = Ui::History;
                self.reason = "history";
            }
            Kind::Escape => {
                if screen_text.contains("Vim: ") {
                    self.known = false;
                    self.ui = Ui::VimNormal;
                    self.reason = "vim";
                }
            }
            Kind::Left => {
                if let Some(g) = self.text[..self.cursor].graphemes(true).next_back() {
                    self.cursor -= g.len();
                }
            }
            Kind::Right => {
                if let Some(g) = self.text[self.cursor..].graphemes(true).next() {
                    self.cursor += g.len();
                }
            }
            Kind::Home => {
                let start = self.text[..self.cursor]
                    .rfind('\n')
                    .map(|i| i + 1)
                    .unwrap_or(0);
                self.cursor = start;
            }
            Kind::End => {
                let end = self.text[self.cursor..]
                    .find('\n')
                    .map(|i| self.cursor + i)
                    .unwrap_or(self.text.len());
                self.cursor = end;
            }
            Kind::Mouse | Kind::Unknown | Kind::Suspend | Kind::Tab | Kind::Undo => {
                self.known = false;
                self.ui = Ui::Unknown;
                self.reason = match ev.kind {
                    Kind::Mouse => "mouse",
                    Kind::Tab => "tab",
                    Kind::Undo => "f6",
                    _ => "unknown",
                };
            }
        }
    }

    fn insert(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
        self.physical = graphemes(&self.text);
    }

    fn backspace(&mut self) {
        if let Some(g) = self.text[..self.cursor].graphemes(true).next_back() {
            let n = g.len();
            self.text.replace_range(self.cursor - n..self.cursor, "");
            self.cursor -= n;
            self.physical = graphemes(&self.text);
        }
    }

    pub fn set_text(&mut self, text: String, cursor: usize) {
        self.text = text;
        self.cursor = cursor.min(self.text.len());
        self.physical = graphemes(&self.text);
        self.version += 1;
    }

    pub fn byte_of_utf16(&self, units: usize) -> Option<usize> {
        utf16_to_byte(&self.text, units)
    }
}

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

pub fn graphemes(s: &str) -> usize {
    s.graphemes(true).count()
}

pub fn utf16_to_byte(s: &str, units: usize) -> Option<usize> {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        if n == units {
            return Some(i);
        }
        n += c.len_utf16();
        if n > units {
            return None;
        }
    }
    (n == units).then_some(s.len())
}

pub fn byte_to_utf16(s: &str, byte: usize) -> usize {
    s[..byte.min(s.len())].encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decoder::Event;

    fn ev(kind: Kind) -> Event {
        Event { raw: vec![], kind }
    }

    #[test]
    fn recovery_needs_empty_composer_and_ready() {
        // OSC title alone must not clear unknown (r11, E25).
        let mut led = Ledger::new();
        let mut screen = Screen::new(24, 80);
        led.apply_event(&ev(Kind::Up), &screen.contents());
        assert!(!led.known);
        screen.title = "Ready".into();
        led.text = "recalled".into();
        led.cursor = led.text.len();
        led.try_recover_from(false, true);
        assert!(!led.known);

        led.text.clear();
        led.cursor = 0;
        led.try_recover_from(true, true);
        assert!(led.known, "empty composer + Ready recovers");
    }

    #[test]
    fn grapheme_backspace() {
        let mut led = Ledger::new();
        let screen = Screen::new(4, 20);
        led.apply_event(&ev(Kind::Char("🙂".into())), &screen.contents());
        assert_eq!(led.cursor, "🙂".len());
        led.apply_event(&ev(Kind::Backspace), &screen.contents());
        assert_eq!(led.text, "");
    }
}
