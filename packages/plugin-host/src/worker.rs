//! Guest worker process: one QuickJS VM, no file I/O, no ambient OS APIs.

use std::cell::Cell;
use std::io::{self, BufRead, Write};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use murmo_js_runtime::{create_runtime, Limits};
use rquickjs::{ArrayBuffer, Context, Ctx, Function, Module, Object};
use serde_json::{json, Value};

use crate::cpu::thread_cpu;
use crate::faults::{classify, error_reply, FaultKind};
use crate::limits::{
    deadline_duration, memory_bytes, slice_duration, DEFAULT_SLICE_MS, INIT_INTERRUPT_MS,
    MAX_MEMORY_MIB, STACK_BYTES,
};
use crate::protocol::{decode_assets, required_memory_mib, source_of};

const GUEST_JS: &str = include_str!("guest.js");

struct Watch {
    wall: Mutex<Instant>,
    cpu_start: Mutex<Option<Duration>>,
    cpu_budget: Mutex<Option<Duration>>,
    interrupted: Mutex<bool>,
    cpu_hit: Mutex<bool>,
    wall_hit: Mutex<bool>,
}

impl Watch {
    fn new() -> Arc<Self> {
        Arc::new(Watch {
            wall: Mutex::new(Instant::now() + Duration::from_millis(INIT_INTERRUPT_MS)),
            cpu_start: Mutex::new(None),
            cpu_budget: Mutex::new(None),
            interrupted: Mutex::new(false),
            cpu_hit: Mutex::new(false),
            wall_hit: Mutex::new(false),
        })
    }

    fn arm(&self, wall: Instant, cpu_budget: Option<Duration>) {
        *self.wall.lock().expect("watch") = wall;
        *self.cpu_start.lock().expect("watch") = thread_cpu();
        *self.cpu_budget.lock().expect("watch") = cpu_budget;
        *self.interrupted.lock().expect("watch") = false;
        *self.cpu_hit.lock().expect("watch") = false;
        *self.wall_hit.lock().expect("watch") = false;
    }

    fn should_interrupt(&self) -> bool {
        let wall_hit = Instant::now() >= *self.wall.lock().expect("watch");
        let cpu_hit = match (
            *self.cpu_start.lock().expect("watch"),
            *self.cpu_budget.lock().expect("watch"),
            thread_cpu(),
        ) {
            (Some(start), Some(budget), Some(now)) => now.saturating_sub(start) >= budget,
            _ => false,
        };
        if wall_hit {
            *self.wall_hit.lock().expect("watch") = true;
        }
        if cpu_hit {
            *self.cpu_hit.lock().expect("watch") = true;
        }
        if wall_hit || cpu_hit {
            *self.interrupted.lock().expect("watch") = true;
            true
        } else {
            false
        }
    }
}

fn reply(v: &Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn install_host<'js>(ctx: &Ctx<'js>, start: Instant, wall: Rc<Cell<f64>>) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    globals.set(
        "__hostNow",
        Function::new(ctx.clone(), move || start.elapsed().as_secs_f64() * 1000.0),
    )?;
    globals.set(
        "__wallTimeMs",
        Function::new(ctx.clone(), move || wall.get()),
    )?;
    globals.set(
        "__decodeUtf8",
        Function::new(ctx.clone(), |bytes: Vec<u8>| -> rquickjs::Result<String> {
            String::from_utf8(bytes)
                .map_err(|e| rquickjs::Error::new_from_js_message("bytes", "UTF-8", e.to_string()))
        }),
    )?;
    Ok(())
}

fn install_assets<'js>(ctx: &Ctx<'js>, assets: &[(String, Vec<u8>)]) -> rquickjs::Result<()> {
    if assets.is_empty() {
        return Ok(());
    }
    let object = Object::new(ctx.clone())?;
    for (name, bytes) in assets {
        object.set(name.as_str(), ArrayBuffer::new(ctx.clone(), bytes.clone())?)?;
    }
    ctx.globals().set("__murmoAssets", object)?;
    Ok(())
}

