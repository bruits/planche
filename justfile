# List available recipes
default:
    @just --list

# Format the whole workspace, the web app included
fmt:
    cargo fmt --all
    pnpm --dir web run fmt

# Lint exactly as CI does, the web app against the core's bindings it builds
lint: web
    cargo clippy --workspace --all-targets -- -D warnings
    cargo clippy -p renderer --target wasm32-unknown-unknown -- -D warnings
    pnpm --dir web run lint
    pnpm --dir web run typecheck

# Test exactly as CI does, or only the tests whose name holds a word: just test lfs
test *args: web
    cargo test --workspace {{args}}
    pnpm --dir web test {{ if args == "" { "" } else if args =~ '^-' { "" } else { "-t " + quote(replace_regex(args, ' .*', '')) } }}

# Build the core for the browser, exactly as CI does
wasm:
    cargo build -p board -p format -p bindings --target wasm32-unknown-unknown

# Install the web app's tools: wasm-bindgen at the version Cargo.lock pins, and those web/package.json pins
setup:
    cargo install --locked wasm-bindgen-cli --version "$(cargo pkgid wasm-bindgen | sed 's/.*@//')"
    pnpm --dir web install

# Build the web app, exactly as CI does
web:
    cargo build -p bindings --release --target wasm32-unknown-unknown
    wasm-bindgen target/wasm32-unknown-unknown/release/bindings.wasm --target web --out-dir web/public/js/wasm
    cargo build -p renderer --release --target wasm32-unknown-unknown
    wasm-bindgen target/wasm32-unknown-unknown/release/renderer.wasm --target web --out-dir web/public/js/wasm
    pnpm --dir web run build

# Time the core compiled to WASM, by hand and never in CI: just bench for a release build, or just bench debug
bench profile="release":
    cargo build -p bindings --target wasm32-unknown-unknown {{ if profile == "release" { "--release" } else if profile == "debug" { "" } else { error("the profile is release or debug") } }}
    wasm-bindgen target/wasm32-unknown-unknown/{{ profile }}/bindings.wasm --target nodejs --out-dir target/bench/{{ profile }}
    node crates/bindings/bench.cjs target/bench/{{ profile }} {{ profile }}

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
    pnpm --dir web run fmt:check
    just web
    pnpm --dir web run lint
    pnpm --dir web run typecheck
    pnpm --dir web test
    cargo build -p desktop
