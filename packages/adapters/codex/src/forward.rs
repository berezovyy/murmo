//! The key-forwarding loop. Engine calls are caught; a panic never happens
//! here (`panic = "abort"` would kill the session).

use std::cell::RefCell;
use std::env;
use std::ffi::CString;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::args::Launch;
use crate::decoder::{Kind, Parser};
use crate::engine::Engine;
use crate::helper::{resolve_helper, Helper};
use crate::hooks::HookServer;
use crate::pty::{self, poll_two, read_stdin, wait_nonblock, Pty};
use crate::screen::Ui;
use crate::session::Inner;
use crate::trace;
use crate::{ESCAPE_TIMEOUT_MS, RECURSION_GUARD, SUBMIT_WAIT_MS};

static SIGNALS: AtomicUsize = AtomicUsize::new(0);

extern "C" fn on_signal(sig: i32) {
    SIGNALS.fetch_or(1usize << sig, Ordering::Relaxed);
}

pub fn run(launch: Launch, self_exe: &std::path::Path) -> i32 {
    let Launch::Wrap { bin, argv } = launch else {
        unreachable!("pass-through is exec'd in main");
    };
    env::set_var(RECURSION_GUARD, "1");
    let bin_c = match CString::new(bin.to_string_lossy().as_bytes()) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("murmo-codex: invalid stock path");
            return 1;
        }
    };
    let args_c: Vec<CString> = argv
        .iter()
        .filter_map(|s| CString::new(s.as_bytes()).ok())
        .collect();
    let hook_server = HookServer::bind();
    let ws = pty::winsize();
    let mut pty = match Pty::spawn(&bin_c, &args_c, ws) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("murmo-codex: forkpty: {e}");
            return 1;
        }
    };
    unsafe {
        for sig in [
            libc::SIGWINCH,
            libc::SIGCONT,
            libc::SIGTERM,
            libc::SIGHUP,
            libc::SIGINT,
        ] {
            libc::signal(sig, on_signal as *const () as libc::sighandler_t);
        }
    }

    let config = load_config();
    let inner = Rc::new(RefCell::new(Inner::new(
        pty.master,
        ws.ws_row,
        ws.ws_col,
        config.clone(),
    )));
    let mut helper = resolve_helper(self_exe).and_then(|p| Helper::spawn(&p).ok());
    if let Some(h) = &mut helper {
        inner.borrow_mut().probes.helper = true;
        let _ = h.hello();
    } else {
        inner
            .borrow_mut()
            .probes
            .note("Murmo: plugin host unreachable; third-party plugins disabled");
    }
    let helper = helper.map(|h| Rc::new(RefCell::new(h)));
    let table = crate::engine::load_english_table();
    let (table_bytes, table_meta) = match &table {
        Some((b, m)) => (Some(b.as_slice()), m.clone()),
        None => (None, json!({})),
    };
    let engine = match Engine::start(
        inner.clone(),
        helper.clone(),
        table_bytes,
        &table_meta,
        &config,
    ) {
        Ok(e) => Some(e),
        Err(e) => {
            trace::emit(&json!({"event": "engine-failed", "error": e}));
            inner
                .borrow_mut()
                .probes
                .note("Murmo: engine failed to start; typing passes through");
            None
        }
    };

    let started = Instant::now();
    let mut parser = Parser::new();
    let mut escaped = Instant::now();
    let mut stdin_open = true;
    let mut initialized = false;
    let mut child_status = 0;

    loop {
        let sig = SIGNALS.swap(0, Ordering::Relaxed);
        if sig & (1 << libc::SIGWINCH) != 0 {
            let ws = pty::winsize();
            pty.resize(ws);
            inner.borrow_mut().screen.resize(ws.ws_row, ws.ws_col);
        }
        if sig & (1 << libc::SIGCONT) != 0 {
            pty.continue_group();
        }
        for s in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
            if sig & (1 << s) != 0 {
                pty.signal_group(s);
            }
        }

        if let Some(h) = &helper {
            if let Some(eng) = &engine {
                for line in h.borrow().try_recv() {
                    let _ = eng.call("__rpcResult", &line);
                    eng.jobs();
                }
            }
        }
        inner.borrow_mut().drain_output(0);

        if !initialized && inner.borrow().screen.has_prompt() {
            initialized = true;
            probe_and_init(&inner, engine.as_ref(), started);
        }

        if let Some(eng) = &engine {
            let _ = eng.call("__tick", "");
            eng.jobs();
        }
        {
            let mut g = inner.borrow_mut();
            if g.overlay.dirty {
                let out = g.redraw();
                crate::pty::write_all(1, &out);
            }
        }

        let timeout = if parser.pending_escape() {
            ESCAPE_TIMEOUT_MS as i32
        } else {
            20
        };
        if let (Some(hooks), Some(eng)) = (&hook_server, &engine) {
            hooks.serve_ready(eng);
        }
        let (in_ready, out_ready) = poll_two(stdin_open, pty.master, timeout);
        if out_ready {
            inner.borrow_mut().drain_output(0);
        }
        if in_ready {
            let mut bytes = [0u8; 8192];
            match read_stdin(&mut bytes) {
                Ok(0) => {
                    stdin_open = false;
                    pty.signal_group(libc::SIGHUP);
                }
                Ok(n) => {
                    parser.push(&bytes[..n]);
                    escaped = Instant::now();
                }
                Err(_) => stdin_open = false,
            }
        }
        let due =
            parser.pending_escape() && escaped.elapsed() > Duration::from_millis(ESCAPE_TIMEOUT_MS);
        for ev in parser.drain(due) {
            if ev.kind == Kind::Suspend {
                inner.borrow_mut().apply_input(&ev);
                pty.write(&ev.raw);
                pty.suspend_self();
                continue;
            }
            handle_event(&inner, engine.as_ref(), helper.as_ref(), &ev);
        }

        if let Some(eng) = &engine {
            step_vm(eng);
            drain_edits(&inner, eng);
        }

        if inner.borrow().ledger.ui == Ui::RealProvider {
            trace::emit(&json!({"event": "SAFETY_STOP"}));
            break;
        }
        if let Some(st) = wait_nonblock(pty.child) {
            child_status = st;
            break;
        }
    }

    if let Some(eng) = &engine {
        let _ = eng.call("__dispose", "");
        eng.jobs();
    }
    drop(helper);
    drop(engine);
    inner.borrow_mut().overlay.ui = json!({});
    {
        let g = inner.borrow();
        let out = {
            let mut ov = g.overlay.clone();
            ov.redraw(&g.screen, false, true)
        };
        crate::pty::write_all(1, &out);
    }
    drop(inner);
    if child_status != 0 {
        if libc::WIFEXITED(child_status) {
            return libc::WEXITSTATUS(child_status);
        }
        return 128 + libc::WTERMSIG(child_status);
    }
    pty.close_and_wait()
}

