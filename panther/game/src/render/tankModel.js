// Tankmodel uit panther.glb (+ LOD-versies): camouflage per skin, losse toren- en loop-nodes,
// meedraaiende rupsen en wielen, terugslag van de loop en een uitgebrand uiterlijk voor wrakken.
import { Color, LOD, MeshDepthMaterial, MeshStandardMaterial, Object3D } from 'three';
import { CONFIG } from '../config.js';
import { SIMPLEX_NOISE_GLSL } from './shaderNoise.js';
import { createRunningGearUniforms, patchRunningGear, prepareRunningGear, setTrackTravel } from './runningGear.js';

// volgorde = waarde van uCamoPattern in de shader
const PATTERNS = ['vlekken', 'stippen', 'effen', 'winter', 'strepen', 'splinter', 'digitaal'];

export function getSkin(id) {
  return CONFIG.skins.find((s) => s.id === id) || CONFIG.skins[0];
}

export function teamSkin(team) {
  return getSkin(CONFIG.teams[team].skin);
}

const CAMO_VERTEX_PARS = /* glsl */ `
varying vec3 vCamoPos;
`;

const CAMO_FRAGMENT_PARS = /* glsl */ `
varying vec3 vCamoPos;
uniform vec3 uCamoBase;
uniform vec3 uCamoA;
uniform vec3 uCamoB;
uniform vec3 uCamoDust;
uniform float uCamoSeed;
uniform float uCamoScale;
uniform float uCamoPattern;
uniform float uDustHeight;
uniform float uBurnt;
${SIMPLEX_NOISE_GLSL}
`;

const CAMO_FRAGMENT = /* glsl */ `
{
  vec3 p = vCamoPos * 0.55 * uCamoScale + vec3(uCamoSeed);
  float green = 0.0; // aandeel kleur A
  float brown = 0.0; // aandeel kleur B
  float light = 0.0; // lichte stippen (grondkleur) in de donkere vlakken
  if (uCamoPattern > 5.5) {
    // digitaal: vlekken op een grof raster, dus blokjes
    vec3 q = floor(p * 8.0) / 8.0;
    float n1 = snoise(q * 0.9) + 0.6 * snoise(q * 3.1 + 11.3);
    float n2 = snoise(q * 1.1 + 37.1) + 0.6 * snoise(q * 3.4 - 5.2);
    green = step(0.1, n1);
    brown = step(0.25, n2) * (1.0 - green);
  } else if (uCamoPattern > 4.5) {
    // splinter: twee gedraaide blokrasters geven hoekige scherven
    vec3 r1 = mat3(0.83, 0.47, -0.30, -0.42, 0.88, 0.22, 0.37, -0.05, 0.93) * p;
    vec3 r2 = mat3(0.60, -0.70, 0.38, 0.75, 0.66, 0.05, -0.28, 0.27, 0.92) * p;
    float n1 = snoise(floor(r1 * 1.3) * 0.61 + 3.1) + 0.6 * snoise(floor(r2 * 2.1) * 0.53);
    float n2 = snoise(floor(r2 * 1.1) * 0.67 - 8.4) + 0.6 * snoise(floor(r1 * 2.4) * 0.47 + 1.7);
    green = step(0.3, n1);
    brown = step(0.35, n2) * (1.0 - green);
  } else if (uCamoPattern > 3.5) {
    // strepen: langgerekte vlekken, schuin over de romp
    vec3 q = vec3(p.x * 1.7 + p.y * 1.2, p.y * 0.22, p.z * 1.7);
    float n1 = snoise(q * 0.9) + 0.35 * snoise(q * 2.7 + 4.0);
    float n2 = snoise(q * 0.95 + 21.7) + 0.35 * snoise(q * 2.9 - 9.0);
    green = smoothstep(0.28, 0.34, n1);
    brown = smoothstep(0.36, 0.42, n2) * (1.0 - green);
  } else if (uCamoPattern > 2.5) {
    // winter: witkalk over de gewone verf, afgesleten in verticale strepen
    float wear = snoise(vec3(p.x * 1.4, p.y * 4.5, p.z * 1.4)) + 0.5 * snoise(p * 3.6 + 2.0);
    green = smoothstep(0.5, 0.62, wear);
    brown = smoothstep(0.55, 0.62, snoise(p * 0.9 + 13.0)) * green;
  } else if (uCamoPattern < 1.5) {
    // vlekken, eventueel met stippen ("licht en schaduw"); effen (2) slaat dit over
    float n1 = snoise(p * 0.8) + 0.45 * snoise(p * 2.1 + 11.3);
    float n2 = snoise(p * 0.85 + 37.1) + 0.45 * snoise(p * 2.3 - 5.2);
    green = smoothstep(0.26, 0.33, n1);
    brown = smoothstep(0.34, 0.41, n2) * (1.0 - green);
    if (uCamoPattern > 0.5) {
      float dark = max(green, brown);
      light = smoothstep(0.58, 0.66, snoise(p * 7.0 + 5.0)) * dark;
      green = max(green, smoothstep(0.62, 0.7, snoise(p * 6.3 - 9.0)) * (1.0 - dark));
    }
  }
  vec3 camo = mix(uCamoBase, uCamoA, green);
  camo = mix(camo, uCamoB, brown);
  camo = mix(camo, uCamoBase, light);
  // stof en modder onderaan de romp (uDustHeight 0 = geen stof)
  float grime = 0.55 + 0.45 * snoise(vCamoPos * 3.1);
  float dust = uDustHeight > 0.0 ? (1.0 - smoothstep(uDustHeight * 0.25, uDustHeight, vCamoPos.y)) * grime : 0.0;
  camo = mix(camo, uCamoDust, clamp(dust, 0.0, 1.0) * 0.75);
  camo *= 0.9 + 0.1 * snoise(vCamoPos * 8.0);
  // uitgebrand wrak: roet en verbrande verf
  float soot = 0.5 + 0.5 * snoise(vCamoPos * 1.7 + 3.0);
  vec3 burnt = mix(vec3(0.018, 0.016, 0.014), vec3(0.09, 0.05, 0.03), soot * soot);
  diffuseColor.rgb = mix(camo, burnt, uBurnt);
}
`;

