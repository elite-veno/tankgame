// Bos: bomen en planten als camera-gerichte impostors (uit de Poly Haven-renders), met wind,
// zachte schaduwen, en procedurele rotsen. Alles is instanced en in brokken verdeeld voor frustum culling.
import {
  Color,
  DoubleSide,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Sphere,
  Vector2,
  Vector3,
  BufferAttribute,
  RGBADepthPacking,
} from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RNG } from '../core/rng.js';
import { Noise2D } from '../core/noise.js';

const BILLBOARD_PARS = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iData; // tegel, schaal, spiegeling, willekeur
uniform vec2 uTileSize[TILE_COUNT];
uniform float uTileBase[TILE_COUNT];
uniform float uTileCount;
uniform float uTime;
uniform float uSway;
uniform float uFadeStart;
uniform float uFadeEnd;
varying float vHeightFrac;
varying float vRnd;
#ifdef SIGHT_FADE
uniform vec3 uSightFrom;
uniform vec3 uSightTo;
varying float vSightFade;
#endif
vec3 bbToCam;
vec3 bbRight;
void billboardAxes() {
  vec3 tc = isOrthographic ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) : cameraPosition - iPos;
  tc.y = 0.0;
  float l = length(tc);
  bbToCam = l > 1e-4 ? tc / l : vec3(0.0, 0.0, 1.0);
  bbRight = vec3(bbToCam.z, 0.0, -bbToCam.x);
}
`;

const BILLBOARD_UV = /* glsl */ `
vMapUv = vec2((iData.x + (iData.z > 0.0 ? uv.x : 1.0 - uv.x)) / uTileCount, uv.y);
`;

const BILLBOARD_POSITION = /* glsl */ `
int ti = int(iData.x + 0.5);
float sc = iData.y;
vec2 bbSize = uTileSize[ti] * sc;
if (uFadeEnd > 0.0) bbSize *= 1.0 - smoothstep(uFadeStart, uFadeEnd, distance(cameraPosition.xz, iPos.xz));
float hFrac = position.y;
vHeightFrac = hFrac;
vRnd = iData.w;
float sway = sin(uTime * 0.8 + iData.w * 40.0 + iPos.x * 0.05) * uSway * hFrac * hFrac * sc;
vec3 transformed = iPos + bbRight * (position.x * bbSize.x + sway) + vec3(0.0, hFrac * bbSize.y - uTileBase[ti] * sc, 0.0);
#ifdef SIGHT_FADE
{
  // bomen op de zichtlijn van de camera naar de tank (of vlak bij de camera) worden doorzichtig
  vec2 ab = uSightTo.xz - uSightFrom.xz;
  float along = dot(iPos.xz - uSightFrom.xz, ab) / max(dot(ab, ab), 1e-4);
  float d = distance(iPos.xz, uSightFrom.xz + ab * clamp(along, 0.0, 1.0));
  vSightFade = along > 0.95 ? 1.0 : smoothstep(1.4, 3.2, d);
}
#endif
`;

const BILLBOARD_FRAGMENT_PARS = /* glsl */ `
varying float vHeightFrac;
varying float vRnd;
#ifdef SIGHT_FADE
varying float vSightFade;
#endif
uniform float uBrightness;
uniform vec3 uTintA;
uniform vec3 uTintB;
uniform vec2 uAtlasSize;
uniform float uBottomShade;
`;

const BILLBOARD_COLOR = /* glsl */ `
diffuseColor.rgb *= mix(uTintA, uTintB, vRnd) * uBrightness * mix(uBottomShade, 1.0, smoothstep(0.02, 0.45, vHeightFrac));
`;

// doorzichtig op de zichtlijn: rasterpatroon (screen-door) met vaste ruis per pixel, zodat er niets
// gesorteerd hoeft te worden; een vleugje van de boom blijft zichtbaar
const SIGHT_FADE_FRAGMENT = /* glsl */ `
#ifdef SIGHT_FADE
if (vSightFade < 0.999) {
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (ign > mix(0.18, 1.0, vSightFade)) discard;
}
#endif
`;

// alfa ophogen op kleinere mipmaps, zodat bomen op afstand niet uitdunnen
const ALPHA_MIP_FIX = /* glsl */ `
{
  vec2 adx = dFdx(vMapUv * uAtlasSize);
  vec2 ady = dFdy(vMapUv * uAtlasSize);
  float mipLod = 0.5 * log2(max(dot(adx, adx), dot(ady, ady)));
  diffuseColor.a *= 1.0 + max(mipLod, 0.0) * 0.3;
}
`;

function billboardMaterials(texture, tiles, opts) {
  const uniforms = {
    uTileSize: { value: tiles.map((t) => new Vector2(t.width, t.height)) },
    uTileBase: { value: tiles.map((t) => t.base) },
    uTileCount: { value: tiles.length },
    uTime: { value: 0 },
    uSway: { value: opts.sway },
    uFadeStart: { value: opts.fadeStart || 0 },
    uFadeEnd: { value: opts.fadeEnd || 0 },
    uBrightness: { value: opts.brightness },
    uTintA: { value: new Color(opts.tintA) },
    uTintB: { value: new Color(opts.tintB) },
    uAtlasSize: { value: new Vector2(texture.image.width, texture.image.height) },
    uBottomShade: { value: opts.bottomShade },
    uSightFrom: { value: new Vector3() },
    uSightTo: { value: new Vector3() },
  };
  const defines = { TILE_COUNT: tiles.length };
  if (opts.sightFade) defines.SIGHT_FADE = '';
  const material = new MeshStandardMaterial({
    map: texture,
    alphaTest: 0.5,
    alphaToCoverage: true,
    roughness: 0.95,
    metalness: 0,
  });
  // de schaduwpas tekent standaard alleen achterkanten; een billboard heeft er maar één
  material.shadowSide = DoubleSide;
  material.defines = defines;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BILLBOARD_PARS}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${BILLBOARD_UV}`)
      .replace(
        '#include <beginnormal_vertex>',
        `billboardAxes();
        vec3 objectNormal = normalize(bbToCam * 0.5 + vec3(0.0, 0.8, 0.0) + bbRight * (uv.x - 0.5) * 1.1);`,
      )
      .replace('#include <begin_vertex>', BILLBOARD_POSITION);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BILLBOARD_FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${BILLBOARD_COLOR}`)
      .replace('#include <alphatest_fragment>', `${ALPHA_MIP_FIX}\n${SIGHT_FADE_FRAGMENT}\n#include <alphatest_fragment>`);
  };
  const variant = `${tiles.length}${opts.sightFade ? '-sight' : ''}`;
  material.customProgramCacheKey = () => `woudfront-billboard-${variant}`;

  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: texture, alphaTest: 0.5 });
  depth.defines = defines;
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BILLBOARD_PARS}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${BILLBOARD_UV}`)
      .replace('#include <begin_vertex>', `billboardAxes();\n${BILLBOARD_POSITION}`);
  };
  depth.customProgramCacheKey = () => `woudfront-billboard-depth-${variant}`;
  return { material, depth, uniforms };
}

// Verdeelt instanties in brokken van `chunk` meter en maakt per brok één mesh met een eigen bol voor culling.
function buildChunks(items, chunk, baseGeo, material, depth, maxHeight) {
  const buckets = new Map();
  for (const it of items) {
    const key = `${Math.floor(it.x / chunk)},${Math.floor(it.z / chunk)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(it);
  }
  const meshes = [];
  for (const list of buckets.values()) {
    const geo = new InstancedBufferGeometry();
    geo.index = baseGeo.index;
    geo.setAttribute('position', baseGeo.getAttribute('position'));
    geo.setAttribute('normal', baseGeo.getAttribute('normal'));
    geo.setAttribute('uv', baseGeo.getAttribute('uv'));
    const pos = new Float32Array(list.length * 3);
    const data = new Float32Array(list.length * 4);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    list.forEach((it, i) => {
      pos[i * 3] = it.x;
      pos[i * 3 + 1] = it.y;
      pos[i * 3 + 2] = it.z;
      data[i * 4] = it.tile;
      data[i * 4 + 1] = it.scale;
      data[i * 4 + 2] = it.flip;
      data[i * 4 + 3] = it.rnd;
      minX = Math.min(minX, it.x);
      maxX = Math.max(maxX, it.x);
      minZ = Math.min(minZ, it.z);
      maxZ = Math.max(maxZ, it.z);
      minY = Math.min(minY, it.y);
      maxY = Math.max(maxY, it.y);
    });
    geo.setAttribute('iPos', new InstancedBufferAttribute(pos, 3));
    geo.setAttribute('iData', new InstancedBufferAttribute(data, 4));
    geo.instanceCount = list.length;
    const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2 + maxHeight / 2, (minZ + maxZ) / 2);
    const radius = Math.hypot(maxX - minX, maxZ - minZ, maxY - minY + maxHeight) / 2 + maxHeight * 0.4;
    geo.boundingSphere = new Sphere(center, radius);
    const mesh = new Mesh(geo, material);
    if (depth) {
      mesh.customDepthMaterial = depth;
      mesh.castShadow = true;
    }
    mesh.receiveShadow = true;
    meshes.push(mesh);
  }
  return meshes;
}

