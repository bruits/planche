# File format

A board is a folder of JSON files, one per element, with each image named by the SHA-256 digest of its bytes and the extension they tell, such as `.png`, when they tell one. An image element names its asset's file the same way. `crates/format` reads and writes it, and its `lib.rs` lists the files.

The format is made to live in Git. One file per element keeps merges clean and diffs readable, and immutable assets go to Git LFS. A database was ruled out because Git cannot merge it, and a single JSON file with images in base64 because it is heavy and diffs badly. JSON Canvas is too poor to be the native format. Importing and exporting it is an intention.

## Rules

- The same board always writes the same bytes. Nothing on that path iterates a `HashMap`.
- An edit rewrites only the files it touches. Elements stack by a fractional z-index, so restacking one rewrites one file.
- An asset never changes once named. The caller writes it once, before any element that draws it, and checks it against its digest on load, which catches a clone made without Git LFS. Its images then show crossed out.
- `read` refuses a field it does not know at every level, naming it. It leaves out an element file that holds a Git conflict or is not valid, and refuses the board only when `board.json` is. A left-out file is never written or deleted, and a ZIP file or a copy of the board takes it as it is.
- A value at its default is left out, such as a rotation of 0 or an image's edits when it has none.
- The caller draws element ids, as the core has no randomness.
- `Board::repair` heals on read what a merge or a cut save can leave, such as a group cycle or an element stuck to one another branch deleted, or to a file left out. An element it cut from a file left out is written with that link until an edit changes it or moves it off, so that fixing the file brings it back. A link to what another branch deleted goes once the element is written.
- Image metadata keeps a file's name without its path, and a web address without its credentials.

## ZIP files

A board also travels as one ZIP file, which `crates/format/src/zip.rs` reads and writes without I/O, so that a shell moves it a slice at a time. Entries are stored uncompressed, since images are compressed already and deflated bytes depend on the compressor's version. They are dated 1980-01-01, start with the board's `.gitattributes`, and take ZIP64 records only past 65,534 entries or 4 GiB, so the same board gives the same file and a shell reads an image straight out of it.

A board zipped again by another tool still opens. The shell inflates its deflated entries, up to 300 MB each, and the one folder holding every entry and `board.json` is left out. Encrypted entries, other compressions, and files spanning several disks are refused.

`samples/demo/` is a board to try the shells on, and every platform must write `samples/demo.zip` from it byte for byte.

## Versions

The format changes freely until the first release. From then on, any change to the files' shape bumps `FORMAT_VERSION`, `read` migrates every earlier version, and a sample board per version stays as a test fixture.
