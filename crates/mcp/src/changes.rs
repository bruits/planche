//! What agents may change on the board, as their tools take it, and the image files the app reads
//! for them, which the web app never names.

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, Prefix};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::Value;

pub const MOST_IDS: usize = 100;
pub const MOST_ELEMENTS: usize = 50;
pub const MOST_IMAGES: usize = 12;
/// What a page holds of a few large photos at once, read and passed on whole.
const MOST_FILE: u64 = 25 << 20;
const MOST_FILES: u64 = 50 << 20;
/// In base64, which costs the agent as much to write as to read.
const MOST_DATA: usize = 5_000_000;
const MOST_TEXT: usize = 10_000;
const MOST_LABEL: usize = 2_000;

// Inlined, here and below, as some clients read no `$ref` in a tool's input.
/// In board units, with y going down.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// In the image's pixels.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct Pixels {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Ids {
    #[schemars(length(min = 1, max = MOST_IDS))]
    pub ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AddImagesArguments {
    #[schemars(length(min = 1, max = MOST_IMAGES))]
    pub images: Vec<NewImage>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct NewImage {
    /// An absolute path to an image or video file on this machine, of 25 MB at most.
    pub path: Option<String>,
    /// The file's bytes in base64, for a small file without a path.
    pub data: Option<String>,
    /// The file's name, kept with the image. A path gives its own.
    pub filename: Option<String>,
    /// The left of the image. Without `x` and `y`, images line up around the view's centre.
    pub x: Option<f64>,
    /// The top of the image.
    pub y: Option<f64>,
    /// Its height follows. Its size in pixels by default.
    pub width: Option<f64>,
    /// Where it came from, such as the address of a page.
    pub source: Option<String>,
    /// What it shows.
    pub caption: Option<String>,
    /// An existing group to add it into, the top level by default.
    pub group: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AddArguments {
    #[schemars(length(min = 1, max = MOST_ELEMENTS))]
    pub elements: Vec<NewElement>,
    /// Whether what lies on an element sticks to it, and follows it: notes, stickies, shapes and
    /// comments as a whole, and each end of an arrow or a line. True by default.
    pub stick: Option<bool>,
}

/// Sizes and font sizes default to what a click places at the view's zoom.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(inline)]
pub enum NewElement {
    /// Text alone, as tall as its lines. `x` and `y` are its top left corner.
    Note {
        x: f64,
        y: f64,
        width: Option<f64>,
        text: String,
        font_size: Option<f64>,
        /// Clockwise, in degrees.
        rotation: Option<f64>,
        group: Option<String>,
        colour: Option<Colour>,
        bold: Option<bool>,
        italic: Option<bool>,
        /// Struck through.
        strike: Option<bool>,
        /// Left by default.
        align: Option<Align>,
    },
    /// A sticky note, which grows to hold its text. `x` and `y` are its top left corner.
    Sticky {
        x: f64,
        y: f64,
        width: Option<f64>,
        height: Option<f64>,
        text: Option<String>,
        font_size: Option<f64>,
        rotation: Option<f64>,
        group: Option<String>,
        /// Yellow by default, whatever the theme.
        paper: Option<Paper>,
        bold: Option<bool>,
        italic: Option<bool>,
        strike: Option<bool>,
        /// Left by default.
        align: Option<Align>,
    },
    /// A rectangle by default, which grows to hold its text, centred. `x` and `y` are its top
    /// left corner.
    Shape {
        shape: Option<ShapeKind>,
        x: f64,
        y: f64,
        width: Option<f64>,
        height: Option<f64>,
        text: Option<String>,
        font_size: Option<f64>,
        rotation: Option<f64>,
        group: Option<String>,
        colour: Option<Colour>,
        weight: Option<Weight>,
        /// Of its outline.
        dash: Option<Dash>,
        /// Hollow by default. Not for a cross.
        fill: Option<Fill>,
        /// Of its text, which it needs.
        bold: Option<bool>,
        italic: Option<bool>,
        strike: Option<bool>,
        /// Centred by default.
        align: Option<Align>,
    },
    /// Its head is at `to`, unless `heads` says both ends.
    Arrow {
        from: Point,
        to: Point,
        group: Option<String>,
        colour: Option<Colour>,
        weight: Option<Weight>,
        dash: Option<Dash>,
        heads: Option<Heads>,
    },
    Line {
        from: Point,
        to: Point,
        group: Option<String>,
        colour: Option<Colour>,
        weight: Option<Weight>,
        dash: Option<Dash>,
    },
    /// Pinned at `at`.
    Comment {
        at: Point,
        text: String,
        group: Option<String>,
    },
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum ShapeKind {
    Rectangle,
    Ellipse,
    Cross,
}

/// A colour of the palette, which each theme draws its own way so that it reads, ink by default,
/// or `#rrggbb`, which every theme draws alike.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(transparent)]
#[schemars(inline, extend("pattern" = "^(ink|red|orange|green|blue|violet|#[0-9a-fA-F]{6})$"))]
pub struct Colour(String);

/// As the schema's pattern says, which clients may not check.
impl<'de> Deserialize<'de> for Colour {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let colour = String::deserialize(deserializer)?;
        let named = ["ink", "red", "orange", "green", "blue", "violet"].contains(&colour.as_str());
        let hex = colour.strip_prefix('#').is_some_and(|digits| {
            digits.len() == 6 && digits.bytes().all(|digit| digit.is_ascii_hexdigit())
        });
        if named || hex {
            Ok(Self(colour))
        } else {
            Err(de::Error::custom(format!(
                "`{colour}` is not a colour, which is ink, red, orange, green, blue, violet, or #rrggbb"
            )))
        }
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Paper {
    Yellow,
    Pink,
    Blue,
    Green,
    Lilac,
}

/// Of strokes, medium by default.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Weight {
    Thin,
    Medium,
    Thick,
}

/// Solid by default.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Dash {
    Solid,
    Dashed,
}

/// Which ends of an arrow draw a head, `to` alone by default.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Heads {
    End,
    Both,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Fill {
    Hollow,
    Tint,
    Solid,
}

/// What an image shows of its crop, the whole of it by default, or the ellipse that fills it.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum CropShape {
    Rectangle,
    Ellipse,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Align {
    Left,
    Centre,
    Right,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateArguments {
    #[schemars(length(min = 1, max = MOST_IDS))]
    pub updates: Vec<Update>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct Update {
    pub id: String,
    /// For a note, a sticky note, a shape, or a comment.
    pub text: Option<String>,
    /// For a note, a sticky note, or a shape.
    pub font_size: Option<f64>,
    pub shape: Option<ShapeKind>,
    /// For an image. Empty, it goes.
    pub caption: Option<String>,
    /// For an image. Empty, it goes.
    pub source: Option<String>,
    /// For an image.
    pub greyscale: Option<bool>,
    /// For an image, the part of it to show, in its pixels, all of them to show it whole. Each
    /// pixel it still shows stays where it was, at the same size.
    pub crop: Option<Pixels>,
    /// For an image.
    pub crop_shape: Option<CropShape>,
    /// For a note, a shape, an arrow, or a line, a colour of the palette, which each theme draws
    /// its own way, or `#rrggbb`, which every theme draws alike.
    pub colour: Option<Colour>,
    /// For a sticky note.
    pub paper: Option<Paper>,
    /// For a shape, an arrow, or a line.
    pub weight: Option<Weight>,
    /// For a shape, an arrow, or a line.
    pub dash: Option<Dash>,
    /// For an arrow.
    pub heads: Option<Heads>,
    /// For a rectangle or an ellipse.
    pub fill: Option<Fill>,
    /// For a note, a sticky note, or a shape holding text.
    pub bold: Option<bool>,
    /// For a note, a sticky note, or a shape holding text.
    pub italic: Option<bool>,
    /// For a note, a sticky note, or a shape holding text, struck through.
    pub strike: Option<bool>,
    /// For a note, a sticky note, or a shape holding text.
    pub align: Option<Align>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransformArguments {
    #[schemars(length(min = 1, max = MOST_IDS))]
    pub ids: Vec<String>,
    /// Images only.
    pub flip: Option<Flip>,
    /// A factor, about `about`.
    pub scale: Option<f64>,
    /// In board units, which the elements together scale to, about `about`.
    pub width: Option<f64>,
    /// Where they scale and rotate about, their centre by default.
    pub about: Option<Point>,
    /// Clockwise, in degrees, about `about`.
    pub rotate: Option<f64>,
    /// How far they move.
    pub translate: Option<Point>,
    /// Where their top left corner goes, once flipped, scaled, and rotated.
    pub move_to: Option<Point>,
    /// Whether what lands on an element sticks to it. True by default.
    pub stick: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Flip {
    Horizontal,
    Vertical,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RestackArguments {
    #[schemars(length(min = 1, max = MOST_IDS))]
    pub ids: Vec<String>,
    pub to: Restack,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Restack {
    Front,
    Forward,
    Backward,
    Back,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SelectArguments {
    /// None, to select nothing.
    #[schemars(length(max = MOST_IDS))]
    pub ids: Vec<String>,
    /// Whether the view turns to them.
    pub frame: Option<bool>,
}

pub fn refused(tool: &str, args: &Value) -> Option<String> {
    let most = match tool {
        "add" => MOST_ELEMENTS,
        "add_images" => MOST_IMAGES,
        _ => MOST_IDS,
    };
    let listed = ["ids", "elements", "images", "updates"]
        .iter()
        .find_map(|key| args[key].as_array());
    if listed.is_some_and(|list| list.len() > most) {
        return Some(format!("At most {most} at a time"));
    }
    long(args)
}

/// The first text over its length, which the board would carry to every agent that reads it.
fn long(value: &Value) -> Option<String> {
    match value {
        Value::Object(fields) => {
            fields
                .iter()
                .find_map(|(key, value)| match (key.as_str(), value) {
                    ("text", Value::String(text)) if text.chars().count() > MOST_TEXT => {
                        Some(format!("A text holds {MOST_TEXT} characters at most"))
                    }
                    ("caption" | "source" | "filename", Value::String(text))
                        if text.chars().count() > MOST_LABEL =>
                    {
                        Some(format!("A {key} holds {MOST_LABEL} characters at most"))
                    }
                    _ => long(value),
                })
        }
        Value::Array(values) => values.iter().find_map(long),
        _ => None,
    }
}

pub fn read_images(images: &mut [NewImage]) -> Result<(), String> {
    let mut total = 0;
    for image in images.iter_mut() {
        match (image.path.take(), &image.data) {
            (Some(path), None) => {
                let (name, bytes) = read(Path::new(&path))?;
                total += bytes.len() as u64;
                if total > MOST_FILES {
                    return Err(format!(
                        "{} MB of files at most at a time",
                        MOST_FILES >> 20
                    ));
                }
                image.filename = Some(image.filename.take().unwrap_or(name));
                image.data = Some(STANDARD.encode(bytes));
            }
            (None, Some(data)) if data.len() > MOST_DATA => {
                return Err(format!(
                    "data holds {MOST_DATA} characters at most: give a path for a larger file"
                ));
            }
            (None, Some(_)) => {}
            _ => return Err("Give each image a path or data, not both".to_owned()),
        }
        image.filename = image.filename.take().map(|name| last(&name).to_owned());
    }
    Ok(())
}

/// Only a regular file, so that no device or pipe holds the call up.
fn read(path: &Path) -> Result<(String, Vec<u8>), String> {
    let shown = path.display();
    if !on_this_machine(path) {
        return Err(format!("{shown}: a path must be absolute, on this machine"));
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("{shown}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{shown}: not a file"));
    }
    if metadata.len() > MOST_FILE {
        return Err(format!("{shown}: over {} MB", MOST_FILE >> 20));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(MOST_FILE + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("{shown}: {error}"))?;
    if bytes.len() as u64 > MOST_FILE {
        return Err(format!("{shown}: over {} MB", MOST_FILE >> 20));
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    Ok((name.unwrap_or_default(), bytes))
}

/// On this machine's disks. Never a server's share, which would be sent the user's credentials,
/// nor a device such as a pipe. Windows reads `/` as a backslash, so `//host/share` is a share.
fn on_this_machine(path: &Path) -> bool {
    path.is_absolute()
        && match path.components().next() {
            Some(Component::Prefix(prefix)) => {
                matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
            }
            _ => true,
        }
}

/// Never a path, which says too much about the disk of whoever added it.
fn last(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

/// Absent, where `json!` would give `null`, which the web app would take for a value.
pub fn without_nulls(value: Value) -> Value {
    match value {
        Value::Object(fields) => fields
            .into_iter()
            .filter(|(_, value)| !value.is_null())
            .map(|(key, value)| (key, without_nulls(value)))
            .collect(),
        Value::Array(values) => values.into_iter().map(without_nulls).collect(),
        value => value,
    }
}