function makeRockGeometry(seed) {
  const rng = new RNG(seed);
  const noise = new Noise2D(seed * 13 + 1);
  let g = new IcosahedronGeometry(1, 3);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.getAttribute('position');
  const ox = rng.range(0, 100);
  const oz = rng.range(0, 100);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    let d = 1 + 0.28 * noise.noise(x * 1.2 + ox, z * 1.2 + y * 0.7) + 0.1 * noise.noise(y * 3 + oz, x * 3 - z);
    // grove facetten, zoals gebroken zandsteen
    d = Math.round(d * 7) / 7 * 0.5 + d * 0.5;
    let ny = y * d * 0.72;
    if (ny < -0.25) ny = -0.25 + (ny + 0.25) * 0.25;
    p.setXYZ(i, x * d, ny + 0.2, z * d);
  }
  g.computeVertexNormals();
  const n = g.getAttribute('normal');
  const colors = new Float32Array(p.count * 3);
  const stone = new Color();
  const moss = new Color('#4f5c2c');
  for (let i = 0; i < p.count; i++) {
    const v = 0.5 + 0.5 * noise.noise(p.getX(i) * 2 + 50, p.getZ(i) * 2 + p.getY(i));
    stone.setRGB(0.36 + v * 0.12, 0.33 + v * 0.1, 0.29 + v * 0.08);
    const up = n.getY(i);
    const m = Math.max(0, Math.min(1, (up - 0.45) * 2.2)) * (0.55 + 0.45 * noise.noise(p.getX(i) * 3, p.getZ(i) * 3 + 20));
    stone.lerp(moss, Math.max(0, m));
    colors[i * 3] = stone.r;
    colors[i * 3 + 1] = stone.g;
    colors[i * 3 + 2] = stone.b;
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
}

