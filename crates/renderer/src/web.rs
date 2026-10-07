use std::mem;
use std::sync::{Arc, Mutex};

use wasm_bindgen::prelude::*;
use web_sys::js_sys::Uint8ClampedArray;
use web_sys::{HtmlCanvasElement, HtmlMediaElement, HtmlVideoElement, ImageBitmap};

/// Uniform buffers take multiples of 16 bytes on WebGL2, hence the padding.
const CAMERA: &str = r#"
struct Camera { origin: vec2f, zoom: f32, viewport: vec2f, padding: vec2f };
@group(0) @binding(0) var<uniform> camera: Camera;

fn clip(screen: vec2f) -> vec4f {
    return vec4f(screen.x / camera.viewport.x * 2.0 - 1.0, 1.0 - screen.y / camera.viewport.y * 2.0, 0.0, 1.0);
}

fn turn(point: vec2f, degrees: f32) -> vec2f {
    let angle = radians(degrees);
    return vec2f(point.x * cos(angle) - point.y * sin(angle), point.x * sin(angle) + point.y * cos(angle));
}

/// A corner of `rect`, from (0, 0) at its top-left to (1, 1), turned by `degrees` around its centre.
fn place(corner: vec2f, rect: vec4f, degrees: f32) -> vec4f {
    let local = (corner - 0.5) * rect.zw;
    return clip((rect.xy + rect.zw * 0.5 + turn(local, degrees) - camera.origin) * camera.zoom);
}
"#;

/// Negative within the ellipse, as the core measures it, bounded where a thin ellipse would
/// otherwise show a gap or fat tips.
const ELLIPSE: &str = r#"
fn ellipse(local: vec2f, half: vec2f) -> f32 {
    let axes = max(half, vec2f(0.5));
    let point = abs(local);
    let scaled = length(point / axes);
    let gradient = length(point / (axes * axes));
    let estimate = select(1e30, abs(scaled * (scaled - 1.0) / gradient), gradient > 0.0);
    let unit = point / axes;
    let straight = axes * sqrt(max(1.0 - unit.yx * unit.yx, vec2f(0.0))) - point;
    let frame = length(max(point - axes, vec2f(0.0)));
    return select(max(estimate, frame), -min(estimate, min(straight.x, straight.y)), scaled < 1.0);
}
"#;

/// An image shown as an ellipse covers a quad a pixel wider than its frame, and its fragments
/// measure in device pixels how far they are from the ellipse, which smooths its edge over one
/// pixel.
const QUADS: &str = r#"
@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var image_sampler: sampler;

struct Out {
    @builtin(position) position: vec4f,
    /// From (0, 0) at the frame's top-left to (1, 1), and beyond it for the edge of an ellipse.
    @location(0) parts: vec2f,
    @location(1) crop: vec4f,
    @location(2) grey: f32,
    /// In device pixels.
    @location(3) size: vec2f,
    @location(4) elliptical: f32,
    @location(5) opacity: f32,
};

@vertex fn vs(
    @builtin(vertex_index) index: u32,
    @location(0) rect: vec4f,
    @location(1) degrees: f32,
    @location(2) crop: vec4f,
    @location(3) grey: f32,
    @location(4) elliptical: f32,
    @location(5) opacity: f32,
) -> Out {
    let corner = vec2f(f32(index & 1u), f32(index >> 1u));
    let size = abs(rect.zw) * camera.zoom;
    let margin = select(vec2f(0.0), 1.0 / max(size, vec2f(1e-6)), elliptical > 0.5);
    var out: Out;
    out.parts = mix(-margin, 1.0 + margin, corner);
    out.position = place(out.parts, rect, degrees);
    out.crop = crop;
    out.grey = grey;
    out.size = size;
    out.elliptical = elliptical;
    out.opacity = opacity;
    return out;
}

/// Linear light as the sRGB values the surface takes as they are.
fn encoded(linear: vec3f) -> vec3f {
    let light = max(linear, vec3f(0.0));
    let curved = 1.055 * pow(light, vec3f(1.0 / 2.4)) - 0.055;
    return select(curved, light * 12.92, light <= vec3f(0.0031308));
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
    let color = textureSample(image, image_sampler, in.crop.xy + clamp(in.parts, vec2f(0.0), vec2f(1.0)) * in.crop.zw);
    let luma = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
    let away = ellipse((in.parts - 0.5) * in.size, in.size * 0.5);
    let shown = select(1.0, clamp(0.5 - away, 0.0, 1.0), in.elliptical > 0.5);
    return vec4f(encoded(mix(color.rgb, vec3f(luma), in.grey)), color.a * shown * in.opacity);
}
"#;

/// Only the texture's alpha counts, as filtering its colour would darken the edges of the
/// letters with the transparent black around them.
const TEXT: &str = r#"
@group(1) @binding(0) var coverage: texture_2d<f32>;
@group(1) @binding(1) var coverage_sampler: sampler;

struct Out {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) colour: vec3f,
    @location(2) opacity: f32,
};

@vertex fn vs(
    @builtin(vertex_index) index: u32,
    @location(0) rect: vec4f,
    @location(1) degrees: f32,
    @location(2) colour: vec3f,
    @location(3) opacity: f32,
) -> Out {
    let corner = vec2f(f32(index & 1u), f32(index >> 1u));
    var out: Out;
    out.position = place(corner, rect, degrees);
    out.uv = corner;
    out.colour = colour;
    out.opacity = opacity;
    return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
    return vec4f(in.colour, textureSample(coverage, coverage_sampler, in.uv).a * in.opacity);
}
"#;

/// Each stroke covers a quad a pixel wider than itself, and its fragments measure in device
/// pixels how far they are from the line, which smooths its edge over one pixel.
const STROKES: &str = r#"
/// A dash and the gap after it, in widths of the stroke.
const DASH: f32 = 7.0;
/// How far a star's inner corners are from its centre, in parts of its points' distance, as the
/// board's `STAR_DEPTH`.
const STAR: f32 = 0.381966;

struct Out {
    @builtin(position) position: vec4f,
    @location(0) local: vec2f,
    @location(1) size: vec2f,
    @location(2) radius: f32,
    @location(3) shape: f32,
    @location(4) colour: vec3f,
    @location(5) dash: f32,
    @location(6) opacity: f32,
    @location(7) extra: f32,
    @location(8) corners: f32,
};

