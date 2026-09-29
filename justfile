# List available recipes
default:
    @just --list

# Format the whole workspace
fmt:
    cargo fmt --all

# Lint exactly as CI does
lint:
    cargo clippy --workspace --all-targets -- -D warnings

# Test exactly as CI does, or only the tests whose name holds a word: just test lfs
test *args:
    cargo test --workspace {{args}}

# Build the core for the browser, exactly as CI does
wasm:
    cargo build -p board -p format --target wasm32-unknown-unknown

# Everything CI checks, in CI order
ci:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace
    cargo build -p board -p format --target wasm32-unknown-unknown
