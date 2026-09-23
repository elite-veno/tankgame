// Veroveringspunten in de wereld: gestippelde cirkel op de grond (volgt het terrein) met voortgangsboog,
// een vlaggenmast met wapperende vlag in de teamkleur en een letter erboven.
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { drawPointBadge, makeCanvas } from './proceduralTextures.js';

const _display = { side: -1, frac: 0, draining: false };

const ZONE_VERTEX = /* glsl */ `
varying vec2 vLocal;
varying float vFogDepth;
void main() {
  vLocal = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const ZONE_FRAGMENT = /* glsl */ `
uniform vec3 uOwner;
uniform vec3 uCap;
uniform float uProgress;
uniform float uTime;
uniform float uContested;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec2 vLocal;
varying float vFogDepth;
void main() {
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x) / 6.2831853 + 0.5;
  float ring = smoothstep(0.95, 0.965, r) * (1.0 - smoothstep(0.995, 1.01, r));
  float dash = step(0.32, fract(ang * 40.0 + uTime * 0.04));
  float inner = smoothstep(0.87, 0.88, r) * (1.0 - smoothstep(0.925, 0.935, r));
  float prog = inner * step(ang, uProgress);
  float fill = (1.0 - smoothstep(0.88, 0.96, r)) * 0.06;
  vec3 owner = uOwner;
  if (uContested > 0.5) owner = mix(owner, vec3(1.0), 0.5 + 0.5 * sin(uTime * 9.0));
  float aRing = ring * dash * 0.95;
  float aProg = prog * 0.9;
  float a = clamp(aRing + fill + aProg, 0.0, 1.0);
  vec3 col = (owner * (aRing + fill) + uCap * aProg) / max(aRing + fill + aProg, 1e-3);
  float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  gl_FragColor = vec4(mix(col, fogColor, fogF * 0.8), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// schijf die het terrein volgt; uv = lokale positie gedeeld door de straal
function zoneGeometry(point, hf, radius) {
  const rings = 14;
  const segs = 96;
  const pos = [];
  const uv = [];
  const idx = [];
  pos.push(point.x, hf.heightAt(point.x, point.z) + 0.15, point.z);
  uv.push(0, 0);
  for (let r = 1; r <= rings; r++) {
    const rr = (r / rings) * radius * 1.02;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const x = point.x + Math.cos(a) * rr;
      const z = point.z + Math.sin(a) * rr;
      pos.push(x, hf.heightAt(x, z) + 0.15, z);
      uv.push((Math.cos(a) * rr) / radius, (Math.sin(a) * rr) / radius);
    }
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segs;
    const b0 = 1 + r * segs;
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class CapturePointViews {
  constructor(scene, world, config) {
    this.scene = scene;
    this.world = world;
    this.teamColors = config.teams.map((t) => new Color(t.color));
    this.neutral = new Color(config.neutralColor);
    this.teamCss = config.teams.map((t) => t.color);
    this.neutralCss = config.neutralColor;
    this.items = [];
    this.poleGeo = new CylinderGeometry(0.07, 0.1, 10, 8).translate(0, 5, 0);
    this.poleMat = new MeshStandardMaterial({ color: '#5d5f5a', roughness: 0.5, metalness: 0.7 });
    this.flagGeo = new PlaneGeometry(2.6, 1.6, 16, 8).translate(1.3, 0, 0);
    const hf = world.map.heightfield;
    for (const p of world.points) {
      const zoneMat = new ShaderMaterial({
        uniforms: UniformsUtils.merge([
          UniformsLib.fog,
          {
            uOwner: { value: this.neutral.clone() },
            uCap: { value: this.neutral.clone() },
            uProgress: { value: 0 },
            uTime: { value: 0 },
            uContested: { value: 0 },
          },
        ]),
        vertexShader: ZONE_VERTEX,
        fragmentShader: ZONE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        fog: true,
      });
      const zone = new Mesh(zoneGeometry(p, hf, p.radius), zoneMat);
      zone.renderOrder = 1;
      scene.add(zone);

      const baseY = hf.heightAt(p.x, p.z);
      const pole = new Mesh(this.poleGeo, this.poleMat);
      pole.position.set(p.x, baseY - 0.2, p.z);
      pole.castShadow = true;
      scene.add(pole);
      const flagMat = new MeshStandardMaterial({ color: this.neutral.clone(), roughness: 0.85, side: DoubleSide });
      const flagUniforms = { uTime: { value: 0 } };
      flagMat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, flagUniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            float fw = position.x / 2.6;
            transformed.z += sin(position.x * 2.4 - uTime * 5.0) * 0.28 * fw + sin(position.y * 3.0 + uTime * 3.1) * 0.05 * fw;
            transformed.y -= fw * fw * 0.25;`,
          );
      };
      flagMat.customProgramCacheKey = () => 'woudfront-flag-1';
      const flag = new Mesh(this.flagGeo, flagMat);
      flag.position.set(p.x + 0.08, baseY + 8.9, p.z);
      flag.rotation.y = Math.PI * 0.25;
      flag.castShadow = true;
      scene.add(flag);

      const canvas = makeCanvas(128, 128);
      const tex = new CanvasTexture(canvas);
      tex.colorSpace = SRGBColorSpace;
      const spriteMat = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
      const sprite = new Sprite(spriteMat);
      sprite.position.set(p.x, baseY + 13.5, p.z);
      sprite.scale.set(4.2, 4.2, 4.2);
      sprite.renderOrder = 6;
      scene.add(sprite);
      const item = { point: p, zone, zoneMat, pole, flag, flagMat, flagUniforms, sprite, spriteMat, tex, canvas, key: '' };
      this.items.push(item);
      this.redrawBadge(item);
    }
  }

  cssFor(team) {
    return team >= 0 ? this.teamCss[team] : this.neutralCss;
  }

  redrawBadge(item) {
    const p = item.point;
    const d = p.display(_display);
    const key = `${p.owner}|${d.side}|${Math.round(d.frac * 50)}|${p.contested ? 1 : 0}`;
    if (key === item.key) return;
    item.key = key;
    const ring = p.contested ? '#ffffff' : this.cssFor(p.owner);
    drawPointBadge(item.canvas.getContext('2d'), 128, p.id, this.cssFor(p.owner), ring, d.frac, this.cssFor(d.side));
    item.tex.needsUpdate = true;
  }

  update(dt, time) {
    for (const item of this.items) {
      const p = item.point;
      const u = item.zoneMat.uniforms;
      u.uTime.value = time;
      u.uOwner.value.copy(p.owner >= 0 ? this.teamColors[p.owner] : this.neutral);
      const d = p.display(_display);
      u.uCap.value.copy(d.side >= 0 ? this.teamColors[d.side] : this.neutral);
      u.uProgress.value = d.frac;
      u.uContested.value = p.contested ? 1 : 0;
      item.flagUniforms.uTime.value = time + p.index * 1.7;
      item.flagMat.color.copy(p.owner >= 0 ? this.teamColors[p.owner] : this.neutral);
      // vlag hijsen naar gelang de voortgang van de eigenaar
      const baseY = this.world.map.heightfield.heightAt(p.x, p.z);
      const ownFrac = p.owner >= 0 ? p.progressFor(p.owner) : 0.35;
      item.flag.position.y = baseY + 3.2 + ownFrac * 5.7;
      this.redrawBadge(item);
    }
  }

  dispose() {
    for (const it of this.items) {
      this.scene.remove(it.zone, it.pole, it.flag, it.sprite);
      it.zone.geometry.dispose();
      it.zoneMat.dispose();
      it.flagMat.dispose();
      it.spriteMat.dispose();
      it.tex.dispose();
    }
    this.poleGeo.dispose();
    this.poleMat.dispose();
    this.flagGeo.dispose();
  }
}
