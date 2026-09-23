// Terreinmesh met textuurmenging (bosbodem, grindpad, open plek), normal maps, schaduw van het bladerdak
// en een "sporenkaart" waarin rupsbanden en brandplekken worden getekend.
import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DataTexture,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  MaxEquation,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  WebGLRenderTarget,
  Color,
} from 'three';

// ------------------------------------------------------------------ sporenkaart
export class TrailMap {
  constructor(renderer, size, resolution = 2048) {
    this.renderer = renderer;
    this.size = size;
    this.target = new WebGLRenderTarget(resolution, resolution, {
      format: RGBAFormat,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    });
    this.scene = new Scene();
    const h = size / 2;
    this.camera = new OrthographicCamera(-h, h, h, -h, -10, 10);
    this.camera.position.set(0, 5, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);
    this.max = 512;
    const mat = new MeshBasicMaterial({
      vertexColors: false,
      transparent: true,
      blending: CustomBlending,
      blendEquation: MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    this.stamps = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, this.max);
    this.stamps.frustumCulled = false;
    this.stamps.count = 0;
    this.scene.add(this.stamps);
    this.color = new Color();
    this.m = new Matrix4();
    this.cleared = false;
    this.pending = 0;
  }

  // rechthoekige stempel (x,z midden, lengte langs yaw, breedte), kleur (r = spoor, g = brandplek)
  stamp(x, z, yaw, length, width, r, g) {
    if (this.pending >= this.max) return;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // lokale x-as langs de rijrichting: (cos, 0, -sin); y-as van de plane (na rotatie) = z
    this.m.set(c * length, 0, s * width, x, 0, 1, 0, 0, -s * length, 0, c * width, z, 0, 0, 0, 1);
    this.stamps.setMatrixAt(this.pending, this.m);
    this.stamps.setColorAt(this.pending, this.color.setRGB(r, g, 0));
    this.pending++;
  }

  flush() {
    const r = this.renderer;
    if (!this.cleared) {
      const prev = r.getRenderTarget();
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.setRenderTarget(prev);
      this.cleared = true;
    }
    if (this.pending === 0) return;
    this.stamps.count = this.pending;
    this.stamps.instanceMatrix.needsUpdate = true;
    if (this.stamps.instanceColor) this.stamps.instanceColor.needsUpdate = true;
    const prev = r.getRenderTarget();
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
    r.autoClear = autoClear;
    this.pending = 0;
  }

  dispose() {
    this.target.dispose();
    this.stamps.geometry.dispose();
    this.stamps.material.dispose();
    this.stamps.dispose();
  }
}

// ------------------------------------------------------------------ terrein
const TERRAIN_VERTEX_PARS = /* glsl */ `
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
`;

const TERRAIN_FRAGMENT_PARS = /* glsl */ `
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
uniform sampler2D tLeaves;
uniform sampler2D tLeavesN;
uniform sampler2D tGravel;
uniform sampler2D tGravelN;
uniform sampler2D tMeadow;
uniform sampler2D tMeadowN;
uniform sampler2D tSplat;
uniform sampler2D tTrail;
uniform float uWorldSize;
uniform float uTrailSize;
vec4 gSplat;
vec4 gTrail;
float gW[3];
vec2 gUvA;
vec2 gUvB;
`;

const TERRAIN_COLOR = /* glsl */ `
{
  vec2 wuv = vTerrainPos.xz;
  gSplat = texture2D(tSplat, wuv / uWorldSize + 0.5);
  // de sporenkaart kijkt van boven met noord (-z) naar boven
  vec2 tuv = vec2(wuv.x / uTrailSize + 0.5, 0.5 - wuv.y / uTrailSize);
  gTrail = (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) ? texture2D(tTrail, tuv) : vec4(0.0);
  gUvA = wuv / 6.5;
  gUvB = wuv / 23.0 + vec2(0.37, 0.71);
  vec3 leaves = mix(texture2D(tLeaves, gUvA).rgb, texture2D(tLeaves, gUvB).rgb, 0.4);
  vec3 gravel = mix(texture2D(tGravel, gUvA * 1.25).rgb, texture2D(tGravel, gUvB * 1.1).rgb, 0.35);
  vec3 meadow = mix(texture2D(tMeadow, gUvA * 0.9).rgb, texture2D(tMeadow, gUvB).rgb, 0.45);
  // overgangen iets scherper maken met de helderheid van de texturen
  float lumG = dot(gravel, vec3(0.33));
  float wR = clamp((gSplat.r - 0.5) * 1.6 + 0.5 + (lumG - 0.35) * 0.8 * (1.0 - abs(gSplat.r - 0.5) * 2.0), 0.0, 1.0);
  float wG = gSplat.g * (1.0 - wR);
  float wF = max(0.0, 1.0 - wR - wG);
  gW[0] = wF; gW[1] = wR; gW[2] = wG;
  meadow = mix(meadow, meadow * vec3(0.95, 1.04, 0.82), 0.6); // open plekken iets groener/droger
  vec3 col = leaves * wF + gravel * wR + meadow * wG;
  col = mix(col, col * vec3(0.66, 0.6, 0.52), gSplat.b * 0.65);  // modder
  col *= mix(1.0, 0.72, gSplat.a);                                 // schaduw onder het bladerdak
  col = mix(col, col * vec3(0.58, 0.52, 0.46), gTrail.r * 0.75);   // rupssporen
  col = mix(col, vec3(0.035, 0.03, 0.026), gTrail.g * 0.85);       // brandplekken
  diffuseColor.rgb *= col;
}
`;

const TERRAIN_NORMAL = /* glsl */ `
{
  vec3 nL = texture2D(tLeavesN, gUvA).xyz * 2.0 - 1.0;
  vec3 nG = texture2D(tGravelN, gUvA * 1.25).xyz * 2.0 - 1.0;
  vec3 nM = texture2D(tMeadowN, gUvA * 0.9).xyz * 2.0 - 1.0;
  vec3 tn = normalize(nL * gW[0] + nG * gW[1] + nM * gW[2] + vec3(0.0, 0.0, 0.001));
  tn.xy *= 1.1 * (1.0 - gTrail.g * 0.6);
  vec3 Nw = normalize(vTerrainNormal);
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - Nw * Nw.x);
  vec3 B = cross(T, Nw);
  vec3 nw = normalize(T * tn.x + B * tn.y + Nw * tn.z);
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
}
`;

export function createTerrain(map, textures, trail) {
  const hf = map.heightfield;
  const res = hf.res;
  const row = res + 1;
  const count = row * row;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const n = { x: 0, y: 0, z: 0 };
  for (let iz = 0; iz <= res; iz++) {
    const z = hf.pointZ(iz);
    for (let ix = 0; ix <= res; ix++) {
      const x = hf.pointX(ix);
      const k = iz * row + ix;
      pos[k * 3] = x;
      pos[k * 3 + 1] = hf.heights[k];
      pos[k * 3 + 2] = z;
      hf.normalAt(x, z, n, hf.cell);
      nor[k * 3] = n.x;
      nor[k * 3 + 1] = n.y;
      nor[k * 3 + 2] = n.z;
    }
  }
  // zelfde driehoeksindeling als Heightfield.heightAt (en PlaneGeometry)
  const idx = new Uint32Array(res * res * 6);
  let p = 0;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = iz * row + ix;
      const b = a + row;
      const c = b + 1;
      const d = a + 1;
      idx[p++] = a;
      idx[p++] = b;
      idx[p++] = d;
      idx[p++] = b;
      idx[p++] = c;
      idx[p++] = d;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nor, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const surf = map.surface;
  const splat = new DataTexture(surf.data, surf.res, surf.res, RGBAFormat);
  splat.magFilter = LinearFilter;
  splat.minFilter = LinearMipmapLinearFilter;
  splat.generateMipmaps = true;
  splat.needsUpdate = true;

  const uniforms = {
    tLeaves: { value: textures.groundLeaves },
    tLeavesN: { value: textures.groundLeavesN },
    tGravel: { value: textures.groundForest },
    tGravelN: { value: textures.groundForestN },
    tMeadow: { value: textures.groundMud },
    tMeadowN: { value: textures.groundMudN },
    tSplat: { value: splat },
    tTrail: { value: trail.target.texture },
    uWorldSize: { value: map.worldSize },
    uTrailSize: { value: trail.size },
  };
  const mat = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.94, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VERTEX_PARS}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${TERRAIN_COLOR}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${TERRAIN_NORMAL}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor - gSplat.b * 0.25 - gTrail.r * 0.12, 0.4, 1.0);`,
      );
  };
  mat.customProgramCacheKey = () => 'woudfront-terrain-1';
  const mesh = new Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return {
    mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
      splat.dispose();
    },
  };
}
