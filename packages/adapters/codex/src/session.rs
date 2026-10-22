//! Shared wrapper state the JS host callback mutates. The forwarding loop
//! owns the engine; this struct is only terminal + ledger.

use std::time::Instant;

use serde_json::{json, Value};

use crate::draft::Ledger;
use crate::overlay::Overlay;
use crate::probes::Probes;
use crate::pty::write_all;
use crate::screen::{Screen, Ui};
use crate::transport::{apply_planned, inline_apply, plan_edit};
use crate::INLINE_MAX_BYTES;

/// Startup echo probe runs before `finish()`, so `edits_on()` is still false.
pub fn edit_gate(probes: &Probes, probed: bool, known: bool, ui: Ui) -> bool {
    known && ui == Ui::Idle && (probes.edits_on() || !probed)
}

pub struct Inner {
    pub fd: i32,
    pub screen: Screen,
    pub ledger: Ledger,
    pub overlay: Overlay,
    pub probes: Probes,
    pub edits: Vec<Value>,
    pub next_edit: u64,
    pub probed: bool,
    pub config: Value,
}

impl Inner {
    pub fn new(fd: i32, rows: u16, cols: u16, config: Value) -> Self {
        Inner {
            fd,
            screen: Screen::new(rows, cols),
            ledger: Ledger::new(),
            overlay: Overlay::new(),
            probes: Probes::new(),
            edits: Vec::new(),
            next_edit: 0,
            probed: false,
            config,
        }
    }

    pub fn snapshot(&self) -> Value {
        self.ledger.snapshot(&self.screen, self.probed)
    }

    pub fn host(&mut self, v: &Value) -> Value {
        match v["op"].as_str().unwrap_or("") {
            "snapshot" => json!({"snapshot": self.snapshot()}),
            "inline-edit" => {
                if !self.probes.transport_on() {
                    return json!({"ok": false, "why": "transport-off"});
                }
                let base = v["version"].as_u64().unwrap_or(0);
                let mut r = inline_apply(&mut self.ledger, self.fd, v, base);
                r["snapshot"] = self.snapshot();
                r
            }
            "edit" => {
                self.next_edit += 1;
                let id = self.next_edit;
                let mut q = v.clone();
                q["id"] = json!(id);
                self.edits.push(q);
                json!({"pending": id})
            }
            "cursor" => {
                if let Some(p) = self
                    .ledger
                    .byte_of_utf16(v["cursor"].as_u64().unwrap_or(0) as usize)
                {
                    let left = p < self.ledger.cursor;
                    let n = if left {
                        crate::draft::graphemes(&self.ledger.text[p..self.ledger.cursor])
                    } else {
                        crate::draft::graphemes(&self.ledger.text[self.ledger.cursor..p])
                    };
                    write_all(
                        self.fd,
                        if left {
                            b"\x1b[D".repeat(n)
                        } else {
                            b"\x1b[C".repeat(n)
                        }
                        .as_slice(),
                    );
                    self.ledger.cursor = p;
                    self.ledger.version += 1;
                }
                json!({"snapshot": self.snapshot()})
            }
            "ui" => {
                if let Some(ui) = v.get("ui") {
                    self.overlay.set_ui(ui.clone());
                }
                json!({"ok": true})
            }
            "config" => json!({"config": self.config}),
            "caps-ceiling" => json!({"maxBytes": INLINE_MAX_BYTES}),
            "platform-pid" => json!({"pid": std::process::id()}),
            "trace" => {
                crate::trace::emit(&v["data"]);
                json!({"ok": true})
            }
            "stop" => {
                self.ledger.note_stop();
                json!({"ok": true, "snapshot": self.snapshot()})
            }
            "idle-empty" => {
                self.refresh_ledger();
                self.ledger
                    .empty_after_idle(self.screen.composer_empty(), self.screen.title_ready());
                json!({"ok": true, "snapshot": self.snapshot()})
            }
            _ => json!({"ok": false, "why": "unknown-op"}),
        }
    }