fn load_factory<'js>(ctx: &Ctx<'js>, name: &str, source: &str) -> rquickjs::Result<Function<'js>> {
    let module = Module::declare(ctx.clone(), name, source)?;
    let (module, promise) = module.eval()?;
    promise.finish::<()>()?;
    module.get("default")
}

fn init_member(ctx: &Ctx<'_>, id: &str) -> rquickjs::Result<String> {
    let init: Function = ctx.globals().get("__initMember")?;
    init.call((id,))
}

struct Prepared {
    id: String,
    source: String,
    settings: Value,
    assets: Vec<(String, Vec<u8>)>,
}

fn members_of(cfg: &Value) -> Result<Vec<Prepared>, String> {
    if let Some(list) = cfg.get("members").and_then(Value::as_array) {
        let mut out = Vec::new();
        for member in list {
            let id = member
                .get("id")
                .and_then(Value::as_str)
                .ok_or("member id required")?
                .to_string();
            let source = source_of(member)?.to_string();
            let settings = member.get("settings").cloned().unwrap_or_else(|| json!({}));
            let assets = decode_assets(member.get("assets"))?;
            out.push(Prepared {
                id,
                source,
                settings,
                assets,
            });
        }
        return Ok(out);
    }
    let id = cfg
        .get("plugin")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_string();
    Ok(vec![Prepared {
        id,
        source: source_of(cfg)?.to_string(),
        settings: cfg.get("settings").cloned().unwrap_or_else(|| json!({})),
        assets: decode_assets(cfg.get("assets"))?,
    }])
}

fn join_member(ctx: &Ctx<'_>, member: &Prepared) -> Result<Value, String> {
    let factory = load_factory(ctx, &member.id, &member.source).map_err(|e| e.to_string())?;
    let factories: Object = ctx
        .globals()
        .get("__factories")
        .map_err(|e| e.to_string())?;
    factories
        .set(member.id.as_str(), factory)
        .map_err(|e| e.to_string())?;
    let settings_obj: Object = ctx
        .globals()
        .get("__memberSettings")
        .map_err(|e| e.to_string())?;
    let parsed = ctx
        .json_parse(member.settings.to_string())
        .map_err(|e| e.to_string())?;
    settings_obj
        .set(member.id.as_str(), parsed)
        .map_err(|e| e.to_string())?;
    install_assets(ctx, &member.assets).map_err(|e| e.to_string())?;
    let meta = init_member(ctx, &member.id).map_err(|e| e.to_string())?;
    serde_json::from_str(&meta).map_err(|e| e.to_string())
}

