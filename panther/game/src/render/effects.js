// Visuele effecten: deeltjes (vuur, rook, stof, vonken), mondingsvuur, inslagen, tankexplosies,
// brandende wrakken, lichtsporen van granaten en lichtflitsen.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PointLight,
  ShaderMaterial,
  Sphere,
  Sprite,
  SpriteMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { fireAtlasTexture, smokeAtlasTexture, softDotTexture } from './proceduralTextures.js';

// Elk deeltje is een camera-gerichte quad (instancing) in plaats van een GL-punt: punten mogen
// (afhankelijk van GPU/driver) op hun middelpunt geclipt worden, waardoor grote wolken in één
// frame aan de schermrand verdwijnen, en zijn begrensd door de maximale puntgrootte van de GPU
// (1024 px onder D3D11, dus bij 4K kromp rook vlak voor de camera). De quad ligt evenwijdig aan
// het beeldvlak, net als een punt-sprite, en is aSize wereldeenheden breed.
const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 aCenter;
attribute float aSize;
attribute vec4 aColor;
attribute float aRot;
attribute float aTile;
uniform float uScale;
uniform float uTiles;
varying vec4 vColor;
varying vec2 vUv;
varying float vFogDepth;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(aCenter, 1.0);
  float depth = -mvPosition.z;
  vColor = vec4(pow(aColor.rgb, vec3(2.2)), aColor.a); // kleuren worden als sRGB opgegeven
  // deeltjes vlak voor de camera vervagen, anders vullen ze het hele beeld
  vColor.a *= smoothstep(0.5, 1.2, depth / max(aSize, 0.1));
  if (vColor.a <= 0.0) {
    // onzichtbaar (of achter de camera): quad laten wegvallen, scheelt vulsnelheid bij grote wolken
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // hoek uitzetten langs de rechts/omhoog-assen van de camera (view-space x/y), gedraaid met aRot;
  // minstens ongeveer één framebuffer-pixel groot, zoals een punt
  float size = max(aSize, depth / uScale);
  float c = cos(aRot);
  float s = sin(aRot);
  vec2 corner = position.xy;
  mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
  gl_Position = projectionMatrix * mvPosition;
  // de textuur draait mee met de quad, dus de uv's blijven binnen de eigen atlastegel
  vUv = vec2((aTile + corner.x + 0.5) / uTiles, corner.y + 0.5);
  vFogDepth = depth;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec4 vColor;
varying vec2 vUv;
varying float vFogDepth;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #ifdef ADDITIVE
    gl_FragColor = vec4(vColor.rgb * t.rgb * vColor.a * t.a * (1.0 - fogF), 1.0);
  #else
    gl_FragColor = vec4(mix(vColor.rgb * t.rgb, fogColor, fogF), vColor.a * t.a);
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class ParticleLayer {
  constructor(max, texture, tiles, additive) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.col0 = new Float32Array(max * 4);
    this.col1 = new Float32Array(max * 4);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.rotVel = new Float32Array(max);
    this.tile = new Float32Array(max);
    this.aSize = new Float32Array(max);
    this.aColor = new Float32Array(max * 4);
    // één quad (4 hoeken, 2 driehoeken tegen de klok in vanuit de camera), per deeltje een instantie
    const geo = new InstancedBufferGeometry();
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    this.posAttr = new InstancedBufferAttribute(this.pos, 3);
    this.sizeAttr = new InstancedBufferAttribute(this.aSize, 1);
    this.colorAttr = new InstancedBufferAttribute(this.aColor, 4);
    this.rotAttr = new InstancedBufferAttribute(this.rot, 1);
    this.tileAttr = new InstancedBufferAttribute(this.tile, 1);
    this.attrs = [this.posAttr, this.sizeAttr, this.colorAttr, this.rotAttr, this.tileAttr];
    for (const a of this.attrs) a.setUsage(DynamicDrawUsage);
    geo.setAttribute('aCenter', this.posAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aRot', this.rotAttr);
    geo.setAttribute('aTile', this.tileAttr);
    geo.instanceCount = 0;
    // handmatige bol: three zou hem anders uit de quadhoeken afleiden; frustum culling staat uit
    // en de volgorde t.o.v. andere transparante objecten komt uit renderOrder
    geo.boundingSphere = new Sphere(new Vector3(), Infinity);
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uMap: { value: null }, uTiles: { value: tiles }, uScale: { value: 500 } }]),
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
      defines: additive ? { ADDITIVE: '' } : {},
      fog: true,
    });
    this.material.uniforms.uMap.value = texture;
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 5 : 4;
    this.mesh.visible = false;
  }

  // o: { x,y,z, vx,vy,vz, life, s0, s1, c0:[r,g,b,a], c1:[r,g,b,a], drag, grav, rot, rotVel, tile }
  spawn(o) {
    let i;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max); // vol: overschrijf een willekeurig deeltje
    this.pos[i * 3] = o.x;
    this.pos[i * 3 + 1] = o.y;
    this.pos[i * 3 + 2] = o.z;
    this.vel[i * 3] = o.vx || 0;
    this.vel[i * 3 + 1] = o.vy || 0;
    this.vel[i * 3 + 2] = o.vz || 0;
    this.life[i] = 0;
    this.maxLife[i] = o.life;
    this.size0[i] = o.s0;
    this.size1[i] = o.s1 ?? o.s0;
    const c0 = o.c0;
    const c1 = o.c1 || c0;
    for (let k = 0; k < 4; k++) {
      this.col0[i * 4 + k] = c0[k];
      this.col1[i * 4 + k] = c1[k];
    }
    this.drag[i] = o.drag || 0;
    this.grav[i] = o.grav || 0;
    this.rot[i] = o.rot ?? Math.random() * 6.283;
    this.rotVel[i] = o.rotVel || 0;
    this.tile[i] = o.tile ?? Math.floor(Math.random() * 4);
  }

  copy(dst, src) {
    this.pos[dst * 3] = this.pos[src * 3];
    this.pos[dst * 3 + 1] = this.pos[src * 3 + 1];
    this.pos[dst * 3 + 2] = this.pos[src * 3 + 2];
    this.vel[dst * 3] = this.vel[src * 3];
    this.vel[dst * 3 + 1] = this.vel[src * 3 + 1];
    this.vel[dst * 3 + 2] = this.vel[src * 3 + 2];
    this.life[dst] = this.life[src];
    this.maxLife[dst] = this.maxLife[src];
    this.size0[dst] = this.size0[src];
    this.size1[dst] = this.size1[src];
    for (let k = 0; k < 4; k++) {
      this.col0[dst * 4 + k] = this.col0[src * 4 + k];
      this.col1[dst * 4 + k] = this.col1[src * 4 + k];
    }
    this.drag[dst] = this.drag[src];
    this.grav[dst] = this.grav[src];
    this.rot[dst] = this.rot[src];
    this.rotVel[dst] = this.rotVel[src];
    this.tile[dst] = this.tile[src];
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        this.count--;
        if (i !== this.count) this.copy(i, this.count);
        continue;
      }
      const t = this.life[i] / this.maxLife[i];
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.rot[i] += this.rotVel[i] * dt;
      // grootte groeit met een ease-out, kleur/alfa lineair
      const e = 1 - (1 - t) * (1 - t);
      this.aSize[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * e;
      for (let k = 0; k < 4; k++) {
        this.aColor[i * 4 + k] = this.col0[i * 4 + k] + (this.col1[i * 4 + k] - this.col0[i * 4 + k]) * t;
      }
      i++;
    }
    this.mesh.geometry.instanceCount = this.count;
    // leeg: niet tekenen en niets uploaden (een bereik met lengte 0 zou de hele buffer kopiëren)
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

