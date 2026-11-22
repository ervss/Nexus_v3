var mr=Object.create;var Pi=Object.defineProperty;var xr=Object.getOwnPropertyDescriptor;var gr=Object.getOwnPropertyNames;var br=Object.getPrototypeOf,yr=Object.prototype.hasOwnProperty;var vr=(e,t)=>()=>(t||e((t={exports:{}}).exports,t),t.exports);var wr=(e,t,i,s)=>{if(t&&typeof t=="object"||typeof t=="function")for(let n of gr(t))!yr.call(e,n)&&n!==i&&Pi(e,n,{get:()=>t[n],enumerable:!(s=xr(t,n))||s.enumerable});return e};var Sr=(e,t,i)=>(i=e!=null?mr(br(e)):{},wr(t||!e||!e.__esModule?Pi(i,"default",{value:e,enumerable:!0}):i,e));var fr=vr((exports,module)=>{(function(t,i){typeof exports=="object"&&typeof module=="object"?module.exports=i():typeof define=="function"&&define.amd?define([],i):typeof exports=="object"?exports.WebSR=i():t.WebSR=i()})(self,()=>(()=>{"use strict";var __webpack_modules__={"./src/context.ts":function(__unused_webpack_module,exports){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
class WebGPUContext {
    constructor(device, resolution, canvas, scale, debug) {
        this.device = device;
        this.canvas = canvas;
        this.resolution = resolution;
        this.textures = {};
        this.buffers = {};
        this.destroyed = false;
        this.scale = scale;
        this.debug = debug;
        let context = this.canvas.getContext('webgpu');
        if (context instanceof GPUCanvasContext) {
            this.context = context;
        }
        else {
            throw new Error("Unable to load WebGPU context");
        }
        this.context.configure({
            device: this.device,
            format: navigator.gpu.getPreferredCanvasFormat()
        });
        this.textureUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
        this.bufferUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
        if (this.debug) {
            // Read output pixel value
            this.textureUsage = this.textureUsage | GPUTextureUsage.COPY_SRC;
            this.bufferUsage = this.bufferUsage | GPUBufferUsage.COPY_SRC;
        }
        this.textures['output'] = this.context.getCurrentTexture();
    }
    readBuffer(bufferName) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.buffers[bufferName])
                throw new Error(\`No buffer with name \${bufferName}\`);
            const readEncoder = this.device.createCommandEncoder({
                label: \`Read \${bufferName} buffer encoder\`,
            });
            const buffer = this.buffers[bufferName];
            const resultBuffer = this.device.createBuffer({
                label: 'result buffer',
                size: buffer.size,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });
            readEncoder.copyBufferToBuffer(buffer, 0, resultBuffer, 0, resultBuffer.size);
            this.device.queue.submit([readEncoder.finish()]);
            yield resultBuffer.mapAsync(GPUMapMode.READ);
            let range = resultBuffer.getMappedRange();
            return new Float32Array(range);
        });
    }
    readTexture(textureName) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.textures[textureName])
                throw new Error(\`No texture with name \${textureName}\`);
            const readEncoder = this.device.createCommandEncoder({
                label: \`Read \${textureName} texture encoder\`,
            });
            const texture = this.textures[textureName];
            let bitsPerPixel = 16;
            if (texture.format === 'rgba8unorm')
                bitsPerPixel = 4;
            if (texture.format === 'r32float')
                bitsPerPixel = 4;
            const resultBuffer = this.device.createBuffer({
                label: 'result buffer',
                size: texture.width * texture.height * bitsPerPixel,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });
            readEncoder.copyTextureToBuffer({
                texture: this.textures[textureName],
            }, {
                buffer: resultBuffer,
                bytesPerRow: texture.width * bitsPerPixel
            }, {
                width: texture.width,
                height: texture.height,
                depthOrArrayLayers: 1,
            });
            this.device.queue.submit([readEncoder.finish()]);
            yield resultBuffer.mapAsync(GPUMapMode.READ);
            if (texture.format === 'r32float')
                return new Float32Array(resultBuffer.getMappedRange());
            else if (texture.format === 'rgba32float')
                return new Float32Array(resultBuffer.getMappedRange());
            else if (texture.format === 'rgba8unorm')
                return new Uint8ClampedArray(resultBuffer.getMappedRange());
            return new Float32Array(0);
        });
    }
    destroy() {
        this.device.destroy();
        this.destroyed = true;
    }
    buffer(key, options) {
        if (!this.buffers[key]) {
            options = options || {};
            const width = options.width || this.resolution.width;
            const height = options.height || this.resolution.height;
            const channels = options.channels || 4;
            const bitdepth = options.bitdepth || 4;
            this.buffers[key] = this.device.createBuffer({
                label: key,
                size: width * height * channels * bitdepth,
                usage: this.bufferUsage
            });
        }
        return this.buffers[key];
    }
    texture(key, options) {
        if (!this.textures[key]) {
            options = options || {};
            this.textures[key] = this.device.createTexture({
                label: key,
                size: [options.width || this.resolution.width, options.height || this.resolution.height],
                format: options.format || 'rgba32float',
                usage: this.textureUsage
            });
        }
        return this.textures[key];
    }
}
exports["default"] = WebGPUContext;


//# sourceURL=webpack://WebSR/./src/context.ts?
}`)},"./src/layers/anime4k/conv2d-112x4.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_compute_layer_1 = __webpack_require__(/*! ../base_compute_layer */ "./src/layers/base_compute_layer.ts");
class Anime4KConv112x4 extends base_compute_layer_1.default {
    constructor(inputs, outputBuffer, weights, first) {
        super(inputs, outputBuffer, weights);
        this.label = "Anime4KConv112x4";
        const kernels = weights.weights;
        this.createUniform("kernels", "array<mat4x4f, 28>");
        let read_buffers = '';
        for (let i = 0; i < 7; i++) {
            if (first) {
                read_buffers += \`
                let pixel_val\${i} = inputBuffer\${i}[buff_ind];
                result += kernels[\${4 * i}]*max(pixel_val\${i}, vec4f(0.0));
                result += kernels[\${4 * i + 2}]*max(-1.0*pixel_val\${i}, vec4f(0.0));
            \`;
            }
            else {
                read_buffers += \`
                let pixel_val\${i} = inputBuffer\${i}[buff_ind];
                result += kernels[\${4 * i + 1}]*max(pixel_val\${i}, vec4f(0.0));
                result += kernels[\${4 * i + 3}]*max(-1.0*pixel_val\${i}, vec4f(0.0));\`;
            }
        }
        this.shader = this.createStandardShader(\`
        
          @compute @workgroup_size(\${this.num_work_groups}, \${this.num_work_groups}) fn main( @builtin(global_invocation_id) id: vec3<u32>) {
          
                let x = id.x;
                let y = id.y;
                
                let i = id.y*\${this.resolution.width} + x;
                var result  = vec4f(0.0, 0.0, 0.0, 0.0);
                
                let coord = vec2<i32>( i32(x), i32(y));
               
                let buff_ind = coord.y*\${this.resolution.width} + coord.x;
                \${read_buffers}
                
                outputBuffer[i] = result;
          }
        \`);
        this.setUniform("kernels", new Float32Array(kernels));
        this.defaultSetup();
    }
    defaultPipelineConfig() {
        return {
            label: \`\${this.label}-pipeline\`,
            layout: 'auto',
            compute: {
                module: this.shader,
                entryPoint: 'main',
            },
        };
    }
    defaultBindGroup() {
        const entries = [];
        this.inputs.forEach(function (input, i) {
            if (input instanceof GPUExternalTexture) {
                entries.push({ binding: i, resource: input });
            }
            else if (input instanceof GPUTexture) {
                entries.push({ binding: i, resource: input.createView() });
            }
            else if (input instanceof GPUBuffer) {
                entries.push({ binding: i, resource: { buffer: input } });
            }
        });
        this.uniforms.forEach((uniform, i) => {
            entries.push({
                binding: i + this.inputs.length,
                resource: {
                    buffer: this.buffers[uniform.name]
                }
            });
        });
        if (this.output instanceof GPUBuffer) {
            entries.push({
                binding: this.inputs.length + this.uniforms.length,
                resource: {
                    buffer: this.output
                }
            });
        }
        if (entries.length === 0)
            return null;
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries
        });
    }
}
exports["default"] = Anime4KConv112x4;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/conv2d-112x4.ts?
}`)},"./src/layers/anime4k/conv2d-16x4.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_compute_layer_1 = __webpack_require__(/*! ../base_compute_layer */ "./src/layers/base_compute_layer.ts");
class Anime4KConv16x4 extends base_compute_layer_1.default {
    constructor(inputs, outputBuffer, weights) {
        super(inputs, outputBuffer, weights);
        this.label = "Anime4KConv16x4";
        const kernels = weights.weights;
        const bias = weights.bias;
        this.createUniform("kernel_offsets", "array<vec4f, 9>");
        this.createUniform("kernels", "array<mat4x4f, 36>");
        this.createUniform("bias", "vec4f");
        this.shader = this.createStandardShader(\`
        
          @compute @workgroup_size(\${this.num_work_groups}, \${this.num_work_groups}) fn main( @builtin(global_invocation_id) id: vec3<u32>) {
          
                let x = id.x;
                let y = id.y;
                
                let i = id.y*\${this.resolution.width} + x;
                var result  = vec4f(0.0, 0.0, 0.0, 0.0);
                
                let coord = vec2<i32>( i32(x), i32(y));
                      
                 for(var i = 0u; i < 9; i++){
                   let pixel_loc = coord + vec2<i32>(kernel_offsets[i].xy);
                   let buff_ind = pixel_loc.y*\${this.resolution.width} + pixel_loc.x;
                   
                   let pix_val0 = inputBuffer0[buff_ind];
                   let pix_val1 = inputBuffer1[buff_ind];
                  
                   result += kernels[i]*max(pix_val0, vec4f(0.0));
                   result += kernels[i+9]*max(pix_val1, vec4f(0.0));
                   result += kernels[i+18]*max(-1.0*pix_val0, vec4f(0.0));
                   result += kernels[i+27]*max(-1.0*pix_val1, vec4f(0.0));
                 } 
                 

                    
                result += bias;
                
                outputBuffer[i] = result;
          }
        \`);
        this.setUniform("kernel_offsets", new Float32Array([
            -1, -1, 0, 0,
            -1, 0, 0, 0,
            -1, 1, 0, 0,
            0, -1, 0, 0,
            0, 0, 0, 0,
            0, 1, 0, 0,
            1, -1, 0, 0,
            1, 0, 0, 0,
            1, 1, 0, 0,
        ]));
        this.setUniform("kernels", new Float32Array(kernels));
        this.setUniform("bias", new Float32Array(bias));
        this.defaultSetup();
    }
}
exports["default"] = Anime4KConv16x4;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/conv2d-16x4.ts?
}`)},"./src/layers/anime4k/conv2d-3x4.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_compute_layer_1 = __webpack_require__(/*! ../base_compute_layer */ "./src/layers/base_compute_layer.ts");
class Anime4KConv3x4 extends base_compute_layer_1.default {
    constructor(inputTextures, outputBuffer, weights) {
        super(inputTextures, outputBuffer, weights);
        this.label = "Anime4KConv3x4";
        const kernels = weights.weights;
        const bias = weights.bias;
        this.createUniform("kernel_offsets", "array<vec4f, 9>");
        this.createUniform("kernels", "array<mat4x4f, 9>");
        this.createUniform("bias", "vec4f");
        // Set up pipeline in Lazy Load
        this.setUniform("kernel_offsets", new Float32Array([
            -1, -1, 0, 0,
            -1, 0, 0, 0,
            -1, 1, 0, 0,
            0, -1, 0, 0,
            0, 0, 0, 0,
            0, 1, 0, 0,
            1, -1, 0, 0,
            1, 0, 0, 0,
            1, 1, 0, 0,
        ]));
        this.setUniform("kernels", new Float32Array(kernels));
        this.setUniform("bias", new Float32Array(bias));
    }
    lazyLoadSetup() {
        const externalTexture = this.inputs[0] instanceof GPUExternalTexture;
        const textureLoad = externalTexture ? 'textureLoad(inputTexture0, coord + offset)' :
            'textureLoad(inputTexture0, coord + offset, 0)';
        this.shader = this.createStandardShader(\`
        
          @compute @workgroup_size(\${this.num_work_groups}, \${this.num_work_groups}) fn main( @builtin(global_invocation_id) id: vec3<u32>) {
          
                let x = id.x;
                let y = id.y;
                
                let i = id.y*\${this.resolution.width} + x;
                var result  = vec4f(0.0, 0.0, 0.0, 0.0);
                
                let coord = vec2<i32>( i32(x), i32(y));
                      
                 for(var i = 0u; i < 9; i++){
                   let offset = vec2<i32>(kernel_offsets[i].xy);
                   result += kernels[i]*\${textureLoad};
                 } 
                    
                result += bias;
                
                outputBuffer[i] = result;
          }
        \`);
        this.pipeline = this.device.createComputePipeline(this.defaultPipelineConfig());
        this.bindGroup = this.defaultBindGroup();
    }
}
exports["default"] = Anime4KConv3x4;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/conv2d-3x4.ts?
}`)},"./src/layers/anime4k/conv2d-56x4.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_compute_layer_1 = __webpack_require__(/*! ../base_compute_layer */ "./src/layers/base_compute_layer.ts");
class Anime4KConv56x4 extends base_compute_layer_1.default {
    constructor(inputs, outputBuffer, weights) {
        super(inputs, outputBuffer, weights);
        this.label = "Anime4KConv56x4";
        const kernels = weights.weights;
        const bias = weights.bias;
        this.createUniform("kernels", "array<mat4x4f, 14>");
        this.createUniform("bias", "vec4f");
        let read_buffers = '';
        for (let i = 0; i < 7; i++) {
            read_buffers += \`
            let pixel_val\${i} = inputBuffer\${i}[buff_ind];
            result += kernels[\${2 * i}]*max(pixel_val\${i}, vec4f(0.0));
            result += kernels[\${2 * i + 1}]*max(-1.0*pixel_val\${i}, vec4f(0.0));
            \`;
        }
        this.shader = this.createStandardShader(\`
        
          @compute @workgroup_size(\${this.num_work_groups}, \${this.num_work_groups}) fn main( @builtin(global_invocation_id) id: vec3<u32>) {
          
                let x = id.x;
                let y = id.y;
                
                let i = id.y*\${this.resolution.width} + x;
                var result  = vec4f(0.0, 0.0, 0.0, 0.0);
                
                let coord = vec2<i32>( i32(x), i32(y));
               
                let buff_ind = coord.y*\${this.resolution.width} + coord.x;
                \${read_buffers}
                      
                result += bias;
                
                outputBuffer[buff_ind] = result;
          }
        \`);
        this.setUniform("kernels", new Float32Array(kernels));
        this.setUniform("bias", new Float32Array(bias));
        this.defaultSetup();
    }
    defaultPipelineConfig() {
        return {
            label: \`\${this.label}-pipeline\`,
            layout: 'auto',
            compute: {
                module: this.shader,
                entryPoint: 'main',
            },
        };
    }
    defaultBindGroup() {
        const entries = [];
        this.inputs.forEach(function (input, i) {
            if (input instanceof GPUExternalTexture) {
                entries.push({ binding: i, resource: input });
            }
            else if (input instanceof GPUTexture) {
                entries.push({ binding: i, resource: input.createView() });
            }
            else if (input instanceof GPUBuffer) {
                entries.push({ binding: i, resource: { buffer: input } });
            }
        });
        this.uniforms.forEach((uniform, i) => {
            entries.push({
                binding: i + this.inputs.length,
                resource: {
                    buffer: this.buffers[uniform.name]
                }
            });
        });
        if (this.output instanceof GPUBuffer) {
            entries.push({
                binding: this.inputs.length + this.uniforms.length,
                resource: {
                    buffer: this.output
                }
            });
        }
        if (entries.length === 0)
            return null;
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries
        });
    }
}
exports["default"] = Anime4KConv56x4;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/conv2d-56x4.ts?
}`)},"./src/layers/anime4k/conv2d-8x4.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_compute_layer_1 = __webpack_require__(/*! ../base_compute_layer */ "./src/layers/base_compute_layer.ts");
class Anime4KConv8x4 extends base_compute_layer_1.default {
    constructor(inputs, outputBuffer, weights) {
        super(inputs, outputBuffer, weights);
        this.label = "Anime4KConv8x4";
        const kernels = weights.weights;
        const bias = weights.bias;
        this.createUniform("kernel_offsets", "array<vec4f, 9>");
        this.createUniform("kernels", "array<mat4x4f, 18>");
        this.createUniform("bias", "vec4f");
        this.shader = this.createStandardShader(\`
        
          @compute @workgroup_size(\${this.num_work_groups}, \${this.num_work_groups}) fn main( @builtin(global_invocation_id) id: vec3<u32>) {
          
                let x = id.x;
                let y = id.y;
                
                let i = id.y*\${this.resolution.width} + x;
                var result  = vec4f(0.0, 0.0, 0.0, 0.0);
                
                let coord = vec2<i32>( i32(x), i32(y));
                      
                 for(var i = 0u; i < 9; i++){
                   let pixel_loc = coord + vec2<i32>(kernel_offsets[i].xy);
                   let buff_ind = pixel_loc.y*\${this.resolution.width} + pixel_loc.x;
                   
                   let pix_val = inputBuffer0[buff_ind];
                  
                   result += kernels[i]*max(pix_val, vec4f(0.0));
                   result += kernels[i+9]*max(-1.0*pix_val, vec4f(0.0));
                 } 
                    
                result += bias;
                
                outputBuffer[i] = result;
          }
        \`);
        this.setUniform("kernel_offsets", new Float32Array([
            -1, -1, 0, 0,
            -1, 0, 0, 0,
            -1, 1, 0, 0,
            0, -1, 0, 0,
            0, 0, 0, 0,
            0, 1, 0, 0,
            1, -1, 0, 0,
            1, 0, 0, 0,
            1, 1, 0, 0,
        ]));
        this.setUniform("kernels", new Float32Array(kernels));
        this.setUniform("bias", new Float32Array(bias));
        this.defaultSetup();
    }
}
exports["default"] = Anime4KConv8x4;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/conv2d-8x4.ts?
}`)},"./src/layers/anime4k/conv2d-concat2.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_compute_layer_1 = __webpack_require__(/*! ../base_compute_layer */ "./src/layers/base_compute_layer.ts");
class Anime4KConcat2 extends base_compute_layer_1.default {
    constructor(inputs, outputBuffer, weights) {
        super(inputs, outputBuffer, weights);
        this.label = "Anime4KConcat2";
        this.createUniform("bias", "vec4f");
        const bias = weights.bias;
        this.shader = this.createStandardShader(\`
        
          @compute @workgroup_size(\${this.num_work_groups}, \${this.num_work_groups}) fn main( @builtin(global_invocation_id) id: vec3<u32>) {
          
                let x = id.x;
                let y = id.y;
                
                let i = id.y*\${this.resolution.width} + x;
                var result  = vec4f(0.0, 0.0, 0.0, 0.0);
                
                let coord = vec2<i32>( i32(x), i32(y));
               
                let buff_ind = coord.y*\${this.resolution.width} + coord.x;
               
                outputBuffer[buff_ind] = inputBuffer0[buff_ind] + inputBuffer1[buff_ind] + bias;
          }
        \`);
        this.setUniform("bias", new Float32Array(bias));
        this.defaultSetup();
    }
}
exports["default"] = Anime4KConcat2;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/conv2d-concat2.ts?
}`)},"./src/layers/anime4k/display.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_render_layer_1 = __webpack_require__(/*! ../base_render_layer */ "./src/layers/base_render_layer.ts");
class DisplayLayer extends base_render_layer_1.default {
    constructor(inputs, output) {
        super(inputs, output);
        this.label = "DisplayLayer";
        this.vertexScale = {
            width: 1,
            height: 1
        };
        this.sampler = this.device.createSampler({
            addressModeU: "repeat",
            addressModeV: "repeat",
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
        });
    }
    lazyLoadSetup() {
        const externalTexture = this.inputs[1] instanceof GPUExternalTexture;
        const textureLoad = externalTexture ? 'textureSampleBaseClampToEdge(inputTexture, ourSampler, input.tex_coord)' :
            'textureSample(inputTexture, ourSampler, input.tex_coord)';
        this.shader = this.device.createShaderModule({
            label: \`\${this.label}-shader\`,
            code: \`
                
                   \${this.defaultVertexShader()}
                   @group(0) @binding(0) var<storage, read_write> inputBuffer0: array<vec4f>;
                   @group(0) @binding(1) var inputTexture: \${externalTexture ? 'texture_external' : 'texture_2d<f32>'};
                   @group(0) @binding(2) var ourSampler: sampler;
                  
                   @fragment fn fragmentMain(input: VertexShaderOutput) -> @location(0) vec4f {
                      
                        let x = \${this.resolution.width}.0*(input.tex_coord.x);
                        let y = \${this.resolution.height}.0*(input.tex_coord.y);
                        
                        let y2 = u32(floor(y));
                        let x2 = u32(floor(x));
                        
                        let i = y2*\${Math.floor(this.resolution.width)} +  x2;
                       
                        let x_floor  = u32(fract(x)*2.0);
                        let y_floor  = u32(fract(y)*2.0);
                        
                        //I don t know, I think this is right? I found this by trial and error
                        let c_index: u32 = x_floor + y_floor*2;  
        
                        let value = inputBuffer0[i][c_index];
                        
                        let bicubic = \${textureLoad};
                        
                        return bicubic + vec4f(value);
                    
                      }            
            \`
        });
        this.pipeline = this.device.createRenderPipeline(this.defaultPipelineConfig());
        this.bindGroup = this.defaultBindGroup();
        this.renderPassDescriptor = this.defaultRenderPassDescriptor();
    }
    defaultBindGroup() {
        const entries = [];
        this.inputs.forEach(function (input, i) {
            if (input instanceof GPUExternalTexture) {
                entries.push({ binding: i, resource: input });
            }
            else if (input instanceof GPUTexture) {
                entries.push({ binding: i, resource: input.createView() });
            }
            else if (input instanceof GPUBuffer) {
                entries.push({ binding: i, resource: { buffer: input } });
            }
        });
        entries.push({ binding: this.inputs.length, resource: this.sampler });
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries
        });
    }
}
exports["default"] = DisplayLayer;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/display.ts?
}`)},"./src/layers/anime4k/display_1x.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_render_layer_1 = __webpack_require__(/*! ../base_render_layer */ "./src/layers/base_render_layer.ts");
class DisplayLayer extends base_render_layer_1.default {
    constructor(inputs, output) {
        super(inputs, output);
        this.label = "DisplayLayer";
        this.vertexScale = {
            width: 1,
            height: 1
        };
        this.sampler = this.device.createSampler({
            addressModeU: "repeat",
            addressModeV: "repeat",
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
        });
    }
    lazyLoadSetup() {
        const externalTexture = this.inputs[1] instanceof GPUExternalTexture;
        const textureLoad = externalTexture ? 'textureSampleBaseClampToEdge(inputTexture, ourSampler, input.tex_coord)' :
            'textureSample(inputTexture, ourSampler, input.tex_coord)';
        this.shader = this.device.createShaderModule({
            label: \`\${this.label}-shader\`,
            code: \`
                
                   \${this.defaultVertexShader()}
                   @group(0) @binding(0) var<storage, read_write> inputBuffer0: array<vec4f>;
                   @group(0) @binding(1) var inputTexture: \${externalTexture ? 'texture_external' : 'texture_2d<f32>'};
                   @group(0) @binding(2) var ourSampler: sampler;
                  
                   @fragment fn fragmentMain(input: VertexShaderOutput) -> @location(0) vec4f {
                      
                        let x = \${this.resolution.width}.0*(input.tex_coord.x);
                        let y = \${this.resolution.height}.0*(input.tex_coord.y);
                        
                        let y2 = u32(floor(y));
                        let x2 = u32(floor(x));
                        
                        let i = y2*\${Math.floor(this.resolution.width)} +  x2;
      
                        let bicubic = \${textureLoad};
                        
                        return bicubic + inputBuffer0[i];
                    
                      }            
            \`
        });
        this.pipeline = this.device.createRenderPipeline(this.defaultPipelineConfig());
        this.bindGroup = this.defaultBindGroup();
        this.renderPassDescriptor = this.defaultRenderPassDescriptor();
    }
    defaultBindGroup() {
        const entries = [];
        this.inputs.forEach(function (input, i) {
            if (input instanceof GPUExternalTexture) {
                entries.push({ binding: i, resource: input });
            }
            else if (input instanceof GPUTexture) {
                entries.push({ binding: i, resource: input.createView() });
            }
            else if (input instanceof GPUBuffer) {
                entries.push({ binding: i, resource: { buffer: input } });
            }
        });
        entries.push({ binding: this.inputs.length, resource: this.sampler });
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries
        });
    }
}
exports["default"] = DisplayLayer;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/display_1x.ts?
}`)},"./src/layers/anime4k/display_3c.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_render_layer_1 = __webpack_require__(/*! ../base_render_layer */ "./src/layers/base_render_layer.ts");
class DisplayLayer3C extends base_render_layer_1.default {
    constructor(inputs, output) {
        super(inputs, output);
        this.label = "DisplayLayer3C";
        this.vertexScale = {
            width: 1,
            height: 1
        };
        this.sampler = this.device.createSampler({
            addressModeU: "repeat",
            addressModeV: "repeat",
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
        });
    }
    lazyLoadSetup() {
        const externalTexture = this.inputs[3] instanceof GPUExternalTexture;
        const textureLoad = externalTexture ? 'textureSampleBaseClampToEdge(inputTexture, ourSampler, input.tex_coord)' :
            'textureSample(inputTexture, ourSampler, input.tex_coord)';
        this.shader = this.device.createShaderModule({
            label: \`\${this.label}-shader\`,
            code: \`
                
                   \${this.defaultVertexShader()}
                   @group(0) @binding(0) var<storage, read_write> inputBuffer0: array<vec4f>;
                   @group(0) @binding(1) var<storage, read_write> inputBuffer1: array<vec4f>;
                   @group(0) @binding(2) var<storage, read_write> inputBuffer2: array<vec4f>;
                   @group(0) @binding(3) var inputTexture: \${externalTexture ? 'texture_external' : 'texture_2d<f32>'};
                   @group(0) @binding(4) var ourSampler: sampler;
                  
                   @fragment fn fragmentMain(input: VertexShaderOutput) -> @location(0) vec4f {
                      
                        let x = \${this.resolution.width}.0*(input.tex_coord.x);
                        let y = \${this.resolution.height}.0*(input.tex_coord.y);
                        
                        let y2 = u32(floor(y));
                        let x2 = u32(floor(x));
                        
                        let i = y2*\${Math.floor(this.resolution.width)} +  x2;
                       
                        let x_floor  = u32(fract(x)*2.0);
                        let y_floor  = u32(fract(y)*2.0);
                        
                        //I don t know, I think this is right? I found this by trial and error
                        let c_index: u32 = x_floor + y_floor*2;  
        
                        let value = inputBuffer0[i][c_index];
                        let value1 = inputBuffer1[i][c_index];
                        let value2 = inputBuffer2[i][c_index];
                        
                        let bicubic = \${textureLoad};
                        
                        return bicubic + vec4f(value, value1, value2, value2);
                    
                      }            
            \`
        });
        this.pipeline = this.device.createRenderPipeline(this.defaultPipelineConfig());
        this.bindGroup = this.defaultBindGroup();
        this.renderPassDescriptor = this.defaultRenderPassDescriptor();
    }
    defaultPipelineConfig() {
        return {
            label: \`\${this.label}-pipeline\`,
            layout: 'auto',
            vertex: {
                module: this.shader,
                entryPoint: 'vertexMain',
            },
            fragment: {
                module: this.shader,
                entryPoint: 'fragmentMain',
                targets: [{ format: this.output.format }],
            },
        };
    }
    defaultBindGroup() {
        const entries = [];
        this.inputs.forEach(function (input, i) {
            if (input instanceof GPUExternalTexture) {
                entries.push({ binding: i, resource: input });
            }
            else if (input instanceof GPUTexture) {
                entries.push({ binding: i, resource: input.createView() });
            }
            else if (input instanceof GPUBuffer) {
                entries.push({ binding: i, resource: { buffer: input } });
            }
        });
        entries.push({ binding: this.inputs.length, resource: this.sampler });
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries
        });
    }
}
exports["default"] = DisplayLayer3C;


//# sourceURL=webpack://WebSR/./src/layers/anime4k/display_3c.ts?
}`)},"./src/layers/base_compute_layer.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_layer_1 = __webpack_require__(/*! ./base_layer */ "./src/layers/base_layer.ts");
class ComputeLayer extends base_layer_1.default {
    constructor(inputTextures, outputBuffer, weights) {
        super(inputTextures, outputBuffer, weights);
        this.num_work_groups = 8;
    }
    createStandardShader(computeShader) {
        return this.device.createShaderModule({
            label: \`\${this.label}-shader\`,
            code: \`
              
              \${this.computeShaderInputs()}
              
              \${computeShader}
        \`
        });
    }
    computeShaderInputs() {
        const inputs = [];
        for (let i = 0; i < this.inputs.length; i++) {
            if (this.inputs[i] instanceof GPUTexture) {
                inputs.push(\`@group(0) @binding(\${i}) var inputTexture\${i}: texture_2d<f32>;\`);
            }
            else if (this.inputs[i] instanceof GPUExternalTexture) {
                inputs.push(\`@group(0) @binding(\${i}) var inputTexture\${i}: texture_external;\`);
            }
            else if (this.inputs[i] instanceof GPUBuffer) {
                inputs.push(\`@group(0) @binding(\${i}) var<storage, read_write> inputBuffer\${i}: array<vec4f>;\`);
            }
            else {
                console.log(this.inputs[i]);
                throw new Error("Input is undefined or non of the correct input type");
            }
        }
        //  console.log("This layer", this.label);
        // console.log(this.inputs.length);
        this.uniforms.forEach((uniform, i) => {
            inputs.push(\`@group(0) @binding(\${i + this.inputs.length}) var <uniform> \${uniform.name}: \${uniform.type};\`);
        });
        inputs.push(\`@group(0) @binding(\${this.inputs.length + this.uniforms.length}) var <storage, read_write> outputBuffer: array<vec4f>;\`);
        return inputs.join('\\n');
    }
    defaultPipelineConfig() {
        return {
            label: \`\${this.label}-pipeline\`,
            layout: 'auto',
            compute: {
                module: this.shader,
                entryPoint: 'main',
            },
        };
    }
    defaultSetup() {
        this.pipeline = this.device.createComputePipeline(this.defaultPipelineConfig());
        this.bindGroup = this.defaultBindGroup();
    }
    lazyLoadSetup() {
    }
    run() {
        const encoder = this.device.createCommandEncoder({ label: this.label });
        if (!this.pipeline)
            this.lazyLoadSetup();
        const pass = encoder.beginComputePass({ label: this.label });
        pass.setPipeline(this.pipeline);
        if (this.hasExternalTexture()) {
            this.bindGroup = this.defaultBindGroup();
        }
        if (this.bindGroup) {
            pass.setBindGroup(0, this.bindGroup);
        }
        // Dividing into work groups speeds up inference. If width or height aren't cleandly divided by work groups, we round to the nearest multiple of work-groups
        // Physically, this means shaving a few pixels (up to num_work_groups-1) off the bottom and right edges of the canvas but users shouldn't notice?
        pass.dispatchWorkgroups(Math.floor(this.resolution.width / this.num_work_groups), Math.floor(this.resolution.height / this.num_work_groups));
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }
}
exports["default"] = ComputeLayer;


//# sourceURL=webpack://WebSR/./src/layers/base_compute_layer.ts?
}`)},"./src/layers/base_layer.ts":(__unused_webpack_module,exports)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
class Layer {
    constructor(inputs, output, weights) {
        this.context = globalThis.context;
        this.device = this.context.device;
        this.resolution = this.context.resolution;
        this.inputs = inputs;
        this.output = output;
        this.uniforms = [];
        this.buffers = {};
        this.weights = weights;
    }
    createUniform(name, type) {
        this.uniforms.push({ name, type });
    }
    setUniform(name, value) {
        const buffer = this.device.createBuffer({
            label: \`layer-\${this.label}-buffer-\${name}\`,
            size: value.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(buffer, /*bufferOffset=*/ 0, value);
        this.buffers[name] = buffer;
    }
    defaultBindGroup() {
        const entries = [];
        this.inputs.forEach(function (input, i) {
            if (input instanceof GPUExternalTexture) {
                entries.push({ binding: i, resource: input });
            }
            else if (input instanceof GPUTexture) {
                entries.push({ binding: i, resource: input.createView() });
            }
            else if (input instanceof GPUBuffer) {
                entries.push({ binding: i, resource: { buffer: input } });
            }
        });
        this.uniforms.forEach((uniform, i) => {
            entries.push({
                binding: i + this.inputs.length,
                resource: {
                    buffer: this.buffers[uniform.name]
                }
            });
        });
        if (this.output instanceof GPUBuffer) {
            entries.push({
                binding: this.inputs.length + this.uniforms.length,
                resource: {
                    buffer: this.output
                }
            });
        }
        if (entries.length === 0)
            return null;
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries
        });
    }
    hasExternalTexture() {
        for (const input of this.inputs) {
            if (input instanceof GPUExternalTexture)
                return true;
        }
        return false;
    }
    lazyLoadSetup() { }
    run() { }
}
exports["default"] = Layer;


//# sourceURL=webpack://WebSR/./src/layers/base_layer.ts?
}`)},"./src/layers/base_render_layer.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_layer_1 = __webpack_require__(/*! ./base_layer */ "./src/layers/base_layer.ts");
class RenderLayer extends base_layer_1.default {
    constructor(inputs, output, weights) {
        super(inputs, output, weights);
        this.vertexScale = this.context.resolution;
    }
    defaultVertexShader() {
        return \`
        
             struct VertexShaderOutput {
                @builtin(position) position: vec4f,
                @location(0) tex_coord: vec2f,
              };

            @vertex
            fn vertexMain( @builtin(vertex_index) vertexIndex : u32) ->  VertexShaderOutput{
                let pos = array(
                // 1st triangle
                vec2f( -1.0,  -1.0),  // center
                vec2f( 1.0,  -1.0),  // right, center
                vec2f( -1.0,  1.0),  // center, top
             
                // 2st triangle
                vec2f( -1.0,  1.0),  // center, top
                vec2f( 1.0,  -1.0),  // right, center
                vec2f( 1.0,  1.0),  // right, top
              );
             
              var vsOutput: VertexShaderOutput;
              let xy = pos[vertexIndex];
              vsOutput.position = vec4f(xy, 0.0, 1.0);
              vsOutput.tex_coord = xy*0.5 + 0.5;
              vsOutput.tex_coord.y = - 1.0* vsOutput.tex_coord.y  + 1.0;
               vsOutput.tex_coord.x =  vsOutput.tex_coord.x*\${this.vertexScale.width};
               vsOutput.tex_coord.y =  vsOutput.tex_coord.y*\${this.vertexScale.height};
              return vsOutput;
            }
        \`;
    }
    defaultPipelineConfig() {
        return {
            label: \`\${this.label}-pipeline\`,
            layout: 'auto',
            vertex: {
                module: this.shader,
                entryPoint: 'vertexMain',
            },
            fragment: {
                module: this.shader,
                entryPoint: 'fragmentMain',
                targets: [{ format: this.output.format }],
            },
        };
    }
    defaultSetup() {
        this.pipeline = this.device.createRenderPipeline(this.defaultPipelineConfig());
        this.bindGroup = this.defaultBindGroup();
        this.renderPassDescriptor = this.defaultRenderPassDescriptor();
    }
    defaultRenderPassDescriptor() {
        return {
            label: \`\${this.label}-render-pass\`,
            colorAttachments: [
                {
                    view: this.output.createView(),
                    clearValue: [0, 0, 0, 1],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        };
    }
    createStandardShader(fragmentShader) {
        return this.device.createShaderModule({
            label: \`\${this.label}-shader\`,
            code: \`
          
              \${this.defaultVertexShader()}
              
              \${this.fragmentShaderInputs()}
              
              \${fragmentShader}
        \`
        });
    }
    fragmentShaderInputs() {
        const inputs = [];
        for (let i = 0; i < this.inputs.length; i++) {
            let type = (this.inputs[i] instanceof GPUTexture) ? 'texture_2d<f32>' : 'texture_external';
            inputs.push(\`@group(0) @binding(0) var inputTexture\${i}: \${type};\`);
        }
        this.uniforms.forEach((uniform, i) => {
            inputs.push(\`@group(0) @binding(\${i + this.inputs.length}) var <uniform> \${uniform.name}: \${uniform.type};\`);
        });
        return inputs.join('\\n');
    }
    run() {
        const encoder = this.device.createCommandEncoder({ label: this.label });
        if (!this.pipeline)
            this.lazyLoadSetup();
        const pass = encoder.beginRenderPass(this.renderPassDescriptor);
        pass.setPipeline(this.pipeline);
        if (this.hasExternalTexture()) {
            this.bindGroup = this.defaultBindGroup();
        }
        if (this.bindGroup) {
            pass.setBindGroup(0, this.bindGroup);
        }
        pass.draw(6); // call our vertex shader 6 times
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }
    setOutput(outputTexture) {
        this.output = outputTexture;
        this.renderPassDescriptor = this.defaultRenderPassDescriptor();
    }
}
exports["default"] = RenderLayer;


//# sourceURL=webpack://WebSR/./src/layers/base_render_layer.ts?
}`)},"./src/layers/utils/gaussian.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_render_layer_1 = __webpack_require__(/*! ../base_render_layer */ "./src/layers/base_render_layer.ts");
class GuassianLayer extends base_render_layer_1.default {
    constructor(inputTextures, outputTexture) {
        super(inputTextures, outputTexture);
        this.label = "Gaussian";
        this.createUniform("gaussian", "array<vec3f, 3>");
        this.createUniform("kernel_offsets", "array<vec4f, 9>");
        this.shader = this.createStandardShader(\`
        
                  @fragment fn fragmentMain(input: VertexShaderOutput) -> @location(0) vec4f {
                  
                     var val  = 0.0;
                      
                     for(var i = 0u; i < 3; i++){
                     
                        let a = vec3f(
                            textureLoad(inputTexture0, vec2<i32>(input.tex_coord + kernel_offsets[i*3].xy), 0).x,
                            textureLoad(inputTexture0, vec2<i32>(input.tex_coord + kernel_offsets[i*3].xy), 0).x,
                            textureLoad(inputTexture0, vec2<i32>(input.tex_coord + kernel_offsets[i*3].xy), 0).x
                        );
                        
                        val += dot(a, gaussian[i]);
                      
                    } 
                  
                    
                    return vec4f(val, val, val, 1.0);
                  }                 
        \`);
        this.setUniform("gaussian", new Float32Array([
            0.0675, 0.125, 0.0675, 0.0,
            0.125, 0.250, 0.1250, 0.0,
            0.0675, 0.125, 0.0675, 0.0
        ]));
        this.setUniform("kernel_offsets", new Float32Array([
            -1, -1, 0, 0,
            0, -1, 0, 0,
            1, -1, 0, 0,
            -1, 0, 0, 0,
            0, 0, 0, 0,
            1, 0, 0, 0,
            -1, 1, 0, 0,
            0, 1, 0, 0,
            1, 1, 0, 0,
        ]));
        this.defaultSetup();
    }
}
exports["default"] = GuassianLayer;


//# sourceURL=webpack://WebSR/./src/layers/utils/gaussian.ts?
}`)},"./src/layers/utils/rgb_2_yuv.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_render_layer_1 = __webpack_require__(/*! ../base_render_layer */ "./src/layers/base_render_layer.ts");
class RGB2YUV extends base_render_layer_1.default {
    constructor(inputTextures, outputTexture) {
        super(inputTextures, outputTexture);
        this.createUniform("rgb2yuv", "mat3x3f");
        this.shader = this.createStandardShader(\`
        
               @fragment fn fragmentMain(input: VertexShaderOutput) -> @location(0) vec4f {
              
                    let color = textureLoad(inputTexture0, vec2<i32>(input.tex_coord), 0);       
                    let yuv = rgb2yuv*color.xyz;
          
                return vec4f(yuv, 1.0);
              }     
        \`);
        this.setUniform("rgb2yuv", new Float32Array([
            0.299, -0.1473, 0.615, 1.0,
            0.587, -.2886, -.51499, 1.0,
            0.114, 0.436, -.1001, 1.0
        ]));
        this.defaultSetup();
    }
}
exports["default"] = RGB2YUV;


//# sourceURL=webpack://WebSR/./src/layers/utils/rgb_2_yuv.ts?
}`)},"./src/main.ts":function(__unused_webpack_module,exports,__webpack_require__){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const context_1 = __webpack_require__(/*! ./context */ "./src/context.ts");
const renderer_1 = __webpack_require__(/*! ./renderer */ "./src/renderer.ts");
const network_list_1 = __webpack_require__(/*! ./networks/network_list */ "./src/networks/network_list.ts");
const utils_1 = __webpack_require__(/*! ./utils */ "./src/utils.ts");
class WebSR {
    constructor(params) {
        this.initialized = false;
        if (!network_list_1.NetworkList[params.network_name])
            throw Error(\`Network \${params.network_name} is not defined or implemented\`);
        this.params = params;
        this.canvas = params.canvas;
        this.scale = network_list_1.NetworkScales[params.network_name];
        this.debug = params.debug;
        // If resolution is provided, initialize immediately
        if (params.resolution) {
            this.resolution = params.resolution;
            this.initialize();
        }
    }
    initialize() {
        if (!this.resolution) {
            throw new Error("Cannot initialize without resolution");
        }
        // Resize canvas to match output resolution
        this.canvas.width = this.resolution.width * this.scale;
        this.canvas.height = this.resolution.height * this.scale;
        // Create context
        this.context = new context_1.default(this.params.gpu, this.resolution, this.canvas, this.scale, this.debug);
        globalThis.context = this.context;
        // Create network
        this.network = new network_list_1.NetworkList[this.params.network_name](this.params.weights);
        // Create renderer
        this.renderer = new renderer_1.default(this.network);
        this.initialized = true;
    }
    updateResolution(newResolution) {
        var _a, _b;
        // Check if resolution actually changed
        if (this.resolution &&
            this.resolution.width === newResolution.width &&
            this.resolution.height === newResolution.height) {
            return; // No change needed
        }
        console.log(\`Resolution changed from \${(_a = this.resolution) === null || _a === void 0 ? void 0 : _a.width}x\${(_b = this.resolution) === null || _b === void 0 ? void 0 : _b.height} to \${newResolution.width}x\${newResolution.height}\`);
        this.resolution = newResolution;
        // Clean up old resources if they exist
        if (this.context) {
            this.context.destroy();
        }
        // Re-initialize with new resolution
        this.initialize();
    }
    switchNetwork(network, weights) {
        if (!network_list_1.NetworkList[network])
            throw Error(\`Network \${network} is not defined or implemented\`);
        this.network = new network_list_1.NetworkList[network](weights);
        if (this.renderer) {
            this.renderer.switchNetwork(this.network);
        }
    }
    static initWebGPU() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!navigator.gpu)
                return false;
            const adapter = yield navigator.gpu.requestAdapter();
            if (!adapter)
                return false;
            const device = yield adapter.requestDevice();
            if (!device)
                return false;
            return device;
        });
    }
    render(source) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!source) {
                throw new Error("render() requires a source parameter");
            }
            // Detect resolution from source
            const sourceResolution = {
                width: (0, utils_1.getSourceWidth)(source),
                height: (0, utils_1.getSourceHeight)(source)
            };
            // Initialize if not yet initialized, or update if resolution changed
            if (!this.initialized) {
                this.resolution = sourceResolution;
                this.initialize();
            }
            else if (sourceResolution.width !== this.resolution.width ||
                sourceResolution.height !== this.resolution.height) {
                this.updateResolution(sourceResolution);
            }
            yield this.renderer.render(source);
        });
    }
    destroy() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.context) {
                this.context.destroy();
            }
        });
    }
}
exports["default"] = WebSR;


//# sourceURL=webpack://WebSR/./src/main.ts?
}`)},"./src/networks/anime4k/cnn-2x-l.ts":function(__unused_webpack_module,exports,__webpack_require__){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_network_1 = __webpack_require__(/*! ../base_network */ "./src/networks/base_network.ts");
const conv2d_3x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-3x4 */ "./src/layers/anime4k/conv2d-3x4.ts");
const display_3c_1 = __webpack_require__(/*! ../../layers/anime4k/display_3c */ "./src/layers/anime4k/display_3c.ts");
const conv2d_16x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-16x4 */ "./src/layers/anime4k/conv2d-16x4.ts");
const conv2d_112x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-112x4 */ "./src/layers/anime4k/conv2d-112x4.ts");
const conv2d_concat2_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-concat2 */ "./src/layers/anime4k/conv2d-concat2.ts");
const utils_1 = __webpack_require__(/*! ../../utils */ "./src/utils.ts");
class Anime4KCNN2XL extends base_network_1.default {
    constructor(weights) {
        super(weights);
    }
    model() {
        const layers = [];
        const weights = this.weights.layers;
        const context = this.context;
        layers.push(new conv2d_3x4_1.default([context.input], context.buffer('conv2d_tf'), weights['conv2d_tf']));
        layers.push(new conv2d_3x4_1.default([context.input], context.buffer('conv2d_tf1'), weights['conv2d_tf1']));
        for (let i = 1; i < 7; i++) {
            let source = (i == 1) ? \`conv2d_tf\` : \`conv2d_\${i - 1}_tf\`;
            layers.push(new conv2d_16x4_1.default([context.buffer(source), context.buffer(source + "1")], context.buffer(\`conv2d_\${i}_tf\`), weights[\`conv2d_\${i}_tf\`]));
            layers.push(new conv2d_16x4_1.default([context.buffer(source), context.buffer(source + "1")], context.buffer(\`conv2d_\${i}_tf1\`), weights[\`conv2d_\${i}_tf1\`]));
        }
        for (let c = 0; c < 3; c++) {
            const sources_0 = [];
            const sources_1 = [];
            for (let i = 0; i < 7; i++) {
                let source = (i == 0) ? \`conv2d_tf\` : \`conv2d_\${i}_tf\`;
                sources_0.push(context.buffer(source));
                sources_1.push(context.buffer(source + "1"));
            }
            const dest = (c == 0) ? \`conv2d_last_tf\` : \`conv2d_last_tf\${c}\`;
            layers.push(new conv2d_112x4_1.default(sources_0, context.buffer(\`conv2d_last_\${c}_pt1\`), weights[dest], true));
            layers.push(new conv2d_112x4_1.default(sources_1, context.buffer(\`conv2d_last_\${c}_pt2\`), weights[dest], false));
            layers.push(new conv2d_concat2_1.default([context.buffer(\`conv2d_last_\${c}_pt1\`), context.buffer(\`conv2d_last_\${c}_pt2\`)], context.buffer(dest), weights[dest]));
        }
        const paint = new display_3c_1.default([context.buffer('conv2d_last_tf'), context.buffer('conv2d_last_tf1'), context.buffer('conv2d_last_tf2'), context.input], context.texture('output'));
        layers.push(paint);
        return layers;
    }
    feedForward(source) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((0, utils_1.isHTMLVideoElement)(source) || (0, utils_1.isVideoFrame)(source)) {
                this.context.input = this.context.device.importExternalTexture({ source });
            }
            else {
                const bitmap = (0, utils_1.isImageBitmap)(source) ? source : yield createImageBitmap(source);
                const width = (0, utils_1.getSourceWidth)(source);
                const height = (0, utils_1.getSourceHeight)(source);
                this.context.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.context.texture('input', { format: "rgba8unorm" }) }, [width, height]);
                this.context.input = this.context.texture('input');
            }
            this.layers[0].inputs[0] = this.context.input;
            this.layers[1].inputs[0] = this.context.input;
            this.layers[this.layers.length - 1].inputs[3] = this.context.input;
            this.layers[0].lazyLoadSetup();
            this.layers[1].lazyLoadSetup();
            this.layers[this.layers.length - 1].lazyLoadSetup();
            this.layers.forEach(function (layer) {
                layer.run();
            });
        });
    }
}
exports["default"] = Anime4KCNN2XL;


//# sourceURL=webpack://WebSR/./src/networks/anime4k/cnn-2x-l.ts?
}`)},"./src/networks/anime4k/cnn-2x-m.ts":function(__unused_webpack_module,exports,__webpack_require__){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_network_1 = __webpack_require__(/*! ../base_network */ "./src/networks/base_network.ts");
const conv2d_3x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-3x4 */ "./src/layers/anime4k/conv2d-3x4.ts");
const conv2d_8x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-8x4 */ "./src/layers/anime4k/conv2d-8x4.ts");
const conv2d_56x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-56x4 */ "./src/layers/anime4k/conv2d-56x4.ts");
const display_3c_1 = __webpack_require__(/*! ../../layers/anime4k/display_3c */ "./src/layers/anime4k/display_3c.ts");
const utils_1 = __webpack_require__(/*! ../../utils */ "./src/utils.ts");
class Anime4KCNN2XM extends base_network_1.default {
    constructor(weights) {
        super(weights);
    }
    model() {
        const layers = [];
        const weights = this.weights.layers;
        const context = this.context;
        const conv2d_tf = new conv2d_3x4_1.default([context.input], context.buffer('conv2d_tf'), weights['conv2d_tf']);
        const conv2d_1_tf = new conv2d_8x4_1.default([context.buffer('conv2d_tf')], context.buffer('conv2d_1_tf'), weights['conv2d_1_tf']);
        const conv2d_2_tf = new conv2d_8x4_1.default([context.buffer('conv2d_1_tf')], context.buffer('conv2d_2_tf'), weights['conv2d_2_tf']);
        const conv2d_3_tf = new conv2d_8x4_1.default([context.buffer('conv2d_2_tf')], context.buffer('conv2d_3_tf'), weights['conv2d_3_tf']);
        const conv2d_4_tf = new conv2d_8x4_1.default([context.buffer('conv2d_3_tf')], context.buffer('conv2d_4_tf'), weights['conv2d_4_tf']);
        const conv2d_5_tf = new conv2d_8x4_1.default([context.buffer('conv2d_4_tf')], context.buffer('conv2d_5_tf'), weights['conv2d_5_tf']);
        const conv2d_6_tf = new conv2d_8x4_1.default([context.buffer('conv2d_5_tf')], context.buffer('conv2d_6_tf'), weights['conv2d_6_tf']);
        const conv2d_7_tf = new conv2d_56x4_1.default([context.buffer('conv2d_tf'), context.buffer('conv2d_1_tf'), context.buffer('conv2d_2_tf'), context.buffer('conv2d_3_tf'), context.buffer('conv2d_4_tf'), context.buffer('conv2d_5_tf'), context.buffer('conv2d_6_tf')], context.buffer('conv2d_7_tf'), weights['conv2d_7_tf']);
        const conv2d_7_tf1 = new conv2d_56x4_1.default([context.buffer('conv2d_tf'), context.buffer('conv2d_1_tf'), context.buffer('conv2d_2_tf'), context.buffer('conv2d_3_tf'), context.buffer('conv2d_4_tf'), context.buffer('conv2d_5_tf'), context.buffer('conv2d_6_tf')], context.buffer('conv2d_7_tf1'), weights['conv2d_7_tf1']);
        const conv2d_7_tf2 = new conv2d_56x4_1.default([context.buffer('conv2d_tf'), context.buffer('conv2d_1_tf'), context.buffer('conv2d_2_tf'), context.buffer('conv2d_3_tf'), context.buffer('conv2d_4_tf'), context.buffer('conv2d_5_tf'), context.buffer('conv2d_6_tf')], context.buffer('conv2d_7_tf2'), weights['conv2d_7_tf2']);
        const paint = new display_3c_1.default([context.buffer('conv2d_7_tf'), context.buffer('conv2d_7_tf1'), context.buffer('conv2d_7_tf2'), context.input], context.texture('output'));
        layers.push(conv2d_tf, conv2d_1_tf, conv2d_2_tf, conv2d_3_tf, conv2d_4_tf, conv2d_5_tf, conv2d_6_tf, conv2d_7_tf, conv2d_7_tf1, conv2d_7_tf2, paint);
        return layers;
    }
    feedForward(source) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((0, utils_1.isHTMLVideoElement)(source) || (0, utils_1.isVideoFrame)(source)) {
                this.context.input = this.context.device.importExternalTexture({ source });
            }
            else {
                const bitmap = (0, utils_1.isImageBitmap)(source) ? source : yield createImageBitmap(source);
                const width = (0, utils_1.getSourceWidth)(source);
                const height = (0, utils_1.getSourceHeight)(source);
                this.context.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.context.texture('input', { format: "rgba8unorm" }) }, [width, height]);
                this.context.input = this.context.texture('input');
            }
            this.layers[0].inputs[0] = this.context.input;
            this.layers[this.layers.length - 1].inputs[3] = this.context.input;
            this.layers[0].lazyLoadSetup();
            this.layers[this.layers.length - 1].lazyLoadSetup();
            this.layers.forEach(function (layer) {
                layer.run();
            });
        });
    }
}
exports["default"] = Anime4KCNN2XM;


//# sourceURL=webpack://WebSR/./src/networks/anime4k/cnn-2x-m.ts?
}`)},"./src/networks/anime4k/cnn-2x-s.ts":function(__unused_webpack_module,exports,__webpack_require__){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_network_1 = __webpack_require__(/*! ../base_network */ "./src/networks/base_network.ts");
const conv2d_3x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-3x4 */ "./src/layers/anime4k/conv2d-3x4.ts");
const conv2d_8x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-8x4 */ "./src/layers/anime4k/conv2d-8x4.ts");
const display_1 = __webpack_require__(/*! ../../layers/anime4k/display */ "./src/layers/anime4k/display.ts");
const utils_1 = __webpack_require__(/*! ../../utils */ "./src/utils.ts");
class Anime4KCNN2XS extends base_network_1.default {
    constructor(weights) {
        super(weights);
    }
    model() {
        const layers = [];
        const weights = this.weights.layers;
        const context = this.context;
        const conv2d_tf = new conv2d_3x4_1.default([context.input], context.buffer('conv2d_tf'), weights['conv2d_tf']);
        const conv2d_1_tf = new conv2d_8x4_1.default([context.buffer('conv2d_tf')], context.buffer('conv2d_1_tf'), weights['conv2d_1_tf']);
        const conv2d_2_tf = new conv2d_8x4_1.default([context.buffer('conv2d_1_tf')], context.buffer('conv2d_2_tf'), weights['conv2d_2_tf']);
        const conv2d_last_tf = new conv2d_8x4_1.default([context.buffer('conv2d_2_tf')], context.buffer('conv2d_last_tf'), weights['conv2d_last_tf']);
        const paint = new display_1.default([context.buffer('conv2d_last_tf'), context.input], context.texture('output'));
        layers.push(conv2d_tf, conv2d_1_tf, conv2d_2_tf, conv2d_last_tf, paint);
        return layers;
    }
    feedForward(source) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((0, utils_1.isHTMLVideoElement)(source) || (0, utils_1.isVideoFrame)(source)) {
                this.context.input = this.context.device.importExternalTexture({ source });
            }
            else {
                const bitmap = (0, utils_1.isImageBitmap)(source) ? source : yield createImageBitmap(source);
                const width = (0, utils_1.getSourceWidth)(source);
                const height = (0, utils_1.getSourceHeight)(source);
                this.context.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.context.texture('input', { format: "rgba8unorm" }) }, [width, height]);
                this.context.input = this.context.texture('input');
            }
            this.layers[0].inputs[0] = this.context.input;
            this.layers[this.layers.length - 1].inputs[1] = this.context.input;
            this.layers[0].lazyLoadSetup();
            this.layers[this.layers.length - 1].lazyLoadSetup();
            this.layers.forEach(function (layer) {
                layer.run();
            });
        });
    }
}
exports["default"] = Anime4KCNN2XS;


//# sourceURL=webpack://WebSR/./src/networks/anime4k/cnn-2x-s.ts?
}`)},"./src/networks/anime4k/cnn-restore-l.ts":function(__unused_webpack_module,exports,__webpack_require__){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_network_1 = __webpack_require__(/*! ../base_network */ "./src/networks/base_network.ts");
const conv2d_3x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-3x4 */ "./src/layers/anime4k/conv2d-3x4.ts");
const conv2d_16x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-16x4 */ "./src/layers/anime4k/conv2d-16x4.ts");
const display_1x_1 = __webpack_require__(/*! ../../layers/anime4k/display_1x */ "./src/layers/anime4k/display_1x.ts");
const utils_1 = __webpack_require__(/*! ../../utils */ "./src/utils.ts");
class Anime4KCNNRL extends base_network_1.default {
    constructor(weights) {
        super(weights);
    }
    model() {
        const layers = [];
        const weights = this.weights.layers;
        const context = this.context;
        layers.push(new conv2d_3x4_1.default([context.input], context.buffer('conv2d_tf'), weights['conv2d_tf']));
        layers.push(new conv2d_3x4_1.default([context.input], context.buffer('conv2d_tf1'), weights['conv2d_tf1']));
        for (let i = 1; i < 4; i++) {
            let source = (i == 1) ? \`conv2d_tf\` : \`conv2d_\${i - 1}_tf\`;
            layers.push(new conv2d_16x4_1.default([context.buffer(source), context.buffer(source + "1")], context.buffer(\`conv2d_\${i}_tf\`), weights[\`conv2d_\${i}_tf\`]));
            layers.push(new conv2d_16x4_1.default([context.buffer(source), context.buffer(source + "1")], context.buffer(\`conv2d_\${i}_tf1\`), weights[\`conv2d_\${i}_tf1\`]));
        }
        layers.push(new conv2d_16x4_1.default([context.buffer('conv2d_3_tf'), context.buffer('conv2d_3_tf1')], context.buffer(\`conv2d_out_tf\`), weights[\`conv2d_out_tf\`]));
        const paint = new display_1x_1.default([context.buffer('conv2d_out_tf'), context.input], context.texture('output'));
        layers.push(paint);
        return layers;
    }
    feedForward(source) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((0, utils_1.isHTMLVideoElement)(source) || (0, utils_1.isVideoFrame)(source)) {
                this.context.input = this.context.device.importExternalTexture({ source });
            }
            else {
                const bitmap = (0, utils_1.isImageBitmap)(source) ? source : yield createImageBitmap(source);
                const width = (0, utils_1.getSourceWidth)(source);
                const height = (0, utils_1.getSourceHeight)(source);
                this.context.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.context.texture('input', { format: "rgba8unorm" }) }, [width, height]);
                this.context.input = this.context.texture('input');
            }
            this.layers[0].inputs[0] = this.context.input;
            this.layers[1].inputs[0] = this.context.input;
            this.layers[this.layers.length - 1].inputs[1] = this.context.input;
            this.layers.forEach(function (layer) {
                layer.run();
            });
        });
    }
}
exports["default"] = Anime4KCNNRL;


//# sourceURL=webpack://WebSR/./src/networks/anime4k/cnn-restore-l.ts?
}`)},"./src/networks/anime4k/cnn-restore-m.ts":function(__unused_webpack_module,exports,__webpack_require__){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_network_1 = __webpack_require__(/*! ../base_network */ "./src/networks/base_network.ts");
const conv2d_3x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-3x4 */ "./src/layers/anime4k/conv2d-3x4.ts");
const conv2d_8x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-8x4 */ "./src/layers/anime4k/conv2d-8x4.ts");
const conv2d_56x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-56x4 */ "./src/layers/anime4k/conv2d-56x4.ts");
const display_1x_1 = __webpack_require__(/*! ../../layers/anime4k/display_1x */ "./src/layers/anime4k/display_1x.ts");
const utils_1 = __webpack_require__(/*! ../../utils */ "./src/utils.ts");
class Anime4KCNNRM extends base_network_1.default {
    constructor(weights) {
        super(weights);
    }
    model() {
        const layers = [];
        const weights = this.weights.layers;
        const context = this.context;
        const conv2d_tf = new conv2d_3x4_1.default([context.input], context.buffer('conv2d_tf'), weights['conv2d_tf']);
        const conv2d_1_tf = new conv2d_8x4_1.default([context.buffer('conv2d_tf')], context.buffer('conv2d_1_tf'), weights['conv2d_1_tf']);
        const conv2d_2_tf = new conv2d_8x4_1.default([context.buffer('conv2d_1_tf')], context.buffer('conv2d_2_tf'), weights['conv2d_2_tf']);
        const conv2d_3_tf = new conv2d_8x4_1.default([context.buffer('conv2d_2_tf')], context.buffer('conv2d_3_tf'), weights['conv2d_3_tf']);
        const conv2d_4_tf = new conv2d_8x4_1.default([context.buffer('conv2d_3_tf')], context.buffer('conv2d_4_tf'), weights['conv2d_4_tf']);
        const conv2d_5_tf = new conv2d_8x4_1.default([context.buffer('conv2d_4_tf')], context.buffer('conv2d_5_tf'), weights['conv2d_5_tf']);
        const conv2d_6_tf = new conv2d_8x4_1.default([context.buffer('conv2d_5_tf')], context.buffer('conv2d_6_tf'), weights['conv2d_6_tf']);
        const conv2d_out_tf = new conv2d_56x4_1.default([context.buffer('conv2d_tf'), context.buffer('conv2d_1_tf'), context.buffer('conv2d_2_tf'), context.buffer('conv2d_3_tf'), context.buffer('conv2d_4_tf'), context.buffer('conv2d_5_tf'), context.buffer('conv2d_6_tf')], context.buffer('conv2d_out_tf'), weights['conv2d_out_tf']);
        const paint = new display_1x_1.default([context.buffer('conv2d_out_tf'), context.input], context.texture('output'));
        layers.push(conv2d_tf, conv2d_1_tf, conv2d_2_tf, conv2d_3_tf, conv2d_4_tf, conv2d_5_tf, conv2d_6_tf, conv2d_out_tf, paint);
        return layers;
    }
    feedForward(source) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((0, utils_1.isHTMLVideoElement)(source) || (0, utils_1.isVideoFrame)(source)) {
                this.context.input = this.context.device.importExternalTexture({ source });
            }
            else {
                const bitmap = (0, utils_1.isImageBitmap)(source) ? source : yield createImageBitmap(source);
                const width = (0, utils_1.getSourceWidth)(source);
                const height = (0, utils_1.getSourceHeight)(source);
                this.context.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.context.texture('input', { format: "rgba8unorm" }) }, [width, height]);
                this.context.input = this.context.texture('input');
            }
            this.layers[0].inputs[0] = this.context.input;
            this.layers[1].inputs[0] = this.context.input;
            this.layers[this.layers.length - 1].inputs[1] = this.context.input;
            this.layers.forEach(function (layer) {
                layer.run();
            });
        });
    }
}
exports["default"] = Anime4KCNNRM;


//# sourceURL=webpack://WebSR/./src/networks/anime4k/cnn-restore-m.ts?
}`)},"./src/networks/anime4k/cnn-restore-s.ts":function(__unused_webpack_module,exports,__webpack_require__){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_network_1 = __webpack_require__(/*! ../base_network */ "./src/networks/base_network.ts");
const conv2d_3x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-3x4 */ "./src/layers/anime4k/conv2d-3x4.ts");
const conv2d_8x4_1 = __webpack_require__(/*! ../../layers/anime4k/conv2d-8x4 */ "./src/layers/anime4k/conv2d-8x4.ts");
const display_1x_1 = __webpack_require__(/*! ../../layers/anime4k/display_1x */ "./src/layers/anime4k/display_1x.ts");
const utils_1 = __webpack_require__(/*! ../../utils */ "./src/utils.ts");
class Anime4KCNNRS extends base_network_1.default {
    constructor(weights) {
        super(weights);
    }
    model() {
        const layers = [];
        const weights = this.weights.layers;
        const context = this.context;
        const conv2d_tf = new conv2d_3x4_1.default([context.input], context.buffer('conv2d_tf'), weights['conv2d_tf']);
        const conv2d_1_tf = new conv2d_8x4_1.default([context.buffer('conv2d_tf')], context.buffer('conv2d_1_tf'), weights['conv2d_1_tf']);
        const conv2d_2_tf = new conv2d_8x4_1.default([context.buffer('conv2d_1_tf')], context.buffer('conv2d_2_tf'), weights['conv2d_2_tf']);
        const conv2d_last_tf = new conv2d_8x4_1.default([context.buffer('conv2d_2_tf')], context.buffer('conv2d_out_tf'), weights['conv2d_out_tf']);
        const paint = new display_1x_1.default([context.buffer('conv2d_out_tf'), context.input], context.texture('output'));
        layers.push(conv2d_tf, conv2d_1_tf, conv2d_2_tf, conv2d_last_tf, paint);
        return layers;
    }
    feedForward(source) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((0, utils_1.isHTMLVideoElement)(source) || (0, utils_1.isVideoFrame)(source)) {
                this.context.input = this.context.device.importExternalTexture({ source });
            }
            else {
                const bitmap = (0, utils_1.isImageBitmap)(source) ? source : yield createImageBitmap(source);
                const width = (0, utils_1.getSourceWidth)(source);
                const height = (0, utils_1.getSourceHeight)(source);
                this.context.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.context.texture('input', { format: "rgba8unorm" }) }, [width, height]);
                this.context.input = this.context.texture('input');
            }
            this.layers[0].inputs[0] = this.context.input;
            this.layers[this.layers.length - 1].inputs[1] = this.context.input;
            this.layers.forEach(function (layer) {
                layer.run();
            });
        });
    }
}
exports["default"] = Anime4KCNNRS;


//# sourceURL=webpack://WebSR/./src/networks/anime4k/cnn-restore-s.ts?
}`)},"./src/networks/base_network.ts":function(__unused_webpack_module,exports){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
class NeuralNetwork {
    constructor(weights) {
        this.weights = weights;
        this.context = globalThis.context;
        this.layers = this.model();
    }
    model() {
        return [];
    }
    lastLayer() {
        return this.layers[this.layers.length - 1];
    }
    feedForward(source) {
        return __awaiter(this, void 0, void 0, function* () {
            this.layers.forEach(layer => {
                layer.run();
            });
        });
    }
}
exports["default"] = NeuralNetwork;


//# sourceURL=webpack://WebSR/./src/networks/base_network.ts?
}`)},"./src/networks/network_list.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.NetworkScales = exports.NetworkList = void 0;
const cnn_2x_s_1 = __webpack_require__(/*! ./anime4k/cnn-2x-s */ "./src/networks/anime4k/cnn-2x-s.ts");
const cnn_2x_m_1 = __webpack_require__(/*! ./anime4k/cnn-2x-m */ "./src/networks/anime4k/cnn-2x-m.ts");
const cnn_2x_l_1 = __webpack_require__(/*! ./anime4k/cnn-2x-l */ "./src/networks/anime4k/cnn-2x-l.ts");
const cnn_restore_l_1 = __webpack_require__(/*! ./anime4k/cnn-restore-l */ "./src/networks/anime4k/cnn-restore-l.ts");
const cnn_restore_m_1 = __webpack_require__(/*! ./anime4k/cnn-restore-m */ "./src/networks/anime4k/cnn-restore-m.ts");
const cnn_restore_s_1 = __webpack_require__(/*! ./anime4k/cnn-restore-s */ "./src/networks/anime4k/cnn-restore-s.ts");
const poc_network_1 = __webpack_require__(/*! ./poc_network */ "./src/networks/poc_network.ts");
exports.NetworkList = {
    "anime4k/cnn-2x-s": cnn_2x_s_1.default,
    "anime4k/cnn-2x-m": cnn_2x_m_1.default,
    "anime4k/cnn-2x-l": cnn_2x_l_1.default,
    "anime4k/cnn-restore-s": cnn_restore_s_1.default,
    "anime4k/cnn-restore-m": cnn_restore_m_1.default,
    "anime4k/cnn-restore-l": cnn_restore_l_1.default,
    "sb2702/blur-poc": poc_network_1.default
};
exports.NetworkScales = {
    "anime4k/cnn-2x-s": 2,
    "anime4k/cnn-2x-m": 2,
    "anime4k/cnn-2x-l": 2,
    "anime4k/cnn-restore-s": 1,
    "anime4k/cnn-restore-m": 1,
    "anime4k/cnn-restore-l": 1,
    "sb2702/blur-poc": 1
};


//# sourceURL=webpack://WebSR/./src/networks/network_list.ts?
}`)},"./src/networks/poc_network.ts":(__unused_webpack_module,exports,__webpack_require__)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
const base_network_1 = __webpack_require__(/*! ./base_network */ "./src/networks/base_network.ts");
const rgb_2_yuv_1 = __webpack_require__(/*! ../layers/utils/rgb_2_yuv */ "./src/layers/utils/rgb_2_yuv.ts");
const gaussian_1 = __webpack_require__(/*! ../layers/utils/gaussian */ "./src/layers/utils/gaussian.ts");
class PoCNetwork extends base_network_1.default {
    constructor() {
        super();
    }
    model() {
        const layers = [];
        const context = this.context;
        layers.push(new rgb_2_yuv_1.default([context.texture('input')], context.texture('yuv')));
        layers.push(new gaussian_1.default([context.texture('yuv')], context.texture('output')));
        return layers;
    }
}
exports["default"] = PoCNetwork;


//# sourceURL=webpack://WebSR/./src/networks/poc_network.ts?
}`)},"./src/renderer.ts":function(__unused_webpack_module,exports,__webpack_require__){eval(`{
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const display_1 = __webpack_require__(/*! ./layers/anime4k/display */ "./src/layers/anime4k/display.ts");
const base_render_layer_1 = __webpack_require__(/*! ./layers/base_render_layer */ "./src/layers/base_render_layer.ts");
const utils_1 = __webpack_require__(/*! ./utils */ "./src/utils.ts");
class WebSRRenderer {
    constructor(network, source) {
        this.context = globalThis.context;
        this.network = network;
        this.source = source;
        this.active = false;
    }
    switchNetwork(network) {
        this.network = network;
    }
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.context.destroyed) {
                throw new Error("WebSR instance was destroyed");
            }
            this.active = true;
            yield this.renderStep();
        });
    }
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            this.active = false;
            if (this.vfc && this.source && (0, utils_1.isHTMLVideoElement)(this.source))
                this.source.cancelVideoFrameCallback(this.vfc);
        });
    }
    renderStep() {
        return __awaiter(this, void 0, void 0, function* () {
            const lastLayer = this.network.lastLayer();
            if (lastLayer instanceof display_1.default)
                lastLayer.setOutput(this.context.context.getCurrentTexture());
            yield this.render();
            if (this.active && this.source && (0, utils_1.isHTMLVideoElement)(this.source)) {
                this.vfc = this.source.requestVideoFrameCallback(this.renderStep.bind(this));
            }
        });
    }
    render(source) {
        return __awaiter(this, void 0, void 0, function* () {
            const lastLayer = this.network.lastLayer();
            if (lastLayer instanceof base_render_layer_1.default)
                lastLayer.setOutput(this.context.context.getCurrentTexture());
            yield this.network.feedForward(source ? source : this.source);
        });
    }
}
exports["default"] = WebSRRenderer;


//# sourceURL=webpack://WebSR/./src/renderer.ts?
}`)},"./src/utils.ts":(__unused_webpack_module,exports)=>{eval(`{
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.isMainThread = isMainThread;
exports.isHTMLVideoElement = isHTMLVideoElement;
exports.isHTMLImageElement = isHTMLImageElement;
exports.isImageBitmap = isImageBitmap;
exports.isVideoFrame = isVideoFrame;
exports.isVideoSource = isVideoSource;
exports.isImageSource = isImageSource;
exports.getSourceWidth = getSourceWidth;
exports.getSourceHeight = getSourceHeight;
/**
 * Check if we're running on the main thread (not in a worker)
 */
function isMainThread() {
    return typeof HTMLVideoElement !== 'undefined';
}
/**
 * Check if a source is a video element (main thread only)
 */
function isHTMLVideoElement(source) {
    return typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
}
/**
 * Check if a source is an image element (main thread only)
 */
function isHTMLImageElement(source) {
    return typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement;
}
/**
 * Check if a source is an ImageBitmap (works in both contexts)
 */
function isImageBitmap(source) {
    return typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap;
}
/**
 * Check if a source is a VideoFrame (worker context)
 */
function isVideoFrame(source) {
    return typeof VideoFrame !== 'undefined' && source instanceof VideoFrame;
}
/**
 * Check if a source is any type of video source
 */
function isVideoSource(source) {
    return isHTMLVideoElement(source) || isVideoFrame(source);
}
/**
 * Check if a source is any type of image source
 */
function isImageSource(source) {
    return isHTMLImageElement(source) || isImageBitmap(source);
}
/**
 * Get the width of a media source
 */
function getSourceWidth(source) {
    if (isHTMLVideoElement(source))
        return source.videoWidth;
    if (isHTMLImageElement(source))
        return source.naturalWidth;
    if (isVideoFrame(source))
        return source.displayWidth;
    if (isImageBitmap(source))
        return source.width;
    return 0;
}
/**
 * Get the height of a media source
 */
function getSourceHeight(source) {
    if (isHTMLVideoElement(source))
        return source.videoHeight;
    if (isHTMLImageElement(source))
        return source.naturalHeight;
    if (isVideoFrame(source))
        return source.displayHeight;
    if (isImageBitmap(source))
        return source.height;
    return 0;
}


//# sourceURL=webpack://WebSR/./src/utils.ts?
}`)}},__webpack_module_cache__={};function __webpack_require__(e){var t=__webpack_module_cache__[e];if(t!==void 0)return t.exports;var i=__webpack_module_cache__[e]={exports:{}};return __webpack_modules__[e].call(i.exports,i,i.exports,__webpack_require__),i.exports}var __webpack_exports__=__webpack_require__("./src/main.ts");return __webpack_exports__=__webpack_exports__.default,__webpack_exports__})())});var Ai=Object.defineProperty,St=(e,t)=>{let i={};for(var s in e)Ai(i,s,{get:e[s],enumerable:!0});return t||Ai(i,Symbol.toStringTag,{value:"Module"}),i};var Bt=Math.pow(2,32),M=Math.pow(2,32)-1,Br=131072,Ur=1024,kr=2048,ue=class Oi extends ArrayBuffer{constructor(t){super(t),this.fileStart=0,this.usedBytes=0}static fromArrayBuffer(t,i){let s=new Oi(t.byteLength);return new Uint8Array(s).set(new Uint8Array(t)),s.fileStart=i,s}};var G=class T{static{this.ENDIANNESS=new Int8Array(new Int16Array([1]).buffer)[0]>0?2:1}constructor(t,i,s){this._byteLength=0,this.failurePosition=0,this._dynamicSize=1,this._byteOffset=i||0,t instanceof ArrayBuffer?this.buffer=ue.fromArrayBuffer(t,0):t instanceof DataView?(this.dataView=t,i&&(this._byteOffset+=i)):this.buffer=new ue(t||0),this.position=0,this.endianness=s||1}getPosition(){return this.position}_realloc(t){if(!this._dynamicSize)return;let i=this._byteOffset+this.position+t,s=this._buffer.byteLength;if(i<=s){i>this._byteLength&&(this._byteLength=i);return}for(s<1&&(s=1);i>s;)s*=2;let n=new ue(s),r=new Uint8Array(this._buffer);new Uint8Array(n,0,r.length).set(r),this.buffer=n,this._byteLength=i}_trimAlloc(){if(this._byteLength===this._buffer.byteLength)return;let t=new ue(this._byteLength),i=new Uint8Array(t),s=new Uint8Array(this._buffer,0,i.length);i.set(s),this.buffer=t}get byteLength(){return this._byteLength-this._byteOffset}get buffer(){return this._trimAlloc(),this._buffer}set buffer(t){this._buffer=t,this._dataView=new DataView(t,this._byteOffset),this._byteLength=t.byteLength}get byteOffset(){return this._byteOffset}set byteOffset(t){this._byteOffset=t,this._dataView=new DataView(this._buffer,this._byteOffset),this._byteLength=this._buffer.byteLength}get dataView(){return this._dataView}set dataView(t){this._byteOffset=t.byteOffset,this._buffer=ue.fromArrayBuffer(t.buffer,0),this._dataView=new DataView(this._buffer,this._byteOffset),this._byteLength=this._byteOffset+t.byteLength}seek(t){let i=Math.max(0,Math.min(this.byteLength,t));this.position=isNaN(i)||!isFinite(i)?0:i}isEof(){return this.position>=this._byteLength}#e(t){return Array.isArray(t)&&t.length===3&&t[0]==="[]"}mapUint8Array(t){this._realloc(t*1);let i=new Uint8Array(this._buffer,this.byteOffset+this.position,t);return this.position+=t*1,i}readInt32Array(t,i){t=t===void 0?this.byteLength-this.position/4:t;let s=new Int32Array(t);return T.memcpy(s.buffer,0,this.buffer,this.byteOffset+this.position,t*s.BYTES_PER_ELEMENT),T.arrayToNative(s,i??this.endianness),this.position+=s.byteLength,s}readInt16Array(t,i){t=t===void 0?this.byteLength-this.position/2:t;let s=new Int16Array(t);return T.memcpy(s.buffer,0,this.buffer,this.byteOffset+this.position,t*s.BYTES_PER_ELEMENT),T.arrayToNative(s,i??this.endianness),this.position+=s.byteLength,s}readInt8Array(t){t=t===void 0?this.byteLength-this.position:t;let i=new Int8Array(t);return T.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),this.position+=i.byteLength,i}readUint32Array(t,i){t=t===void 0?this.byteLength-this.position/4:t;let s=new Uint32Array(t);return T.memcpy(s.buffer,0,this.buffer,this.byteOffset+this.position,t*s.BYTES_PER_ELEMENT),T.arrayToNative(s,i??this.endianness),this.position+=s.byteLength,s}readUint16Array(t,i){t=t===void 0?this.byteLength-this.position/2:t;let s=new Uint16Array(t);return T.memcpy(s.buffer,0,this.buffer,this.byteOffset+this.position,t*s.BYTES_PER_ELEMENT),T.arrayToNative(s,i??this.endianness),this.position+=s.byteLength,s}readUint8Array(t){t=t===void 0?this.byteLength-this.position:t;let i=new Uint8Array(t);return T.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),this.position+=i.byteLength,i}readFloat64Array(t,i){t=t===void 0?this.byteLength-this.position/8:t;let s=new Float64Array(t);return T.memcpy(s.buffer,0,this.buffer,this.byteOffset+this.position,t*s.BYTES_PER_ELEMENT),T.arrayToNative(s,i??this.endianness),this.position+=s.byteLength,s}readFloat32Array(t,i){t=t===void 0?this.byteLength-this.position/4:t;let s=new Float32Array(t);return T.memcpy(s.buffer,0,this.buffer,this.byteOffset+this.position,t*s.BYTES_PER_ELEMENT),T.arrayToNative(s,i??this.endianness),this.position+=s.byteLength,s}readInt32(t){let i=this._dataView.getInt32(this.position,(t??this.endianness)===2);return this.position+=4,i}readInt16(t){let i=this._dataView.getInt16(this.position,(t??this.endianness)===2);return this.position+=2,i}readInt8(){let t=this._dataView.getInt8(this.position);return this.position+=1,t}readUint32(t){let i=this._dataView.getUint32(this.position,(t??this.endianness)===2);return this.position+=4,i}readUint16(t){let i=this._dataView.getUint16(this.position,(t??this.endianness)===2);return this.position+=2,i}readUint8(){let t=this._dataView.getUint8(this.position);return this.position+=1,t}readFloat32(t){let i=this._dataView.getFloat32(this.position,(t??this.endianness)===2);return this.position+=4,i}readFloat64(t){let i=this._dataView.getFloat64(this.position,(t??this.endianness)===2);return this.position+=8,i}static memcpy(t,i,s,n,r){let a=new Uint8Array(t,i,r),o=new Uint8Array(s,n,r);a.set(o)}static arrayToNative(t,i){return i===T.ENDIANNESS?t:this.flipArrayEndianness(t)}static nativeToEndian(t,i){return i&&T.ENDIANNESS===2?t:this.flipArrayEndianness(t)}static flipArrayEndianness(t){let i=new Uint8Array(t.buffer,t.byteOffset,t.byteLength);for(let s=0;s<t.byteLength;s+=t.BYTES_PER_ELEMENT)for(let n=s+t.BYTES_PER_ELEMENT-1,r=s;n>r;n--,r++){let a=i[r];i[r]=i[n],i[n]=a}return t}readString(t,i){return i===void 0||i==="ASCII"?Fi(this.mapUint8Array(t===void 0?this.byteLength-this.position:t)):new TextDecoder(i).decode(this.mapUint8Array(t))}readCString(t){let i=0,s=this.byteLength-this.position,n=new Uint8Array(this._buffer,this._byteOffset+this.position),r=t!==void 0?Math.min(t,s):s;for(;i<r&&n[i]!==0;i++);let a=Fi(this.mapUint8Array(i));return t!==void 0?this.position+=r-i:i!==s&&(this.position+=1),a}readInt64(){return this.readInt32()*Bt+this.readUint32()}readUint64(){return this.readUint32()*Bt+this.readUint32()}readUint24(){return(this.readUint8()<<16)+(this.readUint8()<<8)+this.readUint8()}save(t){let i=new Blob([this.buffer]);if(typeof window<"u"&&typeof document<"u")if(window.URL&&URL.createObjectURL){let s=window.URL.createObjectURL(i),n=document.createElement("a");document.body.appendChild(n),n.setAttribute("href",s),n.setAttribute("download",t),n.setAttribute("target","_self"),n.click(),window.URL.revokeObjectURL(s),document.body.removeChild(n)}else throw new Error("DataStream.save: Can't create object URL.");return i}get dynamicSize(){return this._dynamicSize}set dynamicSize(t){t||this._trimAlloc(),this._dynamicSize=t}shift(t){let i=new ue(this._byteLength-t),s=new Uint8Array(i),n=new Uint8Array(this._buffer,t,s.length);s.set(n),this.buffer=i,this.position-=t}writeInt32Array(t,i){if(this._realloc(t.length*4),t instanceof Int32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)T.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt32Array(t.length,i);else for(let s=0;s<t.length;s++)this.writeInt32(t[s],i)}writeInt16Array(t,i){if(this._realloc(t.length*2),t instanceof Int16Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)T.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt16Array(t.length,i);else for(let s=0;s<t.length;s++)this.writeInt16(t[s],i)}writeInt8Array(t){if(this._realloc(t.length*1),t instanceof Int8Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)T.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt8Array(t.length);else for(let i=0;i<t.length;i++)this.writeInt8(t[i])}writeUint32Array(t,i){if(this._realloc(t.length*4),t instanceof Uint32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)T.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint32Array(t.length,i);else for(let s=0;s<t.length;s++)this.writeUint32(t[s],i)}writeUint16Array(t,i){if(this._realloc(t.length*2),t instanceof Uint16Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)T.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint16Array(t.length,i);else for(let s=0;s<t.length;s++)this.writeUint16(t[s],i)}writeUint8Array(t){if(this._realloc(t.length*1),t instanceof Uint8Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)T.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint8Array(t.length);else for(let i=0;i<t.length;i++)this.writeUint8(t[i])}writeFloat64Array(t,i){if(this._realloc(t.length*8),t instanceof Float64Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)T.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapFloat64Array(t.length,i);else for(let s=0;s<t.length;s++)this.writeFloat64(t[s],i)}writeFloat32Array(t,i){if(this._realloc(t.length*4),t instanceof Float32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)T.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapFloat32Array(t.length,i);else for(let s=0;s<t.length;s++)this.writeFloat32(t[s],i)}writeInt64(t,i){this._realloc(8),this._dataView.setBigInt64(this.position,BigInt(t),(i??this.endianness)===2),this.position+=8}writeInt32(t,i){this._realloc(4),this._dataView.setInt32(this.position,t,(i??this.endianness)===2),this.position+=4}writeInt16(t,i){this._realloc(2),this._dataView.setInt16(this.position,t,(i??this.endianness)===2),this.position+=2}writeInt8(t){this._realloc(1),this._dataView.setInt8(this.position,t),this.position+=1}writeUint32(t,i){this._realloc(4),this._dataView.setUint32(this.position,t,(i??this.endianness)===2),this.position+=4}writeUint16(t,i){this._realloc(2),this._dataView.setUint16(this.position,t,(i??this.endianness)===2),this.position+=2}writeUint8(t){this._realloc(1),this._dataView.setUint8(this.position,t),this.position+=1}writeFloat32(t,i){this._realloc(4),this._dataView.setFloat32(this.position,t,(i??this.endianness)===2),this.position+=4}writeFloat64(t,i){this._realloc(8),this._dataView.setFloat64(this.position,t,(i??this.endianness)===2),this.position+=8}writeUCS2String(t,i,s){s===void 0&&(s=t.length);let n;for(n=0;n<t.length&&n<s;n++)this.writeUint16(t.charCodeAt(n),i);for(;n<s;n++)this.writeUint16(0)}writeString(t,i,s){let n=0;if(i===void 0||i==="ASCII")if(s!==void 0){let r=Math.min(t.length,s);for(n=0;n<r;n++)this.writeUint8(t.charCodeAt(n));for(;n<s;n++)this.writeUint8(0)}else for(n=0;n<t.length;n++)this.writeUint8(t.charCodeAt(n));else this.writeUint8Array(new TextEncoder(i).encode(t.substring(0,s)))}writeCString(t,i){let s=0;if(i!==void 0){let n=Math.min(t.length,i);for(s=0;s<n;s++)this.writeUint8(t.charCodeAt(s));for(;s<i;s++)this.writeUint8(0)}else{for(s=0;s<t.length;s++)this.writeUint8(t.charCodeAt(s));this.writeUint8(0)}}writeStruct(t,i){for(let s=0;s<t.length;s++){let[n,r]=t[s],a=i[n];this.writeType(r,a,i)}}writeType(t,i,s){if(typeof t=="function")return t(this,i);if(typeof t=="object"&&!(t instanceof Array))return t.set(this,i,s);let n,r="ASCII",a=this.position,o=t;if(typeof t=="string"&&/:/.test(t)){let c=t.split(":");o=c[0],n=parseInt(c[1])}if(typeof o=="string"&&/,/.test(o)){let c=o.split(",");o=c[0],r=c[1]}switch(o){case"uint8":this.writeUint8(i);break;case"int8":this.writeInt8(i);break;case"uint16":this.writeUint16(i,this.endianness);break;case"int16":this.writeInt16(i,this.endianness);break;case"uint32":this.writeUint32(i,this.endianness);break;case"int32":this.writeInt32(i,this.endianness);break;case"float32":this.writeFloat32(i,this.endianness);break;case"float64":this.writeFloat64(i,this.endianness);break;case"uint16be":this.writeUint16(i,1);break;case"int16be":this.writeInt16(i,1);break;case"uint32be":this.writeUint32(i,1);break;case"int32be":this.writeInt32(i,1);break;case"float32be":this.writeFloat32(i,1);break;case"float64be":this.writeFloat64(i,1);break;case"uint16le":this.writeUint16(i,2);break;case"int16le":this.writeInt16(i,2);break;case"uint32le":this.writeUint32(i,2);break;case"int32le":this.writeInt32(i,2);break;case"float32le":this.writeFloat32(i,2);break;case"float64le":this.writeFloat64(i,2);break;case"cstring":this.writeCString(i,n);break;case"string":this.writeString(i,r,n);break;case"u16string":this.writeUCS2String(i,this.endianness,n);break;case"u16stringle":this.writeUCS2String(i,2,n);break;case"u16stringbe":this.writeUCS2String(i,1,n);break;default:if(this.#e(o)){let[,c]=o;for(let h=0;h<i.length;h++)this.writeType(c,i[h]);break}else{this.writeStruct(o,i);break}}n&&(this.position=a,this._realloc(n),this.position=a+n)}writeUint64(t){let i=Math.floor(t/Bt);this.writeUint32(i),this.writeUint32(t&4294967295)}writeUint24(t){this.writeUint8((t&16711680)>>16),this.writeUint8((t&65280)>>8),this.writeUint8(t&255)}adjustUint32(t,i){let s=this.position;this.seek(t),this.writeUint32(i),this.seek(s)}readStruct(t){let i={},s=this.position;for(let n=0;n<t.length;n+=1){let r=t[n][1],a=this.readType(r,i);if(!a){this.failurePosition===0&&(this.failurePosition=this.position),this.position=s;return}i[t[n][0]]=a}return i}readUCS2String(t,i){return String.fromCharCode.apply(void 0,this.readUint16Array(t,i))}readType(t,i){if(typeof t=="function")return t(this,i);if(typeof t=="object"&&!(t instanceof Array))return t.get(this,i);if(t instanceof Array&&t.length!==3)return this.readStruct(t);let s,n,r="ASCII",a=this.position,o=t;if(typeof o=="string"&&/:/.test(o)){let c=o.split(":");o=c[0],n=parseInt(c[1])}if(typeof o=="string"&&/,/.test(o)){let c=o.split(",");o=c[0],r=c[1]}switch(o){case"uint8":s=this.readUint8();break;case"int8":s=this.readInt8();break;case"uint16":s=this.readUint16(this.endianness);break;case"int16":s=this.readInt16(this.endianness);break;case"uint32":s=this.readUint32(this.endianness);break;case"int32":s=this.readInt32(this.endianness);break;case"float32":s=this.readFloat32(this.endianness);break;case"float64":s=this.readFloat64(this.endianness);break;case"uint16be":s=this.readUint16(1);break;case"int16be":s=this.readInt16(1);break;case"uint32be":s=this.readUint32(1);break;case"int32be":s=this.readInt32(1);break;case"float32be":s=this.readFloat32(1);break;case"float64be":s=this.readFloat64(1);break;case"uint16le":s=this.readUint16(2);break;case"int16le":s=this.readInt16(2);break;case"uint32le":s=this.readUint32(2);break;case"int32le":s=this.readInt32(2);break;case"float32le":s=this.readFloat32(2);break;case"float64le":s=this.readFloat64(2);break;case"cstring":s=this.readCString(n);break;case"string":s=this.readString(n,r);break;case"u16string":s=this.readUCS2String(n,this.endianness);break;case"u16stringle":s=this.readUCS2String(n,2);break;case"u16stringbe":s=this.readUCS2String(n,1);break;default:if(this.#e(o)){let[,c,h]=o,d=typeof h=="function"?h(i,this,o):typeof h=="string"&&i[h]!==void 0?parseInt(i[h]):typeof h=="number"?h:h==="*"?void 0:parseInt(h);if(typeof c=="string"){let p=c.replace(/(le|be)$/,""),x;switch(/le$/.test(c)?x=2:/be$/.test(c)&&(x=1),p){case"uint8":s=this.readUint8Array(d);break;case"uint16":s=this.readUint16Array(d,x);break;case"uint32":s=this.readUint32Array(d,x);break;case"int8":s=this.readInt8Array(d);break;case"int16":s=this.readInt16Array(d,x);break;case"int32":s=this.readInt32Array(d,x);break;case"float32":s=this.readFloat32Array(d,x);break;case"float64":s=this.readFloat64Array(d,x);break;case"cstring":case"utf16string":case"string":if(d){s=new Array(d);for(let b=0;b<d;b++)s[b]=this.readType(c,i)}else for(s=[];!this.isEof();){let b=this.readType(c,i);if(!b)break;s.push(b)}break}}else if(d){s=new Array(d);for(let p=0;p<d;p++){let x=this.readType(c,i);if(!x)return;s[p]=x}}else for(s=[];;){let p=this.position;try{let x=this.readType(c,i);if(!x){this.position=p;break}s.push(x)}catch{this.position=p;break}}break}}return n&&(this.position=a+n),s}mapInt32Array(t,i){this._realloc(t*4);let s=new Int32Array(this._buffer,this.byteOffset+this.position,t);return T.arrayToNative(s,i??this.endianness),this.position+=t*4,s}mapInt16Array(t,i){this._realloc(t*2);let s=new Int16Array(this._buffer,this.byteOffset+this.position,t);return T.arrayToNative(s,i??this.endianness),this.position+=t*2,s}mapInt8Array(t,i){this._realloc(t*1);let s=new Int8Array(this._buffer,this.byteOffset+this.position,t);return this.position+=t*1,s}mapUint32Array(t,i){this._realloc(t*4);let s=new Uint32Array(this._buffer,this.byteOffset+this.position,t);return T.arrayToNative(s,i??this.endianness),this.position+=t*4,s}mapUint16Array(t,i){this._realloc(t*2);let s=new Uint16Array(this._buffer,this.byteOffset+this.position,t);return T.arrayToNative(s,i??this.endianness),this.position+=t*2,s}mapFloat64Array(t,i){this._realloc(t*8);let s=new Float64Array(this._buffer,this.byteOffset+this.position,t);return T.arrayToNative(s,i??this.endianness),this.position+=t*8,s}mapFloat32Array(t,i){this._realloc(t*4);let s=new Float32Array(this._buffer,this.byteOffset+this.position,t);return T.arrayToNative(s,i??this.endianness),this.position+=t*4,s}};function Fi(e){let t=[];for(let i=0;i<e.length;i++)t[i]=e[i];return String.fromCharCode.apply(void 0,t)}var Ze=new Date,Je=4,Li=3,Di=2,Mi=1,he=Je,u={setLogLevel(e){e===this.debug?he=Mi:e===this.info?he=Di:e===this.warn?he=Li:(this.error,he=Je)},debug(e,t){console.debug===void 0&&(console.debug=console.log),Mi>=he&&console.debug("["+u.getDurationString(new Date().getTime()-Ze.getTime(),1e3)+"]","["+e+"]",t)},log(e,t){this.debug(e.msg)},info(e,t){Di>=he&&console.info("["+u.getDurationString(new Date().getTime()-Ze.getTime(),1e3)+"]","["+e+"]",t)},warn(e,t){Li>=he&&console.warn("["+u.getDurationString(new Date().getTime()-Ze.getTime(),1e3)+"]","["+e+"]",t)},error(e,t,i){i?.onError?i.onError(e,t):Je>=he&&console.error("["+u.getDurationString(new Date().getTime()-Ze.getTime(),1e3)+"]","["+e+"]",t)},getDurationString(e,t){let i;function s(c,h){let d=(""+c).split(".");for(;d[0].length<h;)d[0]="0"+d[0];return d.join(".")}e<0?(i=!0,e=-e):i=!1;let n=e/(t||1),r=Math.floor(n/3600);n-=r*3600;let a=Math.floor(n/60);n-=a*60;let o=n*1e3;return n=Math.floor(n),o-=n*1e3,o=Math.floor(o),(i?"-":"")+r+":"+s(a,2)+":"+s(n,2)+"."+s(o,3)},printRanges(e){let t=e.length;if(t>0){let i="";for(let s=0;s<t;s++)s>0&&(i+=","),i+="["+u.getDurationString(e.start(s))+","+u.getDurationString(e.end(s))+"]";return i}else return"(empty)"}};function Er(e,t){u.debug("ArrayBuffer","Trying to create a new buffer of size: "+(e.byteLength+t.byteLength));let i=new Uint8Array(e.byteLength+t.byteLength);return i.set(new Uint8Array(e),0),i.set(new Uint8Array(t),e.byteLength),i.buffer}var De=class extends G{constructor(e){super(new ArrayBuffer,0),this.buffers=[],this.bufferIndex=-1,e&&(this.insertBuffer(e),this.bufferIndex=0)}initialized(){if(this.bufferIndex>-1)return!0;if(this.buffers.length>0){let e=this.buffers[0];return e.fileStart===0?(this.buffer=e,this.bufferIndex=0,u.debug("MultiBufferStream","Stream ready for parsing"),!0):(u.warn("MultiBufferStream","The first buffer should have a fileStart of 0"),this.logBufferLevel(),!1)}else return u.warn("MultiBufferStream","No buffer to start parsing from"),this.logBufferLevel(),!1}reduceBuffer(e,t,i){let s=new Uint8Array(i);return s.set(new Uint8Array(e,t,i)),s.buffer.fileStart=e.fileStart+t,s.buffer.usedBytes=0,s.buffer}insertBuffer(e){let t=!0,i=0;for(;i<this.buffers.length;i++){let s=this.buffers[i];if(e.fileStart<=s.fileStart){if(e.fileStart===s.fileStart)if(e.byteLength>s.byteLength){this.buffers.splice(i,1),i--;continue}else u.warn("MultiBufferStream","Buffer (fileStart: "+e.fileStart+" - Length: "+e.byteLength+") already appended, ignoring");else e.fileStart+e.byteLength<=s.fileStart||(e=this.reduceBuffer(e,0,s.fileStart-e.fileStart)),u.debug("MultiBufferStream","Appending new buffer (fileStart: "+e.fileStart+" - Length: "+e.byteLength+")"),this.buffers.splice(i,0,e),i===0&&(this.buffer=e);t=!1;break}else if(e.fileStart<s.fileStart+s.byteLength){let n=s.fileStart+s.byteLength-e.fileStart,r=e.byteLength-n;if(r>0)e=this.reduceBuffer(e,n,r);else{t=!1;break}}}t&&(u.debug("MultiBufferStream","Appending new buffer (fileStart: "+e.fileStart+" - Length: "+e.byteLength+")"),this.buffers.push(e),i===0&&(this.buffer=e))}logBufferLevel(e){let t=[],i="",s,n=0,r=0;for(let o=0;o<this.buffers.length;o++){let c=this.buffers[o];o===0?(s={start:c.fileStart,end:c.fileStart+c.byteLength},t.push(s),i+="["+s.start+"-"):s.end===c.fileStart?s.end=c.fileStart+c.byteLength:(s={start:c.fileStart,end:c.fileStart+c.byteLength},i+=t[t.length-1].end-1+"], ["+s.start+"-",t.push(s)),n+=c.usedBytes,r+=c.byteLength}t.length>0&&(i+=s.end-1+"]");let a=e?u.info:u.debug;this.buffers.length===0?a("MultiBufferStream","No more buffer in memory"):a("MultiBufferStream",""+this.buffers.length+" stored buffer(s) ("+n+"/"+r+" bytes), continuous ranges: "+i)}cleanBuffers(){for(let e=0;e<this.buffers.length;e++){let t=this.buffers[e];t.usedBytes===t.byteLength&&(u.debug("MultiBufferStream","Removing buffer #"+e),this.buffers.splice(e,1),e--)}}mergeNextBuffer(){if(this.bufferIndex+1<this.buffers.length){let e=this.buffers[this.bufferIndex+1];if(e.fileStart===this.buffer.fileStart+this.buffer.byteLength){let t=this.buffer.byteLength,i=this.buffer.usedBytes,s=this.buffer.fileStart;return this.buffers[this.bufferIndex]=Er(this.buffer,e),this.buffer=this.buffers[this.bufferIndex],this.buffers.splice(this.bufferIndex+1,1),this.buffer.usedBytes=i,this.buffer.fileStart=s,u.debug("ISOFile","Concatenating buffer for box parsing (length: "+t+"->"+this.buffer.byteLength+")"),!0}else return!1}else return!1}findPosition(e,t,i){let s=-1,n=e===!0?0:this.bufferIndex;for(;n<this.buffers.length;){let a=this.buffers[n];if(a&&a.fileStart<=t)s=n,i&&(a.fileStart+a.byteLength<=t?a.usedBytes=a.byteLength:a.usedBytes=t-a.fileStart,this.logBufferLevel());else break;n++}if(s===-1)return-1;let r=this.buffers[s];return r.fileStart+r.byteLength>=t?(u.debug("MultiBufferStream","Found position in existing buffer #"+s),s):-1}findEndContiguousBuf(e){let t=e!==void 0?e:this.bufferIndex,i=this.buffers[t];if(this.buffers.length>t+1)for(let s=t+1;s<this.buffers.length;s++){let n=this.buffers[s];if(n.fileStart===i.fileStart+i.byteLength)i=n;else break}return i.fileStart+i.byteLength}getEndFilePositionAfter(e){let t=this.findPosition(!0,e,!1);return t!==-1?this.findEndContiguousBuf(t):e}addUsedBytes(e){this.buffer.usedBytes+=e,this.logBufferLevel()}setAllUsedBytes(){this.buffer.usedBytes=this.buffer.byteLength,this.logBufferLevel()}seek(e,t,i){let s=this.findPosition(t,e,i);return s!==-1?(this.buffer=this.buffers[s],this.bufferIndex=s,this.position=e-this.buffer.fileStart,u.debug("MultiBufferStream","Repositioning parser at buffer position: "+this.position),!0):(u.debug("MultiBufferStream","Position "+e+" not found in buffered data"),!1)}getPosition(){return this.bufferIndex===-1||this.buffers[this.bufferIndex]===void 0?0:this.buffers[this.bufferIndex].fileStart+this.position}getLength(){return this.byteLength}getEndPosition(){return this.bufferIndex===-1||this.buffers[this.bufferIndex]===void 0?0:this.buffers[this.bufferIndex].fileStart+this.byteLength}getAbsoluteEndPosition(){if(this.buffers.length===0)return 0;let e=this.buffers[this.buffers.length-1];return e.fileStart+e.byteLength}},_=class{static{this.registryId=Symbol.for("BoxIdentifier")}#e;get type(){return this.constructor.fourcc??this.#e}set type(e){this.#e=e}constructor(e=0){this.size=e}addBox(e){return this.boxes||(this.boxes=[]),this.boxes.push(e),this[e.type+"s"]?this[e.type+"s"].push(e):this[e.type]=e,e}set(e,t){return this[e]=t,this}addEntry(e,t){let i=t||"entries";return this[i]||(this[i]=[]),this[i].push(e),this}writeHeader(e,t){if(this.size+=8,(this.size>M||this.original_size===1)&&(this.size+=8),this.type==="uuid"&&(this.size+=16),u.debug("BoxWriter","Writing box "+this.type+" of size: "+this.size+" at position "+e.getPosition()+(t||"")),this.original_size===0?e.writeUint32(0):this.size>M||this.original_size===1?e.writeUint32(1):(this.sizePosition=e.getPosition(),e.writeUint32(this.size)),e.writeString(this.type,void 0,4),this.type==="uuid"){let i=new Uint8Array(16);for(let s=0;s<16;s++)i[s]=parseInt(this.uuid.substring(s*2,s*2+2),16);e.writeUint8Array(i)}(this.size>M||this.original_size===1)&&(this.sizePosition=e.getPosition(),e.writeUint64(this.size))}write(e){if(this.type==="mdat"){let t=this;if(t.stream){this.size=t.stream.getAbsoluteEndPosition(),this.writeHeader(e);for(let i of t.stream.buffers){let s=new Uint8Array(i);e.writeUint8Array(s)}}else t.data&&(this.size=t.data.length,this.writeHeader(e),e.writeUint8Array(t.data))}else this.size=this.data?this.data.length:0,this.writeHeader(e),this.data&&e.writeUint8Array(this.data)}printHeader(e){this.size+=8,this.size>M&&(this.size+=8),this.type==="uuid"&&(this.size+=16),e.log(e.indent+"size:"+this.size),e.log(e.indent+"type:"+this.type)}print(e){this.printHeader(e)}parse(e){this.type!=="mdat"?this.data=e.readUint8Array(this.size-this.hdr_size):this.size===0?e.seek(e.getEndPosition()):e.seek(this.start+this.size)}parseDataAndRewind(e){this.data=e.readUint8Array(this.size-this.hdr_size),e.seek(this.start+this.hdr_size)}parseLanguage(e){this.language=e.readUint16();let t=[];t[0]=this.language>>10&31,t[1]=this.language>>5&31,t[2]=this.language&31,this.languageString=String.fromCharCode(t[0]+96,t[1]+96,t[2]+96)}computeSize(e){let t=e||new De;this.write(t)}isEndOfBox(e){return e.getPosition()===this.start+this.size}},f=class extends _{constructor(...e){super(...e),this.flags=0,this.version=0}writeHeader(e){this.size+=4,super.writeHeader(e," v="+this.version+" f="+this.flags),e.writeUint8(this.version),e.writeUint24(this.flags)}printHeader(e){this.size+=4,super.printHeader(e),e.log(e.indent+"version:"+this.version),e.log(e.indent+"flags:"+this.flags)}parseDataAndRewind(e){this.parseFullHeader(e),this.data=e.readUint8Array(this.size-this.hdr_size),this.hdr_size-=4,e.seek(this.start+this.hdr_size)}parseFullHeader(e){this.version=e.readUint8(),this.flags=e.readUint24(),this.hdr_size+=4}parse(e){this.parseFullHeader(e),this.data=e.readUint8Array(this.size-this.hdr_size)}},D=class{static{this.registryId=Symbol.for("SampleGroupEntryIdentifier")}constructor(e){this.grouping_type=e}write(e){e.writeUint8Array(this.data)}parse(e){u.warn("BoxParser",`Unknown sample group type: '${this.grouping_type}'`),this.data=e.readUint8Array(this.description_length)}},Ni=class extends f{parse(e){this.parseFullHeader(e),this.track_group_id=e.readUint32()}},Hi=class extends _{constructor(e,t,i,s,n){super(t),this.box_name=i,this.hdr_size=s,this.start=n,this.type=e}parse(e){this.from_item_ID=e.readUint16();let t=e.readUint16();this.references=[];for(let i=0;i<t;i++)this.references[i]={to_item_ID:e.readUint16()}}},Gi=class extends _{constructor(e,t,i,s,n){super(t),this.box_name=i,this.hdr_size=s,this.start=n,this.type=e}parse(e){this.from_item_ID=e.readUint32();let t=e.readUint16();this.references=[];for(let i=0;i<t;i++)this.references[i]={to_item_ID:e.readUint32()}}},Vi=class extends _{constructor(e,t,i,s){super(t),this.hdr_size=i,this.start=s,this.type=e}parse(e){this.track_ids=e.readUint32Array((this.size-this.hdr_size)/4)}write(e){this.size=this.track_ids.length*4,this.writeHeader(e),e.writeUint32Array(this.track_ids)}},tt=["boxes","entries","references","subsamples","items","item_infos","extents","associations","subsegments","ranges","seekLists","seekPoints","esd","levels"],ji=["compatible_brands","matrix","opcolor","sample_counts","sample_deltas","first_chunk","samples_per_chunk","sample_sizes","chunk_offsets","sample_offsets","sample_description_index","sample_duration"];function $i(e,t){if(e&&!t)return!1;let i;for(i in e)if(!tt.find(s=>s===i)){if(e[i]instanceof _||t[i]instanceof _)continue;if(typeof e[i]>"u"||typeof t[i]>"u")continue;if(typeof e[i]=="function"||typeof t[i]=="function")continue;if("subBoxNames"in e&&e.subBoxNames.indexOf(i.slice(0,4))>-1||"subBoxNames"in t&&t.subBoxNames.indexOf(i.slice(0,4))>-1)continue;if(i==="data"||i==="start"||i==="size"||i==="creation_time"||i==="modification_time")continue;if(ji.find(s=>s===i))continue;if(e[i]!==t[i])return!1}return!0}function kt(e,t){if(!$i(e,t))return!1;for(let i=0;i<tt.length;i++){let s=tt[i];if(e[s]&&t[s]&&!kt(e[s],t[s]))return!1}return!0}function Et(e){let t=e;for(;t;){if("registryId"in t)return t.registryId;t=Object.getPrototypeOf(t)}}var Tr=e=>{let t=Symbol.for("SampleGroupEntryIdentifier");return Et(e)===t},Cr=e=>{let t=Symbol.for("SampleEntryIdentifier");return Et(e)===t},zr=e=>{let t=Symbol.for("BoxIdentifier");return Et(e)===t},X={uuid:{},sampleEntry:{},sampleGroupEntry:{},box:{}};function qi(e){let t={uuid:{},sampleEntry:{},sampleGroupEntry:{},box:{}};for(let[i,s]of Object.entries(e)){if(Tr(s)){let n="grouping_type"in s?s.grouping_type:void 0;if(!n)throw new Error(`SampleGroupEntry class ${i} does not have a valid static grouping_type. Please ensure it is defined correctly.`);if(n in t.sampleGroupEntry)throw new Error(`SampleGroupEntry class ${i} has a grouping_type that is already registered. Please ensure it is unique.`);t.sampleGroupEntry[n]=s;continue}if(Cr(s)){let n="fourcc"in s?s.fourcc:void 0;if(!n)throw new Error(`SampleEntry class ${i} does not have a valid static fourcc. Please ensure it is defined correctly.`);if(n in t.sampleEntry)throw new Error(`SampleEntry class ${i} has a fourcc that is already registered. Please ensure it is unique.`);t.sampleEntry[n]=s;continue}if(zr(s)){let n="fourcc"in s?s.fourcc:void 0,r="uuid"in s?s.uuid:void 0;if(n==="uuid"){if(!r)throw new Error(`Box class ${i} has a fourcc of 'uuid' but does not have a valid uuid. Please ensure it is defined correctly.`);if(r in t.uuid)throw new Error(`Box class ${i} has a uuid that is already registered. Please ensure it is unique.`);t.uuid[r]=s;continue}t.box[n]=s;continue}throw new Error(`Box class ${i} does not have a valid static fourcc, uuid, or grouping_type. Please ensure it is defined correctly.`)}return X.uuid={...t.uuid},X.sampleEntry={...t.sampleEntry},X.sampleGroupEntry={...t.sampleGroupEntry},X.box={...t.box},X}var it={};function Wi(e){return Object.entries(e).forEach(([t,i])=>it[t]=i),it}function Ir(e){return me(e)}function me(e){let t="";for(let i=0;i<16;i++){let s=e.readUint8().toString(16);t+=s.length===1?"0"+s:s}return t}function ie(e,t,i){let s,n,r=e.getPosition(),a=0,o;if(e.getEndPosition()-r<8)return u.debug("BoxParser","Not enough data in stream to parse the type and size of the box"),{code:0};if(i&&i<8)return u.debug("BoxParser","Not enough bytes left in the parent box to parse a new box"),{code:0};let c=e.readUint32(),h=e.readString(4);if(h.length!==4||!/^[\x20-\x7E]{4}$/.test(h))return u.error("BoxParser",`Invalid box type: '${h}'`),{code:-1,start:r,type:h};let d=h;if(u.debug("BoxParser","Found box of type '"+h+"' and size "+c+" at position "+r),a=8,h==="uuid"){if(e.getEndPosition()-e.getPosition()<16||i-a<16)return e.seek(r),u.debug("BoxParser","Not enough bytes left in the parent box to parse a UUID box"),{code:0};o=Ir(e),a+=16,d=o}if(c===1){if(e.getEndPosition()-e.getPosition()<8||i&&i-a<8)return e.seek(r),u.warn("BoxParser",'Not enough data in stream to parse the extended size of the "'+h+'" box'),{code:0};n=c,c=e.readUint64(),a+=8}else if(c===0)if(i)c=i;else{if(h!=="mdat")return u.error("BoxParser","Unlimited box size not supported for type: '"+h+"'"),s=new _(c),s.type=h,{code:1,box:s,size:s.size};c=e.getEndPosition()-r}if(c!==0&&c<a)return u.error("BoxParser","Box of type "+h+" has an invalid size "+c+" (too small to be a box)"),{code:0,type:h,size:c,hdr_size:a,start:r};if(c!==0&&i&&c>i)return u.error("BoxParser","Box of type '"+h+"' has a size "+c+" greater than its container size "+i),{code:0,type:h,size:c,hdr_size:a,start:r};if(c!==0&&r+c>e.getEndPosition())return e.seek(r),u.info("BoxParser","Not enough data in stream to parse the entire '"+h+"' box"),{code:0,type:h,size:c,hdr_size:a,start:r,original_size:n};if(t)return{code:1,type:h,size:c,hdr_size:a,start:r};h in X.box?s=new X.box[h](c):h!=="uuid"?(u.warn("BoxParser",`Unknown box type: '${h}'`),s=new _(c),s.type=h,s.has_unparsed_data=!0):o in X.uuid?s=new X.uuid[o](c):(u.warn("BoxParser",`Unknown UUID box type: '${o}'`),s=new _(c),s.type=h,s.uuid=o,s.has_unparsed_data=!0),s.original_size=n,s.hdr_size=a,s.start=r,s.write===_.prototype.write&&s.type!=="mdat"&&(u.info("BoxParser","'"+d+"' box writing not yet implemented, keeping unparsed data in memory for later write"),s.parseDataAndRewind(e)),s.parse(e);let p=e.getPosition()-(s.start+s.size);return p<0?(u.warn("BoxParser","Parsing of box '"+d+"' did not read the entire indicated box data size (missing "+-p+" bytes), seeking forward"),e.seek(s.start+s.size)):p>0&&s.size!==0&&(u.error("BoxParser","Parsing of box '"+d+"' read "+p+" more bytes than the indicated box data size, seeking backwards"),e.seek(s.start+s.size)),{code:1,box:s,size:s.size}}var E=class extends _{write(e){if(this.size=0,this.writeHeader(e),this.boxes)for(let t=0;t<this.boxes.length;t++)this.boxes[t]&&(this.boxes[t].write(e),this.size+=this.boxes[t].size);u.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),e.adjustUint32(this.sizePosition,this.size)}print(e){this.printHeader(e);for(let t=0;t<this.boxes.length;t++)if(this.boxes[t]){let i=e.indent;e.indent+=" ",this.boxes[t].print(e),e.indent=i}}parse(e){let t;for(;e.getPosition()<this.start+this.size;)if(t=ie(e,!1,this.size-(e.getPosition()-this.start)),t.code===1){let i=t.box;if(this.boxes||(this.boxes=[]),this.boxes.push(i),this.subBoxNames&&this.subBoxNames.indexOf(i.type)!==-1){let s=this.subBoxNames[this.subBoxNames.indexOf(i.type)]+"s";this[s]||(this[s]=[]),this[s].push(i)}else{let s=i.type!=="uuid"?i.type:i.uuid;this[s]?u.warn("ContainerBox",`Box of type ${s} already exists in container box ${this.type}.`):this[s]=i}}else return}},ne=class extends E{static{this.registryId=Symbol.for("SampleEntryIdentifier")}constructor(e,t,i){super(e),this.hdr_size=t,this.start=i}isVideo(){return!1}isAudio(){return!1}isSubtitle(){return!1}isMetadata(){return!1}isHint(){return!1}getCodec(){return this.type.replace(".","")}getWidth(){return""}getHeight(){return""}getChannelCount(){return""}getSampleRate(){return""}getSampleSize(){return""}parseHeader(e){e.readUint8Array(6),this.data_reference_index=e.readUint16(),this.hdr_size+=8}parse(e){this.parseHeader(e),this.data=e.readUint8Array(this.size-this.hdr_size)}parseDataAndRewind(e){this.parseHeader(e),this.data=e.readUint8Array(this.size-this.hdr_size),this.hdr_size-=8,e.seek(this.start+this.hdr_size)}parseFooter(e){super.parse(e)}writeHeader(e){this.size=8,super.writeHeader(e),e.writeUint8(0),e.writeUint8(0),e.writeUint8(0),e.writeUint8(0),e.writeUint8(0),e.writeUint8(0),e.writeUint16(this.data_reference_index)}writeFooter(e){if(this.boxes)for(let t=0;t<this.boxes.length;t++)this.boxes[t].write(e),this.size+=this.boxes[t].size;u.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),e.adjustUint32(this.sizePosition,this.size)}write(e){this.writeHeader(e),e.writeUint8Array(this.data),this.size+=this.data.length,u.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),e.adjustUint32(this.sizePosition,this.size)}},Ut=class extends ne{},ve=class extends ne{isMetadata(){return!0}},_e=class extends ne{isSubtitle(){return!0}},Ki=class extends ne{},P=class extends ne{parse(e){this.parseHeader(e),e.readUint16(),e.readUint16(),e.readUint32Array(3),this.width=e.readUint16(),this.height=e.readUint16(),this.horizresolution=e.readUint32(),this.vertresolution=e.readUint32(),e.readUint32(),this.frame_count=e.readUint16();let t=Math.min(31,e.readUint8());this.compressorname=e.readString(t),t<31&&e.readString(31-t),this.depth=e.readUint16(),e.readUint16(),this.parseFooter(e)}isVideo(){return!0}getWidth(){return this.width}getHeight(){return this.height}write(e){this.writeHeader(e),this.size+=70,e.writeUint16(0),e.writeUint16(0),e.writeUint32(0),e.writeUint32(0),e.writeUint32(0),e.writeUint16(this.width),e.writeUint16(this.height),e.writeUint32(this.horizresolution),e.writeUint32(this.vertresolution),e.writeUint32(0),e.writeUint16(this.frame_count),e.writeUint8(Math.min(31,this.compressorname.length)),e.writeString(this.compressorname,void 0,31),e.writeUint16(this.depth),e.writeInt16(-1),this.writeFooter(e)}},K=class extends ne{parse(e){this.parseHeader(e),this.version=e.readUint16(),e.readUint16(),e.readUint32(),this.channel_count=e.readUint16(),this.samplesize=e.readUint16(),e.readUint16(),e.readUint16(),this.samplerate=e.readUint32()/65536,e.isofile?.ftyp?.major_brand.includes("qt")&&(this.version===1?this.extensions=e.readUint8Array(16):this.version===2&&(this.extensions=e.readUint8Array(36))),this.parseFooter(e)}isAudio(){return!0}getChannelCount(){return this.channel_count}getSampleRate(){return this.samplerate}getSampleSize(){return this.samplesize}write(e){this.writeHeader(e),this.size+=20,e.writeUint32(0),e.writeUint32(0),e.writeUint16(this.channel_count),e.writeUint16(this.samplesize),e.writeUint16(0),e.writeUint16(0),e.writeUint32(this.samplerate<<16),this.writeFooter(e)}},rt=class extends ne{parse(e){this.parseHeader(e),this.parseFooter(e)}write(e){this.writeHeader(e),this.writeFooter(e)}},Ri=class extends Array{toString(){let e="<table class='inner-table'>";e+="<thead><tr><th>length</th><th>nalu_data</th></tr></thead>",e+="<tbody>";for(let t=0;t<this.length;t++){let i=this[t];e+="<tr>",e+="<td>"+i.length+"</td>",e+="<td>",e+=i.data.reduce(function(s,n){return s+n.toString(16).padStart(2,"0")},"0x"),e+="</td></tr>"}return e+="</tbody></table>",e}},Tt=class extends _{constructor(...e){super(...e),this.box_name="AVCConfigurationBox"}static{this.fourcc="avcC"}parse(e){this.configurationVersion=e.readUint8(),this.AVCProfileIndication=e.readUint8(),this.profile_compatibility=e.readUint8(),this.AVCLevelIndication=e.readUint8(),this.lengthSizeMinusOne=e.readUint8()&3,this.nb_SPS_nalus=e.readUint8()&31;let t=this.size-this.hdr_size-6;this.SPS=new Ri;for(let i=0;i<this.nb_SPS_nalus;i++){let s=e.readUint16();this.SPS.push({length:s,data:e.readUint8Array(s)}),t-=2+s}this.nb_PPS_nalus=e.readUint8(),t--,this.PPS=new Ri;for(let i=0;i<this.nb_PPS_nalus;i++){let s=e.readUint16();this.PPS.push({length:s,data:e.readUint8Array(s)}),t-=2+s}t>0&&(this.ext=e.readUint8Array(t))}write(e){this.size=7;for(let t=0;t<this.SPS.length;t++)this.size+=2+this.SPS[t].length;for(let t=0;t<this.PPS.length;t++)this.size+=2+this.PPS[t].length;this.ext&&(this.size+=this.ext.length),this.writeHeader(e),e.writeUint8(this.configurationVersion),e.writeUint8(this.AVCProfileIndication),e.writeUint8(this.profile_compatibility),e.writeUint8(this.AVCLevelIndication),e.writeUint8(this.lengthSizeMinusOne+252),e.writeUint8(this.SPS.length+224);for(let t=0;t<this.SPS.length;t++)e.writeUint16(this.SPS[t].length),e.writeUint8Array(this.SPS[t].data);e.writeUint8(this.PPS.length);for(let t=0;t<this.PPS.length;t++)e.writeUint16(this.PPS[t].length),e.writeUint8Array(this.PPS[t].data);this.ext&&e.writeUint8Array(this.ext)}},Me=class extends _{constructor(...e){super(...e),this.box_name="MediaDataBox"}static{this.fourcc="mdat"}},Yi=class extends _{constructor(...e){super(...e),this.box_name="ItemDataBox"}static{this.fourcc="idat"}},Xi=class extends _{constructor(...e){super(...e),this.box_name="FreeSpaceBox"}static{this.fourcc="free"}},Qi=class extends _{constructor(...e){super(...e),this.box_name="FreeSpaceBox"}static{this.fourcc="skip"}},Ct=class extends f{constructor(...e){super(...e),this.box_name="HintMediaHeaderBox"}static{this.fourcc="hmhd"}},Re=class extends f{constructor(...e){super(...e),this.box_name="NullMediaHeaderBox"}static{this.fourcc="nmhd"}},Zi=class extends f{constructor(...e){super(...e),this.box_name="ObjectDescriptorBox"}static{this.fourcc="iods"}},Ji=class extends f{constructor(...e){super(...e),this.box_name="XMLBox"}static{this.fourcc="xml "}},es=class extends f{constructor(...e){super(...e),this.box_name="BinaryXMLBox"}static{this.fourcc="bxml"}},ts=class extends f{constructor(...e){super(...e),this.box_name="ItemProtectionBox",this.sinfs=[]}static{this.fourcc="ipro"}get protections(){return this.sinfs}},Oe=class extends E{constructor(...e){super(...e),this.box_name="MovieBox",this.traks=[],this.psshs=[],this.subBoxNames=["trak","pssh"]}static{this.fourcc="moov"}},zt=class extends E{constructor(...e){super(...e),this.box_name="TrackBox",this.samples=[]}static{this.fourcc="trak"}},is=class extends E{constructor(...e){super(...e),this.box_name="EditBox"}static{this.fourcc="edts"}},It=class extends E{constructor(...e){super(...e),this.box_name="MediaBox"}static{this.fourcc="mdia"}},Pt=class extends E{constructor(...e){super(...e),this.box_name="MediaInformationBox"}static{this.fourcc="minf"}},At=class extends E{constructor(...e){super(...e),this.box_name="DataInformationBox"}static{this.fourcc="dinf"}},Ft=class extends E{constructor(...e){super(...e),this.box_name="SampleTableBox",this.sgpds=[],this.sbgps=[],this.subBoxNames=["sgpd","sbgp"]}static{this.fourcc="stbl"}},st=class extends E{constructor(...e){super(...e),this.box_name="MovieExtendsBox",this.trexs=[],this.subBoxNames=["trex"]}static{this.fourcc="mvex"}},Lt=class extends E{constructor(...e){super(...e),this.box_name="MovieFragmentBox",this.trafs=[],this.subBoxNames=["traf"]}static{this.fourcc="moof"}},Dt=class extends E{constructor(...e){super(...e),this.box_name="TrackFragmentBox",this.truns=[],this.sgpds=[],this.sbgps=[],this.subBoxNames=["trun","sgpd","sbgp"]}static{this.fourcc="traf"}},ss=class extends E{constructor(...e){super(...e),this.box_name="VTTCueBox"}static{this.fourcc="vttc"}},ns=class extends E{constructor(...e){super(...e),this.box_name="MovieFragmentRandomAccessBox",this.tfras=[],this.subBoxNames=["tfra"]}static{this.fourcc="mfra"}},rs=class extends E{constructor(...e){super(...e),this.box_name="AdditionalMetadataContainerBox"}static{this.fourcc="meco"}},as=class extends E{constructor(...e){super(...e),this.box_name="trackhintinformation",this.subBoxNames=["sdp ","rtp "]}static{this.fourcc="hnti"}},os=class extends E{constructor(...e){super(...e),this.box_name="hintstatisticsbox",this.maxrs=[],this.subBoxNames=["maxr"]}static{this.fourcc="hinf"}},cs=class extends E{constructor(...e){super(...e),this.box_name="SubTrackBox"}static{this.fourcc="strk"}},ls=class extends E{constructor(...e){super(...e),this.box_name="SubTrackDefinitionBox"}static{this.fourcc="strd"}},hs=class extends E{constructor(...e){super(...e),this.box_name="ProtectionSchemeInfoBox"}static{this.fourcc="sinf"}},us=class extends E{constructor(...e){super(...e),this.box_name="RestrictedSchemeInfoBox"}static{this.fourcc="rinf"}},ds=class extends E{constructor(...e){super(...e),this.box_name="SchemeInformationBox"}static{this.fourcc="schi"}},fs=class extends E{constructor(...e){super(...e),this.box_name="TrackGroupBox"}static{this.fourcc="trgr"}},ps=class extends E{constructor(...e){super(...e),this.box_name="UserDataBox",this.kinds=[],this.strks=[],this.subBoxNames=["kind","strk"]}static{this.fourcc="udta"}},_s=class extends E{constructor(...e){super(...e),this.box_name="ItemPropertiesBox",this.ipmas=[],this.subBoxNames=["ipma"]}static{this.fourcc="iprp"}},ms=class extends E{constructor(...e){super(...e),this.box_name="ItemPropertyContainerBox",this.hvcCs=[],this.ispes=[],this.claps=[],this.irots=[],this.subBoxNames=["hvcC","ispe","clap","irot"]}static{this.fourcc="ipco"}},xs=class extends E{constructor(...e){super(...e),this.box_name="GroupsListBox"}static{this.fourcc="grpl"}},gs=class extends E{constructor(...e){super(...e),this.box_name="J2KHeaderInfoBox"}static{this.fourcc="j2kH"}},bs=class extends E{constructor(...e){super(...e),this.box_name="ExtendedTypeBox",this.tycos=[],this.subBoxNames=["tyco"]}static{this.fourcc="etyp"}},ys=class extends E{constructor(...e){super(...e),this.box_name="ProjectedOmniVideoBox",this.subBoxNames=["prfr"]}static{this.fourcc="povd"}},Mt=class extends f{constructor(...e){super(...e),this.box_name="DataReferenceBox"}static{this.fourcc="dref"}parse(e){this.parseFullHeader(e),this.entries=[];let t=e.readUint32();for(let i=0;i<t;i++){let s=ie(e,!1,this.size-(e.getPosition()-this.start));if(s.code===1){let n=s.box;this.entries.push(n)}else return}}write(e){this.version=0,this.flags=0,this.size=4,this.writeHeader(e),e.writeUint32(this.entries.length);for(let t=0;t<this.entries.length;t++)this.entries[t].write(e),this.size+=this.entries[t].size;u.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),e.adjustUint32(this.sizePosition,this.size)}},Rt=class extends f{constructor(...e){super(...e),this.box_name="ExtendedLanguageBox"}static{this.fourcc="elng"}parse(e){this.parseFullHeader(e),this.extended_language=e.readString(this.size-this.hdr_size)}write(e){this.version=0,this.flags=0,this.size=this.extended_language.length,this.writeHeader(e),e.writeString(this.extended_language)}},Ot=class extends _{constructor(...e){super(...e),this.box_name="FileTypeBox"}static{this.fourcc="ftyp"}parse(e){let t=this.size-this.hdr_size;this.major_brand=e.readString(4),this.minor_version=e.readUint32();let i=String.fromCharCode(this.minor_version>>24,this.minor_version>>16&255,this.minor_version>>8&255,this.minor_version&255);i.match("[a-zA-Z0-9]{4}")&&(this.minor_version=i),t-=8,this.compatible_brands=[];let s=0;for(;t>=4;)this.compatible_brands[s]=e.readString(4),t-=4,s++}write(e){this.size=8+4*this.compatible_brands.length,this.writeHeader(e),e.writeString(this.major_brand,void 0,4),typeof this.minor_version=="number"?e.writeUint32(this.minor_version):e.writeString(this.minor_version,void 0,4);for(let t=0;t<this.compatible_brands.length;t++)e.writeString(this.compatible_brands[t],void 0,4)}},Nt=class extends f{constructor(...e){super(...e),this.box_name="HandlerBox"}static{this.fourcc="hdlr"}parse(e){if(this.parseFullHeader(e),this.version===0&&(e.readUint32(),this.handler=e.readString(4),e.readUint32Array(3),!this.isEndOfBox(e))){let t=this.start+this.size-e.getPosition();this.name=e.readCString();let i=this.start+this.size-1;e.seek(i),e.readUint8()!==0&&t>1&&(u.info("BoxParser","Warning: hdlr name is not null-terminated, possibly length-prefixed string. Trimming first byte."),this.name=this.name.slice(1))}}write(e){this.size=20+this.name.length+1,this.version=0,this.flags=0,this.writeHeader(e),e.writeUint32(0),e.writeString(this.handler,void 0,4),e.writeUint32Array([0,0,0]),e.writeCString(this.name)}},Ht=class extends _{constructor(...e){super(...e),this.box_name="HEVCConfigurationBox"}static{this.fourcc="hvcC"}parse(e){this.configurationVersion=e.readUint8();let t=e.readUint8();this.general_profile_space=t>>6,this.general_tier_flag=(t&32)>>5,this.general_profile_idc=t&31,this.general_profile_compatibility=e.readUint32(),this.general_constraint_indicator=e.readUint8Array(6),this.general_level_idc=e.readUint8(),this.min_spatial_segmentation_idc=e.readUint16()&4095,this.parallelismType=e.readUint8()&3,this.chroma_format_idc=e.readUint8()&3,this.bit_depth_luma_minus8=e.readUint8()&7,this.bit_depth_chroma_minus8=e.readUint8()&7,this.avgFrameRate=e.readUint16(),t=e.readUint8(),this.constantFrameRate=t>>6,this.numTemporalLayers=(t&13)>>3,this.temporalIdNested=(t&4)>>2,this.lengthSizeMinusOne=t&3,this.nalu_arrays=[];let i=e.readUint8();for(let s=0;s<i;s++){let n=[];this.nalu_arrays.push(n),t=e.readUint8(),n.completeness=(t&128)>>7,n.nalu_type=t&63;let r=e.readUint16();for(let a=0;a<r;a++){let o=e.readUint16();n.push({data:e.readUint8Array(o)})}}}write(e){this.size=23;for(let t=0;t<this.nalu_arrays.length;t++){this.size+=3;for(let i=0;i<this.nalu_arrays[t].length;i++)this.size+=2+this.nalu_arrays[t][i].data.length}this.writeHeader(e),e.writeUint8(this.configurationVersion),e.writeUint8((this.general_profile_space<<6)+(this.general_tier_flag<<5)+this.general_profile_idc),e.writeUint32(this.general_profile_compatibility),e.writeUint8Array(this.general_constraint_indicator),e.writeUint8(this.general_level_idc),e.writeUint16(this.min_spatial_segmentation_idc+(15<<24)),e.writeUint8(this.parallelismType+252),e.writeUint8(this.chroma_format_idc+252),e.writeUint8(this.bit_depth_luma_minus8+248),e.writeUint8(this.bit_depth_chroma_minus8+248),e.writeUint16(this.avgFrameRate),e.writeUint8((this.constantFrameRate<<6)+(this.numTemporalLayers<<3)+(this.temporalIdNested<<2)+this.lengthSizeMinusOne),e.writeUint8(this.nalu_arrays.length);for(let t=0;t<this.nalu_arrays.length;t++){e.writeUint8((this.nalu_arrays[t].completeness<<7)+this.nalu_arrays[t].nalu_type),e.writeUint16(this.nalu_arrays[t].length);for(let i=0;i<this.nalu_arrays[t].length;i++)e.writeUint16(this.nalu_arrays[t][i].data.length),e.writeUint8Array(this.nalu_arrays[t][i].data)}}},Gt=class extends f{constructor(...e){super(...e),this.box_name="MediaHeaderBox"}static{this.fourcc="mdhd"}parse(e){this.parseFullHeader(e),this.version===1?(this.creation_time=e.readUint64(),this.modification_time=e.readUint64(),this.timescale=e.readUint32(),this.duration=e.readUint64()):(this.creation_time=e.readUint32(),this.modification_time=e.readUint32(),this.timescale=e.readUint32(),this.duration=e.readUint32()),this.parseLanguage(e),e.readUint16()}write(e){let t=this.modification_time>M||this.creation_time>M||this.duration>M||this.version===1;this.version=t?1:0,this.size=20,this.size+=t?12:0,this.flags=0,this.writeHeader(e),t?(e.writeUint64(this.creation_time),e.writeUint64(this.modification_time),e.writeUint32(this.timescale),e.writeUint64(this.duration)):(e.writeUint32(this.creation_time),e.writeUint32(this.modification_time),e.writeUint32(this.timescale),e.writeUint32(this.duration)),e.writeUint16(this.language),e.writeUint16(0)}},Vt=class extends f{constructor(...e){super(...e),this.box_name="MovieExtendsHeaderBox"}static{this.fourcc="mehd"}parse(e){this.parseFullHeader(e),this.flags&1&&(u.warn("BoxParser","mehd box incorrectly uses flags set to 1, converting version to 1"),this.version=1),this.version===1?this.fragment_duration=e.readUint64():this.fragment_duration=e.readUint32()}write(e){let t=this.fragment_duration>M||this.version===1;this.version=t?1:0,this.size=4,this.size+=t?4:0,this.flags=0,this.writeHeader(e),t?e.writeUint64(this.fragment_duration):e.writeUint32(this.fragment_duration)}},vs=class extends f{constructor(...e){super(...e),this.box_name="ItemInfoEntry"}static{this.fourcc="infe"}parse(e){if(this.parseFullHeader(e),(this.version===0||this.version===1)&&(this.item_ID=e.readUint16(),this.item_protection_index=e.readUint16(),this.item_name=e.readCString(),this.content_type=e.readCString(),this.isEndOfBox(e)||(this.content_encoding=e.readCString())),this.version===1){this.extension_type=e.readString(4),u.warn("BoxParser","Cannot parse extension type"),e.seek(this.start+this.size);return}this.version>=2&&(this.version===2?this.item_ID=e.readUint16():this.version===3&&(this.item_ID=e.readUint32()),this.item_protection_index=e.readUint16(),this.item_type=e.readString(4),this.item_name=e.readCString(),this.item_type==="mime"?(this.content_type=e.readCString(),this.content_encoding=e.readCString()):this.item_type==="uri "&&(this.item_uri_type=e.readCString()))}},ws=class extends f{constructor(...e){super(...e),this.box_name="ItemInfoBox"}static{this.fourcc="iinf"}parse(e){this.parseFullHeader(e),this.version===0?this.entry_count=e.readUint16():this.entry_count=e.readUint32(),this.item_infos=[];for(let t=0;t<this.entry_count;t++){let i=ie(e,!1,this.size-(e.getPosition()-this.start));if(i.code===1){let s=i.box;s.type==="infe"?this.item_infos[t]=s:u.error("BoxParser","Expected 'infe' box, got "+i.box.type,e.isofile)}else return}}},Ss=class extends f{constructor(...e){super(...e),this.box_name="ItemLocationBox"}static{this.fourcc="iloc"}parse(e){this.parseFullHeader(e);let t;t=e.readUint8(),this.offset_size=t>>4&15,this.length_size=t&15,t=e.readUint8(),this.base_offset_size=t>>4&15,this.version===1||this.version===2?this.index_size=t&15:this.index_size=0,this.items=[];let i=0;if(this.version<2)i=e.readUint16();else if(this.version===2)i=e.readUint32();else throw new Error("version of iloc box not supported");for(let s=0;s<i;s++){let n=0,r=0,a=0;if(this.version<2)n=e.readUint16();else if(this.version===2)n=e.readUint32();else throw new Error("version of iloc box not supported");this.version===1||this.version===2?r=e.readUint16()&15:r=0;let o=e.readUint16();switch(this.base_offset_size){case 0:a=0;break;case 4:a=e.readUint32();break;case 8:a=e.readUint64();break;default:throw new Error("Error reading base offset size")}let c=[],h=e.readUint16();for(let d=0;d<h;d++){let p=0,x=0,b=0;if(this.version===1||this.version===2)switch(this.index_size){case 0:p=0;break;case 4:p=e.readUint32();break;case 8:p=e.readUint64();break;default:throw new Error("Error reading extent index")}switch(this.offset_size){case 0:x=0;break;case 4:x=e.readUint32();break;case 8:x=e.readUint64();break;default:throw new Error("Error reading extent index")}switch(this.length_size){case 0:b=0;break;case 4:b=e.readUint32();break;case 8:b=e.readUint64();break;default:throw new Error("Error reading extent index")}c.push({extent_index:p,extent_length:b,extent_offset:x})}this.items.push({base_offset:a,construction_method:r,item_ID:n,data_reference_index:o,extents:c})}}},Pr={auxl:"Auxiliary image item",base:"Pre-derived image item base",cdsc:"Item describes referenced item",dimg:"Derived image item",dpnd:"Item coding dependency",eroi:"Region",evir:"EVC slice",exbl:"Scalable image item","fdl ":"File delivery",font:"Font item",iloc:"Item data location",mask:"Region mask",mint:"Data integrity",pred:"Predictively coded item",prem:"Pre-multiplied item",tbas:"HEVC tile track base item",text:"Text item",thmb:"Thumbnail image item"},Bs=class Us extends f{constructor(...t){super(...t),this.box_name="ItemReferenceBox",this.references=[]}static{this.fourcc="iref"}static{this.allowed_types=["auxl","base","cdsc","dimg","dpnd","eroi","evir","exbl","fdl ","font","iloc","mask","mint","pred","prem","tbas","text","thmb"]}parse(t){for(this.parseFullHeader(t),this.references=[];t.getPosition()<this.start+this.size;){let i=ie(t,!0,this.size-(t.getPosition()-this.start));if(i.code===1){let s="Unknown item reference";Us.allowed_types.includes(i.type)?s=Pr[i.type]:u.warn("BoxParser",`Unknown item reference type: '${i.type}'`);let n=this.version===0?new Hi(i.type,i.size,s,i.hdr_size,i.start):new Gi(i.type,i.size,s,i.hdr_size,i.start);n.write===_.prototype.write&&n.type!=="mdat"&&(u.warn("BoxParser",n.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),n.parseDataAndRewind(t)),n.parse(t),this.references.push(n)}else return}}},ks=class extends f{constructor(...e){super(...e),this.box_name="PrimaryItemBox"}static{this.fourcc="pitm"}parse(e){this.parseFullHeader(e),this.version===0?this.item_id=e.readUint16():this.item_id=e.readUint32()}},Es=class extends f{constructor(...e){super(...e),this.box_name="MetaBox",this.isQT=!1}static{this.fourcc="meta"}parse(e){let t=e.getPosition();if(this.size>8){switch(e.readUint32(),e.readString(4)){case"hdlr":case"mhdr":case"keys":case"ilst":case"ctry":case"lang":this.isQT=!0;break;default:break}e.seek(t)}this.isQT||this.parseFullHeader(e),E.prototype.parse.call(this,e)}},jt=class extends f{constructor(...e){super(...e),this.box_name="MovieFragmentHeaderBox"}static{this.fourcc="mfhd"}parse(e){this.parseFullHeader(e),this.sequence_number=e.readUint32()}write(e){this.version=0,this.flags=0,this.size=4,this.writeHeader(e),e.writeUint32(this.sequence_number)}},$t=class extends f{constructor(...e){super(...e),this.box_name="MovieHeaderBox"}static{this.fourcc="mvhd"}parse(e){this.parseFullHeader(e),this.version===1?(this.creation_time=e.readUint64(),this.modification_time=e.readUint64(),this.timescale=e.readUint32(),this.duration=e.readUint64()):(this.creation_time=e.readUint32(),this.modification_time=e.readUint32(),this.timescale=e.readUint32(),this.duration=e.readUint32()),this.rate=e.readUint32(),this.volume=e.readUint16()>>8,e.readUint16(),e.readUint32Array(2),this.matrix=e.readInt32Array(9),e.readUint32Array(6),this.next_track_id=e.readUint32()}write(e){let t=this.modification_time>M||this.creation_time>M||this.duration>M||this.version===1;this.version=t?1:0,this.size=96,this.size+=t?12:0,this.flags=0,this.writeHeader(e),t?(e.writeUint64(this.creation_time),e.writeUint64(this.modification_time),e.writeUint32(this.timescale),e.writeUint64(this.duration)):(e.writeUint32(this.creation_time),e.writeUint32(this.modification_time),e.writeUint32(this.timescale),e.writeUint32(this.duration)),e.writeUint32(this.rate),e.writeUint16(this.volume<<8),e.writeUint16(0),e.writeUint32(0),e.writeUint32(0),e.writeInt32Array(this.matrix),e.writeUint32(0),e.writeUint32(0),e.writeUint32(0),e.writeUint32(0),e.writeUint32(0),e.writeUint32(0),e.writeUint32(this.next_track_id)}print(e){super.printHeader(e),e.log(e.indent+"creation_time: "+this.creation_time),e.log(e.indent+"modification_time: "+this.modification_time),e.log(e.indent+"timescale: "+this.timescale),e.log(e.indent+"duration: "+this.duration),e.log(e.indent+"rate: "+this.rate),e.log(e.indent+"volume: "+(this.volume>>8)),e.log(e.indent+"matrix: "+this.matrix.join(", ")),e.log(e.indent+"next_track_id: "+this.next_track_id)}},Ts=class extends ve{static{this.fourcc="mett"}parse(e){this.parseHeader(e),this.content_encoding=e.readCString(),this.mime_format=e.readCString(),this.parseFooter(e)}},Cs=class extends ve{static{this.fourcc="metx"}parse(e){this.parseHeader(e),this.content_encoding=e.readCString(),this.namespace=e.readCString(),this.schema_location=e.readCString(),this.parseFooter(e)}},zs=class extends _{constructor(...e){super(...e),this.box_name="AV1CodecConfigurationBox"}static{this.fourcc="av1C"}parse(e){let t=e.readUint8();if((t>>7&1)!==1){u.error("BoxParser","av1C marker problem",e.isofile);return}if(this.version=t&127,this.version!==1){u.error("BoxParser","av1C version "+this.version+" not supported",e.isofile);return}if(t=e.readUint8(),this.seq_profile=t>>5&7,this.seq_level_idx_0=t&31,t=e.readUint8(),this.seq_tier_0=t>>7&1,this.high_bitdepth=t>>6&1,this.twelve_bit=t>>5&1,this.monochrome=t>>4&1,this.chroma_subsampling_x=t>>3&1,this.chroma_subsampling_y=t>>2&1,this.chroma_sample_position=t&3,t=e.readUint8(),this.reserved_1=t>>5&7,this.reserved_1!==0){u.error("BoxParser","av1C reserved_1 parsing problem",e.isofile);return}if(this.initial_presentation_delay_present=t>>4&1,this.initial_presentation_delay_present===1)this.initial_presentation_delay_minus_one=t&15;else if(this.reserved_2=t&15,this.reserved_2!==0){u.error("BoxParser","av1C reserved_2 parsing problem",e.isofile);return}let i=this.size-this.hdr_size-4;this.configOBUs=e.readUint8Array(i)}},Is=class extends f{constructor(...e){super(...e),this.box_name="ElementaryStreamDescriptorBox"}static{this.fourcc="esds"}parse(e){this.parseFullHeader(e);let t=e.readUint8Array(this.size-this.hdr_size);if("MPEG4DescriptorParser"in it){let i=new it.MPEG4DescriptorParser;this.esd=i.parseOneDescriptor(new G(t.buffer,0))}}},Ps=class extends E{constructor(...e){super(...e),this.box_name="siDecompressionParamBox"}static{this.fourcc="wave"}},As=class extends _{constructor(...e){super(...e),this.box_name="LCEVCConfigurationBox"}static{this.fourcc="lvcC"}parse(e){if(this.configurationVersion=e.readUint8(),this.configurationVersion!==1){u.error("BoxParser","lvcC version "+this.configurationVersion+" not supported",e.isofile);return}this.LCEVCProfileIndication=e.readUint8(),this.LCEVCLevelIndication=e.readUint8();let t=e.readUint8();this.chroma_format_idc=t>>6&3,this.bit_depth_luma_minus8=t>>3&7,this.bit_depth_chroma_minus8=t&7,t=e.readUint8(),this.lengthSizeMinusOne=t>>6&3;let i=t&63;if(i!==63){u.error("BoxParser","lvcC reserved parsing problem",e.isofile);return}if(this.pic_width_in_luma_samples=e.readUint32(),this.pic_height_in_luma_samples=e.readUint32(),t=e.readUint8(),this.sc_in_stream=t>>7&1,this.gc_in_stream=t>>6&1,this.ai_in_stream=t>>5&1,i=t&31,i!==31){u.error("BoxParser","lvcC reserved parsing problem",e.isofile);return}this.nalu_arrays=[];let s=e.readUint8();for(let n=0;n<s;n++){let r=[];if(this.nalu_arrays.push(r),t=e.readUint8(),i=t>>6&3,i!==0){u.error("BoxParser","lvcC reserved parsing problem",e.isofile);return}r.nalu_type=t&63;let a=e.readUint16();for(let o=0;o<a;o++){let c=e.readUint16();r.push({data:e.readUint8Array(c)})}}}},Fs=class extends f{constructor(...e){super(...e),this.box_name="VPCodecConfigurationRecord"}static{this.fourcc="vpcC"}parse(e){if(this.parseFullHeader(e),this.version===1){this.profile=e.readUint8(),this.level=e.readUint8();let t=e.readUint8();this.bitDepth=t>>4,this.chromaSubsampling=t>>1&7,this.videoFullRangeFlag=t&1,this.colourPrimaries=e.readUint8(),this.transferCharacteristics=e.readUint8(),this.matrixCoefficients=e.readUint8(),this.codecIntializationDataSize=e.readUint16(),this.codecIntializationData=e.readUint8Array(this.codecIntializationDataSize)}else{this.profile=e.readUint8(),this.level=e.readUint8();let t=e.readUint8();this.bitDepth=t>>4&15,this.colorSpace=t&15,t=e.readUint8(),this.chromaSubsampling=t>>4&15,this.transferFunction=t>>1&7,this.videoFullRangeFlag=t&1,this.codecIntializationDataSize=e.readUint16(),this.codecIntializationData=e.readUint8Array(this.codecIntializationDataSize)}}},Ls=class extends f{constructor(...e){super(...e),this.box_name="VvcConfigurationBox"}static{this.fourcc="vvcC"}parse(e){this.parseFullHeader(e);let t={held_bits:void 0,num_held_bits:0,stream_read_1_bytes:function(r){this.held_bits=r.readUint8(),this.num_held_bits=8},stream_read_2_bytes:function(r){this.held_bits=r.readUint16(),this.num_held_bits=16},extract_bits:function(r){let a=this.held_bits>>this.num_held_bits-r&(1<<r)-1;return this.num_held_bits-=r,a}};if(t.stream_read_1_bytes(e),t.extract_bits(5),this.lengthSizeMinusOne=t.extract_bits(2),this.ptl_present_flag=t.extract_bits(1),this.ptl_present_flag){if(t.stream_read_2_bytes(e),this.ols_idx=t.extract_bits(9),this.num_sublayers=t.extract_bits(3),this.constant_frame_rate=t.extract_bits(2),this.chroma_format_idc=t.extract_bits(2),t.stream_read_1_bytes(e),this.bit_depth_minus8=t.extract_bits(3),t.extract_bits(5),t.stream_read_2_bytes(e),t.extract_bits(2),this.num_bytes_constraint_info=t.extract_bits(6),this.general_profile_idc=t.extract_bits(7),this.general_tier_flag=t.extract_bits(1),this.general_level_idc=e.readUint8(),t.stream_read_1_bytes(e),this.ptl_frame_only_constraint_flag=t.extract_bits(1),this.ptl_multilayer_enabled_flag=t.extract_bits(1),this.general_constraint_info=new Uint8Array(this.num_bytes_constraint_info),this.num_bytes_constraint_info){for(let r=0;r<this.num_bytes_constraint_info-1;r++){let a=t.extract_bits(6);t.stream_read_1_bytes(e);let o=t.extract_bits(2);this.general_constraint_info[r]=a<<2|o}this.general_constraint_info[this.num_bytes_constraint_info-1]=t.extract_bits(6)}else t.extract_bits(6);if(this.num_sublayers>1){t.stream_read_1_bytes(e),this.ptl_sublayer_present_mask=0;for(let r=this.num_sublayers-2;r>=0;--r){let a=t.extract_bits(1);this.ptl_sublayer_present_mask|=a<<r}for(let r=this.num_sublayers;r<=8&&this.num_sublayers>1;++r)t.extract_bits(1);this.sublayer_level_idc=[];for(let r=this.num_sublayers-2;r>=0;--r)this.ptl_sublayer_present_mask&1<<r&&(this.sublayer_level_idc[r]=e.readUint8())}if(this.ptl_num_sub_profiles=e.readUint8(),this.general_sub_profile_idc=[],this.ptl_num_sub_profiles)for(let r=0;r<this.ptl_num_sub_profiles;r++)this.general_sub_profile_idc.push(e.readUint32());this.max_picture_width=e.readUint16(),this.max_picture_height=e.readUint16(),this.avg_frame_rate=e.readUint16()}let i=12,s=13;this.nalu_arrays=[];let n=e.readUint8();for(let r=0;r<n;r++){let a=[];this.nalu_arrays.push(a),t.stream_read_1_bytes(e),a.completeness=t.extract_bits(1),t.extract_bits(2),a.nalu_type=t.extract_bits(5);let o=1;a.nalu_type!==s&&a.nalu_type!==i&&(o=e.readUint16());for(let c=0;c<o;c++){let h=e.readUint16();a.push({data:e.readUint8Array(h),length:h})}}}},Ds=class extends _{constructor(...e){super(...e),this.box_name="ColourInformationBox"}static{this.fourcc="colr"}parse(e){if(this.colour_type=e.readString(4),this.colour_type==="nclx"){this.colour_primaries=e.readUint16(),this.transfer_characteristics=e.readUint16(),this.matrix_coefficients=e.readUint16();let t=e.readUint8();this.full_range_flag=t>>7}else this.colour_type==="rICC"?this.ICC_profile=e.readUint8Array(this.size-4):this.colour_type==="prof"&&(this.ICC_profile=e.readUint8Array(this.size-4))}};function Ce(e,t){let i=Number(e).toString(16);for(t=typeof t>"u"?2:t;i.length<t;)i="0"+i;return i}var at=class extends P{getCodec(){let e=super.getCodec();return this.avcC?`${e}.${Ce(this.avcC.AVCProfileIndication)}${Ce(this.avcC.profile_compatibility)}${Ce(this.avcC.AVCLevelIndication)}`:e}},Ms=class extends at{constructor(...e){super(...e),this.box_name="AVCSampleEntry"}static{this.fourcc="avc1"}},Rs=class extends at{constructor(...e){super(...e),this.box_name="AVC2SampleEntry"}static{this.fourcc="avc2"}},Os=class extends at{constructor(...e){super(...e),this.box_name="AVCSampleEntry"}static{this.fourcc="avc3"}},Ns=class extends at{constructor(...e){super(...e),this.box_name="AVC2SampleEntry"}static{this.fourcc="avc4"}},Hs=class extends P{constructor(...e){super(...e),this.box_name="AV1SampleEntry"}static{this.fourcc="av01"}getCodec(){let e=super.getCodec(),t=this.av1C.seq_level_idx_0,i=t<10?"0"+t:t,s;return this.av1C.seq_profile===2&&this.av1C.high_bitdepth===1?s=this.av1C.twelve_bit===1?"12":"10":this.av1C.seq_profile<=2&&(s=this.av1C.high_bitdepth===1?"10":"08"),e+"."+this.av1C.seq_profile+"."+i+(this.av1C.seq_tier_0?"H":"M")+"."+s}},Gs=class extends P{static{this.fourcc="dav1"}},ot=class extends P{getCodec(){let e=super.getCodec();if(this.hvcC){switch(e+=".",this.hvcC.general_profile_space){case 0:e+="";break;case 1:e+="A";break;case 2:e+="B";break;case 3:e+="C";break}e+=this.hvcC.general_profile_idc,e+=".";let t=this.hvcC.general_profile_compatibility,i=0;for(let r=0;r<32&&(i|=t&1,r!==31);r++)i<<=1,t>>=1;e+=Ce(i,0),e+=".",this.hvcC.general_tier_flag===0?e+="L":e+="H",e+=this.hvcC.general_level_idc;let s=!1,n="";for(let r=5;r>=0;r--)(this.hvcC.general_constraint_indicator[r]||s)&&(n="."+Ce(this.hvcC.general_constraint_indicator[r],0)+n,s=!0);e+=n}return e}},Vs=class extends ot{constructor(...e){super(...e),this.box_name="HEVCSampleEntry"}static{this.fourcc="hvc1"}},js=class extends ot{static{this.fourcc="hvc2"}},$s=class extends ot{constructor(...e){super(...e),this.box_name="HEVCSampleEntry",this.colrs=[],this.subBoxNames=["colr"]}static{this.fourcc="hev1"}},qs=class extends ot{static{this.fourcc="hev2"}},Ws=class extends P{constructor(...e){super(...e),this.box_name="HEVCTileSampleSampleEntry"}static{this.fourcc="hvt1"}},Ks=class extends P{constructor(...e){super(...e),this.box_name="LHEVCSampleEntry"}static{this.fourcc="lhe1"}},Ys=class extends P{constructor(...e){super(...e),this.box_name="LHEVCSampleEntry"}static{this.fourcc="lhv1"}},Xs=class extends P{constructor(...e){super(...e),this.box_name="LCEVCSampleEntry"}static{this.fourcc="lvc1"}getCodec(){let e=super.getCodec();return this.lvcC&&(e+=".",e+="vprf",e+=this.lvcC.LCEVCProfileIndication,e+=".",e+="vlev",e+=this.lvcC.LCEVCLevelIndication),e}},Qs=class extends P{static{this.fourcc="dvh1"}},Zs=class extends P{static{this.fourcc="dvhe"}},Js=class extends P{getCodec(){let e=super.getCodec();if(this.vvcC){e+="."+this.vvcC.general_profile_idc,this.vvcC.general_tier_flag?e+=".H":e+=".L",e+=this.vvcC.general_level_idc;let t="";if(this.vvcC.general_constraint_info){let i=[],s=0;s|=this.vvcC.ptl_frame_only_constraint_flag<<7,s|=this.vvcC.ptl_multilayer_enabled_flag<<6;let n;for(let r=0;r<this.vvcC.general_constraint_info.length;++r)s|=this.vvcC.general_constraint_info[r]>>2&63,i.push(s),s&&(n=r),s=this.vvcC.general_constraint_info[r]>>2&3;if(n===void 0)t=".CA";else{t=".C";let r="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",a=0,o=0;for(let c=0;c<=n;++c)for(a=a<<8|i[c],o+=8;o>=5;){let h=a>>o-5&31;t+=r[h],o-=5,a&=(1<<o)-1}o&&(a<<=5-o,t+=r[a&31])}}e+=t}return e}},en=class extends Js{constructor(...e){super(...e),this.box_name="VvcSampleEntry"}static{this.fourcc="vvc1"}},tn=class extends Js{constructor(...e){super(...e),this.box_name="VvcSampleEntry"}static{this.fourcc="vvi1"}},sn=class extends P{constructor(...e){super(...e),this.box_name="VvcSampleEntry"}static{this.fourcc="vvs1"}},nn=class extends P{constructor(...e){super(...e),this.box_name="VvcNonVCLSampleEntry"}static{this.fourcc="vvcN"}},rn=class extends P{getCodec(){let e=super.getCodec(),t=this.vpcC.level;t===0&&(t="00");let i=this.vpcC.bitDepth;return i===8&&(i="08"),`${e}.0${this.vpcC.profile}.${t}.${i}`}},an=class extends rn{static{this.fourcc="vp08"}},on=class extends rn{static{this.fourcc="vp09"}},cn=class extends P{static{this.fourcc="avs3"}},ln=class extends P{constructor(...e){super(...e),this.box_name="J2KSampleEntry"}static{this.fourcc="j2ki"}},hn=class extends P{static{this.fourcc="mjp2"}},un=class extends P{static{this.fourcc="mjpg"}},dn=class extends P{constructor(...e){super(...e),this.box_name="UncompressedVideoSampleEntry"}static{this.fourcc="uncv"}},fn=class extends P{constructor(...e){super(...e),this.box_name="MP4VisualSampleEntry"}static{this.fourcc="mp4v"}},qt=class extends K{constructor(...e){super(...e),this.box_name="MP4AudioSampleEntry"}static{this.fourcc="mp4a"}getCodec(){let e=super.getCodec(),t=this.esds??this.wave?.esds;if(t&&t.esd){let i=t.esd.getOTI(),s=t.esd.getAudioConfig();return e+"."+Ce(i)+(s?"."+s:"")}else return e}},pn=class extends K{static{this.fourcc="m4ae"}},_n=class extends K{static{this.fourcc="ac-3"}},mn=class extends K{static{this.fourcc="ac-4"}},xn=class extends K{static{this.fourcc="ec-3"}},gn=class extends K{static{this.fourcc="Opus"}},bn=class extends K{static{this.fourcc="mha1"}},yn=class extends K{static{this.fourcc="mha2"}},vn=class extends K{static{this.fourcc="mhm1"}},wn=class extends K{static{this.fourcc="mhm2"}},Sn=class extends K{static{this.fourcc="fLaC"}},Bn=class extends P{static{this.fourcc="encv"}},Un=class extends K{static{this.fourcc="enca"}},kn=class extends _e{constructor(...e){super(...e),this.subBoxNames=["sinf"],this.sinfs=[]}static{this.fourcc="encu"}},En=class extends rt{constructor(...e){super(...e),this.subBoxNames=["sinf"],this.sinfs=[]}static{this.fourcc="encs"}},Tn=class extends rt{static{this.fourcc="mp4s"}},Cn=class extends Ki{constructor(...e){super(...e),this.subBoxNames=["sinf"],this.sinfs=[]}static{this.fourcc="enct"}},zn=class extends ve{constructor(...e){super(...e),this.subBoxNames=["sinf"],this.sinfs=[]}static{this.fourcc="encm"}},In=class extends P{constructor(...e){super(...e),this.box_name="RestrictedVideoSampleEntry"}static{this.fourcc="resv"}},Pn=class extends _e{static{this.fourcc="sbtt"}parse(e){this.parseHeader(e),this.content_encoding=e.readCString(),this.mime_format=e.readCString(),this.parseFooter(e)}},Wt=class extends _e{static{this.fourcc="stpp"}parse(e){this.parseHeader(e),this.namespace=e.readCString(),this.schema_location=e.readCString(),this.auxiliary_mime_types=e.readCString(),this.parseFooter(e)}write(e){this.writeHeader(e),this.size+=this.namespace.length+1+this.schema_location.length+1+this.auxiliary_mime_types.length+1,e.writeCString(this.namespace),e.writeCString(this.schema_location),e.writeCString(this.auxiliary_mime_types),this.writeFooter(e)}},An=class extends _e{static{this.fourcc="stxt"}parse(e){this.parseHeader(e),this.content_encoding=e.readCString(),this.mime_format=e.readCString(),this.parseFooter(e)}getCodec(){let e=super.getCodec();return this.mime_format?e+"."+this.mime_format:e}},Fn=class extends _e{static{this.fourcc="tx3g"}parse(e){this.parseHeader(e),this.displayFlags=e.readUint32(),this.horizontal_justification=e.readInt8(),this.vertical_justification=e.readInt8(),this.bg_color_rgba=e.readUint8Array(4),this.box_record=e.readInt16Array(4),this.style_record=e.readUint8Array(12),this.parseFooter(e)}},Ln=class extends ve{static{this.fourcc="wvtt"}parse(e){this.parseHeader(e),this.parseFooter(e)}},Dn=class extends f{constructor(...e){super(...e),this.box_name="SampleToGroupBox"}static{this.fourcc="sbgp"}parse(e){this.parseFullHeader(e),this.grouping_type=e.readString(4),this.version===1?this.grouping_type_parameter=e.readUint32():this.grouping_type_parameter=0,this.entries=[];let t=e.readUint32();for(let i=0;i<t;i++)this.entries.push({sample_count:e.readInt32(),group_description_index:e.readInt32()})}write(e){this.grouping_type_parameter?this.version=1:this.version=0,this.flags=0,this.size=8+8*this.entries.length+(this.version===1?4:0),this.writeHeader(e),e.writeString(this.grouping_type,void 0,4),this.version===1&&e.writeUint32(this.grouping_type_parameter),e.writeUint32(this.entries.length);for(let t=0;t<this.entries.length;t++){let i=this.entries[t];e.writeInt32(i.sample_count),e.writeInt32(i.group_description_index)}}},Mn=class extends f{constructor(...e){super(...e),this.box_name="SampleDependencyTypeBox"}static{this.fourcc="sdtp"}parse(e){this.parseFullHeader(e);let t=this.size-this.hdr_size;this.is_leading=[],this.sample_depends_on=[],this.sample_is_depended_on=[],this.sample_has_redundancy=[];for(let i=0;i<t;i++){let s=e.readUint8();this.is_leading[i]=s>>6,this.sample_depends_on[i]=s>>4&3,this.sample_is_depended_on[i]=s>>2&3,this.sample_has_redundancy[i]=s&3}}},Rn=class extends f{constructor(...e){super(...e),this.box_name="SampleGroupDescriptionBox"}static{this.fourcc="sgpd"}parse(e){this.parseFullHeader(e),this.grouping_type=e.readString(4),u.debug("BoxParser","Found Sample Groups of type "+this.grouping_type),this.version===1?this.default_length=e.readUint32():this.default_length=0,this.version>=2&&(this.default_group_description_index=e.readUint32()),this.entries=[];let t=e.readUint32();for(let i=0;i<t;i++){let s;this.grouping_type in X.sampleGroupEntry?s=new X.sampleGroupEntry[this.grouping_type](this.grouping_type):s=new D(this.grouping_type),this.entries.push(s),this.version===1?this.default_length===0?s.description_length=e.readUint32():s.description_length=this.default_length:s.description_length=this.default_length,s.write===D.prototype.write&&(u.info("BoxParser","SampleGroup for type "+this.grouping_type+" writing not yet implemented, keeping unparsed data in memory for later write"),s.data=e.readUint8Array(s.description_length),e.seek(e.getPosition()-s.description_length)),s.parse(e)}}write(e){this.flags=0,this.size=12;for(let t=0;t<this.entries.length;t++){let i=this.entries[t];this.version===1&&(this.default_length===0&&(this.size+=4),this.size+=i.data.length)}this.writeHeader(e),e.writeString(this.grouping_type,void 0,4),this.version===1&&e.writeUint32(this.default_length),this.version>=2&&e.writeUint32(this.default_sample_description_index),e.writeUint32(this.entries.length);for(let t=0;t<this.entries.length;t++){let i=this.entries[t];this.version===1&&this.default_length===0&&e.writeUint32(i.description_length),i.write(e)}}},On=class extends f{constructor(...e){super(...e),this.box_name="CompressedSegmentIndexBox"}static{this.fourcc="sidx"}parse(e){this.parseFullHeader(e),this.reference_ID=e.readUint32(),this.timescale=e.readUint32(),this.version===0?(this.earliest_presentation_time=e.readUint32(),this.first_offset=e.readUint32()):(this.earliest_presentation_time=e.readUint64(),this.first_offset=e.readUint64()),e.readUint16(),this.references=[];let t=e.readUint16();for(let i=0;i<t;i++){let s=e.readUint32(),n=e.readUint32(),r=e.readUint32();this.references.push({reference_type:s>>31&1,referenced_size:s&2147483647,subsegment_duration:n,starts_with_SAP:r>>31&1,SAP_type:r>>28&7,SAP_delta_time:r&268435455})}}write(e){let t=this.earliest_presentation_time>M||this.first_offset>M||this.version===1;this.version=t?1:0,this.size=12+12*this.references.length,this.size+=t?16:8,this.flags=0,this.writeHeader(e),e.writeUint32(this.reference_ID),e.writeUint32(this.timescale),t?(e.writeUint64(this.earliest_presentation_time),e.writeUint64(this.first_offset)):(e.writeUint32(this.earliest_presentation_time),e.writeUint32(this.first_offset)),e.writeUint16(0),e.writeUint16(this.references.length);for(let i=0;i<this.references.length;i++){let s=this.references[i];e.writeUint32(s.reference_type<<31|s.referenced_size),e.writeUint32(s.subsegment_duration),e.writeUint32(s.starts_with_SAP<<31|s.SAP_type<<28|s.SAP_delta_time)}}},Kt=class extends f{constructor(...e){super(...e),this.box_name="SoundMediaHeaderBox"}static{this.fourcc="smhd"}parse(e){this.parseFullHeader(e),this.balance=e.readUint16(),e.readUint16()}write(e){this.version=0,this.size=4,this.writeHeader(e),e.writeUint16(this.balance),e.writeUint16(0)}},Yt=class extends f{constructor(...e){super(...e),this.box_name="ChunkOffsetBox"}static{this.fourcc="stco"}parse(e){this.parseFullHeader(e);let t=e.readUint32();if(this.chunk_offsets=[],this.version===0)for(let i=0;i<t;i++)this.chunk_offsets.push(e.readUint32())}write(e){this.version=0,this.flags=0,this.size=4+4*this.chunk_offsets.length,this.writeHeader(e),e.writeUint32(this.chunk_offsets.length),e.writeUint32Array(this.chunk_offsets)}unpack(e){for(let t=0;t<this.chunk_offsets.length;t++)e[t].offset=this.chunk_offsets[t]}},Xt=class extends f{constructor(...e){super(...e),this.box_name="SubtitleMediaHeaderBox"}static{this.fourcc="sthd"}},Qt=class extends f{constructor(...e){super(...e),this.box_name="SampleToChunkBox"}static{this.fourcc="stsc"}parse(e){this.parseFullHeader(e);let t=e.readUint32();if(this.first_chunk=[],this.samples_per_chunk=[],this.sample_description_index=[],this.version===0)for(let i=0;i<t;i++)this.first_chunk.push(e.readUint32()),this.samples_per_chunk.push(e.readUint32()),this.sample_description_index.push(e.readUint32())}write(e){this.version=0,this.flags=0,this.size=4+12*this.first_chunk.length,this.writeHeader(e),e.writeUint32(this.first_chunk.length);for(let t=0;t<this.first_chunk.length;t++)e.writeUint32(this.first_chunk[t]),e.writeUint32(this.samples_per_chunk[t]),e.writeUint32(this.sample_description_index[t])}unpack(e){let t=0,i=0;for(let s=0;s<this.first_chunk.length;s++)for(let n=0;n<(s+1<this.first_chunk.length?this.first_chunk[s+1]:1/0);n++){i++;for(let r=0;r<this.samples_per_chunk[s];r++){if(e[t])e[t].description_index=this.sample_description_index[s],e[t].chunk_index=i;else return;t++}}}},Zt=class extends f{constructor(...e){super(...e),this.box_name="SampleDescriptionBox"}static{this.fourcc="stsd"}parse(e){this.parseFullHeader(e),this.entries=[];let t=e.readUint32();for(let i=1;i<=t;i++){let s=ie(e,!0,this.size-(e.getPosition()-this.start));if(s.code===1){let n;s.type in X.sampleEntry?(n=new X.sampleEntry[s.type](s.size),n.hdr_size=s.hdr_size,n.start=s.start):(u.warn("BoxParser",`Unknown sample entry type: '${s.type}'`),n=new ne(s.size,s.hdr_size,s.start),n.type=s.type),n.write===ne.prototype.write&&(u.info("BoxParser","SampleEntry "+n.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),n.parseDataAndRewind(e)),n.parse(e),this.entries.push(n)}else return}}write(e){this.version=0,this.flags=0,this.size=0,this.writeHeader(e),e.writeUint32(this.entries.length),this.size+=4;for(let t=0;t<this.entries.length;t++)this.entries[t].write(e),this.size+=this.entries[t].size;u.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),e.adjustUint32(this.sizePosition,this.size)}},Jt=class extends f{constructor(...e){super(...e),this.box_name="SampleSizeBox"}static{this.fourcc="stsz"}parse(e){if(this.parseFullHeader(e),this.sample_sizes=[],this.version===0){this.sample_size=e.readUint32(),this.sample_count=e.readUint32();for(let t=0;t<this.sample_count;t++)this.sample_size===0?this.sample_sizes.push(e.readUint32()):this.sample_sizes[t]=this.sample_size}}write(e){let t=!0;this.version=0,this.flags=0,this.sample_sizes.length>0&&this.sample_size===0&&(t=!1),this.size=8,t||(this.size+=4*this.sample_sizes.length),this.writeHeader(e),e.writeUint32(this.sample_size),e.writeUint32(this.sample_sizes.length),t||e.writeUint32Array(this.sample_sizes)}unpack(e){for(let t=0;t<this.sample_sizes.length;t++)e[t].size=this.sample_sizes[t]}},ei=class extends f{constructor(...e){super(...e),this.box_name="TimeToSampleBox",this.sample_counts=[],this.sample_deltas=[]}static{this.fourcc="stts"}parse(e){this.parseFullHeader(e);let t=e.readUint32();if(this.sample_counts.length=0,this.sample_deltas.length=0,this.version===0)for(let i=0;i<t;i++){this.sample_counts.push(e.readUint32());let s=e.readInt32();s<0&&(u.warn("BoxParser","File uses negative stts sample delta, using value 1 instead, sync may be lost!"),s=1),this.sample_deltas.push(s)}}write(e){this.version=0,this.flags=0,this.size=4+8*this.sample_counts.length,this.writeHeader(e),e.writeUint32(this.sample_counts.length);for(let t=0;t<this.sample_counts.length;t++)e.writeUint32(this.sample_counts[t]),e.writeUint32(this.sample_deltas[t])}unpack(e){let t=0;for(let i=0;i<this.sample_counts.length;i++)for(let s=0;s<this.sample_counts[i];s++)t===0?e[t].dts=0:e[t].dts=e[t-1].dts+this.sample_deltas[i],t++}},ti=class extends f{constructor(...e){super(...e),this.box_name="TrackFragmentBaseMediaDecodeTimeBox"}static{this.fourcc="tfdt"}parse(e){this.parseFullHeader(e),this.version===1?this.baseMediaDecodeTime=e.readUint64():this.baseMediaDecodeTime=e.readUint32()}write(e){let t=this.baseMediaDecodeTime>M||this.version===1;this.version=t?1:0,this.size=4,this.size+=t?4:0,this.flags=0,this.writeHeader(e),t?e.writeUint64(this.baseMediaDecodeTime):e.writeUint32(this.baseMediaDecodeTime)}},ii=class extends f{constructor(...e){super(...e),this.box_name="TrackFragmentHeaderBox"}static{this.fourcc="tfhd"}parse(e){this.parseFullHeader(e);let t=0;this.track_id=e.readUint32(),this.size-this.hdr_size>t&&this.flags&1?(this.base_data_offset=e.readUint64(),t+=8):this.base_data_offset=0,this.size-this.hdr_size>t&&this.flags&2?(this.default_sample_description_index=e.readUint32(),t+=4):this.default_sample_description_index=0,this.size-this.hdr_size>t&&this.flags&8?(this.default_sample_duration=e.readUint32(),t+=4):this.default_sample_duration=0,this.size-this.hdr_size>t&&this.flags&16?(this.default_sample_size=e.readUint32(),t+=4):this.default_sample_size=0,this.size-this.hdr_size>t&&this.flags&32?(this.default_sample_flags=e.readUint32(),t+=4):this.default_sample_flags=0}write(e){this.version=0,this.size=4,this.flags&1&&(this.size+=8),this.flags&2&&(this.size+=4),this.flags&8&&(this.size+=4),this.flags&16&&(this.size+=4),this.flags&32&&(this.size+=4),this.writeHeader(e),e.writeUint32(this.track_id),this.flags&1&&e.writeUint64(this.base_data_offset),this.flags&2&&e.writeUint32(this.default_sample_description_index),this.flags&8&&e.writeUint32(this.default_sample_duration),this.flags&16&&e.writeUint32(this.default_sample_size),this.flags&32&&e.writeUint32(this.default_sample_flags)}},si=class extends f{constructor(...e){super(...e),this.box_name="TrackHeaderBox",this.layer=0,this.alternate_group=0}static{this.fourcc="tkhd"}parse(e){this.parseFullHeader(e),this.version===1?(this.creation_time=e.readUint64(),this.modification_time=e.readUint64(),this.track_id=e.readUint32(),e.readUint32(),this.duration=e.readUint64()):(this.creation_time=e.readUint32(),this.modification_time=e.readUint32(),this.track_id=e.readUint32(),e.readUint32(),this.duration=e.readUint32()),e.readUint32Array(2),this.layer=e.readInt16(),this.alternate_group=e.readInt16(),this.volume=e.readInt16()>>8,e.readUint16(),this.matrix=e.readInt32Array(9),this.width=e.readUint32(),this.height=e.readUint32()}write(e){let t=this.modification_time>M||this.creation_time>M||this.duration>M||this.version===1;this.version=t?1:0,this.size=80,this.size+=t?12:0,this.flags=this.flags??3,this.writeHeader(e),t?(e.writeUint64(this.creation_time),e.writeUint64(this.modification_time),e.writeUint32(this.track_id),e.writeUint32(0),e.writeUint64(this.duration)):(e.writeUint32(this.creation_time),e.writeUint32(this.modification_time),e.writeUint32(this.track_id),e.writeUint32(0),e.writeUint32(this.duration)),e.writeUint32Array([0,0]),e.writeInt16(this.layer),e.writeInt16(this.alternate_group),e.writeInt16(this.volume<<8),e.writeInt16(0),e.writeInt32Array(this.matrix),e.writeUint32(this.width),e.writeUint32(this.height)}print(e){super.printHeader(e),e.log(e.indent+"creation_time: "+this.creation_time),e.log(e.indent+"modification_time: "+this.modification_time),e.log(e.indent+"track_id: "+this.track_id),e.log(e.indent+"duration: "+this.duration),e.log(e.indent+"volume: "+(this.volume>>8)),e.log(e.indent+"matrix: "+this.matrix.join(", ")),e.log(e.indent+"layer: "+this.layer),e.log(e.indent+"alternate_group: "+this.alternate_group),e.log(e.indent+"width: "+this.width),e.log(e.indent+"height: "+this.height)}},nt=class extends f{constructor(...e){super(...e),this.box_name="TrackExtendsBox"}static{this.fourcc="trex"}parse(e){this.parseFullHeader(e),this.track_id=e.readUint32(),this.default_sample_description_index=e.readUint32(),this.default_sample_duration=e.readUint32(),this.default_sample_size=e.readUint32(),this.default_sample_flags=e.readUint32()}write(e){this.version=0,this.flags=0,this.size=20,this.writeHeader(e),e.writeUint32(this.track_id),e.writeUint32(this.default_sample_description_index),e.writeUint32(this.default_sample_duration),e.writeUint32(this.default_sample_size),e.writeUint32(this.default_sample_flags)}},ni=class extends f{constructor(...e){super(...e),this.box_name="TrackRunBox",this.sample_duration=[],this.sample_size=[],this.sample_flags=[],this.sample_composition_time_offset=[]}static{this.fourcc="trun"}parse(e){this.parseFullHeader(e);let t=0;if(this.sample_count=e.readUint32(),t+=4,this.size-this.hdr_size>t&&this.flags&1?(this.data_offset=e.readInt32(),t+=4):this.data_offset=0,this.size-this.hdr_size>t&&this.flags&4?(this.first_sample_flags=e.readUint32(),t+=4):this.first_sample_flags=0,this.sample_duration=[],this.sample_size=[],this.sample_flags=[],this.sample_composition_time_offset=[],this.size-this.hdr_size>t)for(let i=0;i<this.sample_count;i++)this.flags&256&&(this.sample_duration[i]=e.readUint32()),this.flags&512&&(this.sample_size[i]=e.readUint32()),this.flags&1024&&(this.sample_flags[i]=e.readUint32()),this.flags&2048&&(this.version===0?this.sample_composition_time_offset[i]=e.readUint32():this.sample_composition_time_offset[i]=e.readInt32())}write(e){this.size=4,this.flags&1&&(this.size+=4),this.flags&4&&(this.size+=4),this.flags&256&&(this.size+=4*this.sample_duration.length),this.flags&512&&(this.size+=4*this.sample_size.length),this.flags&1024&&(this.size+=4*this.sample_flags.length),this.flags&2048&&(this.size+=4*this.sample_composition_time_offset.length),this.writeHeader(e),e.writeUint32(this.sample_count),this.flags&1&&(this.data_offset_position=e.getPosition(),e.writeInt32(this.data_offset)),this.flags&4&&e.writeUint32(this.first_sample_flags);for(let t=0;t<this.sample_count;t++)this.flags&256&&e.writeUint32(this.sample_duration[t]),this.flags&512&&e.writeUint32(this.sample_size[t]),this.flags&1024&&e.writeUint32(this.sample_flags[t]),this.flags&2048&&(this.version===0?e.writeUint32(this.sample_composition_time_offset[t]):e.writeInt32(this.sample_composition_time_offset[t]))}},ri=class extends f{constructor(...e){super(...e),this.box_name="DataEntryUrlBox"}static{this.fourcc="url "}parse(e){this.parseFullHeader(e),this.flags!==1&&(this.location=e.readCString())}write(e){this.version=0,this.location?(this.flags=0,this.size=this.location.length+1):(this.flags=1,this.size=0),this.writeHeader(e),this.location&&e.writeCString(this.location)}},ai=class extends f{constructor(...e){super(...e),this.box_name="VideoMediaHeaderBox"}static{this.fourcc="vmhd"}parse(e){this.parseFullHeader(e),this.graphicsmode=e.readUint16(),this.opcolor=e.readUint16Array(3)}write(e){this.version=0,this.size=8,this.writeHeader(e),e.writeUint16(this.graphicsmode),e.writeUint16Array(this.opcolor)}},et=class{constructor(e,t,i){this.grouping_type=e,this.grouping_type_parameter=t,this.sbgp=i,this.last_sample_in_run=-1,this.entry_index=-1}},Nn=class se{constructor(t,i=!0){this.boxes=[],this.mdats=[],this.moofs=[],this.isProgressive=!1,this.moovStartFound=!1,this.moovStartSent=!1,this.readySent=!1,this.sampleListBuilt=!1,this.fragmentedTracks=[],this.extractedTracks=[],this.isFragmentationInitialized=!1,this.sampleProcessingStarted=!1,this.nextMoofNumber=0,this.itemListBuilt=!1,this.sidxSent=!1,this.items=[],this.entity_groups=[],this.itemsDataSize=0,this.lastMoofIndex=0,this.samplesDataSize=0,this.lastBoxStartPosition=0,this.nextParsePosition=0,this.discardMdatData=!0,this.discardMdatData=i,t?(this.stream=t,this.parse()):this.stream=new De,this.stream.isofile=this}setSegmentOptions(t,i,s){let{sizePerSegment:n=Number.MAX_SAFE_INTEGER,rapAlignement:r=!0,normalizeAudioSampleEntriesForMSE:a=!0}=s,o=s.nbSamples??s.nbSamplesPerFragment??1e3,c=s.nbSamplesPerFragment??o;if(o<=0||c<=0||n<=0){u.error("ISOFile",`Invalid segment options: nbSamples=${o}, nbSamplesPerFragment=${c}, sizePerSegment=${n}`);return}if(o<c&&(u.warn("ISOFile",`nbSamples (${o}) is less than nbSamplesPerFragment (${c}), setting nbSamples to nbSamplesPerFragment`),o=c),this.fragmentedTracks.some(d=>d.nb_samples!==o)){u.error("ISOFile",`Cannot set segment options for track ${t}: nbSamples (${o}) does not match existing tracks`);return}let h=this.getTrackById(t);if(h){let d={id:t,user:i,trak:h,segmentStream:void 0,nb_samples:o,nb_samples_per_fragment:c,size_per_segment:n,rapAlignement:r,normalizeAudioSampleEntriesForMSE:a,state:{lastFragmentSampleNumber:0,lastSegmentSampleNumber:0,accumulatedSize:0}};this.fragmentedTracks.push(d),h.nextSample=0}this.discardMdatData&&u.warn("ISOFile","Segmentation options set but discardMdatData is true, samples will not be segmented")}unsetSegmentOptions(t){let i=-1;for(let s=0;s<this.fragmentedTracks.length;s++)this.fragmentedTracks[s].id===t&&(i=s);i>-1&&this.fragmentedTracks.splice(i,1)}setExtractionOptions(t,i,{nbSamples:s=1e3}={}){let n=this.getTrackById(t);n&&(this.extractedTracks.push({id:t,user:i,trak:n,nb_samples:s,samples:[]}),n.nextSample=0),this.discardMdatData&&u.warn("ISOFile","Extraction options set but discardMdatData is true, samples will not be extracted")}unsetExtractionOptions(t){let i=-1;for(let s=0;s<this.extractedTracks.length;s++)this.extractedTracks[s].id===t&&(i=s);i>-1&&this.extractedTracks.splice(i,1)}parse(){if(!(this.restoreParsePosition&&!this.restoreParsePosition()))for(;;)if(this.hasIncompleteMdat&&this.hasIncompleteMdat()){if(this.processIncompleteMdat())continue;return}else{this.saveParsePosition&&this.saveParsePosition();let i=ie(this.stream,!1);if(i.code===0)if(this.processIncompleteBox){if(this.processIncompleteBox(i))continue;return}else return;else if(i.code===1){let s=i.box;if(this.boxes.push(s),s.type==="uuid")this[s.uuid]!==void 0&&u.warn("ISOFile","Duplicate Box of uuid: "+s.uuid+", overriding previous occurrence"),this[s.uuid]=s;else switch(s.type){case"mdat":this.mdats.push(s),this.transferMdatData(s);break;case"moof":this.moofs.push(s);break;case"free":case"skip":break;case"moov":this.moovStartFound=!0,this.mdats.length===0&&(this.isProgressive=!0);default:this[s.type]!==void 0?Array.isArray(this[s.type+"s"])?(u.info("ISOFile",`Found multiple boxes of type ${s.type} in ISOFile, adding to array`),this[s.type+"s"].push(s)):(u.warn("ISOFile",`Found multiple boxes of type ${s.type} but no array exists. Creating array dynamically.`),this[s.type+"s"]=[this[s.type],s]):(this[s.type]=s,Array.isArray(this[s.type+"s"])&&this[s.type+"s"].push(s));break}this.updateUsedBytes&&this.updateUsedBytes(s,i)}else if(i.code===-1){u.error("ISOFile",`Invalid data found while parsing box of type '${i.type}' at position ${i.start}. Aborting parsing.`,this);break}}}checkBuffer(t){if(!t)throw new Error("Buffer must be defined and non empty");return t.byteLength===0?(u.warn("ISOFile","Ignoring empty buffer (fileStart: "+t.fileStart+")"),this.stream.logBufferLevel(),!1):(u.info("ISOFile","Processing buffer (fileStart: "+t.fileStart+")"),t.usedBytes=0,this.stream.insertBuffer(t),this.stream.logBufferLevel(),this.stream.initialized()?!0:(u.warn("ISOFile","Not ready to start parsing"),!1))}appendBuffer(t,i){let s;if(this.checkBuffer(t))return this.parse(),this.moovStartFound&&!this.moovStartSent&&(this.moovStartSent=!0,this.onMoovStart&&this.onMoovStart()),this.moov?(this.sampleListBuilt||(this.buildSampleLists(),this.sampleListBuilt=!0),this.updateSampleLists(),this.onReady&&!this.readySent&&(this.readySent=!0,this.onReady(this.getInfo())),this.processSamples(i),this.nextSeekPosition?(s=this.nextSeekPosition,this.nextSeekPosition=void 0):s=this.nextParsePosition,this.stream.getEndFilePositionAfter&&(s=this.stream.getEndFilePositionAfter(s))):this.nextParsePosition?s=this.nextParsePosition:s=0,this.sidx&&this.onSidx&&!this.sidxSent&&(this.onSidx(this.sidx),this.sidxSent=!0),this.meta&&(this.flattenItemInfo&&!this.itemListBuilt&&(this.flattenItemInfo(),this.itemListBuilt=!0),this.processItems&&this.processItems(this.onItem)),this.stream.cleanBuffers&&(u.info("ISOFile","Done processing buffer (fileStart: "+t.fileStart+") - next buffer to fetch should have a fileStart position of "+s),this.stream.logBufferLevel(),this.stream.cleanBuffers(),this.stream.logBufferLevel(!0),u.info("ISOFile","Sample data size in memory: "+this.getAllocatedSampleDataSize())),s}getFragmentDuration(){let t=this.getBox("mvex");if(!t)return;if(t.mehd)return{num:t.mehd.fragment_duration,den:this.moov.mvhd.timescale};let i=this.getBoxes("trak",!1),s={num:0,den:1};for(let n of i){let r=n.samples_duration,a=n.mdia.mdhd.timescale;r&&a&&r/a>s.num/s.den&&(s={num:r,den:a})}return s}getInfo(){if(!this.moov)return{hasMoov:!1,mime:""};let t=new Date("1904-01-01T00:00:00Z").getTime(),i=this.getBox("mvex")!==void 0,s={hasMoov:!0,duration:this.moov.mvhd.duration,timescale:this.moov.mvhd.timescale,isFragmented:i,fragment_duration:this.getFragmentDuration(),isProgressive:this.isProgressive,hasIOD:this.moov.iods!==void 0,brands:[this.ftyp.major_brand].concat(this.ftyp.compatible_brands),created:new Date(t+this.moov.mvhd.creation_time*1e3),modified:new Date(t+this.moov.mvhd.modification_time*1e3),tracks:[],audioTracks:[],videoTracks:[],subtitleTracks:[],metadataTracks:[],hintTracks:[],otherTracks:[],mime:""};for(let n=0;n<this.moov.traks.length;n++){let r=this.moov.traks[n],a=r.mdia.minf.stbl.stsd.entries[0],o=r.samples_size,c=r.mdia.mdhd.timescale,h=r.samples_duration,d={samples_duration:h,bitrate:o*8*c/h,size:o,timescale:c,alternate_group:r.tkhd.alternate_group,codec:a.getCodec(),created:new Date(t+r.tkhd.creation_time*1e3),cts_shift:r.mdia.minf.stbl.cslg,duration:r.mdia.mdhd.duration,id:r.tkhd.track_id,kind:r.udta&&r.udta.kinds.length?r.udta.kinds[0]:{schemeURI:"",value:""},language:r.mdia.elng?r.mdia.elng.extended_language:r.mdia.mdhd.languageString,layer:r.tkhd.layer,matrix:r.tkhd.matrix,modified:new Date(t+r.tkhd.modification_time*1e3),movie_duration:r.tkhd.duration,movie_timescale:s.timescale,name:r.mdia.hdlr.name,nb_samples:r.samples.length,references:[],track_height:r.tkhd.height/65536,track_width:r.tkhd.width/65536,volume:r.tkhd.volume};if(s.tracks.push(d),r.tref)for(let p=0;p<r.tref.references.length;p++)d.references.push({type:r.tref.references[p].type,track_ids:r.tref.references[p].track_ids});r.edts!==void 0&&r.edts.elst!==void 0&&(d.edits=r.edts.elst.entries),a instanceof K?(d.type="audio",s.audioTracks.push(d),d.audio={sample_rate:a.getSampleRate(),channel_count:a.getChannelCount(),sample_size:a.getSampleSize()}):a instanceof P?(d.type="video",s.videoTracks.push(d),d.video={width:a.getWidth(),height:a.getHeight()}):a instanceof _e?(d.type="subtitles",s.subtitleTracks.push(d)):a instanceof Ut?(d.type="metadata",s.hintTracks.push(d)):a instanceof ve?(d.type="metadata",s.metadataTracks.push(d)):(d.type="metadata",s.otherTracks.push(d))}s.videoTracks&&s.videoTracks.length>0?s.mime+='video/mp4; codecs="':s.audioTracks&&s.audioTracks.length>0?s.mime+='audio/mp4; codecs="':s.mime+='application/mp4; codecs="';for(let n=0;n<s.tracks.length;n++)n!==0&&(s.mime+=","),s.mime+=s.tracks[n].codec;return s.mime+='"; profiles="',s.mime+=this.ftyp.compatible_brands.join(),s.mime+='"',s}setNextSeekPositionFromSample(t){t&&(this.nextSeekPosition?this.nextSeekPosition=Math.min(t.offset+t.alreadyRead,this.nextSeekPosition):this.nextSeekPosition=t.offset+t.alreadyRead)}processSamples(t){if(this.sampleProcessingStarted){if(this.isFragmentationInitialized&&this.onSegment!==void 0){let i=new Set;for(;i.size<this.fragmentedTracks.length&&this.fragmentedTracks.some(s=>s.trak.nextSample<s.trak.samples.length)&&this.sampleProcessingStarted;)for(let s of this.fragmentedTracks){let n=s.trak;if(!i.has(s.id)){let r=n.nextSample<n.samples.length?this.getSample(n,n.nextSample):void 0;if(!r){this.setNextSeekPositionFromSample(n.samples[n.nextSample]),i.add(s.id);continue}s.state.accumulatedSize+=r.size;let a=n.nextSample+1,o=a-s.state.lastFragmentSampleNumber>s.nb_samples_per_fragment,c=a-s.state.lastSegmentSampleNumber>s.nb_samples,h=o||a%s.nb_samples_per_fragment===0,d=c||a%s.nb_samples===0,p=s.state.accumulatedSize>=s.size_per_segment,x=!s.rapAlignement||r.is_sync,b=t||n.nextSample+1>=n.samples.length;if(b&&!x&&u.warn("ISOFile","Flushing track #"+s.id+" at sample #"+n.nextSample+" which is not a RAP, this may lead to playback issues"),h=h&&x,d=d&&x,p=p&&x,h||p||b){o?u.warn("ISOFile","Fragment on track #"+s.id+" is overdue, creating it with samples ["+s.state.lastFragmentSampleNumber+", "+n.nextSample+"]"):u.debug("ISOFile","Creating media fragment on track #"+s.id+" for samples ["+s.state.lastFragmentSampleNumber+", "+n.nextSample+"]");let U=this.createFragment(s.id,s.state.lastFragmentSampleNumber,n.nextSample,s.segmentStream);if(U)s.segmentStream=U,s.state.lastFragmentSampleNumber=n.nextSample+1;else{i.add(s.id);continue}}(d||p||b)&&(c?u.warn("ISOFile","Segment on track #"+s.id+" is overdue, sending it with samples ["+Math.max(0,n.nextSample-s.nb_samples)+", "+(n.nextSample-1)+"]"):u.info("ISOFile","Sending fragmented data on track #"+s.id+" for samples ["+Math.max(0,n.nextSample-s.nb_samples)+", "+(n.nextSample-1)+"]"),u.info("ISOFile","Sample data size in memory: "+this.getAllocatedSampleDataSize()),this.onSegment&&this.onSegment(s.id,s.user,s.segmentStream.buffer,n.nextSample+1,t||n.nextSample+1>=n.samples.length),s.segmentStream=void 0,s.state.accumulatedSize=0,s.state.lastSegmentSampleNumber=n.nextSample+1),n.nextSample++}}}if(this.onSamples!==void 0)for(let i=0;i<this.extractedTracks.length;i++){let s=this.extractedTracks[i],n=s.trak;for(;n.nextSample<n.samples.length&&this.sampleProcessingStarted;){u.debug("ISOFile","Exporting on track #"+s.id+" sample #"+n.nextSample);let r=this.getSample(n,n.nextSample);if(r)n.nextSample++,s.samples.push(r);else{this.setNextSeekPositionFromSample(n.samples[n.nextSample]);break}if((n.nextSample%s.nb_samples===0||n.nextSample>=n.samples.length)&&(u.debug("ISOFile","Sending samples on track #"+s.id+" for sample "+n.nextSample),this.onSamples&&this.onSamples(s.id,s.user,s.samples),s.samples=[],s!==this.extractedTracks[i]))break}}}}getBox(t){let i=this.getBoxes(t,!0);return i.length?i[0]:void 0}getBoxes(t,i){let s=[],n=r=>{r instanceof _&&r.type&&r.type===t&&s.push(r);let a=[];r.boxes&&a.push(...r.boxes),r.entries&&a.push(...r.entries),r.item_infos&&a.push(...r.item_infos),r.references&&a.push(...r.references);for(let o of a){if(s.length&&i)return;n(o)}};return n(this),s}getTrackSamplesInfo(t){let i=this.getTrackById(t);if(i)return i.samples}getTrackSample(t,i){let s=this.getTrackById(t);return this.getSample(s,i)}releaseUsedSamples(t,i){let s=0,n=this.getTrackById(t);n.lastValidSample||(n.lastValidSample=0);for(let r=n.lastValidSample;r<i;r++)s+=this.releaseSample(n,r);u.info("ISOFile","Track #"+t+" released samples up to "+i+" (released size: "+s+", remaining: "+this.samplesDataSize+")"),n.lastValidSample=i}start(){this.sampleProcessingStarted=!0,this.processSamples(!1)}stop(){this.sampleProcessingStarted=!1}flush(){u.info("ISOFile","Flushing remaining samples"),this.updateSampleLists(),this.processSamples(!0),this.stream.cleanBuffers(),this.stream.logBufferLevel(!0)}seekTrack(t,i,s){let n=0,r=0,a;if(s.samples.length===0)return u.info("ISOFile","No sample in track, cannot seek! Using time "+u.getDurationString(0,1)+" and offset: 0"),{offset:0,time:0};for(let c=0;c<s.samples.length;c++){let h=s.samples[c];if(c===0)r=0,a=h.timescale;else if(h.cts>t*h.timescale){r=c-1;break}i&&h.is_sync&&(n=c)}for(i&&(r=n),t=s.samples[r].cts,s.nextSample=r,this.resetFragmentedTrackStateAfterSeek(s,r),this.resetExtractedTrackStateAfterSeek(s);s.samples[r].alreadyRead===s.samples[r].size&&s.samples[r+1];)r++;let o=s.samples[r].offset+s.samples[r].alreadyRead;return u.info("ISOFile","Seeking to "+(i?"RAP":"")+" sample #"+s.nextSample+" on track "+s.tkhd.track_id+", time "+u.getDurationString(t,a)+" and offset: "+o),{offset:o,time:t/a}}resetFragmentedTrackStateAfterSeek(t,i){let s=this.fragmentedTracks.find(n=>n.trak===t);s&&(s.state.lastFragmentSampleNumber=i,s.state.lastSegmentSampleNumber=i,s.state.accumulatedSize=0,s.segmentStream=void 0)}resetExtractedTrackStateAfterSeek(t){let i=this.extractedTracks.find(s=>s.trak===t);i&&(i.samples=[])}getTrackDuration(t){if(!t.samples)return 1/0;let i=t.samples[t.samples.length-1];return(i.cts+i.duration)/i.timescale}seek(t,i){let s=this.moov,n={offset:1/0,time:1/0};if(this.moov){for(let r=0;r<s.traks.length;r++){let a=s.traks[r];if(t>this.getTrackDuration(a))continue;let o=this.seekTrack(t,i,a);o.offset<n.offset&&(n.offset=o.offset),o.time<n.time&&(n.time=o.time)}return u.info("ISOFile","Seeking at time "+u.getDurationString(n.time,1)+" needs a buffer with a fileStart position of "+n.offset),n.offset===1/0?n={offset:this.nextParsePosition,time:0}:n.offset=this.stream.getEndFilePositionAfter(n.offset),u.info("ISOFile","Adjusted seek position (after checking data already in buffer): "+n.offset),n}else throw new Error("Cannot seek: moov not received!")}equal(t){let i=0;for(;i<this.boxes.length&&i<t.boxes.length;){let s=this.boxes[i],n=t.boxes[i];if(!kt(s,n))return!1;i++}return!0}write(t){for(let i=0;i<this.boxes.length;i++)this.boxes[i].write(t)}createFragment(t,i,s,n){if(s<i)return u.warn("ISOFile",`Skipping fragment creation on track #${t}: invalid sample range [${i}, ${s}]`),n||new G;let r=[];for(let d=i;d<=s;d++){let p=this.getTrackById(t),x=this.getSample(p,d);if(!x){this.setNextSeekPositionFromSample(p.samples[d]);return}r.push(x)}let a=n||new G,o=this.createMoof(r);o.write(a),o.trafs[0].truns[0].data_offset=o.size+8,u.debug("MP4Box","Adjusting data_offset with new value "+o.trafs[0].truns[0].data_offset),a.adjustUint32(o.trafs[0].truns[0].data_offset_position,o.trafs[0].truns[0].data_offset);let c=new Me;c.stream=new De;let h=0;for(let d of r)if(d.data){let p=ue.fromArrayBuffer(d.data.buffer,h);c.stream.insertBuffer(p),h+=d.data.byteLength}return c.write(a),a}static writeInitializationSegment(t,i,s,n){u.debug("ISOFile","Generating initialization segment");let r=new G;t.write(r);let a=se.normalizeAudioSampleEntriesForMSEFragmentedInit(i.traks,n);try{let o=i.addBox(new st);if(s){let c=o.addBox(new Vt);c.fragment_duration=s}for(let c=0;c<i.traks.length;c++){let h=o.addBox(new nt);h.track_id=i.traks[c].tkhd.track_id,h.default_sample_description_index=1,h.default_sample_duration=i.traks[c].samples[0]?.duration??0,h.default_sample_size=0,h.default_sample_flags=65536}i.write(r)}finally{for(let o=a.length-1;o>=0;o--)a[o]()}return r.buffer}save(t){let i=new G;return i.isofile=this,this.write(i),i.save(t)}getBuffer(){let t=new G;return t.isofile=this,this.write(t),t}static normalizeAudioSampleEntriesForMSEFragmentedInit(t,i){let s=[];for(let n of t)if(i?.has(n.tkhd.track_id))for(let r of n.mdia.minf.stbl.stsd?.entries??[]){if(!(r instanceof qt))continue;let a=r.wave?.esds;if(r.esds||!a)continue;let o=r.esds,c=r.wave,h=r.boxes;s.push(()=>{r.esds=o,r.wave=c,r.boxes=h});let d=Array.isArray(r.boxes)?r.boxes.filter(p=>p?.type!=="wave"&&p?.type!=="esds"):[];r.esds=a,r.boxes=[...d,a],r.wave=void 0}return s}initializeSegmentation(t){if(this.onSegment||u.warn("MP4Box","No segmentation callback set!"),t!==void 0&&t!=="combined"&&t!=="per-track")throw new Error(`Invalid segmentation mode: ${t}`);this.isFragmentationInitialized||(this.isFragmentationInitialized=!0,this.resetTables());let i=[];for(let a of this.fragmentedTracks){let o=this.getTrackById(a.id);if(!o){u.warn("ISOFile",`Track with id ${a.id} not found, skipping fragmentation initialization`);continue}i.push({id:a.id,user:a.user,trak:o})}let s=this.moov?.mvex?.mehd?.fragment_duration,n=new Set(this.fragmentedTracks.filter(a=>a.normalizeAudioSampleEntriesForMSE!==!1).map(a=>a.id));if(t==="per-track")return i.map(({id:a,user:o,trak:c})=>{let h=new Oe;return h.addBox(this.moov.mvhd),h.addBox(c),{id:a,user:o,buffer:se.writeInitializationSegment(this.ftyp,h,s,n)}});let r=new Oe;r.addBox(this.moov.mvhd);for(let a of i)r.addBox(a.trak);return{tracks:i.map(({id:a,user:o})=>({id:a,user:o})),buffer:se.writeInitializationSegment(this.ftyp,r,s,n)}}resetTables(){this.initial_duration=this.moov.mvhd.duration,this.moov.mvhd.duration=0;for(let t=0;t<this.moov.traks.length;t++){let i=this.moov.traks[t];i.tkhd.duration=0,i.mdia.mdhd.duration=0;let s=i.mdia.minf.stbl.stco||i.mdia.minf.stbl.co64;s.chunk_offsets=[];let n=i.mdia.minf.stbl.stsc;n.first_chunk=[],n.samples_per_chunk=[],n.sample_description_index=[];let r=i.mdia.minf.stbl.stsz||i.mdia.minf.stbl.stz2;r.sample_sizes=[];let a=i.mdia.minf.stbl.stts;a.sample_counts=[],a.sample_deltas=[];let o=i.mdia.minf.stbl.ctts;o&&(o.sample_counts=[],o.sample_offsets=[]);let c=i.mdia.minf.stbl.stss,h=i.mdia.minf.stbl.boxes.indexOf(c);h!==-1&&(i.mdia.minf.stbl.boxes[h]=void 0)}}static initSampleGroups(t,i,s,n,r){i&&(i.sample_groups_info=[]),t.sample_groups_info||(t.sample_groups_info=[]);for(let a=0;a<s.length;a++){let o=s[a].grouping_type+"/"+s[a].grouping_type_parameter,c=new et(s[a].grouping_type,s[a].grouping_type_parameter,s[a]);i&&(i.sample_groups_info[o]=c),t.sample_groups_info[o]||(t.sample_groups_info[o]=c);for(let h=0;h<n.length;h++)n[h].grouping_type===s[a].grouping_type&&(c.description=n[h],c.description.used=!0);if(r)for(let h=0;h<r.length;h++)r[h].grouping_type===s[a].grouping_type&&(c.fragment_description=r[h],c.fragment_description.used=!0,c.is_fragment=!0)}if(i){if(r){for(let a=0;a<r.length;a++)if(!r[a].used&&r[a].version>=2){let o=r[a].grouping_type+"/0",c=new et(r[a].grouping_type,0);c.is_fragment=!0,i.sample_groups_info[o]||(i.sample_groups_info[o]=c)}}}else for(let a=0;a<n.length;a++)if(!n[a].used&&n[a].version>=2){let o=n[a].grouping_type+"/0",c=new et(n[a].grouping_type,0);t.sample_groups_info[o]||(t.sample_groups_info[o]=c)}}static setSampleGroupProperties(t,i,s,n){i.sample_groups=[];for(let r in n)if(i.sample_groups[r]={grouping_type:n[r].grouping_type,grouping_type_parameter:n[r].grouping_type_parameter},s>=n[r].last_sample_in_run&&(n[r].last_sample_in_run<0&&(n[r].last_sample_in_run=0),n[r].entry_index++,n[r].entry_index<=n[r].sbgp.entries.length-1&&(n[r].last_sample_in_run+=n[r].sbgp.entries[n[r].entry_index].sample_count)),n[r].entry_index<=n[r].sbgp.entries.length-1?i.sample_groups[r].group_description_index=n[r].sbgp.entries[n[r].entry_index].group_description_index:i.sample_groups[r].group_description_index=-1,i.sample_groups[r].group_description_index!==0){let a;if(n[r].fragment_description?a=n[r].fragment_description:a=n[r].description,i.sample_groups[r].group_description_index>0){let o;i.sample_groups[r].group_description_index>65535?o=(i.sample_groups[r].group_description_index>>16)-1:o=i.sample_groups[r].group_description_index-1,a&&o>=0&&(i.sample_groups[r].description=a.entries[o])}else a&&a.version>=2&&a.default_group_description_index>0&&(i.sample_groups[r].description=a.entries[a.default_group_description_index-1])}}static process_sdtp(t,i,s){i&&(t?(i.is_leading=t.is_leading[s],i.depends_on=t.sample_depends_on[s],i.is_depended_on=t.sample_is_depended_on[s],i.has_redundancy=t.sample_has_redundancy[s]):(i.is_leading=0,i.depends_on=0,i.is_depended_on=0,i.has_redundancy=0))}buildSampleLists(){for(let t=0;t<this.moov.traks.length;t++)this.buildTrakSampleLists(this.moov.traks[t])}buildTrakSampleLists(t){let i,s,n,r,a,o;t.samples=[],t.samples_duration=0,t.samples_size=0;let c=t.mdia.minf.stbl.stco||t.mdia.minf.stbl.co64,h=t.mdia.minf.stbl.stsc,d=t.mdia.minf.stbl.stsz||t.mdia.minf.stbl.stz2,p=t.mdia.minf.stbl.stts,x=t.mdia.minf.stbl.ctts,b=t.mdia.minf.stbl.stss,U=t.mdia.minf.stbl.stsd,v=t.mdia.minf.stbl.subs,z=t.mdia.minf.stbl.stdp,N=t.mdia.minf.stbl.sbgps,Q=t.mdia.minf.stbl.sgpds,F=-1,I=-1,Y=-1,xe=-1,ge=0,H=0,$=0;if(se.initSampleGroups(t,void 0,N,Q),!(typeof d>"u")){for(i=0;i<d.sample_sizes.length;i++){let S={number:i,track_id:t.tkhd.track_id,timescale:t.mdia.mdhd.timescale,alreadyRead:0,size:d.sample_sizes[i]};t.samples[i]=S,t.samples_size+=S.size,i===0?(n=1,s=0,S.chunk_index=n,S.chunk_run_index=s,o=h.samples_per_chunk[s],a=0,s+1<h.first_chunk.length?r=h.first_chunk[s+1]-1:r=1/0):i<o?(S.chunk_index=n,S.chunk_run_index=s):(n++,S.chunk_index=n,a=0,n<=r||(s++,s+1<h.first_chunk.length?r=h.first_chunk[s+1]-1:r=1/0),S.chunk_run_index=s,o+=h.samples_per_chunk[s]),S.description_index=h.sample_description_index[S.chunk_run_index]-1,S.description=U.entries[S.description_index],S.offset=c.chunk_offsets[S.chunk_index-1]+a,a+=S.size,i>F&&(I++,F<0&&(F=0),F+=p.sample_counts[I]),i>0?(t.samples[i-1].duration=p.sample_deltas[I],t.samples_duration+=t.samples[i-1].duration,S.dts=t.samples[i-1].dts+t.samples[i-1].duration):S.dts=0,x?(i>=Y&&(xe++,Y<0&&(Y=0),Y+=x.sample_counts[xe]),S.cts=t.samples[i].dts+x.sample_offsets[xe]):S.cts=S.dts,b?(i===b.sample_numbers[ge]-1?(S.is_sync=!0,ge++):(S.is_sync=!1,S.degradation_priority=0),v&&v.entries[H].sample_delta+$===i+1&&(S.subsamples=v.entries[H].subsamples,$+=v.entries[H].sample_delta,H++)):S.is_sync=!0,se.process_sdtp(t.mdia.minf.stbl.sdtp,S,S.number),z?S.degradation_priority=z.priority[i]:S.degradation_priority=0,v&&v.entries[H].sample_delta+$===i&&(S.subsamples=v.entries[H].subsamples,$+=v.entries[H].sample_delta),(N.length>0||Q.length>0)&&se.setSampleGroupProperties(t,S,i,t.sample_groups_info)}i>0&&(t.samples[i-1].duration=Math.max(t.mdia.mdhd.duration-t.samples[i-1].dts,0),t.samples_duration+=t.samples[i-1].duration)}}updateSampleLists(){let t,i,s,n,r;if(this.moov!==void 0)for(;this.lastMoofIndex<this.moofs.length;){let a=this.moofs[this.lastMoofIndex];if(this.lastMoofIndex++,a.type==="moof"){let o=a;for(let c=0;c<o.trafs.length;c++){let h=o.trafs[c],d=this.getTrackById(h.tfhd.track_id),p=this.getTrexById(h.tfhd.track_id);h.tfhd.flags&2?t=h.tfhd.default_sample_description_index:t=p?p.default_sample_description_index:1,h.tfhd.flags&8?i=h.tfhd.default_sample_duration:i=p?p.default_sample_duration:0,h.tfhd.flags&16?s=h.tfhd.default_sample_size:s=p?p.default_sample_size:0,h.tfhd.flags&32?n=h.tfhd.default_sample_flags:n=p?p.default_sample_flags:0,h.sample_number=0,h.sbgps.length>0&&se.initSampleGroups(d,h,h.sbgps,d.mdia.minf.stbl.sgpds,h.sgpds);for(let x=0;x<h.truns.length;x++){let b=h.truns[x];for(let U=0;U<b.sample_count;U++){let v=t-1,z=n;b.flags&1024?z=b.sample_flags[U]:U===0&&b.flags&4&&(z=b.first_sample_flags);let N=s;b.flags&512&&(N=b.sample_size[U]),d.samples_size+=N;let Q=i;b.flags&256&&(Q=b.sample_duration[U]),d.samples_duration+=Q;let F;d.first_traf_merged||U>0?F=d.samples[d.samples.length-1].dts+d.samples[d.samples.length-1].duration:(h.tfdt?F=h.tfdt.baseMediaDecodeTime:F=0,d.first_traf_merged=!0);let I=F;b.flags&2048&&(I=F+b.sample_composition_time_offset[U]);let Y=!!(h.tfhd.flags&1),xe=!!(h.tfhd.flags&131072),ge=!!(b.flags&1),H=0;Y?H=h.tfhd.base_data_offset:xe||x===0?H=o.start:H=r;let $;x===0&&U===0?ge?$=H+b.data_offset:$=H:$=r,r=$+N;let S=h.sample_number;h.sample_number++;let le={cts:I,description_index:v,description:d.mdia.minf.stbl.stsd.entries[v],dts:F,duration:Q,moof_number:this.lastMoofIndex,number_in_traf:S,number:d.samples.length,offset:$,size:N,timescale:d.mdia.mdhd.timescale,track_id:d.tkhd.track_id,is_sync:!(z>>16&1),is_leading:z>>26&3,depends_on:z>>24&3,is_depended_on:z>>22&3,has_redundancy:z>>20&3,degradation_priority:z&65535};h.first_sample_index=d.samples.length,d.samples.push(le),(h.sbgps.length>0||h.sgpds.length>0||d.mdia.minf.stbl.sbgps.length>0||d.mdia.minf.stbl.sgpds.length>0)&&se.setSampleGroupProperties(d,le,le.number_in_traf,h.sample_groups_info)}}if(h.subs){d.has_fragment_subsamples=!0;let x=h.first_sample_index;for(let b=0;b<h.subs.entries.length;b++){x+=h.subs.entries[b].sample_delta;let U=d.samples[x-1];U.subsamples=h.subs.entries[b].subsamples}}}}}}getSample(t,i){let s=t.samples[i];if(this.moov){if(!s.data)s.data=new Uint8Array(s.size),s.alreadyRead=0,this.samplesDataSize+=s.size,u.debug("ISOFile","Allocating sample #"+i+" on track #"+t.tkhd.track_id+" of size "+s.size+" (total: "+this.samplesDataSize+")");else if(s.alreadyRead===s.size)return s;for(;;){let n=this.stream,r=n.findPosition(!0,s.offset+s.alreadyRead,!1),a,o;if(r>-1)a=n.buffers[r],o=a.fileStart;else for(let c of this.mdats){if(!c.stream){u.debug("ISOFile","mdat stream not yet fully read for #"+this.mdats.indexOf(c)+" mdat");continue}if(r=c.stream.findPosition(!0,s.offset+s.alreadyRead-c.start-c.hdr_size,!1),r>-1){n=c.stream,a=c.stream.buffers[r],o=c.start+c.hdr_size+a.fileStart;break}}if(a){let c=a.byteLength-(s.offset+s.alreadyRead-o);if(s.size-s.alreadyRead<=c)return u.debug("ISOFile","Getting sample #"+i+" data (alreadyRead: "+s.alreadyRead+" offset: "+(s.offset+s.alreadyRead-o)+" read size: "+(s.size-s.alreadyRead)+" full size: "+s.size+")"),G.memcpy(s.data.buffer,s.alreadyRead,a,s.offset+s.alreadyRead-o,s.size-s.alreadyRead),a.usedBytes+=s.size-s.alreadyRead,n.logBufferLevel(),s.alreadyRead=s.size,s;if(c===0)return;u.debug("ISOFile","Getting sample #"+i+" partial data (alreadyRead: "+s.alreadyRead+" offset: "+(s.offset+s.alreadyRead-o)+" read size: "+c+" full size: "+s.size+")"),G.memcpy(s.data.buffer,s.alreadyRead,a,s.offset+s.alreadyRead-o,c),s.alreadyRead+=c,a.usedBytes+=c,n.logBufferLevel()}else return}}}releaseSample(t,i){let s=t.samples[i];return s.data?(this.samplesDataSize-=s.size,s.data=void 0,s.alreadyRead=0,s.size):0}getAllocatedSampleDataSize(){return this.samplesDataSize}getCodecs(){let t="";for(let i=0;i<this.moov.traks.length;i++){let s=this.moov.traks[i];i>0&&(t+=","),t+=s.mdia.minf.stbl.stsd.entries[0].getCodec()}return t}getTrexById(t){if(!(!this.moov||!this.moov.mvex))for(let i=0;i<this.moov.mvex.trexs.length;i++){let s=this.moov.mvex.trexs[i];if(s.track_id===t)return s}}getTrackById(t){if(this.moov)for(let i=0;i<this.moov.traks.length;i++){let s=this.moov.traks[i];if(s.tkhd.track_id===t)return s}}flattenItemInfo(){let t=this.items,i=this.entity_groups,s=this.meta;if(!(!s||!s.hdlr||!s.iinf)){for(let n=0;n<s.iinf.item_infos.length;n++){let r=s.iinf.item_infos[n].item_ID;t[r]={id:r,name:s.iinf.item_infos[n].item_name,ref_to:[],content_type:s.iinf.item_infos[n].content_type,content_encoding:s.iinf.item_infos[n].content_encoding,item_uri_type:s.iinf.item_infos[n].item_uri_type,type:s.iinf.item_infos[n].item_type?s.iinf.item_infos[n].item_type:"mime",protection:s.iinf.item_infos[n].item_protection_index>0?s.ipro.protections[s.iinf.item_infos[n].item_protection_index-1]:void 0}}if(s.grpl)for(let n=0;n<s.grpl.boxes.length;n++){let r=s.grpl.boxes[n];i[r.group_id]={id:r.group_id,entity_ids:r.entity_ids,type:r.type}}if(s.iloc)for(let n=0;n<s.iloc.items.length;n++){let r=s.iloc.items[n],a=t[r.item_ID];r.data_reference_index!==0&&(u.warn("Item storage with reference to other files: not supported"),a.source=s.dinf.boxes[r.data_reference_index-1]),a.extents=[],a.size=0;for(let o=0;o<r.extents.length;o++)a.extents[o]={offset:r.extents[o].extent_offset+r.base_offset,length:r.extents[o].extent_length,alreadyRead:0},r.construction_method===1&&(a.extents[o].offset+=s.idat.start+s.idat.hdr_size),a.size+=a.extents[o].length}if(s.pitm){let n=s.pitm.item_id;t[n]?t[n].primary=!0:u.warn("ISOFile","Primary item_id #"+n+" does not exist in items")}if(s.iref)for(let n=0;n<s.iref.references.length;n++){let r=s.iref.references[n];for(let a=0;a<r.references.length;a++)t[r.from_item_ID].ref_to.push({type:r.type,id:r.references[a]})}if(s.iprp)for(let n=0;n<s.iprp.ipmas.length;n++){let r=s.iprp.ipmas[n];for(let a=0;a<r.associations.length;a++){let o=r.associations[a],c=t[o.id]??i[o.id];if(c){c.properties===void 0&&(c.properties={boxes:[]});for(let h=0;h<o.props.length;h++){let d=o.props[h];if(d.property_index>0&&d.property_index-1<s.iprp.ipco.boxes.length){let p=s.iprp.ipco.boxes[d.property_index-1];c.properties[p.type]=p,c.properties.boxes.push(p)}}}}}}}getItem(t){if(!this.meta)return;let i=this.items[t];if(!i.data&&i.size)i.data=new Uint8Array(i.size),i.alreadyRead=0,this.itemsDataSize+=i.size,u.debug("ISOFile","Allocating item #"+t+" of size "+i.size+" (total: "+this.itemsDataSize+")");else if(i.alreadyRead===i.size)return i;for(let s=0;s<i.extents.length;s++){let n=i.extents[s];if(n.alreadyRead!==n.length){let r=this.stream.findPosition(!0,n.offset+n.alreadyRead,!1);if(r>-1){let a=this.stream.buffers[r],o=a.byteLength-(n.offset+n.alreadyRead-a.fileStart);if(n.length-n.alreadyRead<=o)u.debug("ISOFile","Getting item #"+t+" extent #"+s+" data (alreadyRead: "+n.alreadyRead+" offset: "+(n.offset+n.alreadyRead-a.fileStart)+" read size: "+(n.length-n.alreadyRead)+" full extent size: "+n.length+" full item size: "+i.size+")"),G.memcpy(i.data.buffer,i.alreadyRead,a,n.offset+n.alreadyRead-a.fileStart,n.length-n.alreadyRead),(!this.parsingMdat||this.discardMdatData)&&(a.usedBytes+=n.length-n.alreadyRead),this.stream.logBufferLevel(),i.alreadyRead+=n.length-n.alreadyRead,n.alreadyRead=n.length;else{u.debug("ISOFile","Getting item #"+t+" extent #"+s+" partial data (alreadyRead: "+n.alreadyRead+" offset: "+(n.offset+n.alreadyRead-a.fileStart)+" read size: "+o+" full extent size: "+n.length+" full item size: "+i.size+")"),G.memcpy(i.data.buffer,i.alreadyRead,a,n.offset+n.alreadyRead-a.fileStart,o),n.alreadyRead+=o,i.alreadyRead+=o,(!this.parsingMdat||this.discardMdatData)&&(a.usedBytes+=o),this.stream.logBufferLevel();return}}else return}}if(i.alreadyRead===i.size)return i}releaseItem(t){let i=this.items[t];if(i.data){this.itemsDataSize-=i.size,i.data=void 0,i.alreadyRead=0;for(let s=0;s<i.extents.length;s++){let n=i.extents[s];n.alreadyRead=0}return i.size}else return 0}processItems(t){for(let i in this.items){let s=this.items[i];this.getItem(s.id),t&&!s.sent&&(t(s),s.sent=!0,s.data=void 0)}}hasItem(t){for(let i in this.items){let s=this.items[i];if(s.name===t)return s.id}return-1}getMetaHandler(){if(this.meta)return this.meta.hdlr.handler}getPrimaryItem(){if(this.meta&&this.meta.pitm)return this.getItem(this.meta.pitm.item_id)}itemToFragmentedTrackFile({itemId:t}={}){let i;if(t?i=this.getItem(t):i=this.getPrimaryItem(),!i)return;let s=new se;s.discardMdatData=!1;let n={type:i.type,description_boxes:i.properties.boxes};i.properties.ispe&&(n.width=i.properties.ispe.image_width,n.height=i.properties.ispe.image_height);let r=s.addTrack(n);if(r)return s.addSample(r,i.data),s}processIncompleteBox(t){if(t.type==="mdat"){let i=new Me(t.size);return this.parsingMdat=i,this.boxes.push(i),this.mdats.push(i),i.start=t.start,i.hdr_size=t.hdr_size,i.original_size=t.original_size,this.stream.addUsedBytes(i.hdr_size),this.lastBoxStartPosition=i.start+i.size,this.stream.seek(i.start+i.size,!1,this.discardMdatData)?(this.transferMdatData(),this.parsingMdat=void 0,!0):(this.moovStartFound?this.nextParsePosition=this.stream.findEndContiguousBuf():this.nextParsePosition=i.start+i.size,!1)}else return t.type==="moov"&&(this.moovStartFound=!0,this.mdats.length===0&&(this.isProgressive=!0)),this.stream.mergeNextBuffer&&this.stream.mergeNextBuffer()?(this.nextParsePosition=this.stream.getEndPosition(),!0):(t.type?this.moovStartFound?this.nextParsePosition=this.stream.getEndPosition():this.nextParsePosition=this.stream.getPosition()+t.size:this.nextParsePosition=this.stream.getEndPosition(),!1)}hasIncompleteMdat(){return this.parsingMdat!==void 0}transferMdatData(t){let i=t??this.parsingMdat;if(this.discardMdatData){u.debug("ISOFile","Discarding 'mdat' data, not transferring it to the mdat box stream");return}if(!i){u.warn("ISOFile","Cannot transfer 'mdat' data, no mdat box is being parsed");return}let s=this.stream.findPosition(!0,i.start+i.hdr_size,!1),n=this.stream.findPosition(!0,i.start+i.size,!1);if(s===-1||n===-1){u.warn("ISOFile","Cannot transfer 'mdat' data, start or end buffer not found");return}i.stream=new De;for(let r=s;r<=n;r++){let a=this.stream.buffers[r],o=r===s?i.start+i.hdr_size-a.fileStart:0,c=r===n?i.start+i.size-a.fileStart:a.byteLength;if(c>o){u.debug("ISOFile","Transferring 'mdat' data from buffer #"+r+" ("+o+" to "+c+")");let h=c-o,d=new ue(h),p=i.stream.getAbsoluteEndPosition();G.memcpy(d,0,a,o,h),d.fileStart=p,i.stream.insertBuffer(d),a.usedBytes+=h}}}processIncompleteMdat(){let t=this.parsingMdat;return this.stream.seek(t.start+t.size,!1,this.discardMdatData)?(u.debug("ISOFile","Found 'mdat' end in buffered data"),this.transferMdatData(),this.parsingMdat=void 0,!0):(this.nextParsePosition=this.stream.findEndContiguousBuf(),!1)}restoreParsePosition(){return this.stream.seek(this.lastBoxStartPosition,!0,this.discardMdatData)}saveParsePosition(){this.lastBoxStartPosition=this.stream.getPosition()}updateUsedBytes(t,i){this.stream.addUsedBytes&&(t.type==="mdat"?(this.stream.addUsedBytes(t.hdr_size),this.discardMdatData&&this.stream.addUsedBytes(t.size-t.hdr_size)):this.stream.addUsedBytes(t.size))}addBox(t){return _.prototype.addBox.call(this,t)}init(t={}){let i=this.addBox(new Ot);i.major_brand=t.brands&&t.brands[0]||"iso4",i.minor_version=0,i.compatible_brands=t.brands||["iso4"];let s=this.addBox(new Oe);s.addBox(new st);let n=s.addBox(new $t);return n.timescale=t.timescale||600,n.rate=t.rate||65536,n.creation_time=0,n.modification_time=0,n.duration=t.duration||0,n.volume=t.width?0:256,n.matrix=[65536,0,0,0,65536,0,0,0,1073741824],n.next_track_id=1,this}addTrack(t={}){this.moov||this.init(t);let i=t||{};i.width=i.width||320,i.height=i.height||320,i.id=i.id||this.moov.mvhd.next_track_id,i.type=i.type||"avc1";let s=this.moov.addBox(new zt);this.moov.mvhd.next_track_id=i.id+1;let n=s.addBox(new si);n.flags=7,n.creation_time=0,n.modification_time=0,n.track_id=i.id,n.duration=i.duration||0,n.layer=i.layer||0,n.alternate_group=0,n.volume=1,n.matrix=[65536,0,0,0,65536,0,0,0,1073741824],n.width=i.width<<16,n.height=i.height<<16;let r=s.addBox(new It),a=r.addBox(new Gt);a.creation_time=0,a.modification_time=0,a.timescale=i.timescale||1,a.duration=i.media_duration||0,a.language=i.language||"und";let o=r.addBox(new Nt);o.handler=i.hdlr||"vide",o.name=i.name||"Track created with MP4Box.js";let c=r.addBox(new Rt);c.extended_language=i.language||"fr-FR";let h=r.addBox(new Pt),d=X.sampleEntry[i.type];if(!d)return;let p=new d;if(p.data_reference_index=1,p instanceof P){let I=p,Y=h.addBox(new ai);Y.graphicsmode=0,Y.opcolor=[0,0,0],I.width=i.width,I.height=i.height,I.horizresolution=72<<16,I.vertresolution=72<<16,I.frame_count=1,I.compressorname=i.type+" Compressor",I.depth=24,i.avcDecoderConfigRecord?I.addBox(new Tt(i.avcDecoderConfigRecord.byteLength)).parse(new G(i.avcDecoderConfigRecord)):i.hevcDecoderConfigRecord&&I.addBox(new Ht(i.hevcDecoderConfigRecord.byteLength)).parse(new G(i.hevcDecoderConfigRecord))}else if(p instanceof K){let I=p,Y=h.addBox(new Kt);Y.balance=i.balance||0,I.channel_count=i.channel_count||2,I.samplesize=i.samplesize||16,I.samplerate=i.samplerate||65536}else p instanceof Ut?h.addBox(new Ct):p instanceof _e?(h.addBox(new Xt),p instanceof Wt&&(p.namespace=i.namespace||"nonamespace",p.schema_location=i.schema_location||"",p.auxiliary_mime_types=i.auxiliary_mime_types||"")):p instanceof ve?h.addBox(new Re):p instanceof rt?h.addBox(new Re):h.addBox(new Re);i.description&&p.addBox.call(p,i.description),i.description_boxes&&i.description_boxes.forEach(function(I){p.addBox.call(p,I)});let x=h.addBox(new At).addBox(new Mt),b=new ri;b.flags=1,x.addEntry(b);let U=h.addBox(new Ft);U.addBox(new Zt).addEntry(p);let v=U.addBox(new ei);v.sample_counts=[],v.sample_deltas=[];let z=U.addBox(new Qt);z.first_chunk=[],z.samples_per_chunk=[],z.sample_description_index=[];let N=U.addBox(new Yt);N.chunk_offsets=[];let Q=U.addBox(new Jt);Q.sample_sizes=[];let F=this.moov.mvex.addBox(new nt);return F.track_id=i.id,F.default_sample_description_index=i.default_sample_description_index||1,F.default_sample_duration=i.default_sample_duration||0,F.default_sample_size=i.default_sample_size||0,F.default_sample_flags=i.default_sample_flags||0,this.buildTrakSampleLists(s),i.id}addSample(t,i,{sample_description_index:s,duration:n=1,cts:r=0,dts:a=0,is_sync:o=!1,is_leading:c=0,depends_on:h=0,is_depended_on:d=0,has_redundancy:p=0,degradation_priority:x=0,subsamples:b,offset:U=0}={}){let v=this.getTrackById(t);if(v===void 0)return;let z=s?s-1:0,N={number:v.samples.length,track_id:v.tkhd.track_id,timescale:v.mdia.mdhd.timescale,description_index:z,description:v.mdia.minf.stbl.stsd.entries[z],data:i,size:i.byteLength,alreadyRead:i.byteLength,duration:n,cts:r,dts:a,is_sync:o,is_leading:c,depends_on:h,is_depended_on:d,has_redundancy:p,degradation_priority:x,offset:U,subsamples:b};v.samples.push(N),v.samples_size+=N.size,v.samples_duration+=N.duration,v.first_dts===void 0&&(v.first_dts=a),this.processSamples();let Q=this.addBox(this.createMoof([N]));Q.computeSize(),Q.trafs[0].truns[0].data_offset=Q.size+8;let F=this.addBox(new Me);return F.data=new Uint8Array(i),N}createMoof(t){if(t.length===0)return;if(t.some(d=>d.track_id!==t[0].track_id))throw new Error("Cannot create moof for samples from different tracks: "+t.map(d=>d.track_id).join(", "));let i=t[0].track_id,s=this.getTrackById(i);if(!s)throw new Error("Cannot create moof for non-existing track: "+i);let n=new Lt,r=n.addBox(new jt);r.sequence_number=++this.nextMoofNumber;let a=n.addBox(new Dt),o=a.addBox(new ii);o.track_id=i,o.flags=Br;let c=a.addBox(new ti);c.baseMediaDecodeTime=t[0].dts-(s.first_dts||0);let h=a.addBox(new ni);h.flags=769|Ur|kr,h.data_offset=0,h.first_sample_flags=0,h.sample_count=t.length;for(let d of t){let p=0;d.is_sync?p=1<<25:p=65536,h.sample_duration.push(d.duration),h.sample_size.push(d.size),h.sample_flags.push(p),h.sample_composition_time_offset.push(d.cts-d.dts)}return n}print(t){t.indent="";for(let i=0;i<this.boxes.length;i++)this.boxes[i]&&this.boxes[i].print(t)}};function oi(e=!1,t){return new Nn(t,!e)}var Hn=class extends f{constructor(...e){super(...e),this.box_name="EventMessageBox"}static{this.fourcc="emsg"}parse(e){this.parseFullHeader(e),this.version===1?(this.timescale=e.readUint32(),this.presentation_time=e.readUint64(),this.event_duration=e.readUint32(),this.id=e.readUint32(),this.scheme_id_uri=e.readCString(),this.value=e.readCString()):(this.scheme_id_uri=e.readCString(),this.value=e.readCString(),this.timescale=e.readUint32(),this.presentation_time_delta=e.readUint32(),this.event_duration=e.readUint32(),this.id=e.readUint32());let t=this.size-this.hdr_size-(16+(this.scheme_id_uri.length+1)+(this.value.length+1));this.version===1&&(t-=4),this.message_data=e.readUint8Array(t)}write(e){this.version=0,this.flags=0,this.size=16+this.message_data.length+(this.scheme_id_uri.length+1)+(this.value.length+1),this.writeHeader(e),e.writeCString(this.scheme_id_uri),e.writeCString(this.value),e.writeUint32(this.timescale),e.writeUint32(this.presentation_time_delta),e.writeUint32(this.event_duration),e.writeUint32(this.id),e.writeUint8Array(this.message_data)}},Gn=class extends f{constructor(...e){super(...e),this.box_name="CompressedSubsegmentIndexBox"}static{this.fourcc="ssix"}parse(e){this.parseFullHeader(e),this.subsegments=[];let t=e.readUint32();for(let i=0;i<t;i++){let s={};this.subsegments.push(s),s.ranges=[];let n=e.readUint32();for(let r=0;r<n;r++){let a={};s.ranges.push(a),a.level=e.readUint8(),a.range_size=e.readUint24()}}}},Vn=class extends _{constructor(...e){super(...e),this.box_name="SegmentTypeBox"}static{this.fourcc="styp"}parse(e){let t=this.size-this.hdr_size;this.major_brand=e.readString(4),this.minor_version=e.readUint32(),t-=8,this.compatible_brands=[];let i=0;for(;t>=4;)this.compatible_brands[i]=e.readString(4),t-=4,i++}write(e){this.size=8+4*this.compatible_brands.length,this.writeHeader(e),e.writeString(this.major_brand,void 0,4),e.writeUint32(this.minor_version);for(let t=0;t<this.compatible_brands.length;t++)e.writeString(this.compatible_brands[t],void 0,4)}};var Ar=St({Descriptor:()=>we,ES_Descriptor:()=>Wn,MPEG4DescriptorParser:()=>Rr}),jn=3,ht=4,ci=5,$n=6,we=class qn{constructor(t,i){this.tag=t,this.size=i,this.descs=[]}parse(t){this.data=t.readUint8Array(this.size)}findDescriptor(t){for(let i=0;i<this.descs.length;i++)if(this.descs[i].tag===t)return this.descs[i]}parseOneDescriptor(t){let i=0,s=t.readUint8(),n=t.readUint8();for(;n&128;)i=(i<<7)+(n&127),n=t.readUint8();i=(i<<7)+(n&127),u.debug("Descriptor","Found "+(lt[s]||"Descriptor "+s)+", size "+i+" at position "+t.getPosition());let r=lt[s]?new Mr[lt[s]](i):new qn(i);return r.parse(t),r}parseRemainingDescriptors(t){let i=t.getPosition();for(;t.getPosition()<i+this.size;){let s=this.parseOneDescriptor?.(t);this.descs.push(s)}}},Wn=class extends we{constructor(e){super(jn,e)}parse(e){if(this.ES_ID=e.readUint16(),this.flags=e.readUint8(),this.size-=3,this.flags&128?(this.dependsOn_ES_ID=e.readUint16(),this.size-=2):this.dependsOn_ES_ID=0,this.flags&64){let t=e.readUint8();this.URL=e.readString(t),this.size-=t+1}else this.URL="";this.flags&32?(this.OCR_ES_ID=e.readUint16(),this.size-=2):this.OCR_ES_ID=0,this.parseRemainingDescriptors(e)}getOTI(){let e=this.findDescriptor(ht);return e?e.oti:0}getAudioConfig(){let e=this.findDescriptor(ht);if(!e)return;let t=e.findDescriptor(ci);if(t&&t.data){let i=(t.data[0]&248)>>3;return i===31&&t.data.length>=2&&(i=32+((t.data[0]&7)<<3)+((t.data[1]&224)>>5)),i}}},Fr=class extends we{constructor(e){super(ht,e)}parse(e){this.oti=e.readUint8(),this.streamType=e.readUint8(),this.upStream=(this.streamType>>1&1)!==0,this.streamType=this.streamType>>>2,this.bufferSize=e.readUint24(),this.maxBitrate=e.readUint32(),this.avgBitrate=e.readUint32(),this.size-=13,this.parseRemainingDescriptors(e)}},Lr=class extends we{constructor(e){super(ci,e)}},Dr=class extends we{constructor(e){super($n,e)}},Mr={Descriptor:we,ES_Descriptor:Wn,DecoderConfigDescriptor:Fr,DecoderSpecificInfo:Lr,SLConfigDescriptor:Dr},lt={[jn]:"ES_Descriptor",[ht]:"DecoderConfigDescriptor",[ci]:"DecoderSpecificInfo",[$n]:"SLConfigDescriptor"},Rr=class{constructor(){this.parseOneDescriptor=we.prototype.parseOneDescriptor}getDescriptorName(e){return lt[e]}};var Or=class extends _{constructor(...e){super(...e),this.box_name="AV1LayeredImageIndexingProperty"}static{this.fourcc="a1lx"}parse(e){let t=((e.readUint8()&1)+1)*16;this.layer_size=[];for(let i=0;i<3;i++)t===16?this.layer_size[i]=e.readUint16():this.layer_size[i]=e.readUint32()}},Nr=class extends _{constructor(...e){super(...e),this.box_name="OperatingPointSelectorProperty"}static{this.fourcc="a1op"}parse(e){this.op_index=e.readUint8()}},Hr=class extends f{constructor(...e){super(...e),this.box_name="AuxiliaryTypeProperty"}static{this.fourcc="auxC"}parse(e){this.parseFullHeader(e),this.aux_type=e.readCString();let t=this.size-this.hdr_size-(this.aux_type.length+1);this.aux_subtype=e.readUint8Array(t)}},Gr=class extends _{constructor(...e){super(...e),this.box_name="BitRateBox"}static{this.fourcc="btrt"}parse(e){this.bufferSizeDB=e.readUint32(),this.maxBitrate=e.readUint32(),this.avgBitrate=e.readUint32()}},Vr=class extends f{constructor(...e){super(...e),this.box_name="CodingConstraintsBox"}static{this.fourcc="ccst"}parse(e){this.parseFullHeader(e);let t=e.readUint8();this.all_ref_pics_intra=(t&128)===128,this.intra_pred_used=(t&64)===64,this.max_ref_per_pic=(t&63)>>2,e.readUint24()}},jr=class extends _{constructor(...e){super(...e),this.box_name="ComponentDefinitionBox"}static{this.fourcc="cdef"}parse(e){this.channel_count=e.readUint16(),this.channel_indexes=[],this.channel_types=[],this.channel_associations=[];for(let t=0;t<this.channel_count;t++)this.channel_indexes.push(e.readUint16()),this.channel_types.push(e.readUint16()),this.channel_associations.push(e.readUint16())}},$r=class extends _{constructor(...e){super(...e),this.box_name="CleanApertureBox"}static{this.fourcc="clap"}parse(e){this.cleanApertureWidthN=e.readUint32(),this.cleanApertureWidthD=e.readUint32(),this.cleanApertureHeightN=e.readUint32(),this.cleanApertureHeightD=e.readUint32(),this.horizOffN=e.readUint32(),this.horizOffD=e.readUint32(),this.vertOffN=e.readUint32(),this.vertOffD=e.readUint32()}},qr=class extends _{constructor(...e){super(...e),this.box_name="ContentLightLevelBox"}static{this.fourcc="clli"}parse(e){this.max_content_light_level=e.readUint16(),this.max_pic_average_light_level=e.readUint16()}},Wr=class extends _{constructor(...e){super(...e),this.box_name="CameraExtrinsicMatrixProperty"}static{this.fourcc="cmex"}parse(e){this.flags&1&&(this.pos_x=e.readInt32()),this.flags&2&&(this.pos_y=e.readInt32()),this.flags&4&&(this.pos_z=e.readInt32()),this.flags&8&&(this.version===0?this.flags&16?(this.quat_x=e.readInt32(),this.quat_y=e.readInt32(),this.quat_z=e.readInt32()):(this.quat_x=e.readInt16(),this.quat_y=e.readInt16(),this.quat_z=e.readInt16()):this.version),this.flags&32&&(this.id=e.readUint32())}},Kr=class extends _{constructor(...e){super(...e),this.box_name="CameraIntrinsicMatrixProperty"}static{this.fourcc="cmin"}parse(e){this.focal_length_x=e.readInt32(),this.principal_point_x=e.readInt32(),this.principal_point_y=e.readInt32(),this.flags&1&&(this.focal_length_y=e.readInt32(),this.skew_factor=e.readInt32())}},Yr=class extends f{constructor(...e){super(...e),this.box_name="CompressionConfigurationBox"}static{this.fourcc="cmpC"}parse(e){this.parseFullHeader(e),this.compression_type=e.readString(4),this.compressed_unit_type=e.readUint8()}},Xr=class extends _{constructor(...e){super(...e),this.box_name="ComponentDefinitionBox"}static{this.fourcc="cmpd"}parse(e){this.component_count=e.readUint32(),this.component_types=[],this.component_type_urls=[];for(let t=0;t<this.component_count;t++){let i=e.readUint16();this.component_types.push(i),i>=32768&&this.component_type_urls.push(e.readCString())}}},Qr=class extends f{constructor(...e){super(...e),this.box_name="ChunkLargeOffsetBox"}static{this.fourcc="co64"}parse(e){this.parseFullHeader(e);let t=e.readUint32();if(this.chunk_offsets=[],this.version===0)for(let i=0;i<t;i++)this.chunk_offsets.push(e.readUint64())}write(e){this.version=0,this.flags=0,this.size=4+8*this.chunk_offsets.length,this.writeHeader(e),e.writeUint32(this.chunk_offsets.length);for(let t=0;t<this.chunk_offsets.length;t++)e.writeUint64(this.chunk_offsets[t])}},Zr=class extends f{constructor(...e){super(...e),this.box_name="ContentLightLevelBox"}static{this.fourcc="CoLL"}parse(e){this.parseFullHeader(e),this.maxCLL=e.readUint16(),this.maxFALL=e.readUint16()}},Jr=class{toString(){let e="centre_azimuth: ";return e+=this.centre_azimuth,e+=" (",e+=this.centre_azimuth*2**-16,e+="\xB0), centre_elevation: ",e+=this.centre_elevation,e+=" (",e+=this.centre_elevation*2**-16,e+="\xB0), centre_tilt: ",e+=this.centre_tilt,e+=" (",e+=this.centre_tilt*2**-16,e+="\xB0)",this.range_included_flag&&(e+=", azimuth_range: ",e+=this.azimuth_range,e+=" (",e+=this.azimuth_range*2**-16,e+="\xB0), elevation_range: ",e+=this.elevation_range,e+=" (",e+=this.elevation_range*2**-16,e+="\xB0)"),this.interpolate_included_flag&&(e+=", interpolate: ",e+=this.interpolate),e}},ea=class{toString(){let e="";return this.view_idc&&(e+="view_idc: ",e+=this.view_idc,e+=", "),e+="sphere_region: {",e+=this.sphere_region,e+="}",e}},ta=class extends f{constructor(...e){super(...e),this.box_name="CoverageInformationBox"}static{this.fourcc="covi"}parse(e){this.parseFullHeader(e),this.coverage_shape_type=e.readUint8();let t=e.readUint8(),i=e.readInt8(),s=i&128;s&&(this.default_view_idc=(i&96)>>5),this.coverage_regions=new Array;for(let n=0;n<t;n++){let r=new ea;s&&(r.view_idc=e.readUint8()>>6),r.sphere_region=this.parseSphereRegion(e,!0,!0),this.coverage_regions.push(r)}}parseSphereRegion(e,t,i){let s=new Jr;return s.centre_azimuth=e.readInt32(),s.centre_elevation=e.readInt32(),s.centre_tilt=e.readInt32(),s.range_included_flag=t,t&&(s.azimuth_range=e.readUint32(),s.elevation_range=e.readUint32()),s.interpolate_included_flag=i,i&&(s.interpolate=(e.readUint8()&128)===128),s}},ia=class extends f{constructor(...e){super(...e),this.box_name="CopyrightBox"}static{this.fourcc="cprt"}parse(e){this.parseFullHeader(e),this.parseLanguage(e),this.notice=e.readCString()}},sa=class extends f{constructor(...e){super(...e),this.box_name="CompatibleSchemeTypeBox"}static{this.fourcc="csch"}parse(e){this.parseFullHeader(e),this.scheme_type=e.readString(4),this.scheme_version=e.readUint32(),this.flags&1&&(this.scheme_uri=e.readCString())}},Ne=2147483647,na=class extends f{constructor(...e){super(...e),this.box_name="CompositionToDecodeBox"}static{this.fourcc="cslg"}parse(e){this.parseFullHeader(e),this.version===0?(this.compositionToDTSShift=e.readInt32(),this.leastDecodeToDisplayDelta=e.readInt32(),this.greatestDecodeToDisplayDelta=e.readInt32(),this.compositionStartTime=e.readInt32(),this.compositionEndTime=e.readInt32()):this.version===1&&(this.compositionToDTSShift=e.readInt64(),this.leastDecodeToDisplayDelta=e.readInt64(),this.greatestDecodeToDisplayDelta=e.readInt64(),this.compositionStartTime=e.readInt64(),this.compositionEndTime=e.readInt64())}write(e){this.version=0,(this.compositionToDTSShift>Ne||this.leastDecodeToDisplayDelta>Ne||this.greatestDecodeToDisplayDelta>Ne||this.compositionStartTime>Ne||this.compositionEndTime>Ne)&&(this.version=1),this.flags=0,this.version===0?(this.size=20,this.writeHeader(e),e.writeInt32(this.compositionToDTSShift),e.writeInt32(this.leastDecodeToDisplayDelta),e.writeInt32(this.greatestDecodeToDisplayDelta),e.writeInt32(this.compositionStartTime),e.writeInt32(this.compositionEndTime)):this.version===1&&(this.size=40,this.writeHeader(e),e.writeInt64(this.compositionToDTSShift),e.writeInt64(this.leastDecodeToDisplayDelta),e.writeInt64(this.greatestDecodeToDisplayDelta),e.writeInt64(this.compositionStartTime),e.writeInt64(this.compositionEndTime))}},ra=class extends f{constructor(...e){super(...e),this.box_name="CompositionOffsetBox"}static{this.fourcc="ctts"}parse(e){this.parseFullHeader(e);let t=e.readUint32();if(this.sample_counts=[],this.sample_offsets=[],this.version===0)for(let i=0;i<t;i++){this.sample_counts.push(e.readUint32());let s=e.readInt32();s<0&&u.warn("BoxParser","ctts box uses negative values without using version 1"),this.sample_offsets.push(s)}else if(this.version===1)for(let i=0;i<t;i++)this.sample_counts.push(e.readUint32()),this.sample_offsets.push(e.readInt32())}write(e){this.version=this.sample_offsets.some(t=>t<0)?1:0,this.flags=0,this.size=4+8*this.sample_counts.length,this.writeHeader(e),e.writeUint32(this.sample_counts.length);for(let t=0;t<this.sample_counts.length;t++)e.writeUint32(this.sample_counts[t]),this.version===1?e.writeInt32(this.sample_offsets[t]):e.writeUint32(this.sample_offsets[t])}unpack(e){let t=0;for(let i=0;i<this.sample_counts.length;i++)for(let s=0;s<this.sample_counts[i];s++)e[t].pts=e[t].dts+this.sample_offsets[i],t++}},aa=class extends _{constructor(...e){super(...e),this.box_name="AC3SpecificBox"}static{this.fourcc="dac3"}parse(e){let t=e.readUint8(),i=e.readUint8(),s=e.readUint8();this.fscod=t>>6,this.bsid=t>>1&31,this.bsmod=(t&1)<<2|i>>6&3,this.acmod=i>>3&7,this.lfeon=i>>2&1,this.bit_rate_code=i&3|s>>5&7}},oa=class extends _{constructor(...e){super(...e),this.box_name="EC3SpecificBox"}static{this.fourcc="dec3"}parse(e){let t=e.readUint16();this.data_rate=t>>3,this.num_ind_sub=t&7,this.ind_subs=[];for(let i=0;i<this.num_ind_sub+1;i++){let s=e.readUint8(),n=e.readUint8(),r=e.readUint8(),a={fscod:s>>6,bsid:s>>1&31,bsmod:(s&1)<<4|n>>4&15,acmod:n>>1&7,lfeon:n&1,num_dep_sub:r>>1&15};this.ind_subs.push(a),a.num_dep_sub>0&&(a.chan_loc=(r&1)<<8|e.readUint8())}}},ca=class extends f{constructor(...e){super(...e),this.box_name="FLACSpecificBox"}static{this.fourcc="dfLa"}parse(e){this.parseFullHeader(e);let t=127,i=128,s=[],n=["STREAMINFO","PADDING","APPLICATION","SEEKTABLE","VORBIS_COMMENT","CUESHEET","PICTURE","RESERVED"],r;do{r=e.readUint8();let a=Math.min(r&t,n.length-1);a?e.readUint8Array(e.readUint24()):(e.readUint8Array(13),this.samplerate=e.readUint32()>>12,e.readUint8Array(20)),s.push(n[a])}while(r&i);this.numMetadataBlocks=s.length+" ("+s.join(", ")+")"}},la=class extends _{constructor(...e){super(...e),this.box_name="hintimmediateBytesSent"}static{this.fourcc="dimm"}parse(e){this.bytessent=e.readUint64()}},ha=class extends _{constructor(...e){super(...e),this.box_name="hintlongestpacket"}static{this.fourcc="dmax"}parse(e){this.time=e.readUint32()}},ua=class extends _{constructor(...e){super(...e),this.box_name="hintmediaBytesSent"}static{this.fourcc="dmed"}parse(e){this.bytessent=e.readUint64()}},da=class extends _{constructor(...e){super(...e),this.box_name="OpusSpecificBox"}static{this.fourcc="dOps"}parse(e){if(this.Version=e.readUint8(),this.OutputChannelCount=e.readUint8(),this.PreSkip=e.readUint16(),this.InputSampleRate=e.readUint32(),this.OutputGain=e.readInt16(),this.ChannelMappingFamily=e.readUint8(),this.ChannelMappingFamily!==0){this.StreamCount=e.readUint8(),this.CoupledCount=e.readUint8(),this.ChannelMapping=[];for(let t=0;t<this.OutputChannelCount;t++)this.ChannelMapping[t]=e.readUint8()}}write(e){if(this.size=11,this.ChannelMappingFamily!==0&&(this.size+=2+this.OutputChannelCount),this.writeHeader(e),e.writeUint8(this.Version),e.writeUint8(this.OutputChannelCount),e.writeUint16(this.PreSkip),e.writeUint32(this.InputSampleRate),e.writeInt16(this.OutputGain),e.writeUint8(this.ChannelMappingFamily),this.ChannelMappingFamily!==0){e.writeUint8(this.StreamCount),e.writeUint8(this.CoupledCount);for(let t=0;t<this.OutputChannelCount;t++)e.writeUint8(this.ChannelMapping[t])}}},fa=class extends _{constructor(...e){super(...e),this.box_name="hintrepeatedBytesSent"}static{this.fourcc="drep"}parse(e){this.bytessent=e.readUint64()}},pa=class extends f{constructor(...e){super(...e),this.box_name="EditListBox"}static{this.fourcc="elst"}parse(e){this.parseFullHeader(e),this.entries=[];let t=e.readUint32();for(let i=0;i<t;i++){let s={segment_duration:this.version===1?e.readUint64():e.readUint32(),media_time:this.version===1?e.readInt64():e.readInt32(),media_rate_integer:e.readInt16(),media_rate_fraction:e.readInt16()};this.entries.push(s)}}write(e){let t=this.entries.some(i=>i.segment_duration>M||i.media_time>M)||this.version===1;this.version=t?1:0,this.size=4+12*this.entries.length,this.size+=t?8*this.entries.length:0,this.writeHeader(e),e.writeUint32(this.entries.length);for(let i=0;i<this.entries.length;i++){let s=this.entries[i];t?(e.writeUint64(s.segment_duration),e.writeInt64(s.media_time)):(e.writeUint32(s.segment_duration),e.writeInt32(s.media_time)),e.writeInt16(s.media_rate_integer),e.writeInt16(s.media_rate_fraction)}}},q=class extends f{parse(e){this.parseFullHeader(e),this.group_id=e.readUint32(),this.num_entities_in_group=e.readUint32(),this.entity_ids=[];for(let t=0;t<this.num_entities_in_group;t++){let i=e.readUint32();this.entity_ids.push(i)}}},_a=class extends q{constructor(...e){super(...e),this.box_name="Auto exposure bracketing"}static{this.fourcc="aebr"}},ma=class extends q{constructor(...e){super(...e),this.box_name="Flash exposure information"}static{this.fourcc="afbr"}},xa=class extends q{constructor(...e){super(...e),this.box_name="Album collection"}static{this.fourcc="albc"}},ga=class extends q{constructor(...e){super(...e),this.box_name="Alternative entity"}static{this.fourcc="altr"}},ba=class extends q{constructor(...e){super(...e),this.box_name="Burst image"}static{this.fourcc="brst"}},ya=class extends q{constructor(...e){super(...e),this.box_name="Depth of field bracketing"}static{this.fourcc="dobr"}},va=class extends q{constructor(...e){super(...e),this.box_name="Equivalent entity"}static{this.fourcc="eqiv"}},wa=class extends q{constructor(...e){super(...e),this.box_name="Favorites collection"}static{this.fourcc="favc"}},Sa=class extends q{constructor(...e){super(...e),this.box_name="Focus bracketing"}static{this.fourcc="fobr"}},Ba=class extends q{constructor(...e){super(...e),this.box_name="Image item with an audio track"}static{this.fourcc="iaug"}},Ua=class extends q{constructor(...e){super(...e),this.box_name="Panorama"}static{this.fourcc="pano"}},ka=class extends q{constructor(...e){super(...e),this.box_name="Slideshow"}static{this.fourcc="slid"}},Ea=class extends q{constructor(...e){super(...e),this.box_name="Stereo"}static{this.fourcc="ster"}},Ta=class extends q{constructor(...e){super(...e),this.box_name="Time-synchronized capture"}static{this.fourcc="tsyn"}},Ca=class extends q{constructor(...e){super(...e),this.box_name="White balance bracketing"}static{this.fourcc="wbbr"}},za=class extends q{constructor(...e){super(...e),this.box_name="Progressive rendering"}static{this.fourcc="prgr"}},Ia=class extends q{constructor(...e){super(...e),this.box_name="Image pyramid"}static{this.fourcc="pymd"}parse(e){this.parseFullHeader(e),this.group_id=e.readUint32(),this.num_entities_in_group=e.readUint32(),this.entity_ids=[];for(let t=0;t<this.num_entities_in_group;t++){let i=e.readUint32();this.entity_ids.push(i)}this.tile_size_x=e.readUint16(),this.tile_size_y=e.readUint16(),this.layer_binning=[],this.tiles_in_layer_column_minus1=[],this.tiles_in_layer_row_minus1=[];for(let t=0;t<this.num_entities_in_group;t++)this.layer_binning[t]=e.readUint16(),this.tiles_in_layer_row_minus1[t]=e.readUint16(),this.tiles_in_layer_column_minus1[t]=e.readUint16()}},Pa=class extends _{constructor(...e){super(...e),this.box_name="FieldHandlingBox"}static{this.fourcc="fiel"}parse(e){this.fieldCount=e.readUint8(),this.fieldOrdering=e.readUint8()}},Aa=class extends _{constructor(...e){super(...e),this.box_name="OriginalFormatBox"}static{this.fourcc="frma"}parse(e){this.data_format=e.readString(4)}},Fa=class extends _{constructor(...e){super(...e),this.box_name="ImageMirror"}static{this.fourcc="imir"}parse(e){let t=e.readUint8();this.reserved=t>>7,this.axis=t&1}},La=class extends f{constructor(...e){super(...e),this.box_name="ItemPropertyAssociationBox"}static{this.fourcc="ipma"}parse(e){this.parseFullHeader(e);let t=e.readUint32();this.associations=[];for(let i=0;i<t;i++){let s=this.version<1?e.readUint16():e.readUint32(),n=[],r=e.readUint8();for(let a=0;a<r;a++){let o=e.readUint8();n.push({essential:(o&128)>>7===1,property_index:this.flags&1?(o&127)<<8|e.readUint8():o&127})}this.associations.push({id:s,props:n})}}},Da=class extends _{constructor(...e){super(...e),this.box_name="ImageRotation"}static{this.fourcc="irot"}parse(e){this.angle=e.readUint8()&3}},Ma=class extends f{constructor(...e){super(...e),this.box_name="ImageSpatialExtentsProperty"}static{this.fourcc="ispe"}parse(e){this.parseFullHeader(e),this.image_width=e.readUint32(),this.image_height=e.readUint32()}},Ra=class extends f{constructor(...e){super(...e),this.box_name="TAITimestampBox"}static{this.fourcc="itai"}parse(e){this.TAI_timestamp=e.readUint64();let t=e.readUint8();this.sychronization_state=t>>7&1,this.timestamp_generation_failure=t>>6&1,this.timestamp_is_modified=t>>5&1}},Oa=class extends f{constructor(...e){super(...e),this.box_name="KindBox"}static{this.fourcc="kind"}parse(e){this.parseFullHeader(e),this.schemeURI=e.readCString(),this.isEndOfBox(e)||(this.value=e.readCString())}write(e){this.version=0,this.flags=0,this.size=this.schemeURI.length+1+(this.value?this.value.length+1:0),this.writeHeader(e),e.writeCString(this.schemeURI),this.value&&e.writeCString(this.value)}},Na=class extends f{constructor(...e){super(...e),this.box_name="LevelAssignmentBox"}static{this.fourcc="leva"}parse(e){this.parseFullHeader(e);let t=e.readUint8();this.levels=[];for(let i=0;i<t;i++){let s={};this.levels[i]=s,s.track_ID=e.readUint32();let n=e.readUint8();switch(s.padding_flag=n>>7,s.assignment_type=n&127,s.assignment_type){case 0:s.grouping_type=e.readString(4);break;case 1:s.grouping_type=e.readString(4),s.grouping_type_parameter=e.readUint32();break;case 2:break;case 3:break;case 4:s.sub_track_id=e.readUint32();break;default:u.warn("BoxParser",`Unknown level assignment type: ${s.assignment_type}`)}}}},Ha=class extends _{constructor(...e){super(...e),this.box_name="LHEVCConfigurationBox"}static{this.fourcc="lhvC"}parse(e){this.configurationVersion=e.readUint8(),this.min_spatial_segmentation_idc=e.readUint16()&4095,this.parallelismType=e.readUint8()&3;let t=e.readUint8();this.numTemporalLayers=(t&13)>>3,this.temporalIdNested=(t&4)>>2,this.lengthSizeMinusOne=t&3,this.nalu_arrays=[];let i=e.readUint8();for(let s=0;s<i;s++){let n=[];this.nalu_arrays.push(n),t=e.readUint8(),n.completeness=(t&128)>>7,n.nalu_type=t&63;let r=e.readUint16();for(let a=0;a<r;a++){let o=e.readUint16();n.push({data:e.readUint8Array(o)})}}}},Ga=class extends _{constructor(...e){super(...e),this.box_name="LayerSelectorProperty"}static{this.fourcc="lsel"}parse(e){this.layer_id=e.readUint16()}},Va=class extends _{constructor(...e){super(...e),this.box_name="hintmaxrate"}static{this.fourcc="maxr"}parse(e){this.period=e.readUint32(),this.bytes=e.readUint32()}},ct=class{constructor(e,t){this.x=e,this.y=t}toString(){return"("+this.x+","+this.y+")"}},ja=class extends _{constructor(...e){super(...e),this.box_name="MasteringDisplayColourVolumeBox"}static{this.fourcc="mdcv"}parse(e){this.display_primaries=[],this.display_primaries[0]=new ct(e.readUint16(),e.readUint16()),this.display_primaries[1]=new ct(e.readUint16(),e.readUint16()),this.display_primaries[2]=new ct(e.readUint16(),e.readUint16()),this.white_point=new ct(e.readUint16(),e.readUint16()),this.max_display_mastering_luminance=e.readUint32(),this.min_display_mastering_luminance=e.readUint32()}},$a=class extends f{constructor(...e){super(...e),this.box_name="MovieFragmentRandomAccessOffsetBox"}static{this.fourcc="mfro"}parse(e){this.parseFullHeader(e),this._size=e.readUint32()}},qa=class extends f{constructor(...e){super(...e),this.box_name="MaskConfigurationProperty"}static{this.fourcc="mskC"}parse(e){this.parseFullHeader(e),this.bits_per_pixel=e.readUint8()}},Wa=class extends _{constructor(...e){super(...e),this.box_name="hintPacketsSent"}static{this.fourcc="npck"}parse(e){this.packetssent=e.readUint32()}},Ka=class extends _{constructor(...e){super(...e),this.box_name="hintPacketsSent"}static{this.fourcc="nump"}parse(e){this.packetssent=e.readUint64()}},Ya=class{constructor(e,t){this.pad1=e,this.pad2=t}},Xa=class extends f{constructor(...e){super(...e),this.box_name="PaddingBitsBox"}static{this.fourcc="padb"}parse(e){this.parseFullHeader(e);let t=e.readUint32();this.padbits=[];for(let i=0;i<Math.floor((t+1)/2);i++){let s=e.readUint8(),n=(s&112)>>4,r=s&7;this.padbits.push(new Ya(n,r))}}},Qa=class extends _{constructor(...e){super(...e),this.box_name="PixelAspectRatioBox"}static{this.fourcc="pasp"}parse(e){this.hSpacing=e.readUint32(),this.vSpacing=e.readUint32()}},Za=class extends _{constructor(...e){super(...e),this.box_name="CuePayloadBox"}static{this.fourcc="payl"}parse(e){this.text=e.readString(this.size-this.hdr_size)}},Ja=class extends _{constructor(...e){super(...e),this.box_name="hintpayloadID"}static{this.fourcc="payt"}parse(e){this.payloadID=e.readUint32();let t=e.readUint8();this.rtpmap_string=e.readString(t)}},eo=class extends f{constructor(...e){super(...e),this.box_name="ProgressiveDownloadInfoBox",this.rate=[],this.initial_delay=[]}static{this.fourcc="pdin"}parse(e){this.parseFullHeader(e);let t=(this.size-this.hdr_size)/8;for(let i=0;i<t;i++)this.rate[i]=e.readUint32(),this.initial_delay[i]=e.readUint32()}},to=class extends f{constructor(...e){super(...e),this.box_name="PixelInformationProperty"}static{this.fourcc="pixi"}parse(e){this.parseFullHeader(e),this.num_channels=e.readUint8(),this.bits_per_channels=[];for(let t=0;t<this.num_channels;t++)this.bits_per_channels[t]=e.readUint8()}},io=class extends _{constructor(...e){super(...e),this.box_name="hintlargestpacket"}static{this.fourcc="pmax"}parse(e){this.bytes=e.readUint32()}},so=class extends f{constructor(...e){super(...e),this.box_name="ProgressiveDerivedImageItemInformationProperty"}static{this.fourcc="prdi"}parse(e){if(this.parseFullHeader(e),this.step_count=e.readUint16(),this.item_count=[],this.flags&2)for(let t=0;t<this.step_count;t++)this.item_count[t]=e.readUint16()}},no=class extends f{constructor(...e){super(...e),this.box_name="ProjectionFormatBox"}static{this.fourcc="prfr"}parse(e){this.parseFullHeader(e),this.projection_type=e.readUint8()&31}},ro=class extends f{constructor(...e){super(...e),this.box_name="ProducerReferenceTimeBox"}static{this.fourcc="prft"}parse(e){this.parseFullHeader(e),this.ref_track_id=e.readUint32(),this.ntp_timestamp=e.readUint64(),this.version===0?this.media_time=e.readUint32():this.media_time=e.readUint64()}},ao=class extends f{constructor(...e){super(...e),this.box_name="ProtectionSystemSpecificHeaderBox"}static{this.fourcc="pssh"}parse(e){if(this.parseFullHeader(e),this.system_id=me(e),this.kid=[],this.version>0){let i=e.readUint32();for(let s=0;s<i;s++)this.kid[s]=me(e)}let t=e.readUint32();t>0&&(this.protection_data=e.readUint8Array(t))}},oo=class extends f{constructor(...e){super(...e),this.box_name="TrackCleanApertureDimensionsBox"}static{this.fourcc="clef"}parse(e){this.parseFullHeader(e),this.width=e.readUint32(),this.height=e.readUint32()}};function co(e,t){if(e===He.Types.UTF8)return new TextDecoder("utf-8").decode(t);let i=new DataView(t.buffer);if(e===He.Types.BE_UNSIGNED_INT){if(t.length===1)return i.getUint8(0);if(t.length===2)return i.getUint16(0,!1);if(t.length===4)return i.getUint32(0,!1);if(t.length===8)return i.getBigUint64(0,!1);throw new Error("Unsupported ITIF_TYPE_BE_UNSIGNED_INT length "+t.length)}else if(e===He.Types.BE_SIGNED_INT){if(t.length===1)return i.getInt8(0);if(t.length===2)return i.getInt16(0,!1);if(t.length===4)return i.getInt32(0,!1);if(t.length===8)return i.getBigInt64(0,!1);throw new Error("Unsupported ITIF_TYPE_BE_SIGNED_INT length "+t.length)}else if(e===He.Types.BE_FLOAT32)return i.getFloat32(0,!1);u.warn("DataBox","Unsupported or unimplemented itif data type: "+e)}var He=class extends _{constructor(...e){super(...e),this.box_name="DataBox"}static{this.fourcc="data"}static{this.Types={RESERVED:0,UTF8:1,UTF16:2,SJIS:3,UTF8_SORT:4,UTF16_SORT:5,JPEG:13,PNG:14,BE_SIGNED_INT:21,BE_UNSIGNED_INT:22,BE_FLOAT32:23,BE_FLOAT64:24,BMP:27,QT_ATOM:28,BE_SIGNED_INT8:65,BE_SIGNED_INT16:66,BE_SIGNED_INT32:67,BE_FLOAT32_POINT:70,BE_FLOAT32_DIMENSIONS:71,BE_FLOAT32_RECT:72,BE_SIGNED_INT64:74,BE_UNSIGNED_INT8:75,BE_UNSIGNED_INT16:76,BE_UNSIGNED_INT32:77,BE_UNSIGNED_INT64:78,BE_FLOAT64_AFFINE_TRANSFORM:79}}parse(e){this.valueType=e.readUint32(),this.country=e.readUint16(),this.country>255&&(e.seek(e.getPosition()-2),this.countryString=e.readString(2)),this.language=e.readUint16(),this.language>255&&(e.seek(e.getPosition()-2),this.parseLanguage(e)),this.raw=e.readUint8Array(this.size-this.hdr_size-8),this.value=co(this.valueType,this.raw)}},lo=class extends f{constructor(...e){super(...e),this.box_name="TrackEncodedPixelsDimensionsBox"}static{this.fourcc="enof"}parse(e){this.parseFullHeader(e),this.width=e.readUint32(),this.height=e.readUint32()}},ho=class extends _{constructor(...e){super(...e),this.box_name="IlstBox"}static{this.fourcc="ilst"}parse(e){this.list={};let t=this.size-this.hdr_size;for(;t>0;){let i=e.readUint32(),s=e.readUint32(),n=ie(e,!1,i-8);n.code===1&&(this.list[s]=n.box),t-=i}}},uo=class extends f{constructor(...e){super(...e),this.box_name="KeysBox"}static{this.fourcc="keys"}parse(e){this.parseFullHeader(e),this.count=e.readUint32(),this.keys={};for(let t=0;t<this.count;t++){let i=e.readUint32();this.keys[t+1]=e.readString(i-4)}}},fo=class extends f{constructor(...e){super(...e),this.box_name="TrackProductionApertureDimensionsBox"}static{this.fourcc="prof"}parse(e){this.parseFullHeader(e),this.width=e.readUint32(),this.height=e.readUint32()}},po=class extends E{constructor(...e){super(...e),this.box_name="TrackApertureModeDimensionsBox",this.clefs=[],this.profs=[],this.enofs=[],this.subBoxNames=["clef","prof","enof"]}static{this.fourcc="tapt"}},_o=class extends _{constructor(...e){super(...e),this.box_name="rtpmoviehintinformation"}static{this.fourcc="rtp "}parse(e){this.descriptionformat=e.readString(4),this.sdptext=e.readString(this.size-this.hdr_size-4)}},mo=class extends f{constructor(...e){super(...e),this.box_name="SampleAuxiliaryInformationOffsetsBox"}static{this.fourcc="saio"}parse(e){this.parseFullHeader(e),this.flags&1&&(this.aux_info_type=e.readString(4),this.aux_info_type_parameter=e.readUint32()),this.entry_count=e.readUint32(),this.offset=[];for(let t=0;t<this.entry_count;t++)this.version===0?this.offset[t]=e.readUint32():this.offset[t]=e.readUint64()}},xo=class extends f{constructor(...e){super(...e),this.box_name="SampleAuxiliaryInformationSizesBox"}static{this.fourcc="saiz"}parse(e){if(this.parseFullHeader(e),this.flags&1&&(this.aux_info_type=e.readString(4),this.aux_info_type_parameter=e.readUint32()),this.default_sample_info_size=e.readUint8(),this.sample_count=e.readUint32(),this.sample_info_size=[],this.default_sample_info_size===0)for(let t=0;t<this.sample_count;t++)this.sample_info_size[t]=e.readUint8()}},go=class{constructor(e,t){this.bad_pixel_row=e,this.bad_pixel_column=t}toString(){return"[row: "+this.bad_pixel_row+", column: "+this.bad_pixel_column+"]"}},bo=class extends f{constructor(...e){super(...e),this.box_name="SensorBadPixelsMapBox"}static{this.fourcc="sbpm"}parse(e){this.parseFullHeader(e),this.component_count=e.readUint16(),this.component_index=[];for(let i=0;i<this.component_count;i++)this.component_index.push(e.readUint16());let t=e.readUint8();this.correction_applied=(t&128)===128,this.num_bad_rows=e.readUint32(),this.num_bad_cols=e.readUint32(),this.num_bad_pixels=e.readUint32(),this.bad_rows=[],this.bad_columns=[],this.bad_pixels=[];for(let i=0;i<this.num_bad_rows;i++)this.bad_rows.push(e.readUint32());for(let i=0;i<this.num_bad_cols;i++)this.bad_columns.push(e.readUint32());for(let i=0;i<this.num_bad_pixels;i++){let s=e.readUint32(),n=e.readUint32();this.bad_pixels.push(new go(s,n))}}},yo=class extends f{constructor(...e){super(...e),this.box_name="SchemeTypeBox"}static{this.fourcc="schm"}parse(e){this.parseFullHeader(e),this.scheme_type=e.readString(4),this.scheme_version=e.readUint32(),this.flags&1&&(this.scheme_uri=e.readString(this.size-this.hdr_size-8))}},vo=class extends _{constructor(...e){super(...e),this.box_name="rtptracksdphintinformation"}static{this.fourcc="sdp "}parse(e){this.sdptext=e.readString(this.size-this.hdr_size)}},wo=class extends f{constructor(...e){super(...e),this.box_name="SampleEncryptionBox"}static{this.fourcc="senc"}},So=class extends f{constructor(...e){super(...e),this.box_name="SMPTE2086MasteringDisplayMetadataBox"}static{this.fourcc="SmDm"}parse(e){this.parseFullHeader(e),this.primaryRChromaticity_x=e.readUint16(),this.primaryRChromaticity_y=e.readUint16(),this.primaryGChromaticity_x=e.readUint16(),this.primaryGChromaticity_y=e.readUint16(),this.primaryBChromaticity_x=e.readUint16(),this.primaryBChromaticity_y=e.readUint16(),this.whitePointChromaticity_x=e.readUint16(),this.whitePointChromaticity_y=e.readUint16(),this.luminanceMax=e.readUint32(),this.luminanceMin=e.readUint32()}},Bo=class extends f{constructor(...e){super(...e),this.box_name="SamplingRateBox"}static{this.fourcc="srat"}parse(e){this.parseFullHeader(e),this.sampling_rate=e.readUint32()}},Uo=class extends f{constructor(...e){super(...e),this.box_name="DegradationPriorityBox"}static{this.fourcc="stdp"}parse(e){this.parseFullHeader(e);let t=(this.size-this.hdr_size)/2;this.priority=[];for(let i=0;i<t;i++)this.priority[i]=e.readUint16()}},ko=class extends f{constructor(...e){super(...e),this.box_name="SubTrackInformationBox"}static{this.fourcc="stri"}parse(e){this.parseFullHeader(e),this.switch_group=e.readUint16(),this.alternate_group=e.readUint16(),this.sub_track_id=e.readUint32();let t=(this.size-this.hdr_size-8)/4;this.attribute_list=[];for(let i=0;i<t;i++)this.attribute_list[i]=e.readUint32()}},Eo=class extends f{constructor(...e){super(...e),this.box_name="SubTrackSampleGroupBox"}static{this.fourcc="stsg"}parse(e){this.parseFullHeader(e),this.grouping_type=e.readUint32();let t=e.readUint16();this.group_description_index=[];for(let i=0;i<t;i++)this.group_description_index[i]=e.readUint32()}},To=class extends f{constructor(...e){super(...e),this.box_name="ShadowSyncSampleBox"}static{this.fourcc="stsh"}parse(e){this.parseFullHeader(e);let t=e.readUint32();if(this.shadowed_sample_numbers=[],this.sync_sample_numbers=[],this.version===0)for(let i=0;i<t;i++)this.shadowed_sample_numbers.push(e.readUint32()),this.sync_sample_numbers.push(e.readUint32())}write(e){this.version=0,this.flags=0,this.size=4+8*this.shadowed_sample_numbers.length,this.writeHeader(e),e.writeUint32(this.shadowed_sample_numbers.length);for(let t=0;t<this.shadowed_sample_numbers.length;t++)e.writeUint32(this.shadowed_sample_numbers[t]),e.writeUint32(this.sync_sample_numbers[t])}},Co=class extends f{constructor(...e){super(...e),this.box_name="SyncSampleBox"}static{this.fourcc="stss"}parse(e){this.parseFullHeader(e);let t=e.readUint32();if(this.version===0){this.sample_numbers=[];for(let i=0;i<t;i++)this.sample_numbers.push(e.readUint32())}}write(e){this.version=0,this.flags=0,this.size=4+4*this.sample_numbers.length,this.writeHeader(e),e.writeUint32(this.sample_numbers.length),e.writeUint32Array(this.sample_numbers)}},zo=class extends f{constructor(...e){super(...e),this.box_name="StereoVideoBox"}static{this.fourcc="stvi"}parse(e){this.parseFullHeader(e);let t=e.readUint32();this.single_view_allowed=t&3,this.stereo_scheme=e.readUint32();let i=e.readUint32();for(this.stereo_indication_type=e.readString(i),this.boxes=[];e.getPosition()<this.start+this.size;){let s=ie(e,!1,this.size-(e.getPosition()-this.start));if(s.code===1){let n=s.box;this.boxes.push(n),this[n.type]=n}else return}}},Io=class extends f{constructor(...e){super(...e),this.box_name="CompactSampleSizeBox"}static{this.fourcc="stz2"}parse(e){if(this.parseFullHeader(e),this.sample_sizes=[],this.version===0){this.reserved=e.readUint24(),this.field_size=e.readUint8();let t=e.readUint32();if(this.field_size===4)for(let i=0;i<t;i+=2){let s=e.readUint8();this.sample_sizes[i]=s>>4&15,this.sample_sizes[i+1]=s&15}else if(this.field_size===8)for(let i=0;i<t;i++)this.sample_sizes[i]=e.readUint8();else if(this.field_size===16)for(let i=0;i<t;i++)this.sample_sizes[i]=e.readUint16();else u.error("BoxParser","Error in length field in stz2 box",e.isofile)}}},Po=class extends f{constructor(...e){super(...e),this.box_name="SubSampleInformationBox"}static{this.fourcc="subs"}parse(e){this.parseFullHeader(e);let t=e.readUint32();this.entries=[];let i;for(let s=0;s<t;s++){let n={};if(this.entries[s]=n,n.sample_delta=e.readUint32(),n.subsamples=[],i=e.readUint16(),i>0)for(let r=0;r<i;r++){let a={};n.subsamples.push(a),this.version===1?a.size=e.readUint32():a.size=e.readUint16(),a.priority=e.readUint8(),a.discardable=e.readUint8(),a.codec_specific_parameters=e.readUint32()}}}},Ao=class extends f{constructor(...e){super(...e),this.box_name="TAIClockInfoBox"}static{this.fourcc="taic"}parse(e){this.time_uncertainty=e.readUint64(),this.clock_resolution=e.readUint32(),this.clock_drift_rate=e.readInt32();let t=e.readUint8();this.clock_type=(t&192)>>6}},Fo=class extends f{constructor(...e){super(...e),this.box_name="TrackEncryptionBox"}static{this.fourcc="tenc"}parse(e){if(this.parseFullHeader(e),e.readUint8(),this.version===0)e.readUint8();else{let t=e.readUint8();this.default_crypt_byte_block=t>>4&15,this.default_skip_byte_block=t&15}this.default_isProtected=e.readUint8(),this.default_Per_Sample_IV_Size=e.readUint8(),this.default_KID=me(e),this.default_isProtected===1&&this.default_Per_Sample_IV_Size===0&&(this.default_constant_IV_size=e.readUint8(),this.default_constant_IV=e.readUint8Array(this.default_constant_IV_size))}},Lo=class{},Do=class extends f{constructor(...e){super(...e),this.box_name="TrackFragmentRandomAccessBox"}static{this.fourcc="tfra"}parse(e){this.parseFullHeader(e),this.track_ID=e.readUint32(),e.readUint24();let t=e.readUint8();this.length_size_of_traf_num=t>>4&3,this.length_size_of_trun_num=t>>2&3,this.length_size_of_sample_num=t&3,this.entries=[];let i=e.readUint32();for(let s=0;s<i;s++){let n=new Lo;this.version===1?(n.time=e.readUint64(),n.moof_offset=e.readUint64()):(n.time=e.readUint32(),n.moof_offset=e.readUint32()),n.traf_number=e["readUint"+8*(this.length_size_of_traf_num+1)](),n.trun_number=e["readUint"+8*(this.length_size_of_trun_num+1)](),n.sample_delta=e["readUint"+8*(this.length_size_of_sample_num+1)](),this.entries.push(n)}}},Mo=class extends _{constructor(...e){super(...e),this.box_name="hintmaxrelativetime"}static{this.fourcc="tmax"}parse(e){this.time=e.readUint32()}},Ro=class extends _{constructor(...e){super(...e),this.box_name="hintminrelativetime"}static{this.fourcc="tmin"}parse(e){this.time=e.readUint32()}},Oo=class extends _{constructor(...e){super(...e),this.box_name="hintBytesSent"}static{this.fourcc="totl"}parse(e){this.bytessent=e.readUint32()}},No=class extends _{constructor(...e){super(...e),this.box_name="hintBytesSent"}static{this.fourcc="tpay"}parse(e){this.bytessent=e.readUint32()}},Ho=class extends _{constructor(...e){super(...e),this.box_name="hintBytesSent"}static{this.fourcc="tpyl"}parse(e){this.bytessent=e.readUint64()}},Go=class extends Ni{static{this.fourcc="msrc"}},Vo=class Kn extends _{constructor(...t){super(...t),this.box_name="TrackReferenceBox",this.references=[]}static{this.fourcc="tref"}static{this.allowed_types=["hint","cdsc","font","hind","vdep","vplx","subt","thmb","auxl","cdtg","shsc","aest"]}parse(t){for(;t.getPosition()<this.start+this.size;){let i=ie(t,!0,this.size-(t.getPosition()-this.start));if(i.code===1){Kn.allowed_types.includes(i.type)||u.warn("BoxParser",`Unknown track reference type: '${i.type}'`);let s=new Vi(i.type,i.size,i.hdr_size,i.start);s.write===_.prototype.write&&s.type!=="mdat"&&(u.info("BoxParser","TrackReference "+s.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),s.parseDataAndRewind(t)),s.parse(t),this.references.push(s)}else return}}},jo=class extends f{constructor(...e){super(...e),this.box_name="TrackExtensionPropertiesBox"}static{this.fourcc="trep"}parse(e){for(this.parseFullHeader(e),this.track_ID=e.readUint32(),this.boxes=[];e.getPosition()<this.start+this.size;){let t=ie(e,!1,this.size-(e.getPosition()-this.start));if(t.code===1){let i=t.box;this.boxes.push(i)}else return}}},$o=class extends _{constructor(...e){super(...e),this.box_name="hintBytesSent"}static{this.fourcc="trpy"}parse(e){this.bytessent=e.readUint64()}},qo=class extends f{constructor(...e){super(...e),this.box_name="TrackSelectionBox"}static{this.fourcc="tsel"}parse(e){this.parseFullHeader(e),this.switch_group=e.readUint32();let t=(this.size-this.hdr_size-4)/4;this.attribute_list=[];for(let i=0;i<t;i++)this.attribute_list[i]=e.readUint32()}},Wo=class extends f{constructor(...e){super(...e),this.box_name="TextConfigBox"}static{this.fourcc="txtc"}parse(e){this.parseFullHeader(e),this.config=e.readCString()}},Ko=class extends _{constructor(...e){super(...e),this.box_name="TypeCombinationBox"}static{this.fourcc="tyco"}parse(e){let t=(this.size-this.hdr_size)/4;this.compatible_brands=[];for(let i=0;i<t;i++)this.compatible_brands[i]=e.readString(4)}},Yo=class extends f{constructor(...e){super(...e),this.box_name="UserDescriptionProperty"}static{this.fourcc="udes"}parse(e){this.parseFullHeader(e),this.lang=e.readCString(),this.name=e.readCString(),this.description=e.readCString(),this.tags=e.readCString()}},Xo=class extends f{constructor(...e){super(...e),this.box_name="UncompressedFrameConfigBox"}static{this.fourcc="uncC"}parse(e){if(this.parseFullHeader(e),this.profile=e.readString(4),this.version!==1){if(this.version===0){this.component_count=e.readUint32(),this.component_index=[],this.component_bit_depth_minus_one=[],this.component_format=[],this.component_align_size=[];for(let i=0;i<this.component_count;i++)this.component_index.push(e.readUint16()),this.component_bit_depth_minus_one.push(e.readUint8()),this.component_format.push(e.readUint8()),this.component_align_size.push(e.readUint8());this.sampling_type=e.readUint8(),this.interleave_type=e.readUint8(),this.block_size=e.readUint8();let t=e.readUint8();this.component_little_endian=t>>7&1,this.block_pad_lsb=t>>6&1,this.block_little_endian=t>>5&1,this.block_reversed=t>>4&1,this.pad_unknown=t>>3&1,this.pixel_size=e.readUint32(),this.row_align_size=e.readUint32(),this.tile_align_size=e.readUint32(),this.num_tile_cols_minus_one=e.readUint32(),this.num_tile_rows_minus_one=e.readUint32()}}}},Qo=class extends f{constructor(...e){super(...e),this.box_name="DataEntryUrnBox"}static{this.fourcc="urn "}parse(e){this.parseFullHeader(e),this.name=e.readCString(),this.size-this.hdr_size-this.name.length-1>0&&(this.location=e.readCString())}write(e){this.version=0,this.flags=0,this.size=this.name.length+1+(this.location?this.location.length+1:0),this.writeHeader(e),e.writeCString(this.name),this.location&&e.writeCString(this.location)}},Zo=class extends _{constructor(...e){super(...e),this.box_name="WebVTTConfigurationBox"}static{this.fourcc="vttC"}parse(e){this.text=e.readString(this.size-this.hdr_size)}},Jo=class extends f{constructor(...e){super(...e),this.box_name="VvcNALUConfigBox"}static{this.fourcc="vvnC"}parse(e){this.parseFullHeader(e);let t=e.readUint8();this.lengthSizeMinusOne=t&3}},ec=class extends D{static{this.grouping_type="alst"}parse(e){let t=e.readUint16();this.first_output_sample=e.readUint16(),this.sample_offset=[];for(let s=0;s<t;s++)this.sample_offset[s]=e.readUint32();let i=this.description_length-4-4*t;this.num_output_samples=[],this.num_total_samples=[];for(let s=0;s<i/4;s++)this.num_output_samples[s]=e.readUint16(),this.num_total_samples[s]=e.readUint16()}},tc=class extends D{static{this.grouping_type="avll"}parse(e){this.layerNumber=e.readUint8(),this.accurateStatisticsFlag=e.readUint8(),this.avgBitRate=e.readUint16(),this.avgFrameRate=e.readUint16()}},ic=class extends D{static{this.grouping_type="avss"}parse(e){this.subSequenceIdentifier=e.readUint16(),this.layerNumber=e.readUint8();let t=e.readUint8();this.durationFlag=t>>7,this.avgRateFlag=t>>6&1,this.durationFlag&&(this.duration=e.readUint32()),this.avgRateFlag&&(this.accurateStatisticsFlag=e.readUint8(),this.avgBitRate=e.readUint16(),this.avgFrameRate=e.readUint16()),this.dependency=[];let i=e.readUint8();for(let s=0;s<i;s++)this.dependency.push({subSeqDirectionFlag:e.readUint8(),layerNumber:e.readUint8(),subSequenceIdentifier:e.readUint16()})}},sc=class extends D{static{this.grouping_type="dtrt"}parse(e){u.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}},nc=class extends D{static{this.grouping_type="mvif"}parse(e){u.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}},rc=class extends D{static{this.grouping_type="prol"}parse(e){this.roll_distance=e.readInt16()}},ac=class extends D{static{this.grouping_type="rap "}parse(e){let t=e.readUint8();this.num_leading_samples_known=t>>7,this.num_leading_samples=t&127}},oc=class extends D{static{this.grouping_type="rash"}parse(e){if(this.operation_point_count=e.readUint16(),this.description_length!==2+(this.operation_point_count===1?2:this.operation_point_count*6)+9)u.warn("BoxParser","Mismatch in "+this.grouping_type+" sample group length"),this.data=e.readUint8Array(this.description_length-2);else{if(this.operation_point_count===1)this.target_rate_share=e.readUint16();else{this.target_rate_share=[],this.available_bitrate=[];for(let t=0;t<this.operation_point_count;t++)this.available_bitrate[t]=e.readUint32(),this.target_rate_share[t]=e.readUint16()}this.maximum_bitrate=e.readUint32(),this.minimum_bitrate=e.readUint32(),this.discard_priority=e.readUint8()}}},cc=class extends D{static{this.grouping_type="roll"}parse(e){this.roll_distance=e.readInt16()}},lc=class extends D{static{this.grouping_type="scif"}parse(e){u.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}},hc=class extends D{static{this.grouping_type="scnm"}parse(e){u.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}},uc=class extends D{static{this.grouping_type="seig"}parse(e){this.reserved=e.readUint8();let t=e.readUint8();this.crypt_byte_block=t>>4,this.skip_byte_block=t&15,this.isProtected=e.readUint8(),this.Per_Sample_IV_Size=e.readUint8(),this.KID=me(e),this.constant_IV_size=0,this.constant_IV=0,this.isProtected===1&&this.Per_Sample_IV_Size===0&&(this.constant_IV_size=e.readUint8(),this.constant_IV=e.readUint8Array(this.constant_IV_size))}},dc=class extends D{static{this.grouping_type="stsa"}parse(e){u.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}},fc=class extends D{static{this.grouping_type="sync"}parse(e){let t=e.readUint8();this.NAL_unit_type=t&63}},pc=class extends D{static{this.grouping_type="tele"}parse(e){let t=e.readUint8();this.level_independently_decodable=t>>7}},_c=class extends D{static{this.grouping_type="tsas"}parse(e){u.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}},mc=class extends D{static{this.grouping_type="tscl"}parse(e){u.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}},xc=class extends D{static{this.grouping_type="vipr"}parse(e){u.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}},Yn=class extends _{static{this.fourcc="uuid"}},ze=class extends f{static{this.fourcc="uuid"}},gc=class extends ze{constructor(...e){super(...e),this.box_name="LiveServerManifestBox"}static{this.uuid="a5d40b30e81411ddba2f0800200c9a66"}parse(e){this.parseFullHeader(e),this.LiveServerManifest=e.readString(this.size-this.hdr_size).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}},bc=class extends ze{constructor(...e){super(...e),this.box_name="PiffProtectionSystemSpecificHeaderBox"}static{this.uuid="d08a4f1810f34a82b6c832d8aba183d3"}parse(e){this.parseFullHeader(e),this.system_id=me(e);let t=e.readUint32();t>0&&(this.data=e.readUint8Array(t))}},yc=class extends ze{constructor(...e){super(...e),this.box_name="PiffSampleEncryptionBox"}static{this.uuid="a2394f525a9b4f14a2446c427c648df4"}},vc=class extends ze{constructor(...e){super(...e),this.box_name="PiffTrackEncryptionBox"}static{this.uuid="8974dbce7be74c5184f97148f9882554"}parse(e){this.parseFullHeader(e),this.default_AlgorithmID=e.readUint24(),this.default_IV_size=e.readUint8(),this.default_KID=me(e)}},wc=class extends ze{constructor(...e){super(...e),this.box_name="TfrfBox"}static{this.uuid="d4807ef2ca3946958e5426cb9e46a79f"}parse(e){this.parseFullHeader(e),this.fragment_count=e.readUint8(),this.entries=[];for(let t=0;t<this.fragment_count;t++){let i=0,s=0;this.version===1?(i=e.readUint64(),s=e.readUint64()):(i=e.readUint32(),s=e.readUint32()),this.entries.push({absolute_time:i,absolute_duration:s})}}},Sc=class extends ze{constructor(...e){super(...e),this.box_name="TfxdBox"}static{this.uuid="6d1d9b0542d544e680e2141daff757b2"}parse(e){this.parseFullHeader(e),this.version===1?(this.absolute_time=e.readUint64(),this.duration=e.readUint64()):(this.absolute_time=e.readUint32(),this.duration=e.readUint32())}},Bc=class extends Yn{constructor(...e){super(...e),this.box_name="ItemContentIDProperty"}static{this.uuid="261ef3741d975bbaacbd9d2c8ea73522"}parse(e){this.content_id=e.readCString()}},Uc=class extends Yn{constructor(...e){super(...e),this.box_name="ItemComponentContentIDProperty"}static{this.uuid="9db9dd6e373c5a4e811021fc83a911fd"}parse(e){this.number_of_components=e.readUint32(),this.content_ids=[];for(let t=0;t<this.number_of_components;t++){let i=e.readCString();this.content_ids.push(i)}}},kc=St({CoLLBox:()=>Zr,ItemComponentContentIDPropertyBox:()=>Uc,ItemContentIDPropertyBox:()=>Bc,OpusSampleEntry:()=>gn,SmDmBox:()=>So,a1lxBox:()=>Or,a1opBox:()=>Nr,ac_3SampleEntry:()=>_n,ac_4SampleEntry:()=>mn,aebrBox:()=>_a,afbrBox:()=>ma,albcBox:()=>xa,alstSampleGroupEntry:()=>ec,altrBox:()=>ga,auxCBox:()=>Hr,av01SampleEntry:()=>Hs,av1CBox:()=>zs,avc1SampleEntry:()=>Ms,avc2SampleEntry:()=>Rs,avc3SampleEntry:()=>Os,avc4SampleEntry:()=>Ns,avcCBox:()=>Tt,avllSampleGroupEntry:()=>tc,avs3SampleEntry:()=>cn,avssSampleGroupEntry:()=>ic,brstBox:()=>ba,btrtBox:()=>Gr,bxmlBox:()=>es,ccstBox:()=>Vr,cdefBox:()=>jr,clapBox:()=>$r,clefBox:()=>oo,clliBox:()=>qr,cmexBox:()=>Wr,cminBox:()=>Kr,cmpCBox:()=>Yr,cmpdBox:()=>Xr,co64Box:()=>Qr,colrBox:()=>Ds,coviBox:()=>ta,cprtBox:()=>ia,cschBox:()=>sa,cslgBox:()=>na,cttsBox:()=>ra,dOpsBox:()=>da,dac3Box:()=>aa,dataBox:()=>He,dav1SampleEntry:()=>Gs,dec3Box:()=>oa,dfLaBox:()=>ca,dimmBox:()=>la,dinfBox:()=>At,dmax:()=>ha,dmedBox:()=>ua,dobrBox:()=>ya,drefBox:()=>Mt,drepBox:()=>fa,dtrtSampleGroupEntry:()=>sc,dvh1SampleEntry:()=>Qs,dvheSampleEntry:()=>Zs,ec_3SampleEntry:()=>xn,edtsBox:()=>is,elngBox:()=>Rt,elstBox:()=>pa,emsgBox:()=>Hn,encaSampleEntry:()=>Un,encmSampleEntry:()=>zn,encsSampleEntry:()=>En,enctSampleEntry:()=>Cn,encuSampleEntry:()=>kn,encvSampleEntry:()=>Bn,enofBox:()=>lo,eqivBox:()=>va,esdsBox:()=>Is,etypBox:()=>bs,fLaCSampleEntry:()=>Sn,favcBox:()=>wa,fielBox:()=>Pa,fobrBox:()=>Sa,freeBox:()=>Xi,frmaBox:()=>Aa,ftypBox:()=>Ot,grplBox:()=>xs,hdlrBox:()=>Nt,hev1SampleEntry:()=>$s,hev2SampleEntry:()=>qs,hinfBox:()=>os,hmhdBox:()=>Ct,hntiBox:()=>as,hvc1SampleEntry:()=>Vs,hvc2SampleEntry:()=>js,hvcCBox:()=>Ht,hvt1SampleEntry:()=>Ws,iaugBox:()=>Ba,idatBox:()=>Yi,iinfBox:()=>ws,ilocBox:()=>Ss,ilstBox:()=>ho,imirBox:()=>Fa,infeBox:()=>vs,iodsBox:()=>Zi,ipcoBox:()=>ms,ipmaBox:()=>La,iproBox:()=>ts,iprpBox:()=>_s,irefBox:()=>Bs,irotBox:()=>Da,ispeBox:()=>Ma,itaiBox:()=>Ra,j2kHBox:()=>gs,j2kiSampleEntry:()=>ln,keysBox:()=>uo,kindBox:()=>Oa,levaBox:()=>Na,lhe1SampleEntry:()=>Ks,lhv1SampleEntry:()=>Ys,lhvCBox:()=>Ha,lselBox:()=>Ga,lvc1SampleEntry:()=>Xs,lvcCBox:()=>As,m4aeSampleEntry:()=>pn,maxrBox:()=>Va,mdatBox:()=>Me,mdcvBox:()=>ja,mdhdBox:()=>Gt,mdiaBox:()=>It,mecoBox:()=>rs,mehdBox:()=>Vt,metaBox:()=>Es,mettSampleEntry:()=>Ts,metxSampleEntry:()=>Cs,mfhdBox:()=>jt,mfraBox:()=>ns,mfroBox:()=>$a,mha1SampleEntry:()=>bn,mha2SampleEntry:()=>yn,mhm1SampleEntry:()=>vn,mhm2SampleEntry:()=>wn,minfBox:()=>Pt,mjp2SampleEntry:()=>hn,mjpgSampleEntry:()=>un,moofBox:()=>Lt,moovBox:()=>Oe,mp4aSampleEntry:()=>qt,mp4sSampleEntry:()=>Tn,mp4vSampleEntry:()=>fn,mskCBox:()=>qa,msrcTrackGroupTypeBox:()=>Go,mvexBox:()=>st,mvhdBox:()=>$t,mvifSampleGroupEntry:()=>nc,nmhdBox:()=>Re,npckBox:()=>Wa,numpBox:()=>Ka,padbBox:()=>Xa,panoBox:()=>Ua,paspBox:()=>Qa,paylBox:()=>Za,paytBox:()=>Ja,pdinBox:()=>eo,piffLsmBox:()=>gc,piffPsshBox:()=>bc,piffSencBox:()=>yc,piffTencBox:()=>vc,piffTfrfBox:()=>wc,piffTfxdBox:()=>Sc,pitmBox:()=>ks,pixiBox:()=>to,pmaxBox:()=>io,povdBox:()=>ys,prdiBox:()=>so,prfrBox:()=>no,prftBox:()=>ro,prgrBox:()=>za,profBox:()=>fo,prolSampleGroupEntry:()=>rc,psshBox:()=>ao,pymdBox:()=>Ia,rapSampleGroupEntry:()=>ac,rashSampleGroupEntry:()=>oc,resvSampleEntry:()=>In,rinfBox:()=>us,rollSampleGroupEntry:()=>cc,rtp_Box:()=>_o,saioBox:()=>mo,saizBox:()=>xo,sbgpBox:()=>Dn,sbpmBox:()=>bo,sbttSampleEntry:()=>Pn,schiBox:()=>ds,schmBox:()=>yo,scifSampleGroupEntry:()=>lc,scnmSampleGroupEntry:()=>hc,sdp_Box:()=>vo,sdtpBox:()=>Mn,seigSampleGroupEntry:()=>uc,sencBox:()=>wo,sgpdBox:()=>Rn,sidxBox:()=>On,sinfBox:()=>hs,skipBox:()=>Qi,slidBox:()=>ka,smhdBox:()=>Kt,sratBox:()=>Bo,ssixBox:()=>Gn,stblBox:()=>Ft,stcoBox:()=>Yt,stdpBox:()=>Uo,sterBox:()=>Ea,sthdBox:()=>Xt,stppSampleEntry:()=>Wt,strdBox:()=>ls,striBox:()=>ko,strkBox:()=>cs,stsaSampleGroupEntry:()=>dc,stscBox:()=>Qt,stsdBox:()=>Zt,stsgBox:()=>Eo,stshBox:()=>To,stssBox:()=>Co,stszBox:()=>Jt,sttsBox:()=>ei,stviBox:()=>zo,stxtSampleEntry:()=>An,stypBox:()=>Vn,stz2Box:()=>Io,subsBox:()=>Po,syncSampleGroupEntry:()=>fc,taicBox:()=>Ao,taptBox:()=>po,teleSampleGroupEntry:()=>pc,tencBox:()=>Fo,tfdtBox:()=>ti,tfhdBox:()=>ii,tfraBox:()=>Do,tkhdBox:()=>si,tmaxBox:()=>Mo,tminBox:()=>Ro,totlBox:()=>Oo,tpayBox:()=>No,tpylBox:()=>Ho,trafBox:()=>Dt,trakBox:()=>zt,trefBox:()=>Vo,trepBox:()=>jo,trexBox:()=>nt,trgrBox:()=>fs,trpyBox:()=>$o,trunBox:()=>ni,tsasSampleGroupEntry:()=>_c,tsclSampleGroupEntry:()=>mc,tselBox:()=>qo,tsynBox:()=>Ta,tx3gSampleEntry:()=>Fn,txtcBox:()=>Wo,tycoBox:()=>Ko,udesBox:()=>Yo,udtaBox:()=>ps,uncCBox:()=>Xo,uncvSampleEntry:()=>dn,urlBox:()=>ri,urnBox:()=>Qo,viprSampleGroupEntry:()=>xc,vmhdBox:()=>ai,vp08SampleEntry:()=>an,vp09SampleEntry:()=>on,vpcCBox:()=>Fs,vttCBox:()=>Zo,vttcBox:()=>ss,vvc1SampleEntry:()=>en,vvcCBox:()=>Ls,vvcNSampleEntry:()=>nn,vvi1SampleEntry:()=>tn,vvnCBox:()=>Jo,vvs1SampleEntry:()=>sn,waveBox:()=>Ps,wbbrBox:()=>Ca,wvttSampleEntry:()=>Ln,xmlBox:()=>Ji}),Md=qi(kc);Wi(Ar);var bi=(e,t,i)=>{if(!t.has(e))throw TypeError("Cannot "+i)},l=(e,t,i)=>(bi(e,t,"read from private field"),i?i.call(e):t.get(e)),w=(e,t,i)=>{if(t.has(e))throw TypeError("Cannot add the same private member more than once");t instanceof WeakSet?t.add(e):t.set(e,i)},j=(e,t,i,s)=>(bi(e,t,"write to private field"),s?s.call(e,i):t.set(e,i),i),Ec=(e,t,i,s)=>({set _(n){j(e,t,n,i)},get _(){return l(e,t,s)}}),B=(e,t,i)=>(bi(e,t,"access private method"),i),k=new Uint8Array(8),ce=new DataView(k.buffer),O=e=>[(e%256+256)%256],C=e=>(ce.setUint16(0,e,!1),[k[0],k[1]]),Tc=e=>(ce.setInt16(0,e,!1),[k[0],k[1]]),Qn=e=>(ce.setUint32(0,e,!1),[k[1],k[2],k[3]]),m=e=>(ce.setUint32(0,e,!1),[k[0],k[1],k[2],k[3]]),Cc=e=>(ce.setInt32(0,e,!1),[k[0],k[1],k[2],k[3]]),Te=e=>(ce.setUint32(0,Math.floor(e/2**32),!1),ce.setUint32(4,e,!1),[k[0],k[1],k[2],k[3],k[4],k[5],k[6],k[7]]),yi=e=>(ce.setInt16(0,2**8*e,!1),[k[0],k[1]]),ae=e=>(ce.setInt32(0,2**16*e,!1),[k[0],k[1],k[2],k[3]]),li=e=>(ce.setInt32(0,2**30*e,!1),[k[0],k[1],k[2],k[3]]),ee=(e,t=!1)=>{let i=Array(e.length).fill(null).map((s,n)=>e.charCodeAt(n));return t&&i.push(0),i},mt=e=>e&&e[e.length-1],vi=e=>{let t;for(let i of e)(!t||i.presentationTimestamp>t.presentationTimestamp)&&(t=i);return t},oe=(e,t,i=!0)=>{let s=e*t;return i?Math.round(s):s},Zn=e=>{let t=e*(Math.PI/180),i=Math.cos(t),s=Math.sin(t);return[i,s,0,-s,i,0,0,0,1]},Jn=Zn(0),er=e=>[ae(e[0]),ae(e[1]),li(e[2]),ae(e[3]),ae(e[4]),li(e[5]),ae(e[6]),ae(e[7]),li(e[8])],je=e=>!e||typeof e!="object"?e:Array.isArray(e)?e.map(je):Object.fromEntries(Object.entries(e).map(([t,i])=>[t,je(i)])),Fe=e=>e>=0&&e<2**32,R=(e,t,i)=>({type:e,contents:t&&new Uint8Array(t.flat(10)),children:i}),A=(e,t,i,s,n)=>R(e,[O(t),Qn(i),s??[]],n),zc=e=>{let t=512;return e.fragmented?R("ftyp",[ee("iso5"),m(t),ee("iso5"),ee("iso6"),ee("mp41")]):R("ftyp",[ee("isom"),m(t),ee("isom"),e.holdsAvc?ee("avc1"):[],ee("mp41")])},hi=e=>({type:"mdat",largeSize:e}),Ic=e=>({type:"free",size:e}),ut=(e,t,i=!1)=>R("moov",null,[Pc(t,e),...e.map(s=>Ac(s,t)),i?hl(e):null]),Pc=(e,t)=>{let i=oe(Math.max(0,...t.filter(a=>a.samples.length>0).map(a=>{let o=vi(a.samples);return o.presentationTimestamp+o.duration})),fi),s=Math.max(...t.map(a=>a.id))+1,n=!Fe(e)||!Fe(i),r=n?Te:m;return A("mvhd",+n,0,[r(e),r(e),m(fi),r(i),ae(1),yi(1),Array(10).fill(0),er(Jn),Array(24).fill(0),m(s)])},Ac=(e,t)=>R("trak",null,[Fc(e,t),Lc(e,t)]),Fc=(e,t)=>{let i=vi(e.samples),s=oe(i?i.presentationTimestamp+i.duration:0,fi),n=!Fe(t)||!Fe(s),r=n?Te:m,a;return e.info.type==="video"?a=typeof e.info.rotation=="number"?Zn(e.info.rotation):e.info.rotation:a=Jn,A("tkhd",+n,3,[r(t),r(t),m(e.id),m(0),r(s),Array(8).fill(0),C(0),C(0),yi(e.info.type==="audio"?1:0),C(0),er(a),ae(e.info.type==="video"?e.info.width:0),ae(e.info.type==="video"?e.info.height:0)])},Lc=(e,t)=>R("mdia",null,[Dc(e,t),Mc(e.info.type==="video"?"vide":"soun"),Rc(e)]),Dc=(e,t)=>{let i=vi(e.samples),s=oe(i?i.presentationTimestamp+i.duration:0,e.timescale),n=!Fe(t)||!Fe(s),r=n?Te:m;return A("mdhd",+n,0,[r(t),r(t),m(e.timescale),r(s),C(21956),C(0)])},Mc=e=>A("hdlr",0,0,[ee("mhlr"),ee(e),m(0),m(0),m(0),ee("mp4-muxer-hdlr",!0)]),Rc=e=>R("minf",null,[e.info.type==="video"?Oc():Nc(),Hc(),jc(e)]),Oc=()=>A("vmhd",0,1,[C(0),C(0),C(0),C(0)]),Nc=()=>A("smhd",0,0,[C(0),C(0)]),Hc=()=>R("dinf",null,[Gc()]),Gc=()=>A("dref",0,0,[m(1)],[Vc()]),Vc=()=>A("url ",0,1),jc=e=>{let t=e.compositionTimeOffsetTable.length>1||e.compositionTimeOffsetTable.some(i=>i.sampleCompositionTimeOffset!==0);return R("stbl",null,[$c(e),nl(e),rl(e),al(e),ol(e),cl(e),t?ll(e):null])},$c=e=>A("stsd",0,0,[m(1)],[e.info.type==="video"?qc(yl[e.info.codec],e):tl(wl[e.info.codec],e)]),qc=(e,t)=>R(e,[Array(6).fill(0),C(1),C(0),C(0),Array(12).fill(0),C(t.info.width),C(t.info.height),m(4718592),m(4718592),m(0),C(1),Array(32).fill(0),C(24),Tc(65535)],[vl[t.info.codec](t),t.info.decoderConfig.colorSpace?Xc(t):null]),Wc={bt709:1,bt470bg:5,smpte170m:6},Kc={bt709:1,smpte170m:6,"iec61966-2-1":13},Yc={rgb:0,bt709:1,bt470bg:5,smpte170m:6},Xc=e=>R("colr",[ee("nclx"),C(Wc[e.info.decoderConfig.colorSpace.primaries]),C(Kc[e.info.decoderConfig.colorSpace.transfer]),C(Yc[e.info.decoderConfig.colorSpace.matrix]),O((e.info.decoderConfig.colorSpace.fullRange?1:0)<<7)]),Qc=e=>e.info.decoderConfig&&R("avcC",[...new Uint8Array(e.info.decoderConfig.description)]),Zc=e=>e.info.decoderConfig&&R("hvcC",[...new Uint8Array(e.info.decoderConfig.description)]),Jc=e=>{if(!e.info.decoderConfig)return null;let t=e.info.decoderConfig;if(!t.colorSpace)throw new Error("'colorSpace' is required in the decoder config for VP9.");let i=t.codec.split("."),s=Number(i[1]),n=Number(i[2]),o=(Number(i[3])<<4)+(0<<1)+Number(t.colorSpace.fullRange);return A("vpcC",1,0,[O(s),O(n),O(o),O(2),O(2),O(2),C(0)])},el=()=>{let i=(1<<7)+1;return R("av1C",[i,0,0,0])},tl=(e,t)=>R(e,[Array(6).fill(0),C(1),C(0),C(0),m(0),C(t.info.numberOfChannels),C(16),C(0),C(0),ae(t.info.sampleRate)],[Sl[t.info.codec](t)]),il=e=>{let t=new Uint8Array(e.info.decoderConfig.description);return A("esds",0,0,[m(58753152),O(32+t.byteLength),C(1),O(0),m(75530368),O(18+t.byteLength),O(64),O(21),Qn(0),m(130071),m(130071),m(92307584),O(t.byteLength),...t,m(109084800),O(1),O(2)])},sl=e=>{let t=3840,i=0,s=e.info.decoderConfig?.description;if(s){if(s.byteLength<18)throw new TypeError("Invalid decoder description provided for Opus; must be at least 18 bytes long.");let n=ArrayBuffer.isView(s)?new DataView(s.buffer,s.byteOffset,s.byteLength):new DataView(s);t=n.getUint16(10,!0),i=n.getInt16(14,!0)}return R("dOps",[O(0),O(e.info.numberOfChannels),C(t),m(e.info.sampleRate),yi(i),O(0)])},nl=e=>A("stts",0,0,[m(e.timeToSampleTable.length),e.timeToSampleTable.map(t=>[m(t.sampleCount),m(t.sampleDelta)])]),rl=e=>{if(e.samples.every(i=>i.type==="key"))return null;let t=[...e.samples.entries()].filter(([,i])=>i.type==="key");return A("stss",0,0,[m(t.length),t.map(([i])=>m(i+1))])},al=e=>A("stsc",0,0,[m(e.compactlyCodedChunkTable.length),e.compactlyCodedChunkTable.map(t=>[m(t.firstChunk),m(t.samplesPerChunk),m(1)])]),ol=e=>A("stsz",0,0,[m(0),m(e.samples.length),e.samples.map(t=>m(t.size))]),cl=e=>e.finalizedChunks.length>0&&mt(e.finalizedChunks).offset>=2**32?A("co64",0,0,[m(e.finalizedChunks.length),e.finalizedChunks.map(t=>Te(t.offset))]):A("stco",0,0,[m(e.finalizedChunks.length),e.finalizedChunks.map(t=>m(t.offset))]),ll=e=>A("ctts",0,0,[m(e.compositionTimeOffsetTable.length),e.compositionTimeOffsetTable.map(t=>[m(t.sampleCount),m(t.sampleCompositionTimeOffset)])]),hl=e=>R("mvex",null,e.map(ul)),ul=e=>A("trex",0,0,[m(e.id),m(1),m(0),m(0),m(0)]),Xn=(e,t)=>R("moof",null,[dl(e),...t.map(fl)]),dl=e=>A("mfhd",0,0,[m(e)]),tr=e=>{let t=0,i=0,s=0,n=0,r=e.type==="delta";return i|=+r,r?t|=1:t|=2,t<<24|i<<16|s<<8|n},fl=e=>R("traf",null,[pl(e),_l(e),ml(e)]),pl=e=>{let t=0;t|=8,t|=16,t|=32,t|=131072;let i=e.currentChunk.samples[1]??e.currentChunk.samples[0],s={duration:i.timescaleUnitsToNextSample,size:i.size,flags:tr(i)};return A("tfhd",0,t,[m(e.id),m(s.duration),m(s.size),m(s.flags)])},_l=e=>A("tfdt",1,0,[Te(oe(e.currentChunk.startTimestamp,e.timescale))]),ml=e=>{let t=e.currentChunk.samples.map(v=>v.timescaleUnitsToNextSample),i=e.currentChunk.samples.map(v=>v.size),s=e.currentChunk.samples.map(tr),n=e.currentChunk.samples.map(v=>oe(v.presentationTimestamp-v.decodeTimestamp,e.timescale)),r=new Set(t),a=new Set(i),o=new Set(s),c=new Set(n),h=o.size===2&&s[0]!==s[1],d=r.size>1,p=a.size>1,x=!h&&o.size>1,b=c.size>1||[...c].some(v=>v!==0),U=0;return U|=1,U|=4*+h,U|=256*+d,U|=512*+p,U|=1024*+x,U|=2048*+b,A("trun",1,U,[m(e.currentChunk.samples.length),m(e.currentChunk.offset-e.currentChunk.moofOffset||0),h?m(s[0]):[],e.currentChunk.samples.map((v,z)=>[d?m(t[z]):[],p?m(i[z]):[],x?m(s[z]):[],b?Cc(n[z]):[]])])},xl=e=>R("mfra",null,[...e.map(gl),bl()]),gl=(e,t)=>A("tfra",1,0,[m(e.id),m(63),m(e.finalizedChunks.length),e.finalizedChunks.map(s=>[Te(oe(s.startTimestamp,e.timescale)),Te(s.moofOffset),m(t+1),m(1),m(1)])]),bl=()=>A("mfro",0,0,[m(0)]),yl={avc:"avc1",hevc:"hvc1",vp9:"vp09",av1:"av01"},vl={avc:Qc,hevc:Zc,vp9:Jc,av1:el},wl={aac:"mp4a",opus:"Opus"},Sl={aac:il,opus:sl},F_=Symbol("isTarget"),wt=class{},wi=class extends wt{constructor(){super(...arguments),this.buffer=null}},ir=class extends wt{constructor(e){if(super(),this.options=e,typeof e!="object")throw new TypeError("StreamTarget requires an options object to be passed to its constructor.");if(e.onData){if(typeof e.onData!="function")throw new TypeError("options.onData, when provided, must be a function.");if(e.onData.length<2)throw new TypeError("options.onData, when provided, must be a function that takes in at least two arguments (data and position). Ignoring the position argument, which specifies the byte offset at which the data is to be written, can lead to broken outputs.")}if(e.chunked!==void 0&&typeof e.chunked!="boolean")throw new TypeError("options.chunked, when provided, must be a boolean.");if(e.chunkSize!==void 0&&(!Number.isInteger(e.chunkSize)||e.chunkSize<1024))throw new TypeError("options.chunkSize, when provided, must be an integer and not smaller than 1024.")}},Bl=class extends wt{constructor(e,t){if(super(),this.stream=e,this.options=t,!(e instanceof FileSystemWritableFileStream))throw new TypeError("FileSystemWritableFileStreamTarget requires a FileSystemWritableFileStream instance.");if(t!==void 0&&typeof t!="object")throw new TypeError("FileSystemWritableFileStreamTarget's options, when provided, must be an object.");if(t&&t.chunkSize!==void 0&&(!Number.isInteger(t.chunkSize)||t.chunkSize<=0))throw new TypeError("options.chunkSize, when provided, must be a positive integer")}},Se,Ie,sr=class{constructor(){this.pos=0,w(this,Se,new Uint8Array(8)),w(this,Ie,new DataView(l(this,Se).buffer)),this.offsets=new WeakMap}seek(e){this.pos=e}writeU32(e){l(this,Ie).setUint32(0,e,!1),this.write(l(this,Se).subarray(0,4))}writeU64(e){l(this,Ie).setUint32(0,Math.floor(e/2**32),!1),l(this,Ie).setUint32(4,e,!1),this.write(l(this,Se).subarray(0,8))}writeAscii(e){for(let t=0;t<e.length;t++)l(this,Ie).setUint8(t%8,e.charCodeAt(t)),t%8===7&&this.write(l(this,Se));e.length%8!==0&&this.write(l(this,Se).subarray(0,e.length%8))}writeBox(e){if(this.offsets.set(e,this.pos),e.contents&&!e.children)this.writeBoxHeader(e,e.size??e.contents.byteLength+8),this.write(e.contents);else{let t=this.pos;if(this.writeBoxHeader(e,0),e.contents&&this.write(e.contents),e.children)for(let n of e.children)n&&this.writeBox(n);let i=this.pos,s=e.size??i-t;this.seek(t),this.writeBoxHeader(e,s),this.seek(i)}}writeBoxHeader(e,t){this.writeU32(e.largeSize?1:t),this.writeAscii(e.type),e.largeSize&&this.writeU64(t)}measureBoxHeader(e){return 8+(e.largeSize?8:0)}patchBox(e){let t=this.pos;this.seek(this.offsets.get(e)),this.writeBox(e),this.seek(t)}measureBox(e){if(e.contents&&!e.children)return this.measureBoxHeader(e)+e.contents.byteLength;{let t=this.measureBoxHeader(e);if(e.contents&&(t+=e.contents.byteLength),e.children)for(let i of e.children)i&&(t+=this.measureBox(i));return t}}};Se=new WeakMap;Ie=new WeakMap;var dt,Ee,Ye,Ge,ft,ui,Ul=class extends sr{constructor(e){super(),w(this,ft),w(this,dt,void 0),w(this,Ee,new ArrayBuffer(2**16)),w(this,Ye,new Uint8Array(l(this,Ee))),w(this,Ge,0),j(this,dt,e)}write(e){B(this,ft,ui).call(this,this.pos+e.byteLength),l(this,Ye).set(e,this.pos),this.pos+=e.byteLength,j(this,Ge,Math.max(l(this,Ge),this.pos))}finalize(){B(this,ft,ui).call(this,this.pos),l(this,dt).buffer=l(this,Ee).slice(0,Math.max(l(this,Ge),this.pos))}};dt=new WeakMap;Ee=new WeakMap;Ye=new WeakMap;Ge=new WeakMap;ft=new WeakSet;ui=function(e){let t=l(this,Ee).byteLength;for(;t<e;)t*=2;if(t===l(this,Ee).byteLength)return;let i=new ArrayBuffer(t),s=new Uint8Array(i);s.set(l(this,Ye),0),j(this,Ee,i),j(this,Ye,s)};var kl=2**24,El=2,$e,Be,Ve,fe,J,xt,di,Si,nr,Bi,rr,qe,gt,Ui=class extends sr{constructor(e){super(),w(this,xt),w(this,Si),w(this,Bi),w(this,qe),w(this,$e,void 0),w(this,Be,[]),w(this,Ve,void 0),w(this,fe,void 0),w(this,J,[]),j(this,$e,e),j(this,Ve,e.options?.chunked??!1),j(this,fe,e.options?.chunkSize??kl)}write(e){l(this,Be).push({data:e.slice(),start:this.pos}),this.pos+=e.byteLength}flush(){if(l(this,Be).length===0)return;let e=[],t=[...l(this,Be)].sort((i,s)=>i.start-s.start);e.push({start:t[0].start,size:t[0].data.byteLength});for(let i=1;i<t.length;i++){let s=e[e.length-1],n=t[i];n.start<=s.start+s.size?s.size=Math.max(s.size,n.start+n.data.byteLength-s.start):e.push({start:n.start,size:n.data.byteLength})}for(let i of e){i.data=new Uint8Array(i.size);for(let s of l(this,Be))i.start<=s.start&&s.start<i.start+i.size&&i.data.set(s.data,s.start-i.start);l(this,Ve)?(B(this,xt,di).call(this,i.data,i.start),B(this,qe,gt).call(this)):l(this,$e).options.onData?.(i.data,i.start)}l(this,Be).length=0}finalize(){l(this,Ve)&&B(this,qe,gt).call(this,!0)}};$e=new WeakMap;Be=new WeakMap;Ve=new WeakMap;fe=new WeakMap;J=new WeakMap;xt=new WeakSet;di=function(e,t){let i=l(this,J).findIndex(o=>o.start<=t&&t<o.start+l(this,fe));i===-1&&(i=B(this,Bi,rr).call(this,t));let s=l(this,J)[i],n=t-s.start,r=e.subarray(0,Math.min(l(this,fe)-n,e.byteLength));s.data.set(r,n);let a={start:n,end:n+r.byteLength};if(B(this,Si,nr).call(this,s,a),s.written[0].start===0&&s.written[0].end===l(this,fe)&&(s.shouldFlush=!0),l(this,J).length>El){for(let o=0;o<l(this,J).length-1;o++)l(this,J)[o].shouldFlush=!0;B(this,qe,gt).call(this)}r.byteLength<e.byteLength&&B(this,xt,di).call(this,e.subarray(r.byteLength),t+r.byteLength)};Si=new WeakSet;nr=function(e,t){let i=0,s=e.written.length-1,n=-1;for(;i<=s;){let r=Math.floor(i+(s-i+1)/2);e.written[r].start<=t.start?(i=r+1,n=r):s=r-1}for(e.written.splice(n+1,0,t),(n===-1||e.written[n].end<t.start)&&n++;n<e.written.length-1&&e.written[n].end>=e.written[n+1].start;)e.written[n].end=Math.max(e.written[n].end,e.written[n+1].end),e.written.splice(n+1,1)};Bi=new WeakSet;rr=function(e){let i={start:Math.floor(e/l(this,fe))*l(this,fe),data:new Uint8Array(l(this,fe)),written:[],shouldFlush:!1};return l(this,J).push(i),l(this,J).sort((s,n)=>s.start-n.start),l(this,J).indexOf(i)};qe=new WeakSet;gt=function(e=!1){for(let t=0;t<l(this,J).length;t++){let i=l(this,J)[t];if(!(!i.shouldFlush&&!e)){for(let s of i.written)l(this,$e).options.onData?.(i.data.subarray(s.start,s.end),i.start+s.start);l(this,J).splice(t--,1)}}};var Tl=class extends Ui{constructor(e){super(new ir({onData:(t,i)=>e.stream.write({type:"write",data:t,position:i}),chunked:!0,chunkSize:e.options?.chunkSize}))}},fi=1e3,Cl=["avc","hevc","vp9","av1"],zl=["aac","opus"],Il=2082844800,Pl=["strict","offset","cross-track-offset"],g,y,bt,Z,W,V,Pe,Ae,ki,Ue,ke,We,pi,ar,_i,or,Ei,cr,mi,lr,Ti,hr,pt,xi,re,de,Ci,ur,Ke,yt,vt,zi,Le,Xe,_t,gi,dr=class{constructor(e){if(w(this,pi),w(this,_i),w(this,Ei),w(this,mi),w(this,Ti),w(this,pt),w(this,re),w(this,Ci),w(this,Ke),w(this,vt),w(this,Le),w(this,_t),w(this,g,void 0),w(this,y,void 0),w(this,bt,void 0),w(this,Z,void 0),w(this,W,null),w(this,V,null),w(this,Pe,Math.floor(Date.now()/1e3)+Il),w(this,Ae,[]),w(this,ki,1),w(this,Ue,[]),w(this,ke,[]),w(this,We,!1),B(this,pi,ar).call(this,e),e.video=je(e.video),e.audio=je(e.audio),e.fastStart=je(e.fastStart),this.target=e.target,j(this,g,{firstTimestampBehavior:"strict",...e}),e.target instanceof wi)j(this,y,new Ul(e.target));else if(e.target instanceof ir)j(this,y,new Ui(e.target));else if(e.target instanceof Bl)j(this,y,new Tl(e.target));else throw new Error(`Invalid target: ${e.target}`);B(this,mi,lr).call(this),B(this,_i,or).call(this)}addVideoChunk(e,t,i,s){if(!(e instanceof EncodedVideoChunk))throw new TypeError("addVideoChunk's first argument (sample) must be of type EncodedVideoChunk.");if(t&&typeof t!="object")throw new TypeError("addVideoChunk's second argument (meta), when provided, must be an object.");if(i!==void 0&&(!Number.isFinite(i)||i<0))throw new TypeError("addVideoChunk's third argument (timestamp), when provided, must be a non-negative real number.");if(s!==void 0&&!Number.isFinite(s))throw new TypeError("addVideoChunk's fourth argument (compositionTimeOffset), when provided, must be a real number.");let n=new Uint8Array(e.byteLength);e.copyTo(n),this.addVideoChunkRaw(n,e.type,i??e.timestamp,e.duration,t,s)}addVideoChunkRaw(e,t,i,s,n,r){if(!(e instanceof Uint8Array))throw new TypeError("addVideoChunkRaw's first argument (data) must be an instance of Uint8Array.");if(t!=="key"&&t!=="delta")throw new TypeError("addVideoChunkRaw's second argument (type) must be either 'key' or 'delta'.");if(!Number.isFinite(i)||i<0)throw new TypeError("addVideoChunkRaw's third argument (timestamp) must be a non-negative real number.");if(!Number.isFinite(s)||s<0)throw new TypeError("addVideoChunkRaw's fourth argument (duration) must be a non-negative real number.");if(n&&typeof n!="object")throw new TypeError("addVideoChunkRaw's fifth argument (meta), when provided, must be an object.");if(r!==void 0&&!Number.isFinite(r))throw new TypeError("addVideoChunkRaw's sixth argument (compositionTimeOffset), when provided, must be a real number.");if(B(this,_t,gi).call(this),!l(this,g).video)throw new Error("No video track declared.");if(typeof l(this,g).fastStart=="object"&&l(this,W).samples.length===l(this,g).fastStart.expectedVideoChunks)throw new Error(`Cannot add more video chunks than specified in 'fastStart' (${l(this,g).fastStart.expectedVideoChunks}).`);let a=B(this,pt,xi).call(this,l(this,W),e,t,i,s,n,r);if(l(this,g).fastStart==="fragmented"&&l(this,V)){for(;l(this,ke).length>0&&l(this,ke)[0].decodeTimestamp<=a.decodeTimestamp;){let o=l(this,ke).shift();B(this,re,de).call(this,l(this,V),o)}a.decodeTimestamp<=l(this,V).lastDecodeTimestamp?B(this,re,de).call(this,l(this,W),a):l(this,Ue).push(a)}else B(this,re,de).call(this,l(this,W),a)}addAudioChunk(e,t,i){if(!(e instanceof EncodedAudioChunk))throw new TypeError("addAudioChunk's first argument (sample) must be of type EncodedAudioChunk.");if(t&&typeof t!="object")throw new TypeError("addAudioChunk's second argument (meta), when provided, must be an object.");if(i!==void 0&&(!Number.isFinite(i)||i<0))throw new TypeError("addAudioChunk's third argument (timestamp), when provided, must be a non-negative real number.");let s=new Uint8Array(e.byteLength);e.copyTo(s),this.addAudioChunkRaw(s,e.type,i??e.timestamp,e.duration,t)}addAudioChunkRaw(e,t,i,s,n){if(!(e instanceof Uint8Array))throw new TypeError("addAudioChunkRaw's first argument (data) must be an instance of Uint8Array.");if(t!=="key"&&t!=="delta")throw new TypeError("addAudioChunkRaw's second argument (type) must be either 'key' or 'delta'.");if(!Number.isFinite(i)||i<0)throw new TypeError("addAudioChunkRaw's third argument (timestamp) must be a non-negative real number.");if(!Number.isFinite(s)||s<0)throw new TypeError("addAudioChunkRaw's fourth argument (duration) must be a non-negative real number.");if(n&&typeof n!="object")throw new TypeError("addAudioChunkRaw's fifth argument (meta), when provided, must be an object.");if(B(this,_t,gi).call(this),!l(this,g).audio)throw new Error("No audio track declared.");if(typeof l(this,g).fastStart=="object"&&l(this,V).samples.length===l(this,g).fastStart.expectedAudioChunks)throw new Error(`Cannot add more audio chunks than specified in 'fastStart' (${l(this,g).fastStart.expectedAudioChunks}).`);let r=B(this,pt,xi).call(this,l(this,V),e,t,i,s,n);if(l(this,g).fastStart==="fragmented"&&l(this,W)){for(;l(this,Ue).length>0&&l(this,Ue)[0].decodeTimestamp<=r.decodeTimestamp;){let a=l(this,Ue).shift();B(this,re,de).call(this,l(this,W),a)}r.decodeTimestamp<=l(this,W).lastDecodeTimestamp?B(this,re,de).call(this,l(this,V),r):l(this,ke).push(r)}else B(this,re,de).call(this,l(this,V),r)}finalize(){if(l(this,We))throw new Error("Cannot finalize a muxer more than once.");if(l(this,g).fastStart==="fragmented"){for(let t of l(this,Ue))B(this,re,de).call(this,l(this,W),t);for(let t of l(this,ke))B(this,re,de).call(this,l(this,V),t);B(this,vt,zi).call(this,!1)}else l(this,W)&&B(this,Ke,yt).call(this,l(this,W)),l(this,V)&&B(this,Ke,yt).call(this,l(this,V));let e=[l(this,W),l(this,V)].filter(Boolean);if(l(this,g).fastStart==="in-memory"){let t;for(let s=0;s<2;s++){let n=ut(e,l(this,Pe)),r=l(this,y).measureBox(n);t=l(this,y).measureBox(l(this,Z));let a=l(this,y).pos+r+t;for(let o of l(this,Ae)){o.offset=a;for(let{data:c}of o.samples)a+=c.byteLength,t+=c.byteLength}if(a<2**32)break;t>=2**32&&(l(this,Z).largeSize=!0)}let i=ut(e,l(this,Pe));l(this,y).writeBox(i),l(this,Z).size=t,l(this,y).writeBox(l(this,Z));for(let s of l(this,Ae))for(let n of s.samples)l(this,y).write(n.data),n.data=null}else if(l(this,g).fastStart==="fragmented"){let t=l(this,y).pos,i=xl(e);l(this,y).writeBox(i);let s=l(this,y).pos-t;l(this,y).seek(l(this,y).pos-4),l(this,y).writeU32(s)}else{let t=l(this,y).offsets.get(l(this,Z)),i=l(this,y).pos-t;l(this,Z).size=i,l(this,Z).largeSize=i>=2**32,l(this,y).patchBox(l(this,Z));let s=ut(e,l(this,Pe));if(typeof l(this,g).fastStart=="object"){l(this,y).seek(l(this,bt)),l(this,y).writeBox(s);let n=t-l(this,y).pos;l(this,y).writeBox(Ic(n))}else l(this,y).writeBox(s)}B(this,Le,Xe).call(this),l(this,y).finalize(),j(this,We,!0)}};g=new WeakMap;y=new WeakMap;bt=new WeakMap;Z=new WeakMap;W=new WeakMap;V=new WeakMap;Pe=new WeakMap;Ae=new WeakMap;ki=new WeakMap;Ue=new WeakMap;ke=new WeakMap;We=new WeakMap;pi=new WeakSet;ar=function(e){if(typeof e!="object")throw new TypeError("The muxer requires an options object to be passed to its constructor.");if(!(e.target instanceof wt))throw new TypeError("The target must be provided and an instance of Target.");if(e.video){if(!Cl.includes(e.video.codec))throw new TypeError(`Unsupported video codec: ${e.video.codec}`);if(!Number.isInteger(e.video.width)||e.video.width<=0)throw new TypeError(`Invalid video width: ${e.video.width}. Must be a positive integer.`);if(!Number.isInteger(e.video.height)||e.video.height<=0)throw new TypeError(`Invalid video height: ${e.video.height}. Must be a positive integer.`);let t=e.video.rotation;if(typeof t=="number"&&![0,90,180,270].includes(t))throw new TypeError(`Invalid video rotation: ${t}. Has to be 0, 90, 180 or 270.`);if(Array.isArray(t)&&(t.length!==9||t.some(i=>typeof i!="number")))throw new TypeError(`Invalid video transformation matrix: ${t.join()}`);if(e.video.frameRate!==void 0&&(!Number.isInteger(e.video.frameRate)||e.video.frameRate<=0))throw new TypeError(`Invalid video frame rate: ${e.video.frameRate}. Must be a positive integer.`)}if(e.audio){if(!zl.includes(e.audio.codec))throw new TypeError(`Unsupported audio codec: ${e.audio.codec}`);if(!Number.isInteger(e.audio.numberOfChannels)||e.audio.numberOfChannels<=0)throw new TypeError(`Invalid number of audio channels: ${e.audio.numberOfChannels}. Must be a positive integer.`);if(!Number.isInteger(e.audio.sampleRate)||e.audio.sampleRate<=0)throw new TypeError(`Invalid audio sample rate: ${e.audio.sampleRate}. Must be a positive integer.`)}if(e.firstTimestampBehavior&&!Pl.includes(e.firstTimestampBehavior))throw new TypeError(`Invalid first timestamp behavior: ${e.firstTimestampBehavior}`);if(typeof e.fastStart=="object"){if(e.video){if(e.fastStart.expectedVideoChunks===void 0)throw new TypeError("'fastStart' is an object but is missing property 'expectedVideoChunks'.");if(!Number.isInteger(e.fastStart.expectedVideoChunks)||e.fastStart.expectedVideoChunks<0)throw new TypeError("'expectedVideoChunks' must be a non-negative integer.")}if(e.audio){if(e.fastStart.expectedAudioChunks===void 0)throw new TypeError("'fastStart' is an object but is missing property 'expectedAudioChunks'.");if(!Number.isInteger(e.fastStart.expectedAudioChunks)||e.fastStart.expectedAudioChunks<0)throw new TypeError("'expectedAudioChunks' must be a non-negative integer.")}}else if(![!1,"in-memory","fragmented"].includes(e.fastStart))throw new TypeError("'fastStart' option must be false, 'in-memory', 'fragmented' or an object.");if(e.minFragmentDuration!==void 0&&(!Number.isFinite(e.minFragmentDuration)||e.minFragmentDuration<0))throw new TypeError("'minFragmentDuration' must be a non-negative number.")};_i=new WeakSet;or=function(){if(l(this,y).writeBox(zc({holdsAvc:l(this,g).video?.codec==="avc",fragmented:l(this,g).fastStart==="fragmented"})),j(this,bt,l(this,y).pos),l(this,g).fastStart==="in-memory")j(this,Z,hi(!1));else if(l(this,g).fastStart!=="fragmented"){if(typeof l(this,g).fastStart=="object"){let e=B(this,Ei,cr).call(this);l(this,y).seek(l(this,y).pos+e)}j(this,Z,hi(!0)),l(this,y).writeBox(l(this,Z))}B(this,Le,Xe).call(this)};Ei=new WeakSet;cr=function(){if(typeof l(this,g).fastStart!="object")return;let e=0,t=[l(this,g).fastStart.expectedVideoChunks,l(this,g).fastStart.expectedAudioChunks];for(let i of t)i&&(e+=8*Math.ceil(2/3*i),e+=4*i,e+=12*Math.ceil(2/3*i),e+=4*i,e+=8*i);return e+=4096,e};mi=new WeakSet;lr=function(){if(l(this,g).video&&j(this,W,{id:1,info:{type:"video",codec:l(this,g).video.codec,width:l(this,g).video.width,height:l(this,g).video.height,rotation:l(this,g).video.rotation??0,decoderConfig:null},timescale:l(this,g).video.frameRate??57600,samples:[],finalizedChunks:[],currentChunk:null,firstDecodeTimestamp:void 0,lastDecodeTimestamp:-1,timeToSampleTable:[],compositionTimeOffsetTable:[],lastTimescaleUnits:null,lastSample:null,compactlyCodedChunkTable:[]}),l(this,g).audio&&(j(this,V,{id:l(this,g).video?2:1,info:{type:"audio",codec:l(this,g).audio.codec,numberOfChannels:l(this,g).audio.numberOfChannels,sampleRate:l(this,g).audio.sampleRate,decoderConfig:null},timescale:l(this,g).audio.sampleRate,samples:[],finalizedChunks:[],currentChunk:null,firstDecodeTimestamp:void 0,lastDecodeTimestamp:-1,timeToSampleTable:[],compositionTimeOffsetTable:[],lastTimescaleUnits:null,lastSample:null,compactlyCodedChunkTable:[]}),l(this,g).audio.codec==="aac")){let e=B(this,Ti,hr).call(this,2,l(this,g).audio.sampleRate,l(this,g).audio.numberOfChannels);l(this,V).info.decoderConfig={codec:l(this,g).audio.codec,description:e,numberOfChannels:l(this,g).audio.numberOfChannels,sampleRate:l(this,g).audio.sampleRate}}};Ti=new WeakSet;hr=function(e,t,i){let n=[96e3,88200,64e3,48e3,44100,32e3,24e3,22050,16e3,12e3,11025,8e3,7350].indexOf(t),r=i,a="";a+=e.toString(2).padStart(5,"0"),a+=n.toString(2).padStart(4,"0"),n===15&&(a+=t.toString(2).padStart(24,"0")),a+=r.toString(2).padStart(4,"0");let o=Math.ceil(a.length/8)*8;a=a.padEnd(o,"0");let c=new Uint8Array(a.length/8);for(let h=0;h<a.length;h+=8)c[h/8]=parseInt(a.slice(h,h+8),2);return c};pt=new WeakSet;xi=function(e,t,i,s,n,r,a){let o=s/1e6,c=(s-(a??0))/1e6,h=n/1e6,d=B(this,Ci,ur).call(this,o,c,e);return o=d.presentationTimestamp,c=d.decodeTimestamp,r?.decoderConfig&&(e.info.decoderConfig===null?e.info.decoderConfig=r.decoderConfig:Object.assign(e.info.decoderConfig,r.decoderConfig)),{presentationTimestamp:o,decodeTimestamp:c,duration:h,data:t,size:t.byteLength,type:i,timescaleUnitsToNextSample:oe(h,e.timescale)}};re=new WeakSet;de=function(e,t){l(this,g).fastStart!=="fragmented"&&e.samples.push(t);let i=oe(t.presentationTimestamp-t.decodeTimestamp,e.timescale);if(e.lastTimescaleUnits!==null){let n=oe(t.decodeTimestamp,e.timescale,!1),r=Math.round(n-e.lastTimescaleUnits);if(e.lastTimescaleUnits+=r,e.lastSample.timescaleUnitsToNextSample=r,l(this,g).fastStart!=="fragmented"){let a=mt(e.timeToSampleTable);a.sampleCount===1?(a.sampleDelta=r,a.sampleCount++):a.sampleDelta===r?a.sampleCount++:(a.sampleCount--,e.timeToSampleTable.push({sampleCount:2,sampleDelta:r}));let o=mt(e.compositionTimeOffsetTable);o.sampleCompositionTimeOffset===i?o.sampleCount++:e.compositionTimeOffsetTable.push({sampleCount:1,sampleCompositionTimeOffset:i})}}else e.lastTimescaleUnits=0,l(this,g).fastStart!=="fragmented"&&(e.timeToSampleTable.push({sampleCount:1,sampleDelta:oe(t.duration,e.timescale)}),e.compositionTimeOffsetTable.push({sampleCount:1,sampleCompositionTimeOffset:i}));e.lastSample=t;let s=!1;if(!e.currentChunk)s=!0;else{let n=t.presentationTimestamp-e.currentChunk.startTimestamp;if(l(this,g).fastStart==="fragmented"){let r=l(this,W)??l(this,V),a=l(this,g).minFragmentDuration??1;e===r&&t.type==="key"&&n>=a&&(s=!0,B(this,vt,zi).call(this))}else s=n>=.5}s&&(e.currentChunk&&B(this,Ke,yt).call(this,e),e.currentChunk={startTimestamp:t.presentationTimestamp,samples:[]}),e.currentChunk.samples.push(t)};Ci=new WeakSet;ur=function(e,t,i){let s=l(this,g).firstTimestampBehavior==="strict",n=i.lastDecodeTimestamp===-1;if(s&&n&&t!==0)throw new Error(`The first chunk for your media track must have a timestamp of 0 (received DTS=${t}).Non-zero first timestamps are often caused by directly piping frames or audio data from a MediaStreamTrack into the encoder. Their timestamps are typically relative to the age of thedocument, which is probably what you want.

If you want to offset all timestamps of a track such that the first one is zero, set firstTimestampBehavior: 'offset' in the options.
`);if(l(this,g).firstTimestampBehavior==="offset"||l(this,g).firstTimestampBehavior==="cross-track-offset"){i.firstDecodeTimestamp===void 0&&(i.firstDecodeTimestamp=t);let a;l(this,g).firstTimestampBehavior==="offset"?a=i.firstDecodeTimestamp:a=Math.min(l(this,W)?.firstDecodeTimestamp??1/0,l(this,V)?.firstDecodeTimestamp??1/0),t-=a,e-=a}if(t<i.lastDecodeTimestamp)throw new Error(`Timestamps must be monotonically increasing (DTS went from ${i.lastDecodeTimestamp*1e6} to ${t*1e6}).`);return i.lastDecodeTimestamp=t,{presentationTimestamp:e,decodeTimestamp:t}};Ke=new WeakSet;yt=function(e){if(l(this,g).fastStart==="fragmented")throw new Error("Can't finalize individual chunks if 'fastStart' is set to 'fragmented'.");if(e.currentChunk){if(e.finalizedChunks.push(e.currentChunk),l(this,Ae).push(e.currentChunk),(e.compactlyCodedChunkTable.length===0||mt(e.compactlyCodedChunkTable).samplesPerChunk!==e.currentChunk.samples.length)&&e.compactlyCodedChunkTable.push({firstChunk:e.finalizedChunks.length,samplesPerChunk:e.currentChunk.samples.length}),l(this,g).fastStart==="in-memory"){e.currentChunk.offset=0;return}e.currentChunk.offset=l(this,y).pos;for(let t of e.currentChunk.samples)l(this,y).write(t.data),t.data=null;B(this,Le,Xe).call(this)}};vt=new WeakSet;zi=function(e=!0){if(l(this,g).fastStart!=="fragmented")throw new Error("Can't finalize a fragment unless 'fastStart' is set to 'fragmented'.");let t=[l(this,W),l(this,V)].filter(o=>o&&o.currentChunk);if(t.length===0)return;let i=Ec(this,ki)._++;if(i===1){let o=ut(t,l(this,Pe),!0);l(this,y).writeBox(o)}let s=l(this,y).pos,n=Xn(i,t);l(this,y).writeBox(n);{let o=hi(!1),c=0;for(let d of t)for(let p of d.currentChunk.samples)c+=p.size;let h=l(this,y).measureBox(o)+c;h>=2**32&&(o.largeSize=!0,h=l(this,y).measureBox(o)+c),o.size=h,l(this,y).writeBox(o)}for(let o of t){o.currentChunk.offset=l(this,y).pos,o.currentChunk.moofOffset=s;for(let c of o.currentChunk.samples)l(this,y).write(c.data),c.data=null}let r=l(this,y).pos;l(this,y).seek(l(this,y).offsets.get(n));let a=Xn(i,t);l(this,y).writeBox(a),l(this,y).seek(r);for(let o of t)o.finalizedChunks.push(o.currentChunk),l(this,Ae).push(o.currentChunk),o.currentChunk=null;e&&B(this,Le,Xe).call(this)};Le=new WeakSet;Xe=function(){l(this,y)instanceof Ui&&l(this,y).flush()};_t=new WeakSet;gi=function(){if(l(this,We))throw new Error("Cannot add new video or audio chunks after the file has been finalized.")};var Ii=Sr(fr(),1);function pr(e,t){let i=new OffscreenCanvas(e,t),s=i.getContext("webgl2",{preserveDrawingBuffer:!0});if(!s)throw new Error("WebGL2 is required for export filters.");let n=(o,c)=>{let h=s.createShader(o);if(s.shaderSource(h,c),s.compileShader(h),!s.getShaderParameter(h,s.COMPILE_STATUS))throw new Error(s.getShaderInfoLog(h));return h},r=s.createProgram();if(s.attachShader(r,n(s.VERTEX_SHADER,`#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`)),s.attachShader(r,n(s.FRAGMENT_SHADER,`#version 300 es
precision highp float;
uniform sampler2D source;
uniform vec2 texel;
uniform float sharpen;
uniform float color;
out vec4 pixel;
void main(){
  vec2 uv=vec2(gl_FragCoord.x*texel.x,1.-gl_FragCoord.y*texel.y);
  vec3 center=texture(source,uv).rgb;
  vec3 blur=(texture(source,uv+vec2(texel.x,0.)).rgb+texture(source,uv-vec2(texel.x,0.)).rgb+texture(source,uv+vec2(0.,texel.y)).rgb+texture(source,uv-vec2(0.,texel.y)).rgb)*0.25;
  vec3 c=center+sharpen*0.45*(center-blur);
  float lum=dot(c,vec3(.2126,.7152,.0722));
  c=mix(vec3(lum),c,1.+color*.12);
  c=(c-.5)*(1.+color*.08)+.5;
  pixel=vec4(clamp(c,0.,1.),1.);
}`)),s.linkProgram(r),!s.getProgramParameter(r,s.LINK_STATUS))throw new Error(s.getProgramInfoLog(r));s.useProgram(r),s.uniform2f(s.getUniformLocation(r,"texel"),1/e,1/t);let a=s.createTexture();return s.bindTexture(s.TEXTURE_2D,a),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),{canvas:i,render(o,c){s.viewport(0,0,e,t),s.uniform1f(s.getUniformLocation(r,"sharpen"),c.sharpen?1:0),s.uniform1f(s.getUniformLocation(r,"color"),c.color?1:0),s.texImage2D(s.TEXTURE_2D,0,s.RGBA,s.RGBA,s.UNSIGNED_BYTE,o),s.drawArrays(s.TRIANGLES,0,3)},dispose(){s.deleteTexture(a),s.deleteProgram(r)}}}var Qe=!1;self.onmessage=async({data:e})=>{if(e.type==="cancel"){Qe=!0;return}if(e.type==="process"){Qe=!1;try{await Al(e.file,e.quality,e.content,e.effects)}catch(t){self.postMessage({type:"error",message:t.message})}}};async function Al(e,t,i,s){if(!("VideoDecoder"in self)||!("VideoEncoder"in self))throw new Error("WebCodecs is unavailable. Use Chrome 120+.");if(e.size>128*1024*1024)throw new Error("Export limit: source MP4 must be at most 128 MB.");let n=await e.arrayBuffer(),r=oi(),a=new Map,o=await new Promise((le,be)=>{r.onError=be,r.onReady=pe=>{for(let ye of pe.tracks)(ye.type==="video"||ye.type==="audio")&&(a.set(ye.id,[]),r.setExtractionOptions(ye.id,null,{nbSamples:1}));r.start(),le(pe)},r.onSamples=(pe,ye,L)=>a.get(pe)?.push(...L),n.fileStart=0,r.appendBuffer(n),r.flush()}),c=o.videoTracks[0];if(!c||!c.codec.startsWith("avc1"))throw new Error("Batch currently supports H.264 MP4 input.");let h=c.duration/c.timescale,d=c.video.width*c.video.height*4,p=t==="l"?15e5:4e6;if(!Number.isFinite(h)||h<=0||h>30)throw new Error("Export limit: video must be 30 seconds or shorter.");if(d>p)throw new Error(`Export limit: ${t==="l"?"Large":"selected model"} exceeds the safe output size (${p.toLocaleString()} pixels).`);let x=o.audioTracks.find(le=>le.codec.startsWith("mp4a.40."));if(o.audioTracks.length&&!x)throw new Error("Audio codec is unsupported; use an MP4 with AAC audio.");let b=a.get(c.id)||[];if(!b.length)throw new Error("No video frames could be extracted.");let U=await Ii.default.initWebGPU();if(!U)throw new Error("WebGPU is unavailable.");let v=c.video.width*2,z=c.video.height*2,N={codec:"avc1.640033",width:v,height:z,bitrate:Math.min(4e7,Math.max(4e6,v*z*4)),framerate:Math.max(1,Math.min(60,Math.round(c.nb_samples/(c.duration/c.timescale)))),avc:{format:"avc"}};if(!(await VideoEncoder.isConfigSupported(N)).supported)throw new Error("H.264 encoder cannot handle 2\xD7 resolution on this device.");let F=new wi,I=new dr({target:F,video:{codec:"avc",width:v,height:z},audio:x?{codec:"aac",numberOfChannels:x.audio.channel_count,sampleRate:x.audio.sample_rate}:void 0,fastStart:!1,firstTimestampBehavior:"offset"}),Y=new OffscreenCanvas(v,z),xe=await(await fetch(`/static/video-enhancer/weights/cnn-2x-${t}-${i}.json`)).json(),ge=new Ii.default({canvas:Y,gpu:U,network_name:`anime4k/cnn-2x-${t}`,weights:xe}),H=pr(v,z),$,S;try{let le=0,be=0,pe=Promise.resolve();S=new VideoEncoder({output:(L,te)=>{I.addVideoChunk(L,te),le++},error:L=>{throw L}}),S.configure(N);let ye=Fl(r,c.id);$=new VideoDecoder({output:L=>{pe=pe.then(async()=>{try{if(Qe)return;await ge.render(L),H.render(Y,s);let te=new VideoFrame(H.canvas,{timestamp:L.timestamp,duration:L.duration||void 0});S.encode(te,{keyFrame:be%60===0}),te.close(),be++,be%10===0&&self.postMessage({type:"progress",value:Math.min(99,Math.round(100*be/b.length))})}finally{L.close()}})},error:L=>{throw L}}),$.configure({codec:c.codec,codedWidth:c.video.width,codedHeight:c.video.height,description:ye});for(let L=0;L<b.length;L++){if(Qe)throw new Error("Cancelled.");let te=b[L];for($.decode(new EncodedVideoChunk({type:te.is_sync?"key":"delta",timestamp:Math.round(te.cts*1e6/te.timescale),duration:Math.round(te.duration*1e6/te.timescale),data:te.data}));$.decodeQueueSize>2||be+4<L;)await new Promise(_r=>setTimeout(_r,2))}if(await $.flush(),await pe,await S.flush(),Qe)throw new Error("Cancelled.");if(x)for(let L of a.get(x.id)||[])I.addAudioChunkRaw(new Uint8Array(L.data),"key",Math.round(L.cts*1e6/L.timescale),Math.round(L.duration*1e6/L.timescale));if(I.finalize(),!F.buffer?.byteLength)throw new Error("Export produced an empty MP4.");self.postMessage({type:"complete",buffer:F.buffer,width:v,height:z,hasAudio:!!x},[F.buffer])}finally{$?.close(),S?.close(),H.dispose(),await ge.destroy()}}function Fl(e,t){let s=e.getTrackById(t)?.mdia?.minf?.stbl?.stsd?.entries?.[0]?.avcC;if(!s)throw new Error("Missing H.264 decoder configuration.");let n=new G(void 0,0,G.BIG_ENDIAN);return s.write(n),new Uint8Array(n.buffer.slice(8,n.position))}