fn load_config() -> Value {
    let mut cfg = json!({
        "hostVersion": std::env::var("MURMO_HOST_VERSION").unwrap_or_else(|_| "unknown".into()),
        "autocorrect": std::env::var("MURMO_AUTOCORRECT").ok().as_deref() == Some("1"),
        "replacements": {},
        "pluginOrder": [],
        "plugins": [],
        "overlay": false,
        "hide": std::env::var("MURMO_HIDE").unwrap_or_default(),
    });
    if let Ok(s) = env::var("MURMO_SHORTCUTS") {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            cfg["replacements"] = v;
        }
    }
    if let Ok(s) = env::var("MURMO_PLUGIN_ORDER") {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            cfg["pluginOrder"] = v;
        }
    }
    if let Ok(s) = env::var("MURMO_CONFIG") {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            if let Some(obj) = v.as_object() {
                for (k, val) in obj {
                    cfg[k] = val.clone();
                }
            }
        }
    }
    cfg
}

fn probe_and_init(inner: &Rc<RefCell<Inner>>, engine: Option<&Engine>, started: Instant) {
    let probe_start = Instant::now();
    let echo_ok = {
        let mut g = inner.borrow_mut();
        g.probed = false;
        let v = g.ledger.version;
        let a = g.host(&json!({"op":"edit","from":0,"to":0,"insert":"a","version":v}));
        // Drain the queued edit immediately for the probe.
        let id = a["pending"].as_u64();
        if let Some(id) = id {
            if let Some(e) = g.edits.iter().find(|e| e["id"] == id).cloned() {
                g.edits.retain(|x| x["id"] != id);
                let r = g.run_edit(&e);
                r["ok"] == true && g.ledger.text == "a"
            } else {
                false
            }
        } else {
            false
        }
    };
    {
        let mut g = inner.borrow_mut();
        if echo_ok {
            let v = g.ledger.version;
            let len = g.ledger.text.encode_utf16().count();
            let q = json!({"from":0,"to":len,"insert":"","version":v});
            let _ = g.run_edit(&q);
        }
        let prompt = g.screen.has_prompt();
        let bracketed = g.screen.saw_bracketed_paste;
        let frames = g.screen.saw_sync_frames;
        let vim = g.screen.contents().contains("Vim:") || true; // optional; off only if we later look
        let run_state = g.screen.saw_run_state;
        let helper = g.probes.helper;
        g.probes
            .finish(prompt, bracketed, frames, echo_ok, vim, run_state, helper);
        g.probed = echo_ok && prompt;
        trace::emit(&json!({
            "event": "capability-probe",
            "ok": g.probed,
            "ms": probe_start.elapsed().as_secs_f64() * 1000.0,
            "record": g.probes.record(),
        }));
    }
    if let Some(eng) = engine {
        let r = eng.call("__init", "");
        eng.jobs();
        trace::emit(&json!({
            "event": "initialized",
            "result": r.is_ok(),
            "load_ms": started.elapsed().as_secs_f64() * 1000.0,
        }));
    }
}