const rand = (a, b) => a + Math.random() * (b - a);
const _v = new Vector3();
const _w = new Vector3();

export class Effects {
  constructor(scene, trail) {
    this.scene = scene;
    this.trail = trail;
    this.fireTex = fireAtlasTexture();
    this.smokeTex = smokeAtlasTexture();
    this.dotTex = softDotTexture();
    this.fire = new ParticleLayer(3000, this.fireTex, 4, true);
    this.smoke = new ParticleLayer(4000, this.smokeTex, 4, false);
    scene.add(this.fire.mesh, this.smoke.mesh);
    // vaste set lampen (het aantal lampen wijzigen zou shaders laten hercompileren)
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new PointLight('#ffb35c', 0, 60, 2);
      l.userData = { life: 0, max: 1, peak: 0 };
      scene.add(l);
      this.lights.push(l);
    }
    this.emitters = [];
    // lichtsporen
    this.tracerGeo = new BoxGeometry(1, 1, 1).translate(-0.5, 0, 0);
    this.tracerMat = new MeshBasicMaterial({
      color: new Color('#ffb347').multiplyScalar(6),
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.glowMat = new SpriteMaterial({
      map: this.dotTex,
      color: new Color('#ffc070').multiplyScalar(3),
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    this.tracers = new Map();
    this.tracerPool = [];
  }

  // framebuffer-pixels per wereldeenheid op afstand 1; de deeltjes zelf zijn in wereldeenheden,
  // dit bepaalt alleen de minimale grootte van ongeveer één pixel
  setViewport(height, fov) {
    const scale = height / (2 * Math.tan((fov * Math.PI) / 360));
    this.fire.material.uniforms.uScale.value = scale;
    this.smoke.material.uniforms.uScale.value = scale;
  }

  flash(pos, intensity, duration, color = '#ffb35c') {
    let light = this.lights.find((l) => l.userData.life <= 0);
    if (!light) light = this.lights.reduce((a, b) => (a.userData.life < b.userData.life ? a : b));
    light.position.copy(pos);
    light.color.set(color);
    light.userData.life = duration;
    light.userData.max = duration;
    light.userData.peak = intensity;
    light.intensity = intensity;
  }

  muzzleFlash(pos, dir, groundY) {
    for (let i = 0; i < 4; i++) {
      const s = rand(0.3, 1.4);
      this.fire.spawn({
        x: pos.x + dir.x * s, y: pos.y + dir.y * s, z: pos.z + dir.z * s,
        vx: dir.x * 25, vy: dir.y * 25, vz: dir.z * 25,
        life: rand(0.06, 0.11), s0: rand(1.6, 2.6), s1: rand(3, 4.5),
        c0: [1, 0.86, 0.6, 0.75], c1: [1, 0.45, 0.15, 0], drag: 8,
      });
    }
    // zijstraal van de mondingsrem
    _w.set(-dir.z, 0, dir.x).normalize();
    for (const side of [-1, 1]) {
      this.fire.spawn({
        x: pos.x, y: pos.y, z: pos.z, vx: _w.x * side * 18, vy: 1, vz: _w.z * side * 18,
        life: 0.09, s0: 1.2, s1: 2.6, c0: [1, 0.84, 0.55, 0.6], c1: [1, 0.4, 0.12, 0], drag: 10,
      });
    }
    for (let i = 0; i < 14; i++) {
      const sp = rand(4, 16);
      this.smoke.spawn({
        x: pos.x + dir.x * rand(0, 2), y: pos.y + dir.y * rand(0, 2), z: pos.z + dir.z * rand(0, 2),
        vx: dir.x * sp + rand(-2.5, 2.5), vy: dir.y * sp + rand(0, 2), vz: dir.z * sp + rand(-2.5, 2.5),
        life: rand(1.4, 2.6), s0: rand(1, 1.8), s1: rand(4, 6.5),
        c0: [0.62, 0.6, 0.57, 0.5], c1: [0.7, 0.68, 0.64, 0], drag: 2.2, grav: -0.35, rotVel: rand(-0.5, 0.5),
      });
    }
    if (pos.y - groundY < 4.5) {
      for (let i = 0; i < 12; i++) {
        const a = rand(0, Math.PI * 2);
        const sp = rand(5, 11);
        this.smoke.spawn({
          x: pos.x - dir.x * 2, y: groundY + 0.4, z: pos.z - dir.z * 2,
          vx: Math.cos(a) * sp, vy: rand(0.2, 1.2), vz: Math.sin(a) * sp,
          life: rand(1.2, 2), s0: 1, s1: rand(3.5, 5), c0: [0.5, 0.45, 0.37, 0.42], c1: [0.55, 0.5, 0.42, 0], drag: 3,
        });
      }
    }
    this.flash(pos, 900, 0.08);
  }

  impact(pos, normal, kind) {
    const n = normal;
    if (kind === 'terrain') {
      for (let i = 0; i < 20; i++) {
        const sp = rand(6, 17);
        this.smoke.spawn({
          x: pos.x, y: pos.y + 0.2, z: pos.z,
          vx: n.x * sp + rand(-4, 4), vy: n.y * sp * rand(0.6, 1.2), vz: n.z * sp + rand(-4, 4),
          life: rand(0.9, 1.7), s0: rand(0.6, 1.2), s1: rand(1.8, 3), c0: [0.3, 0.24, 0.17, 0.85], c1: [0.36, 0.3, 0.22, 0], grav: 11, drag: 1.2,
        });
      }
      for (let i = 0; i < 10; i++) {
        this.smoke.spawn({
          x: pos.x + rand(-1, 1), y: pos.y + rand(0, 1), z: pos.z + rand(-1, 1),
          vx: rand(-1.5, 1.5), vy: rand(1.5, 4), vz: rand(-1.5, 1.5),
          life: rand(2, 3.5), s0: rand(1.5, 2.5), s1: rand(5, 7.5), c0: [0.42, 0.39, 0.35, 0.5], c1: [0.55, 0.53, 0.5, 0], drag: 0.9, grav: -0.25, rotVel: rand(-0.4, 0.4),
        });
      }
      this.trail.stamp(pos.x, pos.z, rand(0, 6.28), 3.6, 3.6, 0, 0.9);
      this.fireball(pos, 5, 1.6);
      this.flash(pos, 600, 0.12);
    } else if (kind === 'tree') {
      for (let i = 0; i < 16; i++) {
        this.smoke.spawn({
          x: pos.x, y: pos.y, z: pos.z,
          vx: n.x * rand(3, 10) + rand(-3, 3), vy: rand(0, 6), vz: n.z * rand(3, 10) + rand(-3, 3),
          life: rand(0.7, 1.3), s0: rand(0.2, 0.45), s1: rand(0.2, 0.45), c0: [0.42, 0.3, 0.18, 1], c1: [0.42, 0.3, 0.18, 0], grav: 12, rotVel: rand(-6, 6),
        });
      }
      this.smokePuffs(pos, 7, 0.45);
      this.fireball(pos, 4, 1.2);
      this.flash(pos, 450, 0.1);
    } else if (kind === 'rock') {
      this.sparks(pos, n, 18);
      this.smokePuffs(pos, 8, 0.5);
      this.fireball(pos, 4, 1.3);
      this.flash(pos, 450, 0.1);
    } else {
      // tank of wrak: vonken en een donkere rookwolk
      this.sparks(pos, n, 30);
      this.fireball(pos, 6, 1.4);
      this.smokePuffs(pos, 8, 0.35);
      this.flash(pos, 700, 0.12, '#ffd08a');
    }
  }

  fireball(pos, count, size) {
    for (let i = 0; i < count; i++) {
      this.fire.spawn({
        x: pos.x + rand(-0.4, 0.4), y: pos.y + rand(0, 0.6), z: pos.z + rand(-0.4, 0.4),
        vx: rand(-3, 3), vy: rand(1, 5), vz: rand(-3, 3),
        life: rand(0.12, 0.3), s0: size, s1: size * rand(1.8, 2.6), c0: [1, 0.82, 0.52, 0.55], c1: [1, 0.35, 0.08, 0], drag: 4,
      });
    }
  }

  smokePuffs(pos, count, darkness) {
    const c = 0.2 + darkness * 0.5;
    for (let i = 0; i < count; i++) {
      this.smoke.spawn({
        x: pos.x + rand(-0.6, 0.6), y: pos.y + rand(0, 0.8), z: pos.z + rand(-0.6, 0.6),
        vx: rand(-1.2, 1.2), vy: rand(1, 3.5), vz: rand(-1.2, 1.2),
        life: rand(1.6, 3), s0: rand(1, 2), s1: rand(4, 6), c0: [c, c * 0.97, c * 0.93, 0.55], c1: [c + 0.15, c + 0.14, c + 0.12, 0], drag: 1, grav: -0.3, rotVel: rand(-0.5, 0.5),
      });
    }
  }

  sparks(pos, n, count) {
    for (let i = 0; i < count; i++) {
      const sp = rand(8, 26);
      this.fire.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: n.x * sp * 0.6 + rand(-1, 1) * sp * 0.6, vy: n.y * sp * 0.6 + rand(0, 1) * sp * 0.5, vz: n.z * sp * 0.6 + rand(-1, 1) * sp * 0.6,
        life: rand(0.3, 0.8), s0: rand(0.12, 0.25), s1: 0.05, c0: [1, 0.9, 0.65, 1], c1: [1, 0.45, 0.12, 0], grav: 14, drag: 1.5, tile: 0,
      });
    }
  }

  tankExplosion(pos) {
    const p = _v.copy(pos);
    p.y += 1.6;
    for (let i = 0; i < 18; i++) {
      this.fire.spawn({
        x: p.x + rand(-1.5, 1.5), y: p.y + rand(-0.5, 1.5), z: p.z + rand(-1.5, 1.5),
        vx: rand(-6, 6), vy: rand(2, 12), vz: rand(-6, 6),
        life: rand(0.45, 1.0), s0: rand(1.8, 3), s1: rand(5, 8), c0: [1, 0.8, 0.5, 0.5], c1: [0.9, 0.3, 0.06, 0], drag: 2.5, grav: -1.5,
      });
    }
    for (let i = 0; i < 45; i++) {
      this.smoke.spawn({
        x: p.x + rand(-2, 2), y: p.y + rand(0, 3), z: p.z + rand(-2, 2),
        vx: rand(-3, 3), vy: rand(3, 9), vz: rand(-3, 3),
        life: rand(3, 6), s0: rand(3, 5), s1: rand(10, 16), c0: [0.1, 0.09, 0.085, 0.8], c1: [0.28, 0.27, 0.26, 0], drag: 0.8, grav: -0.6, rotVel: rand(-0.3, 0.3),
      });
    }
    _w.set(0, 1, 0);
    this.sparks(p, _w, 60);
    this.flash(p, 5000, 0.45, '#ffa040');
    this.trail.stamp(pos.x, pos.z, rand(0, 6.28), 9, 9, 0, 1);
  }

  // doorlopende bron: 'burning' (vuur + rook) of 'smoking' (alleen rook). getPos() geeft de positie.
  addEmitter(getPos, kind, duration) {
    const e = { getPos, kind, time: 0, duration, acc: 0 };
    this.emitters.push(e);
    return e;
  }

  removeEmitter(e) {
    const i = this.emitters.indexOf(e);
    if (i >= 0) this.emitters.splice(i, 1);
  }

  runEmitters(dt) {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.time += dt;
      if (e.time > e.duration) {
        this.emitters.splice(i, 1);
        continue;
      }
      const fade = 1 - Math.max(0, (e.time - e.duration + 3) / 3);
      e.acc += dt;
      const interval = e.kind === 'burning' ? 0.035 : 0.12;
      while (e.acc > interval) {
        e.acc -= interval;
        const p = e.getPos();
        if (e.kind === 'burning') {
          this.fire.spawn({
            x: p.x + rand(-1, 1), y: p.y + 1.6 + rand(0, 0.8), z: p.z + rand(-1, 1),
            vx: rand(-0.6, 0.6), vy: rand(2.5, 5), vz: rand(-0.6, 0.6),
            life: rand(0.35, 0.7), s0: rand(1.2, 2.2), s1: rand(0.4, 1), c0: [1, 0.72, 0.38, 0.55], c1: [0.85, 0.28, 0.06, 0], drag: 1,
          });
        }
        this.smoke.spawn({
          x: p.x + rand(-0.8, 0.8), y: p.y + 2.2, z: p.z + rand(-0.8, 0.8),
          vx: rand(-0.5, 0.5) + 0.6, vy: rand(2.5, 4.5), vz: rand(-0.5, 0.5) + 0.4,
          life: rand(3.5, 6), s0: rand(1.5, 2.5), s1: rand(7, 11),
          c0: [0.09, 0.085, 0.08, 0.55 * fade], c1: [0.3, 0.29, 0.28, 0], drag: 0.4, grav: -0.4, rotVel: rand(-0.3, 0.3),
        });
      }
    }
  }

