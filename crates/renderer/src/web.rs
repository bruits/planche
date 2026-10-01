use std::sync::{Arc, Mutex};

use wasm_bindgen::Clamped;
use wasm_bindgen::prelude::*;
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

const QUADS: &str = r#"
@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var image_sampler: sampler;

struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) grey: f32 };

@vertex fn vs(
    @builtin(vertex_index) index: u32,
    @location(0) rect: vec4f,
    @location(1) degrees: f32,
    @location(2) crop: vec4f,
    @location(3) grey: f32,
) -> Out {
    let corner = vec2f(f32(index & 1u), f32(index >> 1u));
    var out: Out;
    out.position = place(corner, rect, degrees);
    out.uv = crop.xy + corner * crop.zw;
    out.grey = grey;
    return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
    let color = textureSample(image, image_sampler, in.uv);
    let luma = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
    return vec4f(mix(color.rgb, vec3f(luma), in.grey), color.a);
}
"#;

/// Only the texture's alpha counts, as filtering its colour would darken the edges of the
/// letters with the transparent black around them.
const TEXT: &str = r#"
@group(1) @binding(0) var coverage: texture_2d<f32>;
@group(1) @binding(1) var coverage_sampler: sampler;

struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) colour: vec3f };

@vertex fn vs(
    @builtin(vertex_index) index: u32,
    @location(0) rect: vec4f,
    @location(1) degrees: f32,
    @location(2) colour: vec3f,
) -> Out {
    let corner = vec2f(f32(index & 1u), f32(index >> 1u));
    var out: Out;
    out.position = place(corner, rect, degrees);
    out.uv = corner;
    out.colour = colour;
    return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
    return vec4f(in.colour, textureSample(coverage, coverage_sampler, in.uv).a);
}
"#;

/// Each stroke covers a quad a pixel wider than itself, and its fragments measure in device
/// pixels how far they are from the line, which smooths its edge over one pixel.
const STROKES: &str = r#"
struct Out {
    @builtin(position) position: vec4f,
    @location(0) local: vec2f,
    @location(1) size: vec2f,
    @location(2) radius: f32,
    @location(3) shape: f32,
    @location(4) colour: vec3f,
};