function applySkin(uniforms, skin) {
  uniforms.uCamoBase.value.set(skin.base);
  uniforms.uCamoA.value.set(skin.a);
  uniforms.uCamoB.value.set(skin.b);
  uniforms.uCamoDust.value.set(skin.dust);
  uniforms.uCamoSeed.value = skin.seed;
  uniforms.uCamoScale.value = skin.scale;
  uniforms.uCamoPattern.value = Math.max(0, PATTERNS.indexOf(skin.pattern));
}

function createCamoMaterial(skin, dustHeight) {
  const mat = new MeshStandardMaterial({ roughness: 0.72, metalness: 0.0 });
  const uniforms = {
    uCamoBase: { value: new Color() },
    uCamoA: { value: new Color() },
    uCamoB: { value: new Color() },
    uCamoDust: { value: new Color() },
    uCamoSeed: { value: 0 },
    uCamoScale: { value: 1 },
    uCamoPattern: { value: 0 },
    uDustHeight: { value: dustHeight },
    uBurnt: { value: 0 },
  };
  applySkin(uniforms, skin);
  mat.userData.camoUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // het patroon volgt de oorspronkelijke vertexpositie, zodat het met draaiende wielen meedraait
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CAMO_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvCamoPos = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CAMO_FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${CAMO_FRAGMENT}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.97, uBurnt);`,
      );
  };
  mat.customProgramCacheKey = () => 'woudfront-camo-2';
  return mat;
}

// Eén materiaal voor een bronmateriaal uit het model. Elke tank krijgt eigen instanties zodat een
// wrak kan uitbranden en elke tank zijn eigen skin en rupsstand heeft.
function createMaterial(src, skin) {
  let mat;
  if (src.name === 'G_paint_hull') mat = createCamoMaterial(skin, 1.05);
  else if (src.name === 'G_paint_turret') mat = createCamoMaterial(skin, 0);
  else {
    mat = src.clone();
    if (src.name === 'G_track_steel' || src.name === 'G_dark_steel') mat.roughness = Math.max(mat.roughness, 0.62);
  }
  mat.name = src.name;
  mat.userData.baseColor = mat.color.clone();
  mat.userData.baseRoughness = mat.roughness;
  return mat;
}

function collectMaterials(root, into) {
  root.traverse((o) => {
    if (o.isMesh) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) if (!into.has(m.name)) into.set(m.name, m);
    }
  });
  return into;
}

export class TankModelFactory {
  // gltfs: { full, lod1, lod2, lod3 } (GLTF-resultaten)
  constructor(gltfs) {
    this.gltfs = gltfs;
    this.sourceMaterials = new Map();
    for (const g of Object.values(gltfs)) collectMaterials(g.scene, this.sourceMaterials);
    // rupsen en wielen laten meedraaien op de modellen die je van dichtbij ziet
    prepareRunningGear(gltfs.full.scene);
    prepareRunningGear(gltfs.lod1.scene);
  }

  // detail: 'hangar' (alleen volledig model), 'player' (volledig + LOD1), 'ai' (LOD1..3)
  // skinId: id uit CONFIG.skins; zonder id de standaardskin van het team
  create(team, detail = 'ai', skinId = null) {
    return new TankModel(this, skinId ? getSkin(skinId) : teamSkin(team), detail);
  }
}

export class TankModel {
  constructor(factory, skin, detail) {
    this.skin = skin;
    this.source = factory.sourceMaterials;
    this.materials = new Map();
    this.gearUniforms = createRunningGearUniforms();
    this.trackDepth = null;
    this.turrets = [];
    this.guns = [];
    this.gunMeshes = [];
    const g = factory.gltfs;
    const levels =
      detail === 'hangar'
        ? [[g.full, 0]]
        : detail === 'player'
          ? [[g.full, 0], [g.lod1, 70]]
          : [[g.lod1, 0], [g.lod2, 45], [g.lod3, 140]];
    const lod = new LOD();
    for (const [gltf, dist] of levels) lod.addLevel(this.instantiate(gltf.scene), dist);
    this.lodDistances = levels.map(([, dist]) => dist);
    this.lodScale = 1;
    this.root = new Object3D();
    this.root.add(lod);
    this.lod = lod;
    this.burnt = 0;
  }

  // Bij inzoomen (kleinere FOV) lijkt alles dichterbij: de detailniveaus pas verder weg overschakelen.
  setLodScale(scale) {
    if (scale === this.lodScale) return;
    this.lodScale = scale;
    this.lod.levels.forEach((level, i) => {
      level.distance = this.lodDistances[i] * scale;
    });
  }

  // materiaal per bronnaam, met een aparte variant voor rupsschakels en wielen
  material(name, gear) {
    const key = gear ? `${name}#${gear}` : name;
    let mat = this.materials.get(key);
    if (!mat) {
      mat = createMaterial(this.source.get(name), this.skin);
      if (gear) patchRunningGear(mat, gear, this.gearUniforms);
      this.materials.set(key, mat);
    }
    return mat;
  }

  instantiate(scene) {
    const obj = scene.clone(true);
    obj.traverse((o) => {
      if (o.isMesh) {
        const gear = o.geometry.userData.runningGear || null;
        o.material = this.material(o.material.name, gear);
        o.castShadow = true;
        o.receiveShadow = true;
        if (gear === 'track') {
          // de schaduw beweegt mee met de schakels
          if (!this.trackDepth) this.trackDepth = patchRunningGear(new MeshDepthMaterial(), 'track', this.gearUniforms);
          o.customDepthMaterial = this.trackDepth;
        }
      }
    });
    const turret = obj.getObjectByName('turret');
    const gun = obj.getObjectByName('gun');
    this.turrets.push(turret);
    this.guns.push(gun);
    this.gunMeshes.push(gun.getObjectByName('gun_mesh') || gun.children[0]);
    return obj;
  }

  setAim(turretYaw, gunPitch) {
    for (const t of this.turrets) t.rotation.y = turretYaw;
    for (const g of this.guns) g.rotation.z = gunPitch;
  }

  // loop schuift terug na een schot (meters)
  setRecoil(offset) {
    for (const m of this.gunMeshes) m.position.x = -offset;
  }

  // afgelegde weg van de linker- en rechterrupsband (meter); bepaalt schakels en wielstand
  setTrackTravel(left, right) {
    setTrackTravel(this.gearUniforms, left, right);
  }

  setSkin(skinId) {
    this.skin = getSkin(skinId);
    for (const mat of this.materials.values()) {
      if (mat.userData.camoUniforms) applySkin(mat.userData.camoUniforms, this.skin);
    }
  }

  // 0 = normaal, 1 = volledig uitgebrand
  setBurnt(amount) {
    if (amount === this.burnt) return;
    this.burnt = amount;
    for (const mat of this.materials.values()) {
      if (mat.userData.camoUniforms) {
        mat.userData.camoUniforms.uBurnt.value = amount;
      } else {
        mat.color.copy(mat.userData.baseColor).multiplyScalar(1 - 0.85 * amount);
        mat.roughness = mat.userData.baseRoughness + (0.95 - mat.userData.baseRoughness) * amount;
      }
    }
  }

  dispose() {
    for (const mat of this.materials.values()) mat.dispose();
    this.trackDepth?.dispose();
  }
}