/// `shape` is 0 for a line from `geometry.xy` to `geometry.zw`, and 6 for an arrow along it, its
/// heads `degrees` long, at its end, and its start too when `extra` is 2. 1 or 2 outlines a
/// rectangle or an ellipse in the frame `geometry`, turned by `degrees`, filling it as much as
/// `extra`, 3 fills the rectangle, and 4 draws its diagonals. 7 or 8 outlines and fills as 1 and 2
/// do a polygon of `corners` corners, or a star of `corners` points. `width` is in board units, but
/// never under a device pixel, and dashes the stroke when negative, though not an arrow's heads.
/// What one instance draws blends once, so that an arrow with its heads, or an outline with its
/// fill, fades as a whole. A text over them blends apart.
@vertex fn vs(
    @builtin(vertex_index) index: u32,
    @location(0) shape: f32,
    @location(1) geometry: vec4f,
    @location(2) degrees: f32,
    @location(3) width: f32,
    @location(4) colour: vec3f,
    @location(5) opacity: f32,
    @location(6) extra: f32,
    @location(7) corners: f32,
) -> Out {
    let corner = vec2f(f32(index & 1u), f32(index >> 1u));
    let fills = shape > 2.5 && shape < 3.5;
    let dashed = width < 0.0 && !fills;
    let thickness = abs(width);
    let radius = max(select(thickness, 0.0, fills) * camera.zoom, 1.0) * 0.5;
    let margin = radius + 1.0;
    var out: Out;
    out.radius = radius;
    out.shape = shape;
    out.colour = colour;
    out.opacity = opacity;
    out.extra = extra;
    out.corners = corners;
    // Never so short that the caps close the gaps.
    out.dash = select(0.0, max(DASH * thickness * camera.zoom, radius * 6.0), dashed);
    if lined(shape) {
        let start = (geometry.xy - camera.origin) * camera.zoom;
        let end = (geometry.zw - camera.origin) * camera.zoom;
        let span = distance(start, end);
        let along = select(vec2f(1.0, 0.0), (end - start) / span, span > 0.0);
        let across = vec2f(-along.y, along.x);
        let head = select(0.0, degrees * camera.zoom, shape > 5.5);
        // As far across as the heads reach, at 30° from the shaft.
        let reach = margin + head * 0.5;
        out.local = vec2f(mix(-margin, span + margin, corner.x), mix(-reach, reach, corner.y));
        out.size = vec2f(span, head);
        out.position = clip(start + along * out.local.x + across * out.local.y);
    } else {
        let half = abs(geometry.zw) * 0.5 * camera.zoom;
        let centre = (geometry.xy + geometry.zw * 0.5 - camera.origin) * camera.zoom;
        out.local = (corner * 2.0 - 1.0) * (half + margin);
        out.size = half;
        out.position = clip(centre + turn(out.local, degrees));
    }
    return out;
}

/// Whether `shape` is a line or an arrow.
fn lined(shape: f32) -> bool {
    return shape < 0.5 || abs(shape - 6.0) < 0.5;
}

fn segment(point: vec2f, start: vec2f, end: vec2f) -> f32 {
    let along = end - start;
    let t = clamp(dot(point - start, along) / max(dot(along, along), 1e-6), 0.0, 1.0);
    return distance(point, start + along * t);
}

/// Negative within the box.
fn box(local: vec2f, half: vec2f) -> f32 {
    let outside = abs(local) - half;
    return length(max(outside, vec2f(0.0))) + min(max(outside.x, outside.y), 0.0);
}

/// The nearest point of [0, `span`] that a dash covers, dashes being half of each `period` and
/// centred on its multiples, so that half of one starts and ends the stretch.
fn nearest_dash(at: f32, period: f32, span: f32) -> f32 {
    let x = at + period * 0.25;
    let start = floor(x / period) * period;
    let within = clamp(x, start, start + period * 0.5);
    let next = start + period;
    return clamp(select(within, next, next - x < abs(x - within)) - period * 0.25, 0.0, span);
}

/// What a stretch of `span` is cut into, nearest `base` long, so that dashes end it as they start it.
fn whole_period(span: f32, base: f32) -> f32 {
    return max(span / max(round(span / base), 1.0), 1e-3);
}

/// Of a dashed rectangle, whose sides each have a whole number of periods, and so the same
/// pattern from either end, which is why the point folds into one quarter.
fn dashed_box(local: vec2f, half: vec2f, base: f32) -> f32 {
    let point = abs(local);
    let sides = half * 2.0;
    let along = half + point;
    let period = vec2f(whole_period(sides.x, base), whole_period(sides.y, base));
    let x = along.x - nearest_dash(along.x, period.x, sides.x);
    let y = along.y - nearest_dash(along.y, period.y, sides.y);
    return min(length(vec2f(x, point.y - half.y)), length(vec2f(point.x - half.x, y)));
}

/// How fast a point goes round the ellipse at parameter `t`, in pixels per radian.
fn speed(t: f32, axes: vec2f) -> f32 {
    return length(vec2f(axes.x * sin(t), axes.y * cos(t)));
}

/// How far along a quarter of the ellipse, from the end of its horizontal axis, the point at
/// parameter `angle` lies, by Gauss-Legendre quadrature of four points, which holds to a
/// thousandth of that length for ellipses up to ten times as wide as they are tall.
fn arc(angle: f32, axes: vec2f) -> f32 {
    let h = angle * 0.5;
    return h * (
        0.3478548 * speed(h * (1.0 - 0.8611363), axes) +
        0.6521452 * speed(h * (1.0 - 0.3399810), axes) +
        0.6521452 * speed(h * (1.0 + 0.3399810), axes) +
        0.3478548 * speed(h * (1.0 + 0.8611363), axes)
    );
}

/// Dashes of the same length all round, `away` being the point's distance from the whole outline.
fn dashed_ellipse(local: vec2f, half: vec2f, base: f32, away: f32) -> f32 {
    let axes = max(half, vec2f(0.5));
    let point = abs(local);
    // Back onto the outline along the normal, where it first meets it, as scaling the point onto
    // it would slant the dashes of a long ellipse.
    let normal = point / (axes * axes);
    let direction = normal / max(length(normal), 1e-20);
    let unit = point / axes;
    let slope = direction / axes;
    let outside = dot(unit, unit) - 1.0;
    let middle = dot(unit, slope);
    let spread = sqrt(max(middle * middle - dot(slope, slope) * outside, 0.0));
    let outline = max(point - direction * outside / max(middle + spread, 1e-20), vec2f(0.0));
    let quarter = arc(1.5707964, axes);
    let along = arc(atan2(outline.y * axes.x, outline.x * axes.y), axes);
    return length(vec2f(along - nearest_dash(along, whole_period(quarter, base), quarter), away));
}

