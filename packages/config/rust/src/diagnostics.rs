//! Structured diagnostics (port of `src/diagnostics.ts`). Every text field is
//! escaped when the diagnostic is made.

use serde_json::{json, Value};

use crate::text_policy::display_text;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    /// 1-based line in the file as written.
    pub line: usize,
    /// 1-based column in code points.
    pub column: usize,
}

pub const FILE_START: Position = Position { line: 1, column: 1 };

impl Position {
    pub fn to_json(self) -> Value {
        json!({ "line": self.line, "column": self.column })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Notice,
}

impl Severity {
    pub fn name(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Notice => "notice",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: Severity,
    /// One of the codes listed in `src/diagnostics.ts`.
    pub code: &'static str,
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub message: String,
    pub excerpt: Option<String>,
}

impl Diagnostic {
    pub fn new(
        severity: Severity,
        code: &'static str,
        file: &str,
        at: Position,
        message: &str,
        excerpt: Option<&str>,
    ) -> Self {
        Diagnostic {
            severity,
            code,
            file: display_text(file),
            line: at.line,
            column: at.column,
            message: display_text(message),
            excerpt: excerpt.map(display_text),
        }
    }

    pub fn at(&self) -> Position {
        Position {
            line: self.line,
            column: self.column,
        }
    }

    /// `file:line:col: message`, then the excerpt on its own line.
    pub fn format(&self) -> String {
        let head = format!(
            "{}:{}:{}: {}",
            self.file, self.line, self.column, self.message
        );
        match &self.excerpt {
            Some(e) => format!("{head}\n  {e}"),
            None => head,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "severity": self.severity.name(),
            "code": self.code,
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "message": self.message,
        });
        if let Some(e) = &self.excerpt {
            v["excerpt"] = json!(e);
        }
        v
    }
}

/// By position, then code, then message (code point order).
pub fn sort_diagnostics(list: &mut [Diagnostic]) {
    list.sort_by(|a, b| {
        a.line
            .cmp(&b.line)
            .then(a.column.cmp(&b.column))
            .then(a.code.cmp(b.code))
            .then(a.message.cmp(&b.message))
    });
}
