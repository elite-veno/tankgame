// Meedraaiende rupsbanden en wielen.
//
// In panther.glb zitten de rupsschakels, loopwielen, het aandrijfwiel (voor) en het spanwiel (achter)
// samengevoegd in de romp-mesh. Bij het laden krijgt elke vertex van die onderdelen een extra attribuut:
//   aTrack = (schakelnummer, kant, positie langs de schakel, positie loodrecht erop)
//   aWheel = (soort wiel + 1, kant, as x, as y)   (soort: 0 loopwiel, 1 aandrijfwiel, 2 spanwiel)
// Een shaderpatch schuift de schakels daarmee langs de rupsbaan en draait de wielen om hun as.
// Omdat alle 87 schakels gelijk verdeeld liggen, hoeft een schakel nooit meer dan één plaats op te
// schuiven: daarna ziet de band er precies zo uit als aan het begin.
//
// De maten komen uit panther/scripts/pz_geom.py, het script waarmee het model gebouwd is
// (modelassen: +x vooruit, +y omhoog, z = zijkant; links = negatieve z).
import { BufferAttribute, DataTexture, FloatType, NearestFilter, RGBAFormat, Vector2, Vector3 } from 'three';

const TRACK_PITCH_NOMINAL = 0.153;
const TRACK_T = 0.1;
const WHEEL_R = 0.43;
const WHEEL_Y = TRACK_T + WHEEL_R;
const STATION_X = Array.from({ length: 8 }, (_, i) => 1.78 - i * 0.505);
const SPROCKET = [2.8, 0.62];
const SPROCKET_RP = TRACK_PITCH_NOMINAL / (2 * Math.sin(Math.PI / 17));
const IDLER = [-2.72, 0.62];
const IDLER_R = 0.33;
const TRACK_CENTER = 1.31; // afstand van het midden van de rupsband tot het midden van de tank
const OUTER_ROW = [TRACK_CENTER + 0.26, TRACK_CENTER - 0.26];
const INNER_ROW = [TRACK_CENTER + 0.115, TRACK_CENTER - 0.115];

export const TRACK_LINKS = 87;
export const TRACK_HALF_GAUGE = TRACK_CENTER;

// wielen per kant: as, grootste straal van hun onderdelen en de vlakken van de wielschijven
const WHEELS = [
  ...STATION_X.map((x, i) => ({
    kind: 0,
    cx: x,
    cy: WHEEL_Y,
    rMax: 0.44,
    // [vlak, kant waar de naafbouten uitsteken (+1 naar buiten, -1 naar de romp)]
    planes: (i % 2 === 0 ? OUTER_ROW : INNER_ROW).map((p, j) => [p, j === 0 ? 1 : -1]),
  })),
  { kind: 1, cx: SPROCKET[0], cy: SPROCKET[1], rMax: 0.47, planes: [] },
  { kind: 2, cx: IDLER[0], cy: IDLER[1], rMax: 0.345, planes: [] },
];

