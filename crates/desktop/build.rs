fn main() {
    // The web app is embedded at compile time, and new files in it must rebuild the shell.
    println!("cargo:rerun-if-changed=../../web/public");
    tauri_build::build();
}
