use std::time::{Duration, Instant};

use murmo_js_runtime::{Engine, JsError, Limits};

const LIMITS: Limits = Limits {
    memory_bytes: 8 << 20,
    stack_bytes: 256 << 10,
};

// A stuck guest must not hang its caller: the Codex wrapper and the plugin host
// rely on the deadline to keep typing alive (vision: "Typing never freezes").
#[test]
fn a_busy_loop_is_interrupted_at_its_deadline() {
    let engine = Engine::new(LIMITS).unwrap();
    engine
        .load_script(
            "globalThis.spin = () => { for (;;) {} };",
            Duration::from_secs(1),
        )
        .unwrap();
    let start = Instant::now();
    let result = engine.call_json("spin", "null", Duration::from_millis(20));
    assert_eq!(result, Err(JsError::Timeout));
    assert!(
        start.elapsed() < Duration::from_millis(500),
        "took {:?}",
        start.elapsed()
    );
}

// A guest that tries to grow past its memory cap fails instead of taking the
// host process's memory (lessons 76, 80).
#[test]
fn allocation_past_the_memory_limit_fails() {
    let engine = Engine::new(LIMITS).unwrap();
    let script = "globalThis.grow = () => { const a = []; for (;;) a.push('x'.repeat(1 << 16)); };";
    engine.load_script(script, Duration::from_secs(1)).unwrap();
    match engine.call_json("grow", "null", Duration::from_secs(5)) {
        Err(JsError::Exception(message)) => assert!(message.contains("out of memory"), "{message}"),
        other => panic!("expected out of memory, got {other:?}"),
    }
}