  // stof achter rijdende tanks
  trackDust(pos, speedFrac, dirX, dirZ) {
    this.smoke.spawn({
      x: pos.x + rand(-0.3, 0.3), y: pos.y + 0.3, z: pos.z + rand(-0.3, 0.3),
      vx: -dirX * 1.5 + rand(-0.6, 0.6), vy: rand(0.4, 1.4), vz: -dirZ * 1.5 + rand(-0.6, 0.6),
      life: rand(1.4, 2.6), s0: rand(0.8, 1.4), s1: rand(3, 5.5),
      c0: [0.45, 0.4, 0.32, 0.26 * speedFrac], c1: [0.5, 0.46, 0.38, 0], drag: 1.5, grav: -0.1, rotVel: rand(-0.4, 0.4),
    });
  }

  exhaust(pos, strength) {
    this.smoke.spawn({
      x: pos.x, y: pos.y, z: pos.z, vx: rand(-0.3, 0.3), vy: rand(1.2, 2.2), vz: rand(-0.3, 0.3),
      life: rand(0.9, 1.6), s0: 0.35, s1: rand(1.4, 2.2), c0: [0.16, 0.15, 0.14, 0.3 * strength], c1: [0.3, 0.29, 0.28, 0], drag: 1, rotVel: rand(-1, 1),
    });
  }

