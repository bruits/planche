//! Declares the board's types in the TypeScript that wasm-bindgen writes for the web app.

use std::path::PathBuf;
use std::{env, fs};

fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("set by Cargo")).join("types.d.ts");
    fs::write(out, board::typescript()).expect("the build's own folder takes files");
}