    pub fn run_edit(&mut self, e: &Value) -> Value {
        if !edit_gate(&self.probes, self.probed, self.ledger.known, self.ledger.ui) {
            return json!({"ok": false, "why": "state", "snapshot": self.snapshot()});
        }
        let from = e["from"].as_u64().unwrap_or(0) as usize;
        let to = e["to"].as_u64().unwrap_or(0) as usize;
        let insert = e["insert"].as_str().unwrap_or("");
        let version = e["version"].as_u64().unwrap_or(0);
        if version != self.ledger.version {
            return json!({"ok": false, "why": "stale", "snapshot": self.snapshot()});
        }
        let plan = match plan_edit(&self.ledger, from, to, insert) {
            Ok(p) => p,
            Err(why) => return json!({"ok": false, "why": why, "snapshot": self.snapshot()}),
        };
        let t = Instant::now();
        write_all(self.fd, &plan.prefix);
        for chunk in &plan.chunks {
            let frames = self.screen.frames;
            write_all(self.fd, chunk);
            let needle: String = std::str::from_utf8(&chunk[6..chunk.len() - 6])
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_alphanumeric())
                .rev()
                .take(32)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            let until = Instant::now() + std::time::Duration::from_millis(crate::ECHO_WAIT_MS);
            while Instant::now() < until {
                self.drain_output(2);
                let screen: String = self
                    .screen
                    .contents()
                    .chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect();
                if self.screen.frames > frames && (needle.is_empty() || screen.contains(&needle)) {
                    break;
                }
            }
            if self.screen.frames == frames {
                self.ledger.known = false;
                self.ledger.ui = Ui::Unknown;
                return json!({"ok": false, "why": "no-echo", "snapshot": self.snapshot()});
            }
        }
        if plan.suffix_left > 0 {
            write_all(self.fd, b"\x1b[D".repeat(plan.suffix_left).as_slice());
        }
        let _ = apply_planned(&mut self.ledger, from, to, insert);
        crate::trace::emit(&json!({
            "event": "edit-timing",
            "chunks": plan.chunks.len(),
            "ms": t.elapsed().as_secs_f64() * 1000.0,
        }));
        json!({"ok": true, "snapshot": self.snapshot()})
    }

    pub fn drain_output(&mut self, timeout_ms: i32) -> bool {
        unsafe {
            let mut p = libc::pollfd {
                fd: self.fd,
                events: libc::POLLIN,
                revents: 0,
            };
            if libc::poll(&mut p, 1, timeout_ms) <= 0 {
                return false;
            }
        }
        let mut b = [0u8; 65536];
        let n = unsafe { libc::read(self.fd, b.as_mut_ptr().cast(), b.len()) };
        if n <= 0 {
            return false;
        }
        self.present(&b[..n as usize]);
        true
    }

    pub fn present(&mut self, raw: &[u8]) {
        let idle = self.ledger.ui == Ui::Idle;
        let ascii = self.ledger.text.is_ascii();
        let frames = self.screen.take_frames(raw);
        for frame in frames {
            let Inner {
                overlay, screen, ..
            } = self;
            let out = overlay.frame(screen, &frame, idle, ascii);
            write_all(1, &out);
        }
        self.refresh_ledger();
    }

    pub fn refresh_ledger(&mut self) {
        let contents = self.screen.contents();
        let busy = self.screen.title_busy();
        let empty = self.screen.composer_empty();
        let ready = self.screen.title_ready();
        self.ledger.refresh_from(&contents, busy);
        self.ledger.try_recover_from(empty, ready);
    }

    pub fn redraw(&mut self) -> Vec<u8> {
        let idle = self.ledger.ui == Ui::Idle;
        let ascii = self.ledger.text.is_ascii();
        let Inner {
            overlay, screen, ..
        } = self;
        overlay.redraw(screen, idle, ascii)
    }

    pub fn apply_input(&mut self, ev: &crate::decoder::Event) {
        let contents = self.screen.contents();
        self.ledger.apply_event(ev, &contents);
        self.refresh_ledger();
    }
}

#[cfg(test)]
mod tests {
    use super::edit_gate;
    use crate::probes::Probes;
    use crate::screen::Ui;

    #[test]
    fn echo_probe_is_allowed_before_finish() {
        let probes = Probes::new();
        assert!(edit_gate(&probes, false, true, Ui::Idle));
        assert!(!edit_gate(&probes, true, true, Ui::Idle));
    }

    #[test]
    fn edits_on_after_prompt_probe() {
        let mut probes = Probes::new();
        probes.finish(true, true, true, true, true, true, false);
        assert!(edit_gate(&probes, true, true, Ui::Idle));
        assert!(probes.transport_on(), "bracketed paste is enough; echo is advisory");
    }
}