fn handle_event(
    inner: &Rc<RefCell<Inner>>,
    engine: Option<&Engine>,
    helper: Option<&Rc<RefCell<Helper>>>,
    ev: &crate::decoder::Event,
) {
    if matches!(ev.kind, Kind::Reply | Kind::Release) {
        crate::pty::write_all(inner.borrow().fd, &ev.raw);
        return;
    }
    let t = Instant::now();
    let key = ev
        .kind
        .key()
        .map(|k| k.id)
        .unwrap_or_else(|| "Unknown".into());
    let native_owns = {
        let g = inner.borrow();
        g.ledger.ui.native_owns_tab_enter() && (key == "Enter" || key == "Tab")
    };
    if native_owns || engine.is_none() || !inner.borrow().probes.edits_on() {
        let mut g = inner.borrow_mut();
        g.apply_input(ev);
        crate::pty::write_all(g.fd, &ev.raw);
        return;
    }
    let eng = engine.unwrap();

    let event = json!({"kind":"key","key": key, "snapshot": inner.borrow().snapshot()});
    let result = eng.call("__event", &event.to_string());
    let value: Value = result
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    let mut consumed = value["value"] == "consume";

    if !consumed
        && (key == "Enter" || key == "Tab")
        && !inner.borrow().ledger.ui.native_owns_tab_enter()
    {
        consumed = submit_guard(inner, eng, helper, &key);
    }

    let origin = crate::keys::origin_of(&ev.kind);
    let input = match &ev.kind {
        Kind::Char(s) => s.as_str(),
        Kind::Newline => "\n",
        Kind::Paste(s) => s.as_str(),
        _ => "",
    };
    let txid = format!("key-{}", inner.borrow().ledger.version);
    let mut inline_failed = false;
    if !consumed && inner.borrow().probes.transport_on() {
        let deltas = {
            let g = inner.borrow();
            let end = g.ledger.utf16_cursor();
            if !input.is_empty() {
                json!([{"origin": origin, "from": end, "to": end, "insert": input}])
            } else if ev.kind == Kind::Backspace {
                let n = g.ledger.text[..g.ledger.cursor]
                    .graphemes(true)
                    .next_back()
                    .map(|g| g.encode_utf16().count())
                    .unwrap_or(0);
                json!([{"origin":"typed","from": end.saturating_sub(n), "to": end, "insert": ""}])
            } else {
                json!([])
            }
        };
        let plan_s = eng.call(
            "__inline",
            &json!({
                "id": txid,
                "origin": origin,
                "key": key,
                "inputText": input,
                "deltas": deltas,
            })
            .to_string(),
        );
        let plan: Value = plan_s
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({}));
        if plan["action"] == "replace" {
            let base = inner.borrow().ledger.version;
            inline_failed = true;
            let applied = inner.borrow_mut().host(&{
                let mut p = plan.clone();
                p["op"] = json!("inline-edit");
                p["version"] = json!(base);
                p
            });
            if applied["ok"] == true {
                consumed = true;
                inline_failed = false;
                let _ = eng.call(
                    "__inlineDone",
                    &json!({
                        "id": txid,
                        "origin": origin,
                        "status": "applied",
                        "replaced": true,
                        "snapshot": applied["snapshot"],
                        "splice": applied["splice"],
                    })
                    .to_string(),
                );
            }
        }
    }

    if !consumed {
        let before = inner.borrow().ledger.draft_json();
        {
            let mut g = inner.borrow_mut();
            g.apply_input(ev);
            crate::pty::write_all(g.fd, &ev.raw);
        }
        let after = inner.borrow().ledger.draft_json();
        let before_len = before["text"].as_str().unwrap_or("").encode_utf16().count();
        let after_len = after["text"].as_str().unwrap_or("").encode_utf16().count();
        let splice = if after_len >= before_len {
            json!({"from": before["cursor"], "to": before["cursor"], "length": after_len - before_len})
        } else {
            json!({"from": after["cursor"], "to": before["cursor"], "length": 0})
        };
        let _ = eng.call(
            "__event",
            &json!({"kind":"change","splice": splice, "origin": origin, "snapshot": inner.borrow().snapshot()}).to_string(),
        );
        let _ = eng.call(
            "__inlineDone",
            &json!({
                "id": txid,
                "origin": origin,
                "status": if inline_failed { "fallback" } else { "applied" },
                "replaced": false,
                "snapshot": inner.borrow().snapshot(),
            })
            .to_string(),
        );
    }
    if inner.borrow().overlay.dirty {
        let out = inner.borrow_mut().redraw();
        crate::pty::write_all(1, &out);
    }
    trace::emit(&json!({
        "event": "key",
        "key": key,
        "consumed": consumed,
        "ms": t.elapsed().as_secs_f64() * 1000.0,
        "draft": inner.borrow().ledger.draft_json(),
        "state": inner.borrow().ledger.ui.as_str(),
    }));
}

