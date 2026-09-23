// Lucht, zon (met meebewegende schaduwcamera), nevel en omgevingslicht van de bosmap.
import {
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

export const SUN_DIRECTION = new Vector3(-0.52, 0.62, 0.59).normalize(); // richting naar de zon
const FOG_COLOR = new Color('#b3c2bd');

export class Environment {
  constructor(scene, envTexture, config) {
    this.scene = scene;
    const g = config.graphics;
    scene.fog = new FogExp2(FOG_COLOR.clone(), g.fogDensity);
    scene.background = FOG_COLOR.clone();
    scene.environment = envTexture;
    scene.environmentIntensity = 0.3;

    // hemel
    this.skyMaterial = new ShaderMaterial({
      uniforms: {
        uZenith: { value: new Color('#4f86c6') },
        uHorizon: { value: FOG_COLOR.clone() },
        uSunDir: { value: SUN_DIRECTION.clone() },
        uSunColor: { value: new Color('#fff0d0') },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(smoothstep(0.0, 0.85, h), 0.55));
          float s = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(s, 1200.0) * 40.0 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.08);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new Mesh(new SphereGeometry(1500, 32, 16), this.skyMaterial);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // zon met schaduw
    this.sun = new DirectionalLight('#ffeed2', 3.6);
    this.sun.castShadow = g.shadows;
    this.shadowHalf = g.shadowRange / 2;
    this.shadowMapSize = g.shadowMapSize;
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowHalf;
    cam.right = this.shadowHalf;
    cam.top = this.shadowHalf;
    cam.bottom = -this.shadowHalf;
    cam.near = 1;
    cam.far = 600;
    this.sun.shadow.mapSize.set(g.shadowMapSize, g.shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 2;
    scene.add(this.sun, this.sun.target);

    this.hemi = new HemisphereLight('#bcd2ea', '#4a4032', 0.18);
    scene.add(this.hemi);

    // lichtruimte-assen voor het vastzetten van de schaduw op texels (tegen flikkeren)
    this.lightForward = SUN_DIRECTION.clone().negate();
    this.lightRight = new Vector3().crossVectors(this.lightForward, new Vector3(0, 1, 0)).normalize();
    this.lightUp = new Vector3().crossVectors(this.lightRight, this.lightForward).normalize();
    this._focus = new Vector3();
  }

  // focus: punt waar de schaduw het scherpst moet zijn (voor de speler, in de kijkrichting)
  update(focus, camera) {
    const texel = (this.shadowHalf * 2) / this.shadowMapSize;
    const f = this._focus.copy(focus);
    const r = f.dot(this.lightRight);
    const u = f.dot(this.lightUp);
    f.addScaledVector(this.lightRight, Math.round(r / texel) * texel - r);
    f.addScaledVector(this.lightUp, Math.round(u / texel) * texel - u);
    this.sun.target.position.copy(f);
    this.sun.position.copy(f).addScaledVector(SUN_DIRECTION, 300);
    this.sun.target.updateMatrixWorld();
    this.sky.position.copy(camera.position);
  }

  dispose() {
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this.sun.dispose();
    this.sun.shadow.map?.dispose();
  }
}
