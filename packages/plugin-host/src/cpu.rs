//! Per-invocation thread CPU time (`CLOCK_THREAD_CPUTIME_ID`). Scheduler
//! pressure is wall time, not plugin CPU (r14-load L5).

use std::time::Duration;

/// Thread CPU used by this thread since it started, or `None` when the clock
/// is missing (should not happen on macOS or Linux).
pub fn thread_cpu() -> Option<Duration> {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: timespec is on the stack; clock_gettime only writes it.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    if rc != 0 {
        return None;
    }
    let secs = ts.tv_sec.checked_mul(1_000_000_000)?;
    let nsec = secs.checked_add(ts.tv_nsec)?;
    Some(Duration::from_nanos(nsec as u64))
}