/// Of a regular polygon of `count` corners, or a star of `count` points, one pointing up, stretched
/// to touch each side of the box of half size `half`, how far `local` is from its outline,
/// negative within it, then from the nearest dash along it when `base` is more than 0, each side
/// cut into a whole number of periods nearest `base` long, as a rectangle's are. As the board's
/// `polygon` draws it.
fn polygon(local: vec2f, half: vec2f, count: f32, star: bool, base: f32) -> vec2f {
    let tau = 6.2831855;
    let steps = select(count, count * 2.0, star);
    // The points reach furthest, those nearest to straight across or down, which a star's inner
    // corners never pass.
    let sector = tau / count;
    let right = cos(sector * abs(count * 0.25 - round(count * 0.25)));
    let bottom = cos(sector * abs(count * 0.5 - round(count * 0.5)));
    let scale = vec2f(half.x / right, 2.0 * half.y / (1.0 + bottom));
    var solid = 1e20;
    var dashed = 1e20;
    var inside = false;
    var start = vec2f(0.0, -half.y);
    for (var corner = 1u; corner <= u32(steps); corner++) {
        let angle = f32(corner) / steps * tau;
        let radius = select(1.0, STAR, star && (corner & 1u) == 1u);
        let unit = radius * vec2f(sin(angle), -cos(angle));
        let end = vec2f(unit.x * scale.x, (1.0 + unit.y) * scale.y - half.y);
        let side = end - start;
        let span = length(side);
        let direction = side / max(span, 1e-6);
        let offset = local - start;
        let along = dot(offset, direction);
        let across = offset.x * direction.y - offset.y * direction.x;
        solid = min(solid, length(vec2f(along - clamp(along, 0.0, span), across)));
        if base > 0.0 {
            let nearest = nearest_dash(along, whole_period(span, base), span);
            dashed = min(dashed, length(vec2f(along - nearest, across)));
        }
        // Even–odd, as a star's dents keep it from being convex.
        if (start.y > local.y) != (end.y > local.y)
            && local.x < start.x + (local.y - start.y) / (end.y - start.y) * (end.x - start.x) {
            inside = !inside;
        }
        start = end;
    }
    return vec2f(select(solid, -solid, inside), dashed);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
    var away: f32;
    var filled = 0.0;
    if lined(in.shape) {
        var nearest = clamp(in.local.x, 0.0, in.size.x);
        if in.dash > 0.0 {
            nearest = nearest_dash(in.local.x, whole_period(in.size.x, in.dash), in.size.x);
        }
        away = length(vec2f(in.local.x - nearest, in.local.y));
        if in.shape > 5.5 {
            // Folded across the shaft, each head's two strokes are one.
            let point = vec2f(in.local.x, abs(in.local.y));
            let back = in.size.y * vec2f(0.8660254, 0.5);
            let tip = vec2f(in.size.x, 0.0);
            away = min(away, segment(point, tip, tip + vec2f(-back.x, back.y)));
            if in.extra > 1.5 {
                away = min(away, segment(point, vec2f(0.0), back));
            }
        }
    } else if in.shape < 1.5 {
        let edge = box(in.local, in.size);
        away = abs(edge);
        filled = clamp(0.5 - edge, 0.0, 1.0) * in.extra;
        if in.dash > 0.0 && away < in.radius + 1.0 {
            away = dashed_box(in.local, in.size, in.dash);
        }
    } else if in.shape < 2.5 {
        let edge = ellipse(in.local, in.size);
        away = abs(edge);
        filled = clamp(0.5 - edge, 0.0, 1.0) * in.extra;
        if in.dash > 0.0 && away < in.radius + 1.0 {
            away = dashed_ellipse(in.local, in.size, in.dash, away);
        }
    } else if in.shape < 3.5 {
        return vec4f(in.colour, clamp(0.5 - box(in.local, in.size), 0.0, 1.0) * in.opacity);
    } else if in.shape > 6.5 {
        // Rounded, as interpolating a whole number may leave it a hair off.
        let edge = polygon(in.local, in.size, round(in.corners), in.shape > 7.5, in.dash);
        away = abs(edge.x);
        filled = clamp(0.5 - edge.x, 0.0, 1.0) * in.extra;
        if in.dash > 0.0 && away < in.radius + 1.0 {
            away = edge.y;
        }
    } else {
        // Folded into one quarter, both diagonals run from the centre to the corner.
        let point = abs(in.local);
        let along = clamp(dot(point, in.size) / max(dot(in.size, in.size), 1e-6), 0.0, 1.0);
        away = length(point - in.size * along);
        if in.dash > 0.0 && away < in.radius + 1.0 {
            // From the centre out along each half of a diagonal, in whole periods.
            let arm = max(length(in.size), 1e-3);
            let direction = in.size / arm;
            let reach = dot(point, direction);
            let off = reach - nearest_dash(reach, whole_period(arm, in.dash), arm);
            away = length(vec2f(off, length(point - direction * reach)));
        }
    }
    let stroke = clamp(in.radius - away + 0.5, 0.0, 1.0);
    return vec4f(in.colour, (stroke + filled * (1.0 - stroke)) * in.opacity);
}

/// How much a line without dashes covers the pixel, as `fs` measures it.
fn covered(in: Out) -> f32 {
    let away = length(vec2f(in.local.x - clamp(in.local.x, 0.0, in.size.x), in.local.y));
    return clamp(in.radius - away + 0.5, 0.0, 1.0);
}

struct Once {
    @location(0) colour: vec4f,
    @builtin(frag_depth) depth: f32,
};

/// The lines of a see-through pen stroke draw each pixel once, as the one that covers it most.
/// `fs_clear` starts the depth and the stencil over under them, `fs_cover` leaves in the depth
/// how much they cover each pixel at most, and `fs_once` draws the first that covers it as much,
/// as the stencil then turns the others away.
@fragment fn fs_clear(in: Out) -> Once {
    return Once(vec4f(0.0), 1.0);
}

@fragment fn fs_cover(in: Out) -> Once {
    let cover = covered(in);
    if cover <= 0.0 {
        discard;
    }
    return Once(vec4f(0.0), 1.0 - cover);
}

/// A hair nearer than `fs_cover` puts it, so that the same coverage, measured again, passes
/// however it rounds.
@fragment fn fs_once(in: Out) -> Once {
    let cover = covered(in);
    if cover <= 0.0 {
        discard;
    }
    return Once(vec4f(in.colour, cover * in.opacity), max(1.0 - cover - 1e-5, 0.0));
}
"#;

/// Lines `spacing` apart, or dots where they cross, over the whole viewport. Every `step`th
/// line shows in full and the others by `fade`. `offset` is the board point at the viewport's
/// top-left, less a whole number of those full lines' spacing, as far from the origin a float
/// would not place the lines. `width` is a line's, or a dot's across, in device pixels, and
/// each is put on whole pixels so that it draws sharp.
const GRID: &str = r#"
struct Grid { offset: vec2f, spacing: f32, fade: f32, colour: vec4f, width: f32, dots: f32, step: f32, padding: f32 };
@group(1) @binding(0) var<uniform> grid: Grid;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4f(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
}

