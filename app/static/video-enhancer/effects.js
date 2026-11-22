/** Small WebGL2 post-process, kept off the UI thread. */
export function createEffects(width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is required for export filters.');
  const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
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
}`));
  gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program); gl.uniform2f(gl.getUniformLocation(program, 'texel'), 1 / width, 1 / height);
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return { canvas, render(source, effects) { gl.viewport(0, 0, width, height); gl.uniform1f(gl.getUniformLocation(program, 'sharpen'), effects.sharpen ? 1 : 0); gl.uniform1f(gl.getUniformLocation(program, 'color'), effects.color ? 1 : 0); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); gl.drawArrays(gl.TRIANGLES, 0, 3); }, dispose() { gl.deleteTexture(texture); gl.deleteProgram(program); } };
}
