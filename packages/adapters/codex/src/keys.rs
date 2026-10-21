//! Canonical key IDs (`@murmo/api` NAMED_KEYS plus printable characters).

use crate::decoder::Kind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    pub id: String,
}

pub fn canonical(kind: &Kind) -> Option<Key> {
    let id = match kind {
        Kind::Char(s) if s == " " => "space".to_string(),
        Kind::Char(s) => s.clone(),
        Kind::Backspace => "Backspace".into(),
        Kind::Enter => "Enter".into(),
        Kind::Newline => "Newline".into(),
        Kind::Tab => "Tab".into(),
        Kind::Escape => "Escape".into(),
        Kind::Undo => "F6".into(),
        Kind::Up => "Up".into(),
        Kind::Down => "Down".into(),
        Kind::Left => "Left".into(),
        Kind::Right => "Right".into(),
        Kind::Home => "Home".into(),
        Kind::End => "End".into(),
        Kind::Kill => "Ctrl+U".into(),
        Kind::Paste(_)
        | Kind::Reply
        | Kind::Release
        | Kind::Mouse
        | Kind::Unknown
        | Kind::Suspend => {
            return None;
        }
    };
    Some(Key { id })
}

pub fn origin_of(kind: &Kind) -> &'static str {
    match kind {
        Kind::Char(_) | Kind::Backspace | Kind::Newline | Kind::Kill => "typed",
        Kind::Paste(_) => "paste",
        Kind::Up | Kind::Down => "history",
        _ => "unknown",
    }
}