/// How far `screen` lies from the nearest line of each direction.
fn away(screen: vec2f, spacing: f32) -> vec2f {
    let line = round((grid.offset + screen / camera.zoom) / spacing) * spacing;
    let start = round((line - grid.offset) * camera.zoom - grid.width * 0.5);
    return abs(screen - start - grid.width * 0.5);
}

fn covered(screen: vec2f, spacing: f32) -> f32 {
    let off = away(screen, spacing);
    let distance = select(min(off.x, off.y), length(off), grid.dots > 0.5);
    return clamp(grid.width * 0.5 - distance + 0.5, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let fine = covered(position.xy, grid.spacing) * grid.fade;
    let coarse = covered(position.xy, grid.spacing * grid.step);
    return vec4f(grid.colour.rgb, grid.colour.a * max(fine, coarse));
}
"#;

/// Draws one mipmap level from the one above it.
const BLIT: &str = r#"
@group(0) @binding(0) var above: texture_2d<f32>;
@group(0) @binding(1) var image_sampler: sampler;

struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) index: u32) -> Out {
    let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    var out: Out;
    out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
    return textureSample(above, image_sampler, in.uv);
}
"#;

/// Read in linear light, so that mipmaps and filtering keep an image's brightness. Texts read
/// only the alpha, which stays linear.
const TEXTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
/// Floats per item in [`Renderer::draw`]: its kind, which is 0 for an image, 1 for a stroke, 2
/// for a text, and 3 for a line of a see-through pen stroke, its texture or -1, then its instance,
/// whose last float is its opacity from 0 to 1, whatever its kind.
///
/// An image's instance is its x, y, width, height, rotation, the crop's x, y, width, and height
/// in texture coordinates, which a negative size flips, 1 to draw in greys or 0, and 1 to show
/// the ellipse that fills it or 0. A text's is its x, y, width, height, rotation, colour, and
/// padding. A stroke's is the shape, geometry, rotation, width, colour, corners, and extra that
/// [`STROKES`] reads. Colours are red, green, and blue from 0 to 1. A pen stroke's lines come one
/// after the other, as lines from each of its points to the next, whose extra tells them from the
/// stroke's next to them, and when see-through, they draw [`ONCE`].
const STRIDE: usize = 15;
const IMAGE: f32 = 0.0;
const STROKE: f32 = 1.0;
/// The lines of a see-through pen stroke, which together cover each pixel once, as the
/// `fs_clear`, `fs_cover`, and `fs_once` of [`STROKES`] draw them.
const ONCE: f32 = 3.0;
/// For drawing pen strokes [`ONCE`], which every pipeline of a pass must declare.
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth24PlusStencil8;
/// Bytes per instance, which every kind shares, as WebGL2 finds instances by one stride.
const INSTANCE: u64 = (STRIDE as u64 - 2) * 4;
const fn opacity(location: u32) -> wgpu::VertexAttribute {
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32,
        offset: INSTANCE - 4,
        shader_location: location,
    }
}
/// The camera's origin, zoom, and viewport, padded as [`CAMERA`] lays them out.
const CAMERA_SIZE: u64 = 32;
/// Floats of the grid, as [`GRID`] lays them out. Its offset, spacing, fade, colour's red,
/// green, blue, and alpha from 0 to 1, width, 1 for dots or 0 for lines, step, and padding.
const GRID_FLOATS: usize = 12;
/// Floats of a view in [`Renderer::render`]. The x and y of the board's point at the top-left,
/// the zoom, the width and height in pixels, and the colour behind the board's red, green, blue,
/// and alpha from 0 to 1, straight.
const VIEW_FLOATS: usize = 9;

#[wasm_bindgen]
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    /// For a pass without the depth and the stencil, which no frame needs until it holds a
    /// see-through pen stroke, and one with them, which then holds its [`ONCE`] lines too.
    plain: Pipelines,
    deep: Pipelines,
    /// To clear, to cover, then to draw a see-through pen stroke, in that order.
    once: [wgpu::RenderPipeline; 3],
    blit: wgpu::RenderPipeline,
    image_layout: wgpu::BindGroupLayout,
    /// The window's, as large as its canvas, made at the first draw that needs it at that size,
    /// and kept, as a stroke coming in and out of view would make it again and again.
    depth: Option<wgpu::Texture>,
    camera: wgpu::Buffer,
    camera_group: wgpu::BindGroup,
    grid_uniform: wgpu::Buffer,
    grid_group: wgpu::BindGroup,
    sampler: wgpu::Sampler,
    /// By index, which a released texture leaves free for the next one.
    textures: Vec<Option<Texture>>,
    instances: wgpu::Buffer,
    backend: String,
    webgpu: bool,
    /// wgpu's default is to panic, which would leave the page waiting on a dead module.
    error: Arc<Mutex<Option<String>>>,
}

struct Pipelines {
    quads: wgpu::RenderPipeline,
    texts: wgpu::RenderPipeline,
    strokes: wgpu::RenderPipeline,
    grid: wgpu::RenderPipeline,
}

struct Texture {
    /// Dropping it frees nothing on WebGPU, where only destroying it does.
    texture: wgpu::Texture,
    group: wgpu::BindGroup,
    bytes: u64,
}

