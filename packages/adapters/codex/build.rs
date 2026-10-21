// Embed the esbuild IIFE (pnpm build) so the wrapper has one JS policy
// (lesson 57). Cargo test can run decoder/args without a bundle: a stub is
// enough to compile; MURMO_BUNDLE overrides at runtime for a rebuilt engine.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let dest = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("engine.js");
    let src = Path::new("dist/quickjs/engine.js");
    println!("cargo:rerun-if-changed=dist/quickjs/engine.js");
    if src.exists() {
        fs::copy(src, &dest).expect("copy engine bundle");
    } else {
        fs::write(
            &dest,
            "/* stub: run pnpm build before a product murmo-codex */\nglobalThis.__init=function(){return '{\"ok\":false,\"why\":\"no-bundle\"}'};\n",
        )
        .expect("write engine stub");
    }
}
