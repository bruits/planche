# File format

A board is a folder of JSON files, one per element, with each image named by the SHA-256 digest of its bytes. `crates/format` reads and writes it, and its `lib.rs` lists the files.

The format is made to live in Git. One file per element keeps merges clean and diffs readable, and immutable assets go to Git LFS. A database was ruled out because Git cannot merge it, and a single JSON file with images in base64 because it is heavy and diffs badly. JSON Canvas is too poor to be the native format. Importing and exporting it is an intention.

## Rules

- The same board always writes the same bytes. Nothing on that path iterates a `HashMap`.
- An edit rewrites only the files it touches. Elements stack by a fractional z-index, so restacking one rewrites one file.
- An asset never changes once named. The caller writes it once, before any element that draws it, and checks it against its digest on load, which catches a clone made without Git LFS.
- The caller draws element ids, as the core has no randomness.
- `Board::repair` heals on read what a merge or a cut save can leave, such as a group cycle or an element stuck to one another branch deleted.
- Image metadata keeps a file's name without its path, and a web address without its credentials.

## ZIP files

A board also travels as one ZIP file, which `crates/format/src/zip.rs` reads and writes without I/O, so that a shell moves it a slice at a time. Entries are stored uncompressed, since images are compressed already and deflated bytes depend on the compressor's version. They are dated 1980-01-01 and never use ZIP64, so the same board gives the same file and a shell reads an image straight out of it. Compressed, encrypted, and ZIP64 files are refused.

`samples/demo/` is a board to try the shells on, and every platform must write `samples/demo.zip` from it byte for byte.

## Versions

The format changes freely until the first release. From then on, any change to the files' shape bumps `FORMAT_VERSION`, `read` migrates every earlier version, and a sample board per version stays as a test fixture.