// ---------------------------------------------------------------------------------- rupsbaan
// Hart van de rupsband: omhullende van de wielen (zoals track_centreline() in pz_geom.py),
// daarna 87 gelijk verdeelde schakelposities (resample_closed()).
function circleHull(circles, n) {
  const unique = new Map();
  for (const [cx, cy, r] of circles) {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const p = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      unique.set(`${p[0]},${p[1]}`, p);
    }
  }
  const pts = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  const upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function buildTrackPath() {
  const circles = STATION_X.map((x) => [x, WHEEL_Y, WHEEL_R + TRACK_T / 2]);
  circles.push([SPROCKET[0], SPROCKET[1], SPROCKET_RP]);
  circles.push([IDLER[0], IDLER[1], IDLER_R + TRACK_T / 2]);
  const P = circleHull(circles, 240);
  const seg = P.map((p, i) => {
    const q = P[(i + 1) % P.length];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  const cum = [0];
  for (const s of seg) cum.push(cum[cum.length - 1] + s);
  const length = cum[cum.length - 1];
  // per schakel: midden (x, y) en richting langs de band (tx, ty)
  const links = new Float32Array(TRACK_LINKS * 4);
  let i = 0;
  for (let k = 0; k < TRACK_LINKS; k++) {
    const s = (length * k) / TRACK_LINKS;
    while (i + 1 < P.length && cum[i + 1] <= s) i++;
    const a = P[i];
    const b = P[(i + 1) % P.length];
    const t = seg[i] > 0 ? (s - cum[i]) / seg[i] : 0;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-12;
    links.set([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / d, (b[1] - a[1]) / d], k * 4);
  }
  return { links, pitch: length / TRACK_LINKS };
}

const TRACK = buildTrackPath();
export const TRACK_PITCH = TRACK.pitch;

// straal waarmee elk soort wiel over de band rolt (loopwiel, aandrijfwiel, spanwiel). Het aandrijfwiel
// draait precies één tand (1/17 omwenteling) per schakel, zodat de tanden in de band blijven grijpen.
const ROLL_RADIUS = [WHEEL_R, (TRACK.pitch * 17) / (2 * Math.PI), IDLER_R + TRACK_T / 2];

let pathTexture = null;
function getPathTexture() {
  if (!pathTexture) {
    pathTexture = new DataTexture(TRACK.links, TRACK_LINKS, 1, RGBAFormat, FloatType);
    pathTexture.minFilter = pathTexture.magFilter = NearestFilter;
    pathTexture.generateMipmaps = false;
    pathTexture.needsUpdate = true;
  }
  return pathTexture;
}

// ---------------------------------------------------------------------------------- vertices koppelen
// schakel waar een punt (x, y) bij hoort: van de dichtstbijzijnde drie schakelmiddens die waarvan het
// punt het minst ver langs de band ligt
function nearestLink(x, y) {
  const L = TRACK.links;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < TRACK_LINKS; k++) {
    const d = (x - L[k * 4]) ** 2 + (y - L[k * 4 + 1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  let link = best;
  let along = Infinity;
  for (const k of [(best + TRACK_LINKS - 1) % TRACK_LINKS, best, (best + 1) % TRACK_LINKS]) {
    const a = Math.abs((x - L[k * 4]) * L[k * 4 + 2] + (y - L[k * 4 + 1]) * L[k * 4 + 3]);
    if (a < along) {
      along = a;
      link = k;
    }
  }
  return link;
}

// Per los onderdeel één schakel (de meeste van zijn vertices): in het vereenvoudigde LOD1-model zijn
// hier en daar stukjes van twee buurschakels aan elkaar gelast; die bewegen dan als één geheel mee in
// plaats van uit elkaar getrokken te worden in de bochten.
function trackAttribute(pos, index) {
  const L = TRACK.links;
  const out = new Float32Array((pos.length / 3) * 4);
  const votes = new Int32Array(TRACK_LINKS);
  for (const verts of islands(pos, index)) {
    votes.fill(0);
    for (const i of verts) votes[nearestLink(pos[i * 3], pos[i * 3 + 1])]++;
    let link = 0;
    for (let k = 1; k < TRACK_LINKS; k++) if (votes[k] > votes[link]) link = k;
    const tx = L[link * 4 + 2];
    const ty = L[link * 4 + 3];
    for (const i of verts) {
      const dx = pos[i * 3] - L[link * 4];
      const dy = pos[i * 3 + 1] - L[link * 4 + 1];
      const z = pos[i * 3 + 2];
      const lt = dx * tx + dy * ty;
      const ln = dx * ty - dy * tx; // normaal (ty, -tx) wijst naar buiten
      const onTrack = Math.abs(lt) <= TRACK.pitch * 1.6 && Math.abs(ln) < 0.2 && Math.abs(z) > 0.9 && Math.abs(z) < 1.72;
      out.set([link, onTrack ? (z > 0 ? 1 : 0) : -1, lt, ln], i * 4);
    }
  }
  return out;
}

// losse delen van een mesh: vertices op dezelfde plek of in dezelfde driehoek horen bij elkaar
function islands(pos, index) {
  const n = pos.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const key =
      (Math.round((pos[i * 3] + 10) * 1e4) * 200001 + Math.round((pos[i * 3 + 1] + 10) * 1e4)) * 200001 +
      Math.round((pos[i * 3 + 2] + 10) * 1e4);
    const j = seen.get(key);
    if (j === undefined) seen.set(key, i);
    else union(i, j);
  }
  if (index) {
    for (let t = 0; t < index.length; t += 3) {
      union(index[t], index[t + 1]);
      union(index[t], index[t + 2]);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }
  return groups.values();
}

// bij welk wiel hoort dit losse deel? (null = vast onderdeel, zoals de torsiearmen en de eindaandrijving)
function wheelOf(pos, verts) {
  const side = Math.sign(pos[verts[0] * 3 + 2]);
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const i of verts) {
    const az = Math.abs(pos[i * 3 + 2]);
    if (az < 0.95 || Math.sign(pos[i * 3 + 2]) !== side) return null;
    sx += pos[i * 3];
    sy += pos[i * 3 + 1];
    sz += az;
  }
  const bx = sx / verts.length;
  const by = sy / verts.length;
  const bz = sz / verts.length;
  for (const w of WHEELS) {
    let r = 0;
    for (const i of verts) r = Math.max(r, Math.hypot(pos[i * 3] - w.cx, pos[i * 3 + 1] - w.cy));
    if (r > w.rMax) continue;
    const dc = Math.hypot(bx - w.cx, by - w.cy);
    if (dc < 0.03) return w; // rond om de as: schijf, band, tandkrans, naaf
    if (w.kind === 0 && dc > 0.07 && dc < 0.36) {
      // bout op een wielschijf: steekt aan één kant 4 tot 10 cm uit het vlak van zijn eigen schijf
      for (const [p, dir] of w.planes) {
        const off = (bz - p) * dir;
        if (off > 0.035 && off < 0.1) return w;
      }
    }
    if (w.kind === 1 && dc > 0.15 && dc < 0.31 && ((bz > 1.04 && bz < 1.08) || (bz > 1.52 && bz < 1.57))) return w;
  }
  return null;
}

function wheelAttribute(pos, index) {
  const out = new Float32Array((pos.length / 3) * 4);
  let count = 0;
  for (const verts of islands(pos, index)) {
    const w = wheelOf(pos, verts);
    if (!w) continue;
    const side = pos[verts[0] * 3 + 2] > 0 ? 1 : 0;
    for (const i of verts) out.set([w.kind + 1, side, w.cx, w.cy], i * 4);
    count += verts.length;
  }
  return count > 0 ? out : null;
}

// Voegt de attributen toe aan de romp-meshes van een geladen tankmodel (eenmalig per GLTF;
// kopieën van de scène delen de geometrie).
export function prepareRunningGear(scene) {
  const hull = scene.getObjectByName('hull');
  if (!hull) return;
  hull.traverse((o) => {
    if (!o.isMesh || o.geometry.userData.runningGear !== undefined) return;
    const g = o.geometry;
    // losse kopie van de posities: in de LOD-modellen staan positie en normaal door elkaar in één buffer
    const P = g.attributes.position;
    const pos = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
      pos[i * 3] = P.getX(i);
      pos[i * 3 + 1] = P.getY(i);
      pos[i * 3 + 2] = P.getZ(i);
    }
    const index = g.index ? g.index.array : null;
    g.userData.runningGear = null;
    if (o.material.name === 'G_track_steel') {
      g.setAttribute('aTrack', new BufferAttribute(trackAttribute(pos, index), 4));
      g.userData.runningGear = 'track';
    } else if (o.material.name === 'G_paint_hull' || o.material.name === 'G_dark_steel') {
      const attr = wheelAttribute(pos, index);
      if (attr) {
        g.setAttribute('aWheel', new BufferAttribute(attr, 4));
        g.userData.runningGear = 'wheel';
      }
    }
  });
}

// ---------------------------------------------------------------------------------- shader
const TRACK_VERTEX_PARS = /* glsl */ `
attribute vec4 aTrack;
uniform highp sampler2D uTrackPath;
uniform vec2 uTrackShift;
vec4 rgLink(float k) {
  return texelFetch(uTrackPath, ivec2(int(mod(k + 0.5, ${TRACK_LINKS}.0)), 0), 0);
}
// midden en richting van de band op schakelpositie u (tussen twee schakelplaatsen in)
vec4 rgTrackAt(float u) {
  float i0 = floor(u);
  float f = u - i0;
  vec4 a = rgLink(i0);
  vec4 b = rgLink(i0 + 1.0);
  return vec4(mix(a.xy, b.xy, f), normalize(mix(a.zw, b.zw, f)));
}
float rgTrackU() {
  return aTrack.x + (aTrack.y > 0.5 ? uTrackShift.y : uTrackShift.x);
}
vec3 rgPosition(vec3 p) {
  if (aTrack.y < -0.5) return p;
  vec4 s = rgTrackAt(rgTrackU());
  return vec3(s.xy + s.zw * aTrack.z + vec2(s.w, -s.z) * aTrack.w, p.z);
}
vec3 rgNormal(vec3 n) {
  if (aTrack.y < -0.5) return n;
  vec4 own = rgLink(aTrack.x);
  vec2 local = vec2(dot(n.xy, own.zw), n.x * own.w - n.y * own.z);
  vec4 s = rgTrackAt(rgTrackU());
  return vec3(s.zw * local.x + vec2(s.w, -s.z) * local.y, n.z);
}
`;

const WHEEL_VERTEX_PARS = /* glsl */ `
attribute vec4 aWheel;
uniform vec3 uWheelAngleL;
uniform vec3 uWheelAngleR;
vec2 rgRotate(vec2 v) {
  vec3 a = aWheel.y > 0.5 ? uWheelAngleR : uWheelAngleL;
  float ang = aWheel.x < 1.5 ? a.x : (aWheel.x < 2.5 ? a.y : a.z);
  float c = cos(ang);
  float s = sin(ang);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}
vec3 rgPosition(vec3 p) {
  if (aWheel.x < 0.5) return p;
  return vec3(aWheel.zw + rgRotate(p.xy - aWheel.zw), p.z);
}
vec3 rgNormal(vec3 n) {
  if (aWheel.x < 0.5) return n;
  return vec3(rgRotate(n.xy), n.z);
}
`;

// Uniforms van één tank; alle gepatchte materialen van die tank delen ze.
export function createRunningGearUniforms() {
  return {
    uTrackPath: { value: getPathTexture() },
    uTrackShift: { value: new Vector2() },
    uWheelAngleL: { value: new Vector3() },
    uWheelAngleR: { value: new Vector3() },
  };
}

// Zet de stand van de rupsen: afgelegde weg van de linker- en rechterband (meter, vooruit positief).
export function setTrackTravel(uniforms, left, right) {
  const wrap = (v, m) => ((v % m) + m) % m;
  // rijdt de tank vooruit, dan schuift de onderkant van de band naar achteren (lagere schakelnummers)
  uniforms.uTrackShift.value.set(wrap(-left / TRACK.pitch, TRACK_LINKS), wrap(-right / TRACK.pitch, TRACK_LINKS));
  const TAU = Math.PI * 2;
  const angles = (travel, out) =>
    out.set(wrap(-travel / ROLL_RADIUS[0], TAU), wrap(-travel / ROLL_RADIUS[1], TAU), wrap(-travel / ROLL_RADIUS[2], TAU));
  angles(left, uniforms.uWheelAngleL.value);
  angles(right, uniforms.uWheelAngleR.value);
}

// Past een materiaal aan zodat het de rupsschakels ('track') of wielen ('wheel') laat bewegen.
// Werkt bovenop een eventuele eerdere onBeforeCompile (zoals de camouflage).
export function patchRunningGear(material, kind, uniforms) {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  const pars = kind === 'track' ? TRACK_VERTEX_PARS : WHEEL_VERTEX_PARS;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${pars}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = rgNormal(objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = rgPosition(transformed);');
  };
  material.customProgramCacheKey = () => `${previousKey}|running-gear-${kind}`;
  return material;
}