fn submit_guard(
    inner: &Rc<RefCell<Inner>>,
    eng: &Engine,
    helper: Option<&Rc<RefCell<Helper>>>,
    key: &str,
) -> bool {
    let (guarded, allowed) = {
        let g = inner.borrow();
        let guarded = !g.ledger.text.is_empty() || g.ledger.ui != Ui::Idle;
        let allowed = g.ledger.known && g.ledger.ui == Ui::Idle;
        (guarded, allowed)
    };
    if !guarded {
        return false;
    }
    if !allowed {
        inner
            .borrow_mut()
            .overlay
            .set_status("Guard blocked: unknown draft");
        return true;
    }
    let event = json!({
        "kind": "submit",
        "gesture": if key == "Tab" { "queue" } else { "send" },
        "snapshot": inner.borrow().snapshot(),
    });
    let _ = eng.call("__event", &event.to_string());
    let until = Instant::now() + Duration::from_millis(SUBMIT_WAIT_MS);
    let mut decision = None;
    while Instant::now() < until {
        if let Some(h) = helper {
            for line in h.borrow().try_recv() {
                let _ = eng.call("__rpcResult", &line);
                eng.jobs();
            }
        }
        match eng.call("__vmStep", "") {
            Ok(_) => {}
            Err(e) => {
                trace::emit(&json!({"event":"plugin-cpu-fault","reason": e}));
                let _ = eng.call("__vmFault", "native CPU budget exceeded");
            }
        }
        eng.jobs();
        if let Ok(s) = eng.call("__decisionGet", "") {
            if s != "null" && !s.is_empty() {
                decision = serde_json::from_str::<Value>(&s).ok();
                break;
            }
        }
        let _ = eng.call("__tick", "");
        inner.borrow_mut().drain_output(1);
    }
    match decision.and_then(|d| {
        let action = d.get("action").and_then(Value::as_str)?.to_owned();
        Some((action, d))
    }) {
        Some((action, _)) if action == "send" => false,
        Some((action, d)) if action == "replace" => {
            let (version, len) = {
                let b = inner.borrow();
                (b.ledger.version, b.ledger.text.encode_utf16().count())
            };
            let r = inner.borrow_mut().run_edit(&json!({
                "from": 0, "to": len, "insert": d["text"].as_str().unwrap_or(""), "version": version
            }));
            r["ok"] != true
        }
        Some((_, d)) => {
            inner
                .borrow_mut()
                .overlay
                .set_status(d["reason"].as_str().unwrap_or("blocked"));
            true
        }
        None => {
            inner.borrow_mut().overlay.set_status("Guard timeout");
            true
        }
    }
}

fn step_vm(eng: &Engine) {
    for _ in 0..32 {
        match eng.call("__vmStep", "") {
            Ok(s) if s == "none" => break,
            Err(e) => {
                trace::emit(&json!({"event":"plugin-cpu-fault","reason": e}));
                let _ = eng.call("__vmFault", "native CPU budget exceeded");
            }
            _ => {}
        }
        eng.jobs();
    }
}

fn drain_edits(inner: &Rc<RefCell<Inner>>, eng: &Engine) {
    let request = {
        let mut g = inner.borrow_mut();
        if g.edits.is_empty() {
            None
        } else {
            Some(g.edits.remove(0))
        }
    };
    let Some(e) = request else { return };
    let permit = eng
        .call("__permit", &e["id"].to_string())
        .unwrap_or_else(|_| "false".into())
        == "true";
    let result = if !permit {
        json!({"ok": false, "why": "cancelled", "snapshot": inner.borrow().snapshot()})
    } else {
        inner.borrow_mut().run_edit(&e)
    };
    let _ = eng.call(
        "__complete",
        &json!({"id": e["id"], "result": result}).to_string(),
    );
    eng.jobs();
}

use unicode_segmentation::UnicodeSegmentation;