fn run_call(
    runtime: &rquickjs::Runtime,
    ctx: &Context,
    watch: &Arc<Watch>,
    wall: &Rc<Cell<f64>>,
    line: &str,
    q: &Value,
    default_slice: u64,
) -> Value {
    let t = Instant::now();
    let slice = q
        .get("sliceMs")
        .or_else(|| q.get("cpuMs"))
        .and_then(Value::as_u64)
        .unwrap_or(default_slice);
    let deadline_ms = q
        .get("deadlineMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SLICE_MS);
    let wall_deadline = t + deadline_duration(deadline_ms);
    let slice_wall = Instant::now() + slice_duration(slice);
    let interrupt_at = wall_deadline.min(slice_wall);
    watch.arm(interrupt_at, Some(slice_duration(slice)));
    wall.set(
        q.get("wallTimeMs")
            .and_then(Value::as_f64)
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0)
            }),
    );

    let invoked = ctx.with(|c| {
        let start: Function = c.globals().get("__start")?;
        start.call::<_, ()>((line.to_string(),))
    });
    let mut caught: Option<String> = invoked.err().map(|e| e.to_string());
    let mut allocation = false;
    let mut output = None;

    while caught.is_none() {
        while runtime.is_job_pending() {
            watch.arm(
                wall_deadline.min(Instant::now() + slice_duration(slice)),
                Some(slice_duration(slice)),
            );
            if let Err(e) = runtime.execute_pending_job() {
                allocation = false;
                let message = format!("{e:?}");
                caught = Some(message.clone());
                // rquickjs reports an interrupted job as JobException, not as
                // Error::Allocation; the watchdog already decided this is cpu.
                if message.contains("JobException") {
                    *watch.interrupted.lock().expect("watch") = true;
                    *watch.cpu_hit.lock().expect("watch") = true;
                }
                break;
            }
            if t.elapsed() >= deadline_duration(deadline_ms) {
                *watch.wall_hit.lock().expect("watch") = true;
                caught = Some("deadline exceeded".into());
                break;
            }
        }
        if caught.is_some() {
            break;
        }
        let value = ctx.with(|c| {
            let f: Function = c.globals().get("__getOutput")?;
            f.call::<_, Option<String>>(())
        });
        match value {
            Ok(Some(s)) => {
                output = serde_json::from_str::<Value>(&s).ok();
                break;
            }
            Err(e) => {
                if matches!(e, rquickjs::Error::Allocation) {
                    allocation = true;
                }
                caught = Some(e.to_string());
                break;
            }
            Ok(None) => {}
        }
        if t.elapsed() >= deadline_duration(deadline_ms) {
            *watch.wall_hit.lock().expect("watch") = true;
            caught = Some("deadline exceeded".into());
            break;
        }
        let ran = ctx.with(|c| {
            let f: Function = c.globals().get("__runTimers")?;
            f.call::<_, ()>(())
        });
        if let Err(e) = ran {
            caught = Some(e.to_string());
            break;
        }
        std::thread::sleep(Duration::from_micros(100));
    }

    let interrupted = *watch.interrupted.lock().expect("watch");
    let cpu_hit = *watch.cpu_hit.lock().expect("watch");
    let wall_hit = *watch.wall_hit.lock().expect("watch");
    let mut out = output.unwrap_or_else(|| {
        let kind = if allocation {
            FaultKind::Memory
        } else {
            classify(None, interrupted, cpu_hit, wall_hit)
        };
        error_reply(
            kind,
            &caught.unwrap_or_else(|| "invalid guest output".into()),
        )
    });
    if out.get("status").and_then(Value::as_str) == Some("error") && out.get("kind").is_none() {
        let kind = if allocation {
            FaultKind::Memory
        } else {
            classify(None, interrupted, cpu_hit, wall_hit)
        };
        out["kind"] = json!(kind.as_str());
    }
    out["durationMs"] = json!(t.elapsed().as_secs_f64() * 1000.0);
    out
}

