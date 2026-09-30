//! The wgpu candidate of the renderer bake-off: images as textured quads, on WebGL2 or
//! WebGPU, drawn in the order given.

#![cfg(target_arch = "wasm32")]

use std::sync::{Arc, Mutex};

use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, ImageBitmap};

/// Uniform buffers take multiples of 16 bytes on WebGL2, hence the padding.
const QUADS: &str = r#"
struct Camera { origin: vec2f, zoom: f32, viewport: vec2f, padding: vec2f };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var image_sampler: sampler;

struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) index: u32, @location(0) rect: vec4f, @location(1) degrees: f32) -> Out {
    let corner = vec2f(f32(index & 1u), f32(index >> 1u));
    let local = (corner - 0.5) * rect.zw;
    let angle = radians(degrees);
    let turned = vec2f(local.x * cos(angle) - local.y * sin(angle), local.x * sin(angle) + local.y * cos(angle));
    let screen = (rect.xy + rect.zw * 0.5 + turned - camera.origin) * camera.zoom;
    var out: Out;
    out.position = vec4f(screen.x / camera.viewport.x * 2.0 - 1.0, 1.0 - screen.y / camera.viewport.y * 2.0, 0.0, 1.0);
    out.uv = corner;
    return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
    return textureSample(image, image_sampler, in.uv);
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
/// Floats per image in [`Renderer::draw`]: texture, x, y, width, height, and rotation.
const STRIDE: usize = 6;
/// Bytes per instance: x, y, width, height, and rotation.
const INSTANCE: u64 = 5 * 4;

#[wasm_bindgen]
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    quads: wgpu::RenderPipeline,
    blit: wgpu::RenderPipeline,
    image_layout: wgpu::BindGroupLayout,
    camera: wgpu::Buffer,
    camera_group: wgpu::BindGroup,
    sampler: wgpu::Sampler,
    images: Vec<wgpu::BindGroup>,
    instances: wgpu::Buffer,
    backend: String,
    /// wgpu's default is to panic, which would leave the page waiting on a dead module.
    error: Arc<Mutex<Option<String>>>,
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
    // Like the other candidates, which draw image bytes as they are.
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
            visibility: wgpu::ShaderStages::VERTEX,
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
        size: 32,
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
    let blend = Some(wgpu::BlendState::ALPHA_BLENDING);
    let quads = pipeline(
        &device,
        QUADS,
        &[&camera_layout, &image_layout],
        &[Some(wgpu::VertexBufferLayout {
            array_stride: INSTANCE,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32],
        })],
        wgpu::ColorTargetState {
            format: config.format,
            blend,
            write_mask: wgpu::ColorWrites::ALL,
        },
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
        blit,
        image_layout,
        camera,
        camera_group,
        sampler,
        images: Vec::new(),
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

    /// The texture's index, for [`Renderer::draw`].
    pub fn upload(&mut self, bitmap: ImageBitmap) -> Result<u32, JsError> {
        let size = wgpu::Extent3d {
            width: bitmap.width(),
            height: bitmap.height(),
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
                source: wgpu::ExternalImageSource::ImageBitmap(bitmap),
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
        self.images.push(self.image_group(&view));
        self.check()?;
        Ok(u32::try_from(self.images.len() - 1).expect("fewer than 2³² images"))
    }

    /// In device pixels.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
    }

    /// `zoom` is in device pixels per board unit, and `images` holds [`STRIDE`] floats per
    /// image.
    pub fn draw(&mut self, x: f32, y: f32, zoom: f32, images: &[f32]) -> Result<(), JsError> {
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
        if self.instances.size() < (images.len() / STRIDE) as u64 * INSTANCE {
            self.instances = instance_buffer(&self.device, images.len() / STRIDE);
        }
        let (images, _) = images.as_chunks::<STRIDE>();
        let instances: Vec<u8> = images
            .iter()
            .flat_map(|image| &image[1..])
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
            pass.set_pipeline(&self.quads);
            pass.set_bind_group(0, &self.camera_group, &[]);
            pass.set_vertex_buffer(0, self.instances.slice(..));
            for (at, image) in images.iter().enumerate() {
                let texture = &self.images[image[0] as usize];
                let at = at as u32;
                pass.set_bind_group(1, texture, &[]);
                pass.draw(0..4, at..at + 1);
            }
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        self.check()
    }
}

/// Dropping a device frees nothing on WebGPU, which would leave its textures to the next run.
impl Drop for Renderer {
    fn drop(&mut self) {
        self.device.destroy();
    }
}

impl Renderer {
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
