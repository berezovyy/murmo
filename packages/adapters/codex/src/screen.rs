//! vt100 screen (no scrollback) and Codex UI recognition. Unsure means skip.

use crate::OPAQUE_PASTE_CHARS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ui {
    Idle,
    Popup,
    Dialog,
    VimNormal,
    VimReplace,
    History,
    Busy,
    Opaque,
    Unknown,
    RealProvider,
}

impl Ui {
    pub fn as_str(self) -> &'static str {
        match self {
            Ui::Idle => "idle",
            Ui::Popup => "popup",
            Ui::Dialog => "dialog",
            Ui::VimNormal => "vim-normal",
            Ui::VimReplace => "vim-replace",
            Ui::History => "history",
            Ui::Busy => "busy",
            Ui::Opaque => "opaque",
            Ui::Unknown => "unknown",
            Ui::RealProvider => "real-provider",
        }
    }

    pub fn native_owns_tab_enter(self) -> bool {
        matches!(self, Ui::Popup | Ui::Dialog)
    }
}

pub struct Screen {
    pub vt: vt100::Parser,
    pub title: String,
    pub frames: u64,
    pub saw_bracketed_paste: bool,
    pub saw_sync_frames: bool,
    pub saw_run_state: bool,
    pending: Vec<u8>,
}

impl Screen {
    pub fn new(rows: u16, cols: u16) -> Self {
        Screen {
            vt: vt100::Parser::new(rows, cols, 0),
            title: String::new(),
            frames: 0,
            saw_bracketed_paste: false,
            saw_sync_frames: false,
            saw_run_state: false,
            pending: Vec::new(),
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.vt.screen_mut().set_size(rows, cols);
    }

    pub fn contents(&self) -> String {
        self.vt.screen().contents()
    }

    pub fn process(&mut self, raw: &[u8]) {
        if raw.windows(8).any(|w| w == b"\x1b[?2004h") {
            self.saw_bracketed_paste = true;
        }
        if raw
            .windows(8)
            .any(|w| w == b"\x1b[?2026h" || w == b"\x1b[?2026l")
        {
            self.saw_sync_frames = true;
        }
        self.frames += raw.windows(8).filter(|w| *w == b"\x1b[?2026l").count() as u64;
        if let Some(title) = osc_title(raw) {
            self.title = title;
            if matches!(
                self.title.as_str(),
                "Ready" | "Working" | "Thinking" | "Waiting" | "Starting"
            ) {
                self.saw_run_state = true;
            }
        }
        self.vt.process(raw);
    }

    /// Buffer until a DEC 2026 frame closes so the overlay can paint inside it.
    pub fn take_frames(&mut self, raw: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(raw);
        let mut frames = Vec::new();
        loop {
            if self.pending.is_empty() {
                break;
            }
            let start = self.pending.windows(8).position(|w| w == b"\x1b[?2026h");
            let n = if let Some(b) = start {
                if b > 0 {
                    b
                } else {
                    match self.pending.windows(8).position(|w| w == b"\x1b[?2026l") {
                        Some(e) => e + 8,
                        None => break,
                    }
                }
            } else {
                let mut n = self.pending.len();
                for k in 1..8.min(n + 1) {
                    if b"\x1b[?2026h".starts_with(&self.pending[n - k..]) {
                        n -= k;
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
                n
            };
            let frame: Vec<u8> = self.pending.drain(..n).collect();
            frames.push(frame);
        }
        frames
    }

    pub fn composer_empty(&self) -> bool {
        let text = self.contents();
        text.lines().any(|line| {
            let t = line.trim_end();
            t == "›" || t == "› "
        })
    }

    pub fn has_prompt(&self) -> bool {
        self.contents().contains('›')
    }

    pub fn title_busy(&self) -> bool {
        matches!(
            self.title.as_str(),
            "Working" | "Thinking" | "Waiting" | "Starting"
        )
    }

    pub fn title_ready(&self) -> bool {
        self.title == "Ready"
    }
}

fn osc_title(raw: &[u8]) -> Option<String> {
    let i = raw.windows(4).position(|w| w == b"\x1b]0;")?;
    let tail = &raw[i + 4..];
    let e = tail.iter().position(|c| *c == 7)?;
    Some(String::from_utf8_lossy(&tail[..e]).into_owned())
}

pub fn classify(screen: &str, draft: &str, cursor: usize, known: bool, title_busy: bool) -> Ui {
    if screen.contains("https://api.openai.com") || screen.contains("api.openai.com") {
        return Ui::RealProvider;
    }
    if screen.contains("Vim: Normal") {
        return Ui::VimNormal;
    }
    if screen.contains("Vim: Replace") {
        return Ui::VimReplace;
    }
    if is_dialog(screen) {
        return Ui::Dialog;
    }
    if is_popup(draft, cursor) {
        return Ui::Popup;
    }
    if title_busy {
        return Ui::Busy;
    }
    if !known {
        return Ui::Unknown;
    }
    if !screen.contains('›') {
        return Ui::Unknown;
    }
    Ui::Idle
}

fn is_dialog(screen: &str) -> bool {
    const MARKERS: &[&str] = &[
        "Would you like to run the following command",
        "Would you like to grant these permissions",
        "Would you like to make the following edits",
        "Would you like to send input to",
        "needs your approval",
    ];
    MARKERS.iter().any(|m| screen.contains(m))
}

fn is_popup(draft: &str, cursor: usize) -> bool {
    if draft.starts_with('/') || draft.starts_with('!') {
        return true;
    }
    let at = cursor.min(draft.len());
    let prefix = &draft[..at];
    prefix
        .split_whitespace()
        .last()
        .is_some_and(|t| t.starts_with('@'))
}

pub fn opaque_paste(chars: usize) -> bool {
    chars > OPAQUE_PASTE_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_and_at_are_popups() {
        assert_eq!(classify("› /ide", "/ide", 4, true, false), Ui::Popup);
        assert_eq!(
            classify("› see @foo", "see @foo", 8, true, false),
            Ui::Popup
        );
        assert_eq!(classify("› hello", "hello", 5, true, false), Ui::Idle);
    }

    #[test]
    fn dialog_and_vim_win() {
        assert_eq!(
            classify(
                "Would you like to run the following command",
                "",
                0,
                true,
                false
            ),
            Ui::Dialog
        );
        assert_eq!(
            classify("Vim: Normal\n› x", "x", 1, true, false),
            Ui::VimNormal
        );
    }

    #[test]
    fn unknown_until_prompt() {
        assert_eq!(classify("loading", "hi", 2, true, false), Ui::Unknown);
        assert_eq!(classify("› hi", "hi", 2, false, false), Ui::Unknown);
    }
}
