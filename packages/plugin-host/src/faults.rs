//! Typed fault kinds. Classification uses the engine error type and which
//! deadline fired, never substring matching on the message (E8).

use rquickjs::{CaughtError, Error as JsError};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultKind {
    Cpu,
    WallTimeout,
    Memory,
    Plugin,
    OutputLimit,
    Cancelled,
    Transport,
    SessionExit,
}

impl FaultKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FaultKind::Cpu => "cpu",
            FaultKind::WallTimeout => "wall-timeout",
            FaultKind::Memory => "memory",
            FaultKind::Plugin => "plugin",
            FaultKind::OutputLimit => "output-limit",
            FaultKind::Cancelled => "cancelled",
            FaultKind::Transport => "transport",
            FaultKind::SessionExit => "session-exit",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "cpu" => FaultKind::Cpu,
            "wall-timeout" | "timeout" => FaultKind::WallTimeout,
            "memory" => FaultKind::Memory,
            "plugin" | "exception" => FaultKind::Plugin,
            "output-limit" => FaultKind::OutputLimit,
            "cancelled" => FaultKind::Cancelled,
            "transport" => FaultKind::Transport,
            "session-exit" => FaultKind::SessionExit,
            _ => return None,
        })
    }
}

/// Classify a guest failure from the engine error and the deadline that fired.
pub fn classify(
    error: Option<&CaughtError<'_>>,
    interrupted: bool,
    cpu_hit: bool,
    wall_hit: bool,
) -> FaultKind {
    if interrupted {
        if cpu_hit {
            return FaultKind::Cpu;
        }
        if wall_hit {
            return FaultKind::WallTimeout;
        }
        return FaultKind::Cpu;
    }
    if let Some(CaughtError::Error(JsError::Allocation)) = error {
        return FaultKind::Memory;
    }
    if matches!(error, Some(CaughtError::Exception(_))) {
        // QuickJS reports OOM as an exception when the allocator returns null
        // after the Allocation path; still not a string search of "memory".
        if let Some(CaughtError::Exception(ex)) = error {
            if ex.message().is_some_and(|m| m == "out of memory") {
                return FaultKind::Memory;
            }
        }
    }
    if wall_hit {
        return FaultKind::WallTimeout;
    }
    FaultKind::Plugin
}

pub fn error_reply(kind: FaultKind, message: &str) -> Value {
    json!({
        "status": "error",
        "kind": kind.as_str(),
        "error": message,
        "effects": []
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupt_with_cpu_budget_is_cpu_not_a_string_match() {
        // A wall-busy neighbour must not look like plugin CPU (L5).
        assert_eq!(classify(None, true, true, true), FaultKind::Cpu);
        assert_eq!(classify(None, true, false, true), FaultKind::WallTimeout);
        assert_eq!(
            FaultKind::from_name("wall-timeout"),
            Some(FaultKind::WallTimeout)
        );
    }
}