function rockMaterial(detailTexture) {
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  const uniforms = { tDetail: { value: detailTexture } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockPos;\nvarying vec3 vRockNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRockPos = position * 1.4;\nvRockNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vRockPos;\nvarying vec3 vRockNormal;\nuniform sampler2D tDetail;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 w = pow(abs(normalize(vRockNormal)), vec3(4.0));
          w /= (w.x + w.y + w.z);
          vec3 t = texture2D(tDetail, vRockPos.yz).rgb * w.x + texture2D(tDetail, vRockPos.xz).rgb * w.y + texture2D(tDetail, vRockPos.xy).rgb * w.z;
          diffuseColor.rgb *= t * 2.2;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'woudfront-rock-1';
  return mat;
}

export class ForestView {
  constructor(scene, map, textures, config) {
    this.scene = scene;
    this.meshes = [];
    this.disposables = [];
    const meta = textures.treesMeta;
    const treeTiles = meta.tiles.map((t) => ({ width: t.tileWidth, height: t.tileHeight, base: t.baseOffset }));
    const tree = billboardMaterials(textures.trees, treeTiles, {
      sway: 0.35,
      brightness: 1.75,
      tintA: '#d2dcc4',
      tintB: '#fff4df',
      bottomShade: 0.7,
      sightFade: true,
    });
    this.treeUniforms = tree.uniforms;
    const quad = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
    this.disposables.push(quad, tree.material, tree.depth);
    const rng = new RNG(map.seed + 99);
    const treeItems = map.trees.map((t) => ({
      x: t.x,
      y: t.y,
      z: t.z,
      tile: t.tile,
      scale: t.scale,
      flip: t.flip,
      rnd: t.tint,
    }));
    const maxTree = Math.max(...treeTiles.map((t) => t.height)) * config.map.treeScale[1];
    for (const m of buildChunks(treeItems, 110, quad, tree.material, tree.depth, maxTree)) this.add(m);

    // planten: gras en varens, dichter op open plekken, niet op paden
    const plantTiles = [
      { width: 1.25, height: 1.25, base: 0.02 },
      { width: 1.6, height: 1.6, base: 0.06 },
    ];
    const plant = billboardMaterials(textures.plants, plantTiles, {
      sway: 0.12,
      brightness: 1.15,
      tintA: '#c9d3b4',
      tintB: '#fff2d6',
      bottomShade: 0.55,
      fadeStart: config.graphics.plantDrawDistance * 0.72,
      fadeEnd: config.graphics.plantDrawDistance,
    });
    this.plantUniforms = plant.uniforms;
    this.disposables.push(plant.material, plant.depth);
    const plants = [];
    const surf = map.surface;
    const half = map.half + 60;
    const want = config.graphics.plantCount;
    let tries = 0;
    while (plants.length < want && tries++ < want * 8) {
      const x = rng.range(-half, half);
      const z = rng.range(-half, half);
      const si = Math.floor((x / surf.size + 0.5) * surf.res);
      const sj = Math.floor((z / surf.size + 0.5) * surf.res);
      const k = (sj * surf.res + si) * 4;
      const road = surf.data[k] / 255;
      const meadow = surf.data[k + 1] / 255;
      if (road > 0.35) continue;
      const pGrass = 0.25 + meadow * 0.75;
      const accept = (1 - road) * (0.35 + meadow * 0.65);
      if (rng.next() > accept) continue;
      const isGrass = rng.next() < pGrass;
      plants.push({
        x,
        y: map.heightfield.heightAt(x, z),
        z,
        tile: isGrass ? 0 : 1,
        scale: isGrass ? rng.range(0.55, 1.15) : rng.range(0.6, 1.2),
        flip: rng.next() < 0.5 ? -1 : 1,
        rnd: rng.next(),
      });
    }
    for (const m of buildChunks(plants, 60, quad, plant.material, null, 2)) {
      m.castShadow = false;
      this.add(m);
    }

    // rotsen
    const rockMat = rockMaterial(textures.groundForest);
    this.disposables.push(rockMat);
    const variants = 4;
    const byVariant = Array.from({ length: variants }, () => []);
    for (const r of map.rocks) byVariant[r.variant % variants].push(r);
    const m4 = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    for (let v = 0; v < variants; v++) {
      const list = byVariant[v];
      if (list.length === 0) continue;
      const geo = makeRockGeometry(map.seed + v * 17);
      this.disposables.push(geo);
      const inst = new InstancedMesh(geo, rockMat, list.length);
      list.forEach((r, i) => {
        q.setFromAxisAngle(up, r.rot);
        m4.compose(new Vector3(r.x, r.y, r.z), q, new Vector3(r.r * r.stretch, r.h, r.r / r.stretch));
        inst.setMatrixAt(i, m4);
      });
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      this.add(inst);
    }
  }

  add(mesh) {
    this.meshes.push(mesh);
    this.scene.add(mesh);
  }

  // from = camera, to = kijkpunt boven de tank: bomen daartussen worden doorzichtig
  update(time, from, to) {
    this.treeUniforms.uTime.value = time;
    this.plantUniforms.uTime.value = time;
    this.treeUniforms.uSightFrom.value.copy(from);
    this.treeUniforms.uSightTo.value.copy(to);
  }

  dispose() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      if (m.isInstancedMesh) m.dispose();
      else m.geometry.dispose();
    }
    for (const d of this.disposables) d.dispose();
  }
}
