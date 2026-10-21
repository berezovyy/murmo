//! Startup capability probes. Each failure turns off one feature with a notice.

use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Probes {
    pub prompt: bool,
    pub bracketed_paste: bool,
    pub sync_frames: bool,
    pub echo: bool,
    pub vim_footer: bool,
    pub run_state: bool,
    pub helper: bool,
    pub notices: Vec<String>,
}

impl Default for Probes {
    fn default() -> Self {
        Self::new()
    }
}

impl Probes {
    pub fn new() -> Self {
        Probes {
            prompt: false,
            bracketed_paste: false,
            sync_frames: false,
            echo: false,
            vim_footer: false,
            run_state: false,
            helper: false,
            notices: Vec::new(),
        }
    }

    pub fn note(&mut self, text: &str) {
        self.notices.push(text.to_string());
    }

    /// After the composer is on screen. `echo_ok` is the probe-edit result.
    #[allow(clippy::too_many_arguments)]
    pub fn finish(
        &mut self,
        prompt: bool,
        bracketed: bool,
        frames: bool,
        echo_ok: bool,
        vim: bool,
        run_state: bool,
        helper: bool,
    ) {
        self.prompt = prompt;
        self.bracketed_paste = bracketed;
        self.sync_frames = frames;
        self.echo = echo_ok;
        self.vim_footer = vim;
        self.run_state = run_state;
        self.helper = helper;
        if !prompt {
            self.note("Murmo: prompt line not recognized; edits disabled");
        }
        if !bracketed {
            self.note("Murmo: bracketed paste not enabled; inline transport disabled");
        }
        if !frames {
            self.note("Murmo: DEC 2026 frames absent; overlay ghost and menu disabled");
        }
        if !echo_ok {
            self.note("Murmo: probe edit did not echo; inline transport disabled");
        }
        if !vim {
            self.note("Murmo: Vim footer not seen; Normal/Replace treated as unknown");
        }
        if !run_state {
            self.note("Murmo: run-state title not seen; busy becomes unknown");
        }
        if !helper {
            self.note("Murmo: plugin host unreachable; third-party plugins disabled");
        }
    }

    pub fn edits_on(&self) -> bool {
        self.prompt
    }

    pub fn transport_on(&self) -> bool {
        self.prompt && self.bracketed_paste && self.echo
    }

    pub fn overlay_on(&self) -> bool {
        self.sync_frames
    }

    pub fn record(&self) -> Value {
        json!({
            "host": "codex",
            "historical": false,
            "quirks": ["Tab-queues", "tracked-draft", "managed-submit-boundary", "native-popup-tab-passes"],
            "probes": {
                "prompt": self.prompt,
                "bracketedPaste": self.bracketed_paste,
                "syncFrames": self.sync_frames,
                "echo": self.echo,
                "vimFooter": self.vim_footer,
                "runState": self.run_state,
                "helper": self.helper,
            },
            "patch": {
                "inputOriginEvidence": "host-labeled",
                "inlineRewrite": "immediate-managed-transport",
                "inline": {
                    "commitReceipt": "transport-write",
                    "maxBytes": 800,
                    "nativeCompletion": false,
                    "attributed": false,
                },
                "menu": false,
                "ghost": "none",
                "highlight": "none",
                "edit": { "certainties": ["tracked"], "selection": false, "attributed": false },
                "submit": {
                    "gestures": ["send", "queue", "newline"],
                    "guardPosition": "managed",
                    "committed": "none",
                },
                "ui": {
                    "anchor": "overlay",
                    "statusMaxLength": 99,
                    "normalization": "preserve",
                    "opaqueParts": true,
                    "dialogSafe": false,
                },
                "keyPriority": "before-peers",
            }
        })
    }
}
