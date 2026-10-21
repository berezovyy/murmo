// The terminal and prompt text policy is phase 04's (@murmo/text): expansions
// are refused, and diagnostics escaped, by the same rules as plugin text. The
// Rust twin (rust/src/text_policy.rs) keeps the same reasons and escapes.
export { displayText, unsafeText } from '@murmo/text';