#[wasm_bindgen]
pub async fn create(canvas: HtmlCanvasElement, webgpu: bool) -> Result<Renderer, JsError> {
    let (width, height) = (canvas.width().max(1), canvas.height().max(1));
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = if webgpu {
        wgpu::Backends::BROWSER_WEBGPU
    } else {
        wgpu::Backends::GL
    };
    let instance = wgpu::Instance::new(descriptor);
    let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas))?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            ..Default::default()
        })
        .await?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            // WebGL2's defaults cap textures at 2048 pixels.
            required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                .using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await?;
    let error = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&error);
    device.on_uncaptured_error(Arc::new(move |raised| {
        slot.lock()
            .expect("never poisoned")
            .get_or_insert(raised.to_string());
    }));
    let capabilities = surface.get_capabilities(&adapter);
    let mut config = surface
        .get_default_config(&adapter, width, height)
        .ok_or_else(|| JsError::new("the canvas cannot be drawn to"))?;
    // Every pipeline writes sRGB values, which an sRGB surface would encode again.
    if let Some(format) = capabilities.formats.iter().find(|format| !format.is_srgb()) {
        config.format = *format;
    }
    // wgpu reports only opaque canvases on WebGPU, which take premultiplied ones all the same.
    if webgpu
        || capabilities
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
    {
        config.alpha_mode = wgpu::CompositeAlphaMode::PreMultiplied;
    }
    surface.configure(&device, &config);

    let image_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });
    let camera_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    });
    let uniform = |size| {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &camera_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        });
        (buffer, group)
    };
    let (camera, camera_group) = uniform(CAMERA_SIZE);
    let (grid_uniform, grid_group) = uniform(GRID_FLOATS as u64 * 4);
    let target = wgpu::ColorTargetState {
        format: config.format,
        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
        write_mask: wgpu::ColorWrites::ALL,
    };
    let [rect, degrees, crop, grey, elliptical] = wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32, 2 => Float32x4, 3 => Float32, 4 => Float32];
    let quads_module = module(&device, &[CAMERA, ELLIPSE, QUADS].concat());
    let quad_attributes = [rect, degrees, crop, grey, elliptical, opacity(5)];
    let [rect, degrees, colour] =
        wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32, 2 => Float32x3];
    let texts_module = module(&device, &[CAMERA, TEXT].concat());
    let text_attributes = [rect, degrees, colour, opacity(3)];
    let [shape, geometry, degrees, width, colour, corners, extra] = wgpu::vertex_attr_array![0 => Float32, 1 => Float32x4, 2 => Float32, 3 => Float32, 4 => Float32x3, 7 => Float32, 6 => Float32];
    let strokes_module = module(&device, &[CAMERA, ELLIPSE, STROKES].concat());
    let stroke_attributes = [
        shape,
        geometry,
        degrees,
        width,
        colour,
        corners,
        extra,
        opacity(5),
    ];
    let stroking = |target, depth, fragment| {
        pipeline(
            &device,
            &strokes_module,
            &[&camera_layout],
            &[Some(wgpu::VertexBufferLayout {
                array_stride: INSTANCE,
                step_mode: wgpu::VertexStepMode::Instance,
                attributes: &stroke_attributes,
            })],
            target,
            depth,
            fragment,
        )
    };
    let grid_module = module(&device, &[CAMERA, GRID].concat());
    // The same modules for both, which WebGL2 links once.
    let pipelines = |depth: Option<wgpu::DepthStencilState>| {
        let instanced = |attributes| {
            [Some(wgpu::VertexBufferLayout {
                array_stride: INSTANCE,
                step_mode: wgpu::VertexStepMode::Instance,
                attributes,
            })]
        };
        Pipelines {
            quads: pipeline(
                &device,
                &quads_module,
                &[&camera_layout, &image_layout],
                &instanced(&quad_attributes),
                target.clone(),
                depth.clone(),
                "fs",
            ),
            texts: pipeline(
                &device,
                &texts_module,
                &[&camera_layout, &image_layout],
                &instanced(&text_attributes),
                target.clone(),
                depth.clone(),
                "fs",
            ),
            strokes: stroking(target.clone(), depth.clone(), "fs"),
            grid: pipeline(
                &device,
                &grid_module,
                &[&camera_layout, &camera_layout],
                &[],
                target.clone(),
                depth,
                "fs",
            ),
        }
    };
    let plain = pipelines(None);
    let deep = pipelines(Some(depth(Depth::Ignored)));
    let unseen = wgpu::ColorTargetState {
        format: config.format,
        blend: None,
        write_mask: wgpu::ColorWrites::empty(),
    };
    let once = [
        stroking(unseen.clone(), Some(depth(Depth::Clear)), "fs_clear"),
        stroking(unseen, Some(depth(Depth::Cover)), "fs_cover"),
        stroking(target, Some(depth(Depth::Once)), "fs_once"),
    ];
    let blit = pipeline(
        &device,
        &module(&device, BLIT),
        &[&image_layout],
        &[],
        TEXTURE_FORMAT.into(),
        None,
        "fs",
    );
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    });
    let info = adapter.get_info();
    Ok(Renderer {
        instances: instance_buffer(&device, 0),
        device,
        queue,
        surface,
        config,
        plain,
        deep,
        once,
        blit,
        image_layout,
        depth: None,
        camera,
        camera_group,
        grid_uniform,
        grid_group,
        sampler,
        textures: Vec::new(),
        backend: format!("wgpu {:?}, {}", info.backend, info.name),
        webgpu,
        error,
    })
}

#[wasm_bindgen]
impl Renderer {
    #[wasm_bindgen(getter)]
    pub fn backend(&self) -> String {
        self.backend.clone()
    }

    /// The texture's index, for [`Renderer::draw`], until it is released.
    pub fn upload(&mut self, bitmap: ImageBitmap) -> Result<u32, JsError> {
        self.upload_from(wgpu::ExternalImageSource::ImageBitmap(bitmap))
    }

    /// As [`Renderer::upload`], from what the canvas holds.
    #[wasm_bindgen(js_name = uploadCanvas)]
    pub fn upload_canvas(&mut self, canvas: HtmlCanvasElement) -> Result<u32, JsError> {
        self.upload_from(wgpu::ExternalImageSource::HTMLCanvasElement(canvas))
    }

    /// Draws the next frame of `animation` onto the texture, which must be as large. How long the
    /// frame asks to show, in milliseconds, `undefined` once none is left.
    pub fn advance(
        &mut self,
        index: u32,
        animation: &mut Animation,
    ) -> Result<Option<f64>, JsError> {
        let Some(frame) = animation.0.next_frame()? else {
            return Ok(None);
        };
        let (numerator, denominator) = frame.delay().numer_denom_ms();
        let canvas = frame.into_buffer();
        let (width, height) = canvas.dimensions();
        self.draw_frame(index, width, height, canvas.as_raw())?;
        Ok(Some(f64::from(numerator) / f64::from(denominator)))
    }

    /// Draws a frame `pixels` holds, as `Animation.pixels` gives it, onto the texture, which must be
    /// as large.
    pub fn show(&mut self, index: u32, pixels: &[u8]) -> Result<(), JsError> {
        let texture = self
            .textures
            .get(index as usize)
            .and_then(Option::as_ref)
            .ok_or_else(|| JsError::new(&format!("texture {index} is not uploaded")))?;
        let wgpu::Extent3d { width, height, .. } = texture.texture.size();
        if pixels.len() != 4 * width as usize * height as usize {
            return Err(JsError::new(&format!(
                "{} bytes are no frame of a {width} by {height} texture",
                pixels.len()
            )));
        }
        self.draw_frame(index, width, height, pixels)
    }