/// `shape` is 0 for a line from `geometry.xy` to `geometry.zw`, 1 or 2 for the outline of a
/// rectangle or an ellipse in the frame `geometry`, turned by `degrees`, 3 fills that
/// rectangle, and 4 draws its diagonals. `width` is in board units, but never under a device
/// pixel.
@vertex fn vs(
    @builtin(vertex_index) index: u32,
    @location(0) shape: f32,
    @location(1) geometry: vec4f,
    @location(2) degrees: f32,
    @location(3) width: f32,
    @location(4) colour: vec3f,
) -> Out {
    let corner = vec2f(f32(index & 1u), f32(index >> 1u));
    let radius = max(width * camera.zoom, 1.0) * 0.5;
    let margin = radius + 1.0;
    var out: Out;
    out.radius = radius;
    out.shape = shape;
    out.colour = colour;
    if shape < 0.5 {
        let start = (geometry.xy - camera.origin) * camera.zoom;
        let end = (geometry.zw - camera.origin) * camera.zoom;
        let span = distance(start, end);
        let along = select(vec2f(1.0, 0.0), (end - start) / span, span > 0.0);
        let across = vec2f(-along.y, along.x);
        out.local = vec2f(mix(-margin, span + margin, corner.x), mix(-margin, margin, corner.y));
        out.size = vec2f(span, 0.0);
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

/// Negative within the box.
fn box(local: vec2f, half: vec2f) -> f32 {
    let outside = abs(local) - half;
    return length(max(outside, vec2f(0.0))) + min(max(outside.x, outside.y), 0.0);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
    var away: f32;
    if in.shape < 0.5 {
        away = length(vec2f(in.local.x - clamp(in.local.x, 0.0, in.size.x), in.local.y));
    } else if in.shape < 1.5 {
        away = abs(box(in.local, in.size));
    } else if in.shape > 3.5 {
        // Folded into one quarter, both diagonals run from the centre to the corner.
        let point = abs(in.local);
        let along = clamp(dot(point, in.size) / max(dot(in.size, in.size), 1e-6), 0.0, 1.0);
        away = length(point - in.size * along);
    } else if in.shape > 2.5 {
        return vec4f(in.colour, clamp(0.5 - box(in.local, in.size), 0.0, 1.0));
    } else {
        // As the core measures it, bounded where a thin ellipse would otherwise show a gap or
        // fat tips.
        let axes = max(in.size, vec2f(0.5));
        let point = abs(in.local);
        let scaled = length(point / axes);
        let gradient = length(point / (axes * axes));
        let estimate = select(1e30, abs(scaled * (scaled - 1.0) / gradient), gradient > 0.0);
        let unit = point / axes;
        let straight = axes * sqrt(max(1.0 - unit.yx * unit.yx, vec2f(0.0))) - point;
        let frame = length(max(point - axes, vec2f(0.0)));
        away = select(max(estimate, frame), min(estimate, min(straight.x, straight.y)), scaled < 1.0);
    }
    return vec4f(in.colour, clamp(in.radius - away + 0.5, 0.0, 1.0));
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

const TEXTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Floats per item in [`Renderer::draw`]: its kind, which is 0 for an image, 1 for a stroke, and
/// 2 for a text, its texture or -1, then its instance.
///
/// An image's instance is its x, y, width, height, rotation, the crop's x, y, width, and height
/// in texture coordinates, which a negative size flips, and 1 to draw in greys or 0. A text's is
/// its x, y, width, height, rotation, colour, and padding. A stroke's is the shape, geometry,
/// rotation, width, and colour that [`STROKES`] reads. Colours are red, green, and blue from 0 to 1.
const STRIDE: usize = 12;
const IMAGE: f32 = 0.0;
const STROKE: f32 = 1.0;
/// Bytes per instance, which every kind shares, as WebGL2 finds instances by one stride.
const INSTANCE: u64 = (STRIDE as u64 - 2) * 4;
/// The camera's origin, zoom, and viewport, padded as [`CAMERA`] lays them out.
const CAMERA_SIZE: u64 = 32;
/// Floats of the grid, as [`GRID`] lays them out. Its offset, spacing, fade, colour's red,
/// green, blue, and alpha from 0 to 1, width, 1 for dots or 0 for lines, step, and padding.
const GRID_FLOATS: usize = 12;
/// Floats of a view in [`Renderer::render`]. The x and y of the board's point at the top-left,
/// the zoom, the width and height in pixels, and the colour behind the board's red, green, and
/// blue from 0 to 1.
const VIEW_FLOATS: usize = 8;

#[wasm_bindgen]
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    quads: wgpu::RenderPipeline,
    texts: wgpu::RenderPipeline,
    strokes: wgpu::RenderPipeline,
    grid: wgpu::RenderPipeline,
    blit: wgpu::RenderPipeline,
    image_layout: wgpu::BindGroupLayout,
    camera: wgpu::Buffer,
    camera_group: wgpu::BindGroup,
    grid_uniform: wgpu::Buffer,
    grid_group: wgpu::BindGroup,
    sampler: wgpu::Sampler,
    /// By index, which a released texture leaves free for the next one.
    textures: Vec<Option<Texture>>,
    instances: wgpu::Buffer,
    backend: String,
    /// wgpu's default is to panic, which would leave the page waiting on a dead module.
    error: Arc<Mutex<Option<String>>>,
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
    // Textures hold sRGB bytes as they are, which an sRGB surface would encode again.
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
    let quads = pipeline(
        &device,
        &[CAMERA, QUADS].concat(),
        &[&camera_layout, &image_layout],
        &[Some(wgpu::VertexBufferLayout {
            array_stride: INSTANCE,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32, 2 => Float32x4, 3 => Float32],
        })],
        target.clone(),
    );
    let texts = pipeline(
        &device,
        &[CAMERA, TEXT].concat(),
        &[&camera_layout, &image_layout],
        &[Some(wgpu::VertexBufferLayout {
            array_stride: INSTANCE,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32, 2 => Float32x3],
        })],
        target.clone(),
    );
    let strokes = pipeline(
        &device,
        &[CAMERA, STROKES].concat(),
        &[&camera_layout],
        &[Some(wgpu::VertexBufferLayout {
            array_stride: INSTANCE,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32, 1 => Float32x4, 2 => Float32, 3 => Float32, 4 => Float32x3],
        })],
        target.clone(),
    );
    let grid = pipeline(
        &device,
        &[CAMERA, GRID].concat(),
        &[&camera_layout, &camera_layout],
        &[],
        target,
    );
    let blit = pipeline(&device, BLIT, &[&image_layout], &[], TEXTURE_FORMAT.into());
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
        quads,
        texts,
        strokes,
        grid,
        blit,
        image_layout,
        camera,
        camera_group,
        grid_uniform,
        grid_group,
        sampler,
        textures: Vec::new(),
        backend: format!("wgpu {:?}, {}", info.backend, info.name),
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
        let texture = self.fitting(index, width, height)?;
        self.queue.write_texture(
            texture.texture.as_image_copy(),
            canvas.as_raw(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * width),
                rows_per_image: Some(height),
            },
            texture.texture.size(),
        );
        self.generate_mipmaps(&texture.texture);
        Ok(Some(f64::from(numerator) / f64::from(denominator)))
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
        let viewport = [self.config.width as f32, self.config.height as f32];
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.record(
            &mut encoder,
            &view,
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
        let Ok([x, y, zoom, width, height, red, green, blue]) =
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
        let stride = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(stride) * u64::from(height),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let clear = wgpu::Color {
            r: f64::from(red),
            g: f64::from(green),
            b: f64::from(blue),
            a: 1.0,
        };
        self.record(
            &mut encoder,
            &target.create_view(&Default::default()),
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
        };
        self.check()?;
        Ok(readback)
    }
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

    /// Red, green, blue, and alpha, as straight as the clear colour left them, which is opaque,
    /// row by row from the top. Only once [`Readback::poll`] says so, and once.
    pub fn pixels(&self) -> Result<Clamped<Vec<u8>>, JsError> {
        if !matches!(&*self.mapped.lock().expect("never poisoned"), Some(Ok(()))) {
            return Err(JsError::new("the render is not read back yet"));
        }
        let row = self.width as usize * 4;
        let view = self.buffer.slice(..).get_mapped_range()?;
        let mut pixels = Vec::with_capacity(row * self.height as usize);
        for line in view.chunks(self.stride as usize) {
            pixels.extend_from_slice(&line[..row]);
        }
        drop(view);
        self.buffer.unmap();
        if self.swap {
            for pixel in pixels.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
        }
        Ok(Clamped(pixels))
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
        target: &wgpu::TextureView,
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
        if self.instances.size() < (items.len() / STRIDE) as u64 * INSTANCE {
            self.instances = instance_buffer(&self.device, items.len() / STRIDE);
        }
        let (items, _) = items.as_chunks::<STRIDE>();
        let instances: Vec<u8> = items
            .iter()
            .flat_map(|item| &item[2..])
            .flat_map(|value| value.to_le_bytes())
            .collect();
        self.queue.write_buffer(&self.instances, 0, &instances);

        let mut pass = begin(encoder, target, wgpu::LoadOp::Clear(clear));
        pass.set_bind_group(0, &self.camera_group, &[]);
        if !grid.is_empty() {
            pass.set_pipeline(&self.grid);
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
            let (pipeline, run) = if kind == STROKE {
                let run = items[at..]
                    .iter()
                    .take_while(|item| item[0] == STROKE)
                    .count();
                (&self.strokes, run)
            } else if let Some(Some(texture)) = self.textures.get(texture as usize) {
                pass.set_bind_group(1, &texture.group, &[]);
                (
                    if kind == IMAGE {
                        &self.quads
                    } else {
                        &self.texts
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

fn pipeline(
    device: &wgpu::Device,
    shader: &str,
    layouts: &[&wgpu::BindGroupLayout],
    buffers: &[Option<wgpu::VertexBufferLayout<'_>>],
    target: wgpu::ColorTargetState,
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(shader.into()),
    });
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
            module: &module,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers,
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(target)],
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleStrip,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn begin<'a>(
    encoder: &'a mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
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
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
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