  // lichtsporen synchroniseren met de granaten in de simulatie
  syncTracers(projectiles, alpha, camera) {
    const seen = new Set();
    for (const p of projectiles) {
      seen.add(p.id);
      let t = this.tracers.get(p.id);
      if (!t) {
        t = this.tracerPool.pop();
        if (!t) {
          const streak = new Mesh(this.tracerGeo, this.tracerMat);
          const glow = new Sprite(this.glowMat);
          glow.scale.set(1.3, 1.3, 1.3);
          streak.frustumCulled = false;
          t = { streak, glow, start: new Vector3() };
        }
        t.start.copy(p.prev);
        this.scene.add(t.streak, t.glow);
        this.tracers.set(p.id, t);
      }
      const head = _v.lerpVectors(p.prev, p.pos, alpha);
      const dir = _w.copy(p.vel).normalize();
      const len = Math.min(9, head.distanceTo(t.start));
      t.streak.position.copy(head);
      t.streak.quaternion.setFromUnitVectors(X_AXIS, dir);
      const thick = 0.07 + camera.position.distanceTo(head) * 0.0018;
      t.streak.scale.set(Math.max(0.01, len), thick, thick);
      t.glow.position.copy(head);
    }
    for (const [id, t] of this.tracers) {
      if (!seen.has(id)) {
        this.scene.remove(t.streak, t.glow);
        this.tracers.delete(id);
        this.tracerPool.push(t);
      }
    }
  }

  update(dt) {
    this.runEmitters(dt);
    this.fire.update(dt);
    this.smoke.update(dt);
    for (const l of this.lights) {
      const u = l.userData;
      if (u.life > 0) {
        u.life -= dt;
        l.intensity = Math.max(0, u.peak * (u.life / u.max));
      } else {
        l.intensity = 0;
      }
    }
  }

  dispose() {
    for (const t of this.tracers.values()) this.scene.remove(t.streak, t.glow);
    this.scene.remove(this.fire.mesh, this.smoke.mesh);
    this.fire.dispose();
    this.smoke.dispose();
    this.fireTex.dispose();
    this.smokeTex.dispose();
    this.dotTex.dispose();
    this.tracerGeo.dispose();
    this.tracerMat.dispose();
    this.glowMat.dispose();
    for (const l of this.lights) {
      this.scene.remove(l);
      l.dispose();
    }
  }
}

const X_AXIS = new Vector3(1, 0, 0);