/// Worker process entry: first stdin line is the load config.
pub fn run() {
    let stdin = io::stdin();
    let mut input = stdin.lock().lines();
    let Some(Ok(first)) = input.next() else {
        return;
    };
    let cfg: Value = match serde_json::from_str(&first) {
        Ok(v) => v,
        Err(e) => {
            reply(&error_reply(FaultKind::Plugin, &e.to_string()));
            return;
        }
    };
    let memory_mib = match required_memory_mib(&cfg) {
        Ok(n) if n <= MAX_MEMORY_MIB => n,
        Ok(n) => {
            reply(&error_reply(
                FaultKind::Memory,
                &format!("memoryMiB {n} exceeds {MAX_MEMORY_MIB}"),
            ));
            return;
        }
        Err(e) => {
            reply(&error_reply(FaultKind::Plugin, &e));
            return;
        }
    };
    let members = match members_of(&cfg) {
        Ok(m) if !m.is_empty() => m,
        Ok(_) => {
            reply(&error_reply(
                FaultKind::Plugin,
                "load requires source or members",
            ));
            return;
        }
        Err(e) => {
            reply(&error_reply(FaultKind::Plugin, &e));
            return;
        }
    };
    let default_slice = cfg
        .get("sliceMs")
        .or_else(|| cfg.get("cpuMs"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SLICE_MS);

    let limits = Limits {
        memory_bytes: memory_bytes(memory_mib),
        stack_bytes: STACK_BYTES,
    };
    let runtime = match create_runtime(limits) {
        Ok(rt) => rt,
        Err(e) => {
            reply(&error_reply(FaultKind::Plugin, &e.to_string()));
            return;
        }
    };
    let watch = Watch::new();
    let watch_handler = watch.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || watch_handler.should_interrupt())));
    let ctx = match Context::full(&runtime) {
        Ok(c) => c,
        Err(e) => {
            reply(&error_reply(FaultKind::Plugin, &e.to_string()));
            return;
        }
    };
    let start = Instant::now();
    let wall = Rc::new(Cell::new(0.0));
    watch.arm(
        Instant::now() + Duration::from_millis(INIT_INTERRUPT_MS),
        Some(Duration::from_millis(INIT_INTERRUPT_MS)),
    );

    let init = ctx.with(|c| -> Result<Value, String> {
        install_host(&c, start, wall.clone()).map_err(|e| e.to_string())?;
        c.eval::<(), _>(GUEST_JS).map_err(|e| e.to_string())?;
        let factories = Object::new(c.clone()).map_err(|e| e.to_string())?;
        let settings = Object::new(c.clone()).map_err(|e| e.to_string())?;
        c.globals()
            .set("__factories", factories)
            .map_err(|e| e.to_string())?;
        c.globals()
            .set("__memberSettings", settings)
            .map_err(|e| e.to_string())?;
        let mut descriptors = Vec::new();
        for member in &members {
            let meta = join_member(&c, member)?;
            descriptors.push((member.id.clone(), meta));
        }
        let mut members_obj = serde_json::Map::new();
        for (id, meta) in &descriptors {
            members_obj.insert(id.clone(), meta.clone());
        }
        let primary = descriptors
            .first()
            .map(|(_, m)| m.clone())
            .unwrap_or(Value::Null);
        Ok(json!({
            "status": "ok",
            "metadata": primary,
            "members": members_obj,
        }))
    });
    match init {
        Ok(ok) => reply(&ok),
        Err(e) => {
            let interrupted = *watch.interrupted.lock().expect("watch");
            let kind = classify(None, interrupted, false, false);
            reply(&error_reply(kind, &e));
            return;
        }
    }

    for line in input {
        let Ok(line) = line else {
            break;
        };
        let Ok(q) = serde_json::from_str::<Value>(&line) else {
            reply(&error_reply(FaultKind::Transport, "invalid JSON"));
            continue;
        };
        if q.get("op").and_then(Value::as_str) == Some("fault") {
            if cfg!(debug_assertions) {
                std::process::exit(77);
            }
            reply(&error_reply(
                FaultKind::Transport,
                "fault is only available in test builds",
            ));
            continue;
        }
        if q.get("op").and_then(Value::as_str) == Some("join") {
            let member_val = q.get("member").cloned().unwrap_or(Value::Null);
            match members_of(&json!({"members": [member_val]})) {
                Ok(list) => match list.into_iter().next() {
                    Some(member) => match ctx.with(|c| join_member(&c, &member)) {
                        Ok(meta) => reply(&json!({"status": "ok", "metadata": meta})),
                        Err(e) => reply(&error_reply(FaultKind::Plugin, &e)),
                    },
                    None => reply(&error_reply(FaultKind::Plugin, "join requires a member")),
                },
                Err(e) => reply(&error_reply(FaultKind::Plugin, &e)),
            }
            continue;
        }
        let out = run_call(&runtime, &ctx, &watch, &wall, &line, &q, default_slice);
        reply(&out);
    }
}