    fn draw_frame(
        &mut self,
        index: u32,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> Result<(), JsError> {
        let texture = self.fitting(index, width, height)?;
        self.queue.write_texture(
            texture.texture.as_image_copy(),
            pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * width),
                rows_per_image: Some(height),
            },
            texture.texture.size(),
        );
        self.generate_mipmaps(&texture.texture);
        Ok(())
    }

    /// Draws the frame `video` shows onto the texture, which must be as large. Whether it had one
    /// to show.
    #[wasm_bindgen(js_name = copyVideo)]
    pub fn copy_video(&self, index: u32, video: HtmlVideoElement) -> Result<bool, JsError> {
        // Copying from one that has none throws, which kills the module on WebGPU.
        if video.ready_state() < HtmlMediaElement::HAVE_CURRENT_DATA || video.video_width() == 0 {
            return Ok(false);
        }
        let texture = self.fitting(index, video.video_width(), video.video_height())?;
        self.copy_external(
            wgpu::ExternalImageSource::HTMLVideoElement(video),
            &texture.texture,
        );
        // Which submits the copy at once, as WebGL2 only records it until then.
        self.generate_mipmaps(&texture.texture);
        Ok(true)
    }

    /// Frees the texture, whose index the next upload may take. Items that still name it draw
    /// nothing.
    pub fn release(&mut self, index: u32) {
        if let Some(texture) = self.textures.get_mut(index as usize).and_then(Option::take) {
            texture.texture.destroy();
        }
    }

    /// The longest side a texture or a render may have, in pixels.
    #[wasm_bindgen(getter, js_name = maxTextureSide)]
    pub fn max_texture_side(&self) -> u32 {
        self.device.limits().max_texture_dimension_2d
    }

    /// What the textures take on the GPU, their mipmaps included.
    #[wasm_bindgen(getter, js_name = textureBytes)]
    pub fn texture_bytes(&self) -> f64 {
        self.textures
            .iter()
            .flatten()
            .map(|texture| texture.bytes)
            .sum::<u64>() as f64
    }

    /// In device pixels.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
        if let Some(depth) = self.depth.take() {
            depth.destroy();
        }
    }

    /// `zoom` is in device pixels per board unit, `items` holds [`STRIDE`] floats per item,
    /// back to front, and `grid` its [`GRID_FLOATS`], or none when there is no grid.
    pub fn draw(
        &mut self,
        x: f32,
        y: f32,
        zoom: f32,
        items: &[f32],
        grid: &[f32],
    ) -> Result<(), JsError> {
        check_grid(grid)?;
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) => frame,
            other => return Err(JsError::new(&format!("no frame to draw: {other:?}"))),
        };
        let view = frame.texture.create_view(&Default::default());
        let size = frame.texture.size();
        let depth = if holds_once(items) {
            if self.depth.as_ref().is_none_or(|depth| depth.size() != size) {
                let made = depth_texture(&self.device, size);
                if let Some(old) = self.depth.replace(made) {
                    old.destroy();
                }
            }
            self.depth
                .as_ref()
                .map(|depth| depth.create_view(&Default::default()))
        } else {
            None
        };
        let viewport = [self.config.width as f32, self.config.height as f32];
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.record(
            &mut encoder,
            (&view, depth.as_ref()),
            wgpu::Color::TRANSPARENT,
            [x, y, zoom, viewport[0], viewport[1]],
            items,
            grid,
        );
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        self.check()
    }

    /// Draws as [`Renderer::draw`] does, but onto a texture of its own, which the surface and
    /// the camera of the window never see. Read back with [`Readback::poll`] until it says so,
    /// then [`Readback::pixels`].
    pub fn render(
        &mut self,
        view: &[f32],
        items: &[f32],
        grid: &[f32],
    ) -> Result<Readback, JsError> {
        check_grid(grid)?;
        let Ok([x, y, zoom, width, height, red, green, blue, alpha]) =
            <[f32; VIEW_FLOATS]>::try_from(view)
        else {
            return Err(JsError::new(&format!(
                "a view takes {VIEW_FLOATS} floats, not {}",
                view.len()
            )));
        };
        let (width, height) = (width as u32, height as u32);
        let most = self.device.limits().max_texture_dimension_2d;
        if width == 0 || height == 0 || width > most || height > most {
            return Err(JsError::new(&format!(
                "a render of {width} by {height} pixels is not within 1 to {most}"
            )));
        }
        let stride = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let size = u64::from(stride) * u64::from(height);
        // Also keeps the readback's offsets within a `u32`.
        let largest = self.device.limits().max_buffer_size;
        if size > largest {
            return Err(JsError::new(&format!(
                "a render of {width} by {height} pixels takes {size} bytes, past {largest}"
            )));
        }
        let swap = match self.config.format {
            wgpu::TextureFormat::Rgba8Unorm => false,
            wgpu::TextureFormat::Bgra8Unorm => true,
            other => return Err(JsError::new(&format!("{other:?} cannot be read back"))),
        };
        // The pipelines were made for the surface's format.
        let target = self.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.config.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let depth = holds_once(items).then(|| depth_texture(&self.device, target.size()));
        let mut encoder = self.device.create_command_encoder(&Default::default());
        // Multiplied by its alpha, as blending over it leaves every colour.
        let alpha = f64::from(alpha.clamp(0.0, 1.0));
        let clear = wgpu::Color {
            r: f64::from(red) * alpha,
            g: f64::from(green) * alpha,
            b: f64::from(blue) * alpha,
            a: alpha,
        };
        self.record(
            &mut encoder,
            (
                &target.create_view(&Default::default()),
                depth
                    .as_ref()
                    .map(|depth| depth.create_view(&Default::default()))
                    .as_ref(),
            ),
            clear,
            [x, y, zoom, width as f32, height as f32],
            items,
            grid,
        );
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(height),
                },
            },
            target.size(),
        );
        self.queue.submit([encoder.finish()]);
        // Submitted work outlives its textures' destruction.
        target.destroy();
        if let Some(depth) = depth {
            depth.destroy();
        }
        let mapped = Arc::new(Mutex::new(None));
        let slot = Arc::clone(&mapped);
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                *slot.lock().expect("never poisoned") = Some(result);
            });
        // Before checking, so that dropping it destroys the buffer.
        let readback = Readback {
            device: self.device.clone(),
            buffer,
            mapped,
            width,
            height,
            stride,
            swap,
            webgpu: self.webgpu,
            opaque: alpha >= 1.0,
        };
        self.check()?;
        Ok(readback)
    }
}

#[wasm_bindgen]
extern "C" {
    /// The same array, whose allocation fails into a `Result`, as one thrown through the module
    /// would leave the readback borrowed and its buffer mapped.
    #[wasm_bindgen(extends = Uint8ClampedArray)]
    type Pixels;
    #[wasm_bindgen(catch, constructor, js_class = "Uint8ClampedArray")]
    fn new(length: u32) -> Result<Pixels, JsValue>;
}

#[wasm_bindgen]
pub struct Readback {
    device: wgpu::Device,
    buffer: wgpu::Buffer,
    mapped: Arc<Mutex<Option<Result<(), wgpu::BufferAsyncError>>>>,
    width: u32,
    height: u32,
    /// Bytes per row of the buffer, which the copy pads.
    stride: u32,
    /// Whether the surface's format has blue first.
    swap: bool,
    /// Whether its mapping is a JS array, which WebGL2 holds in the module's memory instead.
    webgpu: bool,
    /// Whether the colour behind was, which leaves every pixel so.
    opaque: bool,
}

