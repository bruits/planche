//! The renderer: images as textured quads, text as textures of its coverage in a colour,
//! strokes (lines, the outlines of rectangles and ellipses, and crosses), and filled
//! rectangles, on WebGL2 or WebGPU, drawn in the order given.

#![cfg(target_arch = "wasm32")]

use std::sync::{Arc, Mutex};

use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, ImageBitmap};

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

#[wasm_bindgen]
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    quads: wgpu::RenderPipeline,
    texts: wgpu::RenderPipeline,
    strokes: wgpu::RenderPipeline,
    blit: wgpu::RenderPipeline,
    image_layout: wgpu::BindGroupLayout,
    camera: wgpu::Buffer,
    camera_group: wgpu::BindGroup,
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
    let camera = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: CAMERA_SIZE,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let camera_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &camera_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: camera.as_entire_binding(),
        }],
    });
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
        blit,
        image_layout,
        camera,
        camera_group,
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

    /// `zoom` is in device pixels per board unit, and `items` holds [`STRIDE`] floats per item,
    /// back to front.
    pub fn draw(&mut self, x: f32, y: f32, zoom: f32, items: &[f32]) -> Result<(), JsError> {
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) => frame,
            other => return Err(JsError::new(&format!("no frame to draw: {other:?}"))),
        };
        let viewport = [self.config.width as f32, self.config.height as f32];
        let camera: Vec<u8> = [x, y, zoom, 0.0, viewport[0], viewport[1], 0.0, 0.0]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        self.queue.write_buffer(&self.camera, 0, &camera);
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

        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = begin(
                &mut encoder,
                &view,
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            );
            pass.set_bind_group(0, &self.camera_group, &[]);
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
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        self.check()
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
        self.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source,
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            size,
        );
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
        self.check()?;
        Ok(u32::try_from(index).expect("fewer than 2³² textures"))
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
