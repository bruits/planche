// The arguments of the tools that change the board, as `crates/mcp` takes them from
// agents and the web app answers them. Written by `PLANCHE_DECLARE=1 cargo test -p mcp`.

export type AddArguments = { elements: Array<NewElement>, 
/**
 * Whether what lies on an element sticks to it, and follows it: notes, stickies, shapes,
 * strokes, and comments as a whole, and each end of an arrow or a line. True by default.
 */
stick?: boolean, };

export type AddImagesArguments = { images: Array<NewImage>, };

export type Align = "left" | "centre" | "right";

export type AlignArguments = { ids: Array<string>, 
/**
 * The side, or the middle, of their extent they line up on.
 */
to: Alignment, };

export type Alignment = "left" | "centre" | "right" | "top" | "middle" | "bottom";

export type Axis = "horizontal" | "vertical";

export type Colour = string;

export type CropShape = "rectangle" | "ellipse";

export type Dash = "solid" | "dashed";

export type DistributeArguments = { ids: Array<string>, axis: Axis, };

export type Fill = "hollow" | "tint" | "solid";

export type Heads = "end" | "both";

export type Ids = { ids: Array<string>, };

export type NewElement = { "type": "note", x: number, y: number, width?: number, text: string, font_size?: number, 
/**
 * Clockwise, in degrees.
 */
rotation?: number, group?: string, colour?: Colour, bold?: boolean, italic?: boolean, 
/**
 * Struck through.
 */
strike?: boolean, 
/**
 * Left by default.
 */
align?: Align, 
/**
 * In percent, whole by default.
 */
opacity?: number, } | { "type": "sticky", x: number, y: number, width?: number, height?: number, text?: string, font_size?: number, rotation?: number, group?: string, 
/**
 * Yellow by default, whatever the theme.
 */
paper?: Paper, bold?: boolean, italic?: boolean, strike?: boolean, 
/**
 * Left by default.
 */
align?: Align, 
/**
 * In percent, whole by default.
 */
opacity?: number, } | { "type": "shape", shape?: ShapeKind, x: number, y: number, width?: number, height?: number, text?: string, font_size?: number, rotation?: number, group?: string, colour?: Colour, weight?: Weight, 
/**
 * Of its outline.
 */
dash?: Dash, 
/**
 * Hollow by default. Not for a cross.
 */
fill?: Fill, 
/**
 * Of its text, which it needs.
 */
bold?: boolean, italic?: boolean, strike?: boolean, 
/**
 * Centred by default.
 */
align?: Align, 
/**
 * In percent, whole by default.
 */
opacity?: number, } | { "type": "arrow", from: Point, to: Point, group?: string, colour?: Colour, weight?: Weight, dash?: Dash, heads?: Heads, 
/**
 * In percent, whole by default.
 */
opacity?: number, } | { "type": "line", from: Point, to: Point, group?: string, colour?: Colour, weight?: Weight, dash?: Dash, 
/**
 * In percent, whole by default.
 */
opacity?: number, } | { "type": "stroke", tip?: Tip, points: Array<Point>, group?: string, colour?: Colour, weight?: Weight, 
/**
 * In percent, whole by default.
 */
opacity?: number, } | { "type": "comment", at: Point, text: string, group?: string, };

export type NewImage = { 
/**
 * An absolute path to an image or video file on this machine, of 25 MB at most.
 */
path?: string, 
/**
 * The file's bytes in base64, for a small file without a path.
 */
data?: string, 
/**
 * The file's name, kept with the image. A path gives its own.
 */
filename?: string, 
/**
 * The left of the image. Without `x` and `y`, images line up around the view's centre.
 */
x?: number, 
/**
 * The top of the image.
 */
y?: number, 
/**
 * Its height follows. Its size in pixels by default.
 */
width?: number, 
/**
 * Where it came from, such as the address of a page.
 */
source?: string, 
/**
 * What it shows.
 */
caption?: string, 
/**
 * An existing group to add it into, the top level by default.
 */
group?: string, };

export type Paper = "yellow" | "pink" | "orange" | "green" | "blue" | "lilac";

export type Pixels = { x: number, y: number, width: number, height: number, };

export type Point = { x: number, y: number, };

export type Restack = "front" | "forward" | "backward" | "back";

export type RestackArguments = { ids: Array<string>, to: Restack, };

export type SelectArguments = { 
/**
 * None, to select nothing.
 */
ids: Array<string>, 
/**
 * Whether the view turns to them.
 */
frame?: boolean, };

export type ShapeKind = "rectangle" | "ellipse" | "cross";

export type Tip = "pen" | "highlighter";

export type TransformArguments = { ids: Array<string>, 
/**
 * Images only, `horizontal` swapping left and right.
 */
flip?: Axis, 
/**
 * A factor, about `about`.
 */
scale?: number, 
/**
 * In board units, which the elements together scale to, about `about`.
 */
width?: number, 
/**
 * Where they scale and rotate about, their centre by default.
 */
about?: Point, 
/**
 * Clockwise, in degrees, about `about`.
 */
rotate?: number, 
/**
 * How far they move.
 */
translate?: Point, 
/**
 * Where their top left corner goes, once flipped, scaled, and rotated.
 */
move_to?: Point, 
/**
 * Whether what lands on an element sticks to it. True by default.
 */
stick?: boolean, };

export type Update = { id: string, 
/**
 * For a note, a sticky note, a shape, or a comment.
 */
text?: string, 
/**
 * For a note, a sticky note, or a shape.
 */
font_size?: number, shape?: ShapeKind, 
/**
 * For an image. Empty, it goes.
 */
caption?: string, 
/**
 * For an image. Empty, it goes.
 */
source?: string, 
/**
 * For an image.
 */
greyscale?: boolean, 
/**
 * For an image, the part of it to show, in its pixels, all of them to show it whole. Each
 * pixel it still shows stays where it was, at the same size.
 */
crop?: Pixels, 
/**
 * For an image.
 */
crop_shape?: CropShape, 
/**
 * For a note, a shape, an arrow, a line, or a stroke, a colour of the palette, which each
 * theme draws its own way, or `#rrggbb`, which every theme draws alike.
 */
colour?: Colour, 
/**
 * For a sticky note.
 */
paper?: Paper, 
/**
 * For a shape, an arrow, a line, or a stroke.
 */
weight?: Weight, 
/**
 * For a shape, an arrow, or a line.
 */
dash?: Dash, 
/**
 * For an arrow.
 */
heads?: Heads, 
/**
 * For a rectangle or an ellipse.
 */
fill?: Fill, 
/**
 * For a note, a sticky note, or a shape holding text.
 */
bold?: boolean, 
/**
 * For a note, a sticky note, or a shape holding text.
 */
italic?: boolean, 
/**
 * For a note, a sticky note, or a shape holding text, struck through.
 */
strike?: boolean, 
/**
 * For a note, a sticky note, or a shape holding text.
 */
align?: Align, 
/**
 * For anything but a comment or a group, in percent.
 */
opacity?: number, };

export type UpdateArguments = { updates: Array<Update>, };

export type Weight = "thin" | "medium" | "thick";