#[wasm_bindgen]
impl Readback {
    /// Whether the pixels are ready, which WebGL2 learns only as it is asked again, in turns of
    /// the event loop.
    pub fn poll(&self) -> Result<bool, JsError> {
        self.device.poll(wgpu::PollType::Poll)?;
        match &*self.mapped.lock().expect("never poisoned") {
            Some(Ok(())) => Ok(true),
            Some(Err(error)) => Err(JsError::new(&format!(
                "the render was not read back: {error}"
            ))),
            None => Ok(false),
        }
    }

    /// Red, green, blue, and alpha, straight, row by row from the top. Only once
    /// [`Readback::poll`] says so, and once. They cross the module's memory a row at a time, as it
    /// never shrinks once grown.
    pub fn pixels(&self) -> Result<Uint8ClampedArray, JsError> {
        if !matches!(&*self.mapped.lock().expect("never poisoned"), Some(Ok(()))) {
            return Err(JsError::new("the render is not read back yet"));
        }
        let row = self.width * 4;
        let pixels: Uint8ClampedArray = Pixels::new(row * self.height)
            .map_err(|_| {
                JsError::new(&format!(
                    "the browser has no room for a render of {} by {} pixels",
                    self.width, self.height
                ))
            })?
            .into();
        let mut line = vec![0; row as usize];
        let view = self.buffer.slice(..).get_mapped_range()?;
        for y in 0..self.height {
            let start = y * self.stride;
            // Dereferencing the view on WebGPU would copy the whole mapping into the module.
            if self.webgpu {
                view.as_uint8array()
                    .subarray(start, start + row)
                    .copy_to(&mut line);
            } else {
                line.copy_from_slice(&view[start as usize..(start + row) as usize]);
            }
            if self.swap {
                for pixel in line.as_chunks_mut::<4>().0 {
                    pixel.swap(0, 2);
                }
            }
            if !self.opaque {
                crate::alpha::unpremultiply(&mut line);
            }
            pixels.subarray(y * row, (y + 1) * row).copy_from(&line);
        }
        drop(view);
        self.buffer.unmap();
        Ok(pixels)
    }
}

/// Dropping a buffer frees nothing on WebGPU.
impl Drop for Readback {
    fn drop(&mut self) {
        self.buffer.destroy();
    }
}

/// The frames of an animated GIF, PNG, or WebP, decoded one at a time onto its canvas.
#[wasm_bindgen]
pub struct Animation(crate::animation::Animation);

#[wasm_bindgen]
impl Animation {
    /// Throws when the bytes are not an image it decodes.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<Animation, JsError> {
        Ok(Self(crate::animation::Animation::new(bytes)?))
    }

    pub fn restart(&mut self) -> Result<(), JsError> {
        Ok(self.0.restart()?)
    }

    /// How many frames it decoded since it last started, which is the next one's index.
    #[wasm_bindgen(getter)]
    pub fn position(&self) -> u32 {
        self.0.position()
    }

    /// Past `count` frames without drawing them, fewer once none is left. How many it went past.
    pub fn skip(&mut self, count: u32) -> Result<u32, JsError> {
        Ok(self.0.skip(count)?)
    }

    /// The next frame, straight RGBA on its whole canvas, which `Renderer.show` draws,
    /// `undefined` once none is left.
    pub fn pixels(&mut self) -> Result<Option<Vec<u8>>, JsError> {
        Ok(self
            .0
            .next_frame()?
            .map(|frame| frame.into_buffer().into_raw()))
    }
}

/// Dropping a device frees nothing on WebGPU, so its textures would outlive the renderer.
impl Drop for Renderer {
    fn drop(&mut self) {
        self.device.destroy();
    }
}

impl Renderer {
    fn upload_from(&mut self, source: wgpu::ExternalImageSource) -> Result<u32, JsError> {
        let size = wgpu::Extent3d {
            width: source.width(),
            height: source.height(),
            depth_or_array_layers: 1,
        };
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size,
            mip_level_count: size.max_mips(wgpu::TextureDimension::D2),
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: TEXTURE_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        self.copy_external(source, &texture);
        self.generate_mipmaps(&texture);
        let view = texture.create_view(&Default::default());
        let bytes = (0..texture.mip_level_count())
            .map(|level| {
                let size = size.mip_level_size(level, wgpu::TextureDimension::D2);
                u64::from(size.width) * u64::from(size.height) * 4
            })
            .sum();
        let uploaded = Texture {
            group: self.image_group(&view),
            texture,
            bytes,
        };
        // Before it takes a slot, which nobody would know to release.
        self.check().inspect_err(|_| uploaded.texture.destroy())?;
        let index = match self.textures.iter().position(Option::is_none) {
            Some(free) => {
                self.textures[free] = Some(uploaded);
                free
            }
            None => {
                self.textures.push(Some(uploaded));
                self.textures.len() - 1
            }
        };
        Ok(u32::try_from(index).expect("fewer than 2³² textures"))
    }

    fn record(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        (target, depth): (&wgpu::TextureView, Option<&wgpu::TextureView>),
        clear: wgpu::Color,
        [x, y, zoom, width, height]: [f32; 5],
        items: &[f32],
        grid: &[f32],
    ) {
        let camera: Vec<u8> = [x, y, zoom, 0.0, width, height, 0.0, 0.0]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        self.queue.write_buffer(&self.camera, 0, &camera);
        if !grid.is_empty() {
            let grid: Vec<u8> = grid.iter().flat_map(|value| value.to_le_bytes()).collect();
            self.queue.write_buffer(&self.grid_uniform, 0, &grid);
        }
        let needed = items.len() / STRIDE;
        let capacity = (self.instances.size() / INSTANCE) as usize;
        if capacity < needed {
            // By half again, so that a board gaining images one by one does not make one at each
            // draw, and destroyed, as dropping one frees nothing on WebGPU.
            let grown = instance_buffer(&self.device, needed.max(capacity + capacity / 2));
            mem::replace(&mut self.instances, grown).destroy();
        }
        let (items, _) = items.as_chunks::<STRIDE>();
        let instances: Vec<u8> = items
            .iter()
            .flat_map(|item| &item[2..])
            .flat_map(|value| value.to_le_bytes())
            .collect();
        self.queue.write_buffer(&self.instances, 0, &instances);

        let pipelines = if depth.is_some() {
            &self.deep
        } else {
            &self.plain
        };
        let mut pass = begin(encoder, target, depth, wgpu::LoadOp::Clear(clear));
        pass.set_bind_group(0, &self.camera_group, &[]);
        if !grid.is_empty() {
            pass.set_pipeline(&pipelines.grid);
            pass.set_bind_group(1, &self.grid_group, &[]);
            pass.draw(0..3, 0..1);
        }
        pass.set_vertex_buffer(0, self.instances.slice(..));
        // Strokes one after the other draw at once, as each draw rebinds the instances on
        // WebGL2.
        let mut drawing = None;
        let mut at = 0;
        while at < items.len() {
            let [kind, texture, ..] = items[at];
            if kind == ONCE {
                let stroke = items[at][STRIDE - 2];
                let run = items[at..]
                    .iter()
                    .take_while(|item| item[0] == ONCE && item[STRIDE - 2] == stroke)
                    .count();
                for pipeline in &self.once {
                    pass.set_pipeline(pipeline);
                    pass.draw(0..4, at as u32..(at + run) as u32);
                }
                drawing = None;
                at += run;
                continue;
            }
            let (pipeline, run) = if kind == STROKE {
                let run = items[at..]
                    .iter()
                    .take_while(|item| item[0] == STROKE)
                    .count();
                (&pipelines.strokes, run)
            } else if let Some(Some(texture)) = self.textures.get(texture as usize) {
                pass.set_bind_group(1, &texture.group, &[]);
                (
                    if kind == IMAGE {
                        &pipelines.quads
                    } else {
                        &pipelines.texts
                    },
                    1,
                )
            } else {
                at += 1;
                continue;
            };
            if drawing != Some(kind) {
                pass.set_pipeline(pipeline);
                drawing = Some(kind);
            }
            pass.draw(0..4, at as u32..(at + run) as u32);
            at += run;
        }
    }

