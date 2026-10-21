//! Embedded QuickJS shared by `murmo-plugin-host` and the `murmo codex` wrapper.
//!
//! Both run the same JavaScript bundles (one JS policy, lesson 57), so both get
//! the same engine setup: a memory limit, a stack limit, and a CPU deadline on
//! every entry into guest code. Values cross the boundary as JSON text.

use std::cell::Cell;
use std::fmt;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::{CaughtError, Context, Ctx, Function, Object, Runtime, Value};

/// Resource limits for one engine. Callers choose them; phase 10 and phase 23
/// own the numbers.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub memory_bytes: usize,
    pub stack_bytes: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum JsError {
    /// The engine could not be created.
    Init(String),
    /// Guest code ran past its CPU deadline and was interrupted.
    Timeout,
    /// Guest code threw, or a value could not cross the boundary.
    Exception(String),
}

impl fmt::Display for JsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JsError::Init(m) => write!(f, "engine init failed: {m}"),
            JsError::Timeout => write!(f, "guest code passed its deadline"),
            JsError::Exception(m) => write!(f, "guest error: {m}"),
        }
    }
}

impl std::error::Error for JsError {}

pub struct Engine {
    runtime: Runtime,
    context: Context,
    deadline: Rc<Cell<Option<Instant>>>,
    interrupted: Rc<Cell<bool>>,
}

impl Engine {
    pub fn new(limits: Limits) -> Result<Self, JsError> {
        let runtime = Runtime::new().map_err(|e| JsError::Init(e.to_string()))?;
        runtime.set_memory_limit(limits.memory_bytes);
        runtime.set_max_stack_size(limits.stack_bytes);
        let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
        let interrupted = Rc::new(Cell::new(false));
        let (watch, flag) = (deadline.clone(), interrupted.clone());
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let late = watch.get().is_some_and(|d| Instant::now() >= d);
            if late {
                flag.set(true);
            }
            late
        })));
        let context = Context::full(&runtime).map_err(|e| JsError::Init(e.to_string()))?;
        Ok(Engine {
            runtime,
            context,
            deadline,
            interrupted,
        })
    }

    /// Evaluate a classic script (an IIFE bundle) in the global scope.
    pub fn load_script(&self, source: &str, budget: Duration) -> Result<(), JsError> {
        self.guarded(budget, |ctx| {
            let result = ctx.eval::<(), _>(source);
            CaughtError::catch(&ctx, result).map_err(describe)
        })
    }

    /// Call a global function by dotted path (`MurmoCore.plan`) with one JSON
    /// argument; returns the JSON of its result (`undefined` becomes `null`).
    pub fn call_json(
        &self,
        path: &str,
        arg_json: &str,
        budget: Duration,
    ) -> Result<String, JsError> {
        self.guarded(budget, |ctx| {
            let result = (|| {
                let function = lookup(&ctx, path)?;
                let arg = ctx.json_parse(arg_json)?;
                let value: Value = function.call((arg,))?;
                let text = ctx.json_stringify(value)?;
                match text {
                    Some(s) => s.to_string(),
                    None => Ok("null".to_owned()),
                }
            })();
            CaughtError::catch(&ctx, result).map_err(describe)
        })
    }

    /// Bytes the engine has allocated, for budgets and reports.
    pub fn memory_used(&self) -> i64 {
        self.runtime.memory_usage().malloc_size
    }

    fn guarded<R>(
        &self,
        budget: Duration,
        run: impl FnOnce(Ctx<'_>) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        self.interrupted.set(false);
        self.deadline.set(Some(Instant::now() + budget));
        let result = self.context.with(run);
        self.deadline.set(None);
        if self.interrupted.replace(false) {
            return Err(JsError::Timeout);
        }
        result
    }
}

fn lookup<'js>(ctx: &Ctx<'js>, path: &str) -> rquickjs::Result<Function<'js>> {
    let mut parts = path.split('.').peekable();
    let mut object: Object = ctx.globals();
    while let Some(name) = parts.next() {
        if parts.peek().is_none() {
            return object.get(name);
        }
        object = object.get(name)?;
    }
    Err(rquickjs::Error::new_from_js("empty path", "function"))
}

fn describe(error: CaughtError<'_>) -> JsError {
    JsError::Exception(match error {
        CaughtError::Exception(ex) => ex.message().unwrap_or_else(|| ex.to_string()),
        CaughtError::Value(v) => format!("{v:?}"),
        CaughtError::Error(e) => e.to_string(),
    })
}
