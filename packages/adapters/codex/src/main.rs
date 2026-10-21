//! `murmo-codex`: wrap stock Codex in a PTY, or exec it for non-interactive
//! commands so IDE-spawned processes are never touched (lesson 40).

use std::env;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;

use murmo_codex::args::{self, Launch};
use murmo_codex::forward;
use murmo_codex::pty::exec_stock;
use murmo_codex::RECURSION_GUARD;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let self_exe = env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("murmo-codex"));
    let path = env::var_os("PATH").unwrap_or_default();
    match args::launch(&self_exe, &args, &path) {
        Ok(Launch::PassThrough { bin, argv }) => {
            env::set_var(RECURSION_GUARD, "1");
            let bin_c = CString::new(bin.as_os_str().as_bytes())
                .unwrap_or_else(|_| CString::new("codex").unwrap());
            let args_c: Vec<CString> = argv
                .iter()
                .filter_map(|s| CString::new(s.as_bytes()).ok())
                .collect();
            exec_stock(&bin_c, &args_c);
        }
        Ok(launch) => {
            let code = forward::run(launch, &self_exe);
            std::process::exit(code);
        }
        Err(e) => {
            eprintln!("murmo-codex: {e}");
            std::process::exit(1);
        }
    }
}
