// 3D-hangar voor de lobby: donkere hal, lampen met lichtbundels, rekwisieten en zwevend stof.
// De camera draait langzaam rond de tank; de speler kan zelf draaien en zoomen.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RNG } from '../core/rng.js';
import { concreteTextures, corrugatedTextures, woodTexture, softDotTexture } from './proceduralTextures.js';

const HALL = { w: 46, d: 34, h: 13 };

// Nep-volumetrische lichtbundel: kegel met zachte randen en additief mengen.
function lightShaftMaterial(color, strength) {
  return new ShaderMaterial({
    uniforms: { uColor: { value: new Color(color) }, uStrength: { value: strength } },
    vertexShader: /* glsl */ `
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        vAlong = uv.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        float edge = pow(abs(dot(vNormalV, vViewDir)), 1.6);
        float fade = smoothstep(0.0, 0.35, vAlong) * (0.35 + 0.65 * vAlong);
        gl_FragColor = vec4(uColor * edge * fade * uStrength, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

export class HangarScene {
  constructor(renderer, tankFactory, skinId) {
    this.renderer = renderer;
    this.scene = new Scene();
    this.scene.background = new Color('#07090a');
    this.scene.fog = new Fog('#0a0c0d', 18, 60);
    this.camera = new PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(12.5, 4.1, 11.5);
    this.time = 0;
    this.disposables = [];
    this.rng = new RNG(77);

    const pmrem = new PMREMGenerator(renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.16;

    this.buildHall();
    this.buildLights();
    this.buildProps();
    this.buildDust();

    this.tank = tankFactory.create(0, 'hangar', skinId);
    this.tank.root.position.set(0, 0, 0);
    this.tank.root.rotation.y = 0.35;
    this.tank.setAim(0.12, 0.04);
    this.scene.add(this.tank.root);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0.2, 1.35, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 24;
    this.controls.minPolarAngle = (18 * Math.PI) / 180;
    this.controls.maxPolarAngle = (84 * Math.PI) / 180;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.45;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.8;
    this.resumeTimer = 0;
    this.onStart = () => {
      this.controls.autoRotate = false;
      this.resumeTimer = -1;
    };
    this.onEnd = () => {
      this.resumeTimer = 4;
    };
    this.controls.addEventListener('start', this.onStart);
    this.controls.addEventListener('end', this.onEnd);
    this.controls.enabled = false;
  }

  track(obj) {
    this.disposables.push(obj);
    return obj;
  }

  buildHall() {
    const { w, d, h } = HALL;
    const concrete = concreteTextures();
    concrete.map.repeat.set(5, 3.7);
    concrete.roughnessMap.repeat.set(5, 3.7);
    this.track(concrete.map);
    this.track(concrete.roughnessMap);
    const floorMat = this.track(
      new MeshStandardMaterial({ map: concrete.map, roughnessMap: concrete.roughnessMap, roughness: 1, metalness: 0 }),
    );
    const floor = new Mesh(this.track(new PlaneGeometry(w, d)), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // gele vloermarkering rond de tankplek
    const lineMat = this.track(new MeshStandardMaterial({ color: '#b8922f', roughness: 0.85 }));
    const addLine = (x, z, lw, ld, rot = 0) => {
      const m = new Mesh(this.track(new PlaneGeometry(lw, ld)), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rot;
      m.position.set(x, 0.006, z);
      m.receiveShadow = true;
      this.scene.add(m);
    };
    const bw = 12;
    const bd = 7.5;
    addLine(0, -bd / 2, bw, 0.18);
    addLine(0, bd / 2, bw, 0.18);
    addLine(-bw / 2, 0, 0.18, bd);
    addLine(bw / 2, 0, 0.18, bd);
    for (let i = 0; i < 7; i++) addLine(-bw / 2 - 1.2, -bd / 2 + 0.6 + i * 1.05, 1.6, 0.22, 0.7);

    // wanden van golfplaat
    const corr = corrugatedTextures();
    this.track(corr.map);
    this.track(corr.bumpMap);
    const wallMat = (rx, ry) => {
      const map = corr.map.clone();
      const bump = corr.bumpMap.clone();
      map.repeat.set(rx, ry);
      bump.repeat.set(rx, ry);
      map.needsUpdate = bump.needsUpdate = true;
      this.track(map);
      this.track(bump);
      return this.track(
        new MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 1.2, roughness: 0.62, metalness: 0.35, color: '#9aa39a' }),
      );
    };
    const sideMat = wallMat(6, 1.4);
    const addWall = (width, height, x, y, z, ry, mat) => {
      const m = new Mesh(this.track(new PlaneGeometry(width, height)), mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      this.scene.add(m);
      return m;
    };
    addWall(d, h, -w / 2, h / 2, 0, Math.PI / 2, sideMat);
    addWall(d, h, w / 2, h / 2, 0, -Math.PI / 2, sideMat);
    addWall(w, h, 0, h / 2, d / 2, Math.PI, wallMat(8, 1.4));
    // achterwand met grote deuropening
    const doorW = 14;
    const doorH = 8.5;
    const sideW = (w - doorW) / 2;
    const backMat = wallMat(3, 1.4);
    addWall(sideW, h, -w / 2 + sideW / 2, h / 2, -d / 2, 0, backMat);
    addWall(sideW, h, w / 2 - sideW / 2, h / 2, -d / 2, 0, backMat);
    addWall(doorW, h - doorH, 0, doorH + (h - doorH) / 2, -d / 2, 0, wallMat(2, 0.5));
    // deurpanelen half open geschoven
    const doorMat = wallMat(2.5, 1.2);
    for (const s of [-1, 1]) {
      const panel = new Mesh(this.track(new BoxGeometry(doorW / 2 - 2.4, doorH, 0.25)), doorMat);
      panel.position.set(s * (doorW / 2 - (doorW / 2 - 2.4) / 2 + 1.2), doorH / 2, -d / 2 - 0.4);
      panel.castShadow = true;
      this.scene.add(panel);
    }
    // daglicht buiten de deur
    const outside = new Mesh(
      this.track(new PlaneGeometry(doorW + 4, doorH + 2)),
      this.track(new MeshBasicMaterial({ color: new Color('#c9dcf0').multiplyScalar(2.2), fog: false })),
    );
    outside.position.set(0, doorH / 2, -d / 2 - 3);
    this.scene.add(outside);
    // lichtvlek op de vloer bij de deur
    const patch = new Mesh(
      this.track(new PlaneGeometry(5, 12)),
      this.track(
        new ShaderMaterial({
          uniforms: { uColor: { value: new Color('#9fb8d6') } },
          vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
          fragmentShader: `uniform vec3 uColor; varying vec2 vUv; void main(){ float a = smoothstep(0.0,0.35,vUv.x)*(1.0-smoothstep(0.65,1.0,vUv.x))*smoothstep(0.0,0.9,vUv.y); gl_FragColor = vec4(uColor * a * 0.35, 1.0); }`,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      ),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(0, 0.01, -d / 2 + 6);
    patch.scale.set(2.4, 1, 1);
    this.scene.add(patch);

    // plafond en spanten
    const ceiling = new Mesh(this.track(new PlaneGeometry(w, d)), this.track(new MeshStandardMaterial({ color: '#15181a', roughness: 0.9 })));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = h;
    this.scene.add(ceiling);
    const steel = this.track(new MeshStandardMaterial({ color: '#2a2e2c', roughness: 0.55, metalness: 0.6 }));
    for (let i = 0; i < 6; i++) {
      const z = -d / 2 + 3 + i * ((d - 6) / 5);
      const beam = new Mesh(this.track(new BoxGeometry(w, 0.5, 0.3)), steel);
      beam.position.set(0, h - 1.6, z);
      beam.castShadow = true;
      this.scene.add(beam);
      for (let k = -3; k <= 3; k++) {
        const brace = new Mesh(this.track(new BoxGeometry(0.12, 1.9, 0.12)), steel);
        brace.position.set(k * 6.2, h - 0.75, z);
        brace.rotation.z = k % 2 === 0 ? 0.55 : -0.55;
        this.scene.add(brace);
      }
    }
    for (const x of [-w / 2 + 0.4, w / 2 - 0.4]) {
      for (let i = 0; i < 5; i++) {
        const col = new Mesh(this.track(new BoxGeometry(0.4, h, 0.4)), steel);
        col.position.set(x, h / 2, -d / 2 + 2 + i * ((d - 4) / 4));
        this.scene.add(col);
      }
    }
  }

  buildLights() {
    this.scene.add(new HemisphereLight('#3b4652', '#1a1511', 0.2));

    const lampShade = this.track(new MeshStandardMaterial({ color: '#2f3a2c', roughness: 0.5, metalness: 0.5, side: DoubleSide }));
    const bulbMat = this.track(new MeshBasicMaterial({ color: new Color('#ffd9a0').multiplyScalar(3), fog: false }));
    const cableMat = this.track(new MeshBasicMaterial({ color: '#0b0b0b' }));
    this.lamps = [];
    const lampSpots = [
      { x: 0.4, z: 0.2, key: true },
      { x: -9, z: -6 },
      { x: 9, z: 5 },
      { x: -10, z: 8 },
      { x: 11, z: -8 },
    ];
    for (const spot of lampSpots) {
      const g = new Group();
      const y = HALL.h - 3.2;
      g.position.set(spot.x, y, spot.z);
      const cable = new Mesh(this.track(new CylinderGeometry(0.015, 0.015, 3.2, 4)), cableMat);
      cable.position.y = 1.6;
      g.add(cable);
      const shade = new Mesh(this.track(new ConeGeometry(0.75, 0.55, 20, 1, true)), lampShade);
      shade.position.y = -0.1;
      g.add(shade);
      const bulb = new Mesh(this.track(new SphereGeometry(0.16, 12, 8)), bulbMat);
      bulb.position.y = -0.3;
      g.add(bulb);
      const shaftH = y - 0.3;
      const shaftGeo = this.track(new CylinderGeometry(0.55, spot.key ? 5.2 : 3.6, shaftH, 32, 1, true));
      // uv.y: 1 bij de lamp, 0 op de vloer
      const shaft = new Mesh(shaftGeo, this.track(lightShaftMaterial('#ffcf8a', spot.key ? 0.16 : 0.1)));
      shaft.position.y = -0.3 - shaftH / 2;
      shaft.renderOrder = 2;
      g.add(shaft);
      this.scene.add(g);
      this.lamps.push({ group: g, shaft, base: spot.key ? 0.16 : 0.1, phase: this.rng.range(0, 10) });

      const light = new SpotLight('#ffcf94', spot.key ? 420 : 110, 32, spot.key ? 0.62 : 0.7, 0.65, 2);
      light.position.set(spot.x, y - 0.35, spot.z);
      light.target.position.set(spot.x * (spot.key ? 1 : 0.9), 0, spot.z);
      if (spot.key) {
        light.castShadow = true;
        light.shadow.mapSize.set(2048, 2048);
        light.shadow.bias = -0.0002;
        light.shadow.normalBias = 0.02;
        light.shadow.camera.near = 2;
        light.shadow.camera.far = 20;
        this.keyLight = light;
      }
      this.scene.add(light, light.target);
    }

    // koel tegenlicht uit de deur
    const rim = new SpotLight('#a8c4ff', 420, 50, 0.5, 0.8, 2);
    rim.position.set(0, 6, -HALL.d / 2 - 1);
    rim.target.position.set(0, 1, 0);
    this.scene.add(rim, rim.target);

    // zachte opvulling van voren, zodat de camouflage leesbaar blijft
    const fill = new SpotLight('#ffe8cc', 70, 40, 0.6, 1, 2);
    fill.position.set(8, 5, 12);
    fill.target.position.set(0, 1.2, 0);
    this.scene.add(fill, fill.target);
  }

  buildProps() {
    const wood = this.track(woodTexture());
    const crateMat = this.track(new MeshStandardMaterial({ map: wood, roughness: 0.85 }));
    const crateGeo = this.track(new BoxGeometry(1.4, 0.9, 0.9));
    const crates = [
      [-15, 0.45, -9, 0.1], [-13.5, 0.45, -9.2, -0.05], [-14.3, 1.35, -9.1, 0.2], [-15.5, 0.45, -7.6, 0.4],
      [14.5, 0.45, 9, 0.3], [13, 0.45, 9.4, -0.2], [13.8, 1.35, 9.2, 0.05],
    ];
    for (const [x, y, z, r] of crates) {
      const m = new Mesh(crateGeo, crateMat);
      m.position.set(x, y, z);
      m.rotation.y = r;
      m.castShadow = m.receiveShadow = true;
      this.scene.add(m);
    }
    // olievaten
    const drumGeo = this.track(new CylinderGeometry(0.3, 0.3, 0.9, 20));
    const drumMats = ['#3d4a2a', '#4a2d1e', '#2f3534'].map((c) =>
      this.track(new MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.45 })),
    );
    const drums = [[16, -6], [16.7, -5.5], [16.3, -4.8], [-16.5, 6], [-17.1, 6.6], [15.6, -4.6]];
    drums.forEach(([x, z], i) => {
      const m = new Mesh(drumGeo, drumMats[i % 3]);
      m.position.set(x, i === 5 ? 0.3 : 0.45, z);
      if (i === 5) m.rotation.z = Math.PI / 2;
      m.castShadow = m.receiveShadow = true;
      this.scene.add(m);
    });
    // granatenrek met 75 mm munitie
    const rack = new Mesh(this.track(new BoxGeometry(3.2, 0.12, 0.8)), crateMat);
    rack.position.set(-8, 0.9, 11.5);
    rack.castShadow = rack.receiveShadow = true;
    this.scene.add(rack);
    for (const lx of [-1.5, 1.5]) {
      const leg = new Mesh(this.track(new BoxGeometry(0.1, 0.9, 0.7)), crateMat);
      leg.position.set(-8 + lx, 0.45, 11.5);
      this.scene.add(leg);
    }
    const caseGeo = this.track(new CylinderGeometry(0.045, 0.05, 0.62, 12));
    const tipGeo = this.track(new ConeGeometry(0.037, 0.2, 12));
    const brass = this.track(new MeshStandardMaterial({ color: '#b58a3c', roughness: 0.35, metalness: 0.9 }));
    const tipMat = this.track(new MeshStandardMaterial({ color: '#1a1a18', roughness: 0.5, metalness: 0.4 }));
    const cases = new InstancedMesh(caseGeo, brass, 24);
    const tips = new InstancedMesh(tipGeo, tipMat, 24);
    const m4 = new Matrix4();
    let n = 0;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 12; i++) {
        const x = -8 - 1.35 + i * 0.245;
        const z = 11.5 - 0.18 + row * 0.36;
        m4.makeTranslation(x, 0.96 + 0.31, z);
        cases.setMatrixAt(n, m4);
        m4.makeTranslation(x, 0.96 + 0.62 + 0.1, z);
        tips.setMatrixAt(n, m4);
        n++;
      }
    }
    cases.castShadow = tips.castShadow = true;
    this.scene.add(cases, tips);
  }

  buildDust() {
    const count = 700;
    const pos = new Float32Array(count * 3);
    this.dustVel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = this.rng.range(-12, 12);
      pos[i * 3 + 1] = this.rng.range(0.2, 9);
      pos[i * 3 + 2] = this.rng.range(-10, 10);
      this.dustVel[i * 3] = this.rng.range(-0.05, 0.05);
      this.dustVel[i * 3 + 1] = this.rng.range(-0.02, 0.03);
      this.dustVel[i * 3 + 2] = this.rng.range(-0.05, 0.05);
    }
    const geo = this.track(new BufferGeometry());
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    const tex = this.track(softDotTexture());
    const mat = this.track(
      new PointsMaterial({
        size: 0.05,
        map: tex,
        color: '#ffe2b0',
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.dust = new Points(geo, mat);
    this.scene.add(this.dust);
  }

  setActive(active) {
    this.controls.enabled = active;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    this.time += dt;
    if (this.resumeTimer > 0) {
      this.resumeTimer -= dt;
      if (this.resumeTimer <= 0) this.controls.autoRotate = true;
    }
    this.controls.update(dt);
    // stof laten zweven
    const p = this.dust.geometry.attributes.position;
    const a = p.array;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += (this.dustVel[i] + Math.sin(this.time * 0.3 + i) * 0.01) * dt;
      a[i + 1] += this.dustVel[i + 1] * dt;
      a[i + 2] += (this.dustVel[i + 2] + Math.cos(this.time * 0.25 + i) * 0.01) * dt;
      if (a[i + 1] > 9) a[i + 1] = 0.2;
      if (a[i + 1] < 0.2) a[i + 1] = 9;
      if (Math.abs(a[i]) > 12) a[i] *= -0.98;
      if (Math.abs(a[i + 2]) > 10) a[i + 2] *= -0.98;
    }
    p.needsUpdate = true;
    // lampen flikkeren heel licht
    for (const l of this.lamps) {
      const f = 1 + 0.04 * Math.sin(this.time * 7 + l.phase) * Math.sin(this.time * 2.3 + l.phase * 2);
      l.shaft.material.uniforms.uStrength.value = l.base * f;
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.controls.removeEventListener('start', this.onStart);
    this.controls.removeEventListener('end', this.onEnd);
    this.controls.dispose();
    for (const d of this.disposables) d.dispose();
    this.envTexture.dispose();
    this.tank.dispose();
  }
}