    fn copy_external(&self, source: wgpu::ExternalImageSource, texture: &wgpu::Texture) {
        let size = wgpu::Extent3d {
            width: source.width(),
            height: source.height(),
            depth_or_array_layers: 1,
        };
        self.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source,
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            size,
        );
    }

    fn fitting(&self, index: u32, width: u32, height: u32) -> Result<&Texture, JsError> {
        let texture = self
            .textures
            .get(index as usize)
            .and_then(Option::as_ref)
            .ok_or_else(|| JsError::new(&format!("texture {index} is not uploaded")))?;
        let size = texture.texture.size();
        if (width, height) == (size.width, size.height) {
            Ok(texture)
        } else {
            Err(JsError::new(&format!(
                "a {width} by {height} frame does not fit a {} by {} texture",
                size.width, size.height
            )))
        }
    }

    fn check(&self) -> Result<(), JsError> {
        match self.error.lock().expect("never poisoned").take() {
            Some(error) => Err(JsError::new(&error)),
            None => Ok(()),
        }
    }

    fn image_group(&self, view: &wgpu::TextureView) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.image_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }

    /// wgpu leaves mipmaps to its users.
    fn generate_mipmaps(&self, texture: &wgpu::Texture) {
        let level = |at| {
            texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: at,
                mip_level_count: Some(1),
                ..Default::default()
            })
        };
        let mut encoder = self.device.create_command_encoder(&Default::default());
        for at in 1..texture.mip_level_count() {
            let above = self.image_group(&level(at - 1));
            let target = level(at);
            let mut pass = begin(
                &mut encoder,
                &target,
                None,
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            );
            pass.set_pipeline(&self.blit);
            pass.set_bind_group(0, &above, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
    }
}

fn check_grid(grid: &[f32]) -> Result<(), JsError> {
    if grid.is_empty() || grid.len() == GRID_FLOATS {
        Ok(())
    } else {
        Err(JsError::new(&format!(
            "a grid takes {GRID_FLOATS} floats, not {}",
            grid.len()
        )))
    }
}

fn module(device: &wgpu::Device, shader: &str) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(shader.into()),
    })
}

fn pipeline(
    device: &wgpu::Device,
    module: &wgpu::ShaderModule,
    layouts: &[&wgpu::BindGroupLayout],
    buffers: &[Option<wgpu::VertexBufferLayout<'_>>],
    target: wgpu::ColorTargetState,
    depth_stencil: Option<wgpu::DepthStencilState>,
    fragment: &str,
) -> wgpu::RenderPipeline {
    let layouts: Vec<Option<&wgpu::BindGroupLayout>> = layouts.iter().copied().map(Some).collect();
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &layouts,
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers,
        },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(fragment),
            compilation_options: Default::default(),
            targets: &[Some(target)],
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleStrip,
            ..Default::default()
        },
        depth_stencil,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn begin<'a>(
    encoder: &'a mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    depth: Option<&wgpu::TextureView>,
    load: wgpu::LoadOp<wgpu::Color>,
) -> wgpu::RenderPass<'a> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: None,
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load,
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: depth.map(|view| wgpu::RenderPassDepthStencilAttachment {
            view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(1.0),
                store: wgpu::StoreOp::Discard,
            }),
            stencil_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(0),
                store: wgpu::StoreOp::Discard,
            }),
        }),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

/// What a pipeline does with the depth and the stencil, which only [`ONCE`] uses.
enum Depth {
    Ignored,
    /// Starts both over, as far, and none.
    Clear,
    /// Keeps the nearest.
    Cover,
    /// Draws where as near as what was kept, the first time only.
    Once,
}

fn depth(use_: Depth) -> wgpu::DepthStencilState {
    let stencil = |compare, pass_op| {
        let face = wgpu::StencilFaceState {
            compare,
            fail_op: wgpu::StencilOperation::Keep,
            depth_fail_op: wgpu::StencilOperation::Keep,
            pass_op,
        };
        wgpu::StencilState {
            front: face,
            back: face,
            read_mask: 0xff,
            write_mask: 0xff,
        }
    };
    let (write, compare, stencil) = match use_ {
        Depth::Ignored => (false, wgpu::CompareFunction::Always, Default::default()),
        Depth::Clear => (
            true,
            wgpu::CompareFunction::Always,
            stencil(wgpu::CompareFunction::Always, wgpu::StencilOperation::Zero),
        ),
        Depth::Cover => (true, wgpu::CompareFunction::Less, Default::default()),
        Depth::Once => (
            false,
            wgpu::CompareFunction::LessEqual,
            stencil(
                wgpu::CompareFunction::Equal,
                wgpu::StencilOperation::IncrementClamp,
            ),
        ),
    };
    wgpu::DepthStencilState {
        format: DEPTH,
        depth_write_enabled: Some(write),
        depth_compare: Some(compare),
        stencil,
        bias: Default::default(),
    }
}

/// Whether `items` hold a see-through pen stroke, which only a pass with the depth and the
/// stencil draws.
fn holds_once(items: &[f32]) -> bool {
    let (items, _) = items.as_chunks::<STRIDE>();
    items.iter().any(|item| item[0] == ONCE)
}

fn depth_texture(device: &wgpu::Device, size: wgpu::Extent3d) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    })
}

fn instance_buffer(device: &wgpu::Device, count: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (count.max(1) as u64) * INSTANCE,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}
