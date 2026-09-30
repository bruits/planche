# List available recipes
default:
    @just --list

# Format the whole workspace
fmt:
    cargo fmt --all

# Lint exactly as CI does
lint:
    cargo clippy --workspace --all-targets -- -D warnings
    cargo clippy -p renderer --target wasm32-unknown-unknown -- -D warnings

# Test exactly as CI does, or only the tests whose name holds a word: just test lfs
test *args:
    cargo test --workspace {{args}}

# Build the core for the browser, exactly as CI does
wasm:
    cargo build -p board -p format -p bindings --target wasm32-unknown-unknown

# Install the web app's tools: wasm-bindgen at the version Cargo.lock pins, and TypeScript
setup:
    cargo install --locked wasm-bindgen-cli --version "$(cargo pkgid wasm-bindgen | sed 's/.*@//')"
    pnpm --dir web install

# Build the web app, exactly as CI does
web:
    cargo build -p bindings --target wasm32-unknown-unknown
    wasm-bindgen target/wasm32-unknown-unknown/debug/bindings.wasm --target web --out-dir web/public/js/wasm
    cargo build -p renderer --release --target wasm32-unknown-unknown
    wasm-bindgen target/wasm32-unknown-unknown/release/renderer.wasm --target web --out-dir web/public/js/wasm
    pnpm --dir web exec tsc

# Serve the web app on http://localhost:8080
serve: web
    python3 -m http.server 8080 --directory web/public

# Run the desktop app
desktop: web
    cargo run -p desktop

# Everything CI checks, in CI order
ci:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo clippy -p renderer --target wasm32-unknown-unknown -- -D warnings
    cargo test --workspace
    cargo build -p board -p format -p bindings --target wasm32-unknown-unknown
    just web
    cargo build -p desktop
