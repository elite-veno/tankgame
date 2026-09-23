// Procedurele bosmap: terrein, wegen, open plekken, veroveringspunten, teambases, bomen en rotsen.
// Volledig deterministisch vanuit de seed in de config, zodat een server later exact dezelfde kaart bouwt.
// Geen DOM of rendering: de weergave leest de kaartdata en bouwt er zelf meshes van.
import { Heightfield } from './terrain.js';
import { ObstacleGrid } from './obstacles.js';
import { Noise2D } from '../core/noise.js';
import { RNG } from '../core/rng.js';
import { clamp, lerp, smoothstep } from '../core/mathUtils.js';

const SURFACE_RES = 1024;

// Genereert de kaart in stappen: yield { progress, label } zodat een laadscherm kan bijwerken.
export function* mapGenerator(config) {
  const mc = config.map;
  const rng = new RNG(mc.seed);
  const noiseA = new Noise2D(mc.seed + 11);
  const noiseB = new Noise2D(mc.seed + 23);
  const noiseC = new Noise2D(mc.seed + 37);
  const half = mc.size / 2;
  const hf = new Heightfield(mc.worldSize, mc.heightResolution);

  const map = {
    seed: mc.seed,
    size: mc.size,
    half,
    worldSize: mc.worldSize,
    heightfield: hf,
    bases: [],
    points: [],
    roads: [],
    meadows: [],
    trees: [],
    rocks: [],
    obstacles: null,
    surface: null,
    treeExtent: half + mc.treeBorderDepth,
  };

  yield { progress: 0.02, label: 'Terrein vormen' };

  // ---------------------------------------------------------------- layout
  const bd = mc.baseDistance;
  map.bases.push(makeBase(0, 0, bd, Math.PI / 2));
  map.bases.push(makeBase(1, 0, -bd, -Math.PI / 2));
  const jitter = () => rng.range(-12, 12);
  const ids = ['A', 'B', 'C'];
  const px = [-mc.pointSpread, 0, mc.pointSpread];
  for (let i = 0; i < 3; i++) {
    map.points.push({
      id: ids[i],
      index: i,
      x: px[i] + jitter(),
      z: (i - 1) * 6 + jitter() * 0.6,
      radius: config.capture.radius,
      clearing: mc.pointClearingRadius,
    });
  }
  // open plekken (weides) voor afwisseling en zichtlijnen
  let guard = 0;
  while (map.meadows.length < mc.meadowCount && guard++ < 500) {
    const m = { x: rng.range(-half + 40, half - 40), z: rng.range(-half + 60, half - 60), r: rng.range(18, 40) };
    const clash =
      map.points.some((p) => Math.hypot(p.x - m.x, p.z - m.z) < p.clearing + m.r + 25) ||
      map.bases.some((b) => Math.hypot(b.x - m.x, b.z - m.z) < mc.baseClearingRadius + m.r + 20) ||
      map.meadows.some((o) => Math.hypot(o.x - m.x, o.z - m.z) < o.r + m.r + 40);
    if (!clash) map.meadows.push(m);
  }

  // ---------------------------------------------------------------- basishoogte + vlakke zones
  const zones = [];
  for (const p of map.points) zones.push({ x: p.x, z: p.z, rIn: p.clearing * 0.75, rOut: p.clearing + 16 });
  for (const b of map.bases) zones.push({ x: b.x, z: b.z, rIn: mc.baseClearingRadius * 0.8, rOut: mc.baseClearingRadius + 26 });

  const baseHeight = (x, z) => {
    let h = 13 * noiseA.fbm(x / 330, z / 330, 4) + 3.2 * noiseB.fbm(x / 85, z / 85, 3);
    const outside = Math.max(Math.abs(x), Math.abs(z)) - half;
    h += 24 * smoothstep(-25, 170, outside); // heuvelrand rond het speelveld
    return h;
  };
  for (const zn of zones) zn.h = baseHeight(zn.x, zn.z);

  const row = hf.res + 1;
  for (let iz = 0; iz <= hf.res; iz++) {
    const z = hf.pointZ(iz);
    for (let ix = 0; ix <= hf.res; ix++) {
      const x = hf.pointX(ix);
      let h = baseHeight(x, z);
      for (const zn of zones) {
        const d = Math.hypot(x - zn.x, z - zn.z);
        if (d < zn.rOut) h = lerp(h, zn.h, 1 - smoothstep(zn.rIn, zn.rOut, d));
      }
      hf.heights[iz * row + ix] = h;
    }
  }

  yield { progress: 0.18, label: 'Bospaden aanleggen' };

  // ---------------------------------------------------------------- wegen
  const B0 = map.bases[0];
  const B1 = map.bases[1];
  const [PA, PB, PC] = map.points;
  const links = [
    [B0, PA], [B0, PB], [B0, PC],
    [B1, PA], [B1, PB], [B1, PC],
    [PA, PB], [PB, PC],
  ];
  for (const [a, b] of links) map.roads.push(makeRoad(a, b, mc.roadWidth, rng, hf));

  // afstand tot dichtstbijzijnde weg op hoogteveldresolutie (voor vlakken en boomvrije stroken)
  const roadDist = new Float32Array(row * row).fill(1e9);
  const roadTarget = new Float32Array(row * row);
  const reach = mc.roadWidth / 2 + 12;
  for (const road of map.roads) {
    for (const s of road.samples) {
      const i0 = Math.max(0, Math.floor((s.x - reach + hf.half) / hf.cell));
      const i1 = Math.min(hf.res, Math.ceil((s.x + reach + hf.half) / hf.cell));
      const j0 = Math.max(0, Math.floor((s.z - reach + hf.half) / hf.cell));
      const j1 = Math.min(hf.res, Math.ceil((s.z + reach + hf.half) / hf.cell));
      for (let j = j0; j <= j1; j++) {
        const z = hf.pointZ(j);
        for (let i = i0; i <= i1; i++) {
          const x = hf.pointX(i);
          const d = Math.hypot(x - s.x, z - s.z);
          const k = j * row + i;
          if (d < roadDist[k]) {
            roadDist[k] = d;
            roadTarget[k] = s.h;
          }
        }
      }
    }
  }
  const rw = mc.roadWidth / 2;
  for (let k = 0; k < roadDist.length; k++) {
    const d = roadDist[k];
    if (d > rw + 9) continue;
    const w = (1 - smoothstep(rw * 0.9, rw + 9, d)) * 0.92;
    hf.heights[k] = lerp(hf.heights[k], roadTarget[k] - 0.12 * (1 - smoothstep(0, rw, d)), w);
  }
  map.roadDistanceAt = (x, z) => {
    const fx = clamp(Math.round((x + hf.half) / hf.cell), 0, hf.res);
    const fz = clamp(Math.round((z + hf.half) / hf.cell), 0, hf.res);
    return roadDist[fz * row + fx];
  };
  // zelfde hoogte voor de zones ook na het wegenwerk
  for (const p of map.points) p.y = hf.heightAt(p.x, p.z);
  for (const b of map.bases) {
    b.y = hf.heightAt(b.x, b.z);
    for (const s of b.spawns) s.y = hf.heightAt(s.x, s.z);
  }

  yield { progress: 0.32, label: 'Bomen planten' };

  // ---------------------------------------------------------------- bomen
  const treeExtent = map.treeExtent;
  const speciesWeights = mc.treeSpecies.map((s) => s.weight);
  const clearingAt = (x, z) => {
    for (const p of map.points) {
      const d = Math.hypot(x - p.x, z - p.z);
      const wobble = 5 * noiseC.noise(Math.atan2(z - p.z, x - p.x) * 1.3 + p.index * 7, 0.5);
      if (d < p.clearing + wobble) return true;
    }
    for (const b of map.bases) {
      if (Math.hypot(x - b.x, z - b.z) < mc.baseClearingRadius + 4 * noiseC.noise(x / 20, z / 20)) return true;
    }
    for (const m of map.meadows) {
      const d = Math.hypot(x - m.x, z - m.z);
      const wobble = 0.25 * m.r * noiseC.noise(Math.atan2(z - m.z, x - m.x) * 1.6 + m.x, m.z * 0.01);
      if (d < m.r + wobble) return true;
    }
    return false;
  };
  map.isClearing = clearingAt;

  const hashCell = 4;
  const hashCols = Math.ceil((treeExtent * 2) / hashCell) + 1;
  const hash = new Array(hashCols * hashCols);
  const hashIndex = (x, z) =>
    clamp(Math.floor((z + treeExtent) / hashCell), 0, hashCols - 1) * hashCols +
    clamp(Math.floor((x + treeExtent) / hashCell), 0, hashCols - 1);

  const step = 2.4;
  const candidates = [];
  for (let z = -treeExtent; z < treeExtent; z += step) {
    for (let x = -treeExtent; x < treeExtent; x += step) {
      candidates.push(x + rng.next() * step, z + rng.next() * step);
    }
  }
  // shuffle paren
  for (let i = candidates.length / 2 - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const ax = candidates[i * 2], az = candidates[i * 2 + 1];
    candidates[i * 2] = candidates[j * 2];
    candidates[i * 2 + 1] = candidates[j * 2 + 1];
    candidates[j * 2] = ax;
    candidates[j * 2 + 1] = az;
  }

  const total = candidates.length / 2;
  for (let c = 0; c < total; c++) {
    if (c % 40000 === 0) yield { progress: 0.32 + 0.33 * (c / total), label: 'Bomen planten' };
    const x = candidates[c * 2];
    const z = candidates[c * 2 + 1];
    const inPlay = Math.abs(x) < half && Math.abs(z) < half;
    let spacing;
    if (inPlay) {
      const edge = half - Math.max(Math.abs(x), Math.abs(z));
      if (clearingAt(x, z)) continue;
      if (map.roadDistanceAt(x, z) < mc.roadWidth / 2 + 2.6) continue;
      const density = smoothstep(-0.35, 0.55, noiseB.fbm(x / 140 + 9, z / 140 - 4, 3));
      spacing = lerp(mc.treeSpacingDense, mc.treeSpacingSparse, density);
      spacing = lerp(mc.treeSpacingBorder, spacing, smoothstep(0, 25, edge));
    } else {
      spacing = mc.treeSpacingBorder;
    }
    // buren controleren
    let ok = true;
    const r = Math.ceil(spacing / hashCell);
    const cx = clamp(Math.floor((x + treeExtent) / hashCell), 0, hashCols - 1);
    const cz = clamp(Math.floor((z + treeExtent) / hashCell), 0, hashCols - 1);
    for (let dz = -r; dz <= r && ok; dz++) {
      const zz = cz + dz;
      if (zz < 0 || zz >= hashCols) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= hashCols) continue;
        const list = hash[zz * hashCols + xx];
        if (!list) continue;
        for (const t of list) {
          const ddx = t.x - x;
          const ddz = t.z - z;
          if (ddx * ddx + ddz * ddz < spacing * spacing) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
    }
    if (!ok) continue;
    const species = rng.weighted(speciesWeights);
    const sp = mc.treeSpecies[species];
    const scale = rng.range(mc.treeScale[0], mc.treeScale[1]);
    const tree = {
      x,
      z,
      y: hf.heightAt(x, z),
      species,
      tile: species * 2 + (rng.next() < 0.5 ? 0 : 1),
      scale,
      flip: rng.next() < 0.5 ? -1 : 1,
      tint: rng.next(),
      h: sp.height * scale,
      r: Math.max(0.28, sp.trunkRadius * scale),
      border: !inPlay,
    };
    map.trees.push(tree);
    const hi = hashIndex(x, z);
    (hash[hi] || (hash[hi] = [])).push(tree);
  }

  yield { progress: 0.68, label: 'Rotsen plaatsen' };

  // ---------------------------------------------------------------- rotsen
  const treeNear = (x, z, dist) => {
    const cx = clamp(Math.floor((x + treeExtent) / hashCell), 0, hashCols - 1);
    const cz = clamp(Math.floor((z + treeExtent) / hashCell), 0, hashCols - 1);
    const r = Math.ceil(dist / hashCell);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = cx + dx, zz = cz + dz;
        if (xx < 0 || zz < 0 || xx >= hashCols || zz >= hashCols) continue;
        const list = hash[zz * hashCols + xx];
        if (!list) continue;
        for (const t of list) if (Math.hypot(t.x - x, t.z - z) < dist) return true;
      }
    }
    return false;
  };
  const rockOk = (x, z, r) => {
    if (Math.abs(x) > half - 8 || Math.abs(z) > half - 8) return false;
    if (map.roadDistanceAt(x, z) < mc.roadWidth / 2 + r + 1.5) return false;
    for (const p of map.points) if (Math.hypot(x - p.x, z - p.z) < p.radius + r + 3) return false;
    for (const b of map.bases) if (Math.hypot(x - b.x, z - b.z) < mc.baseClearingRadius * 0.7 + r) return false;
    for (const o of map.rocks) if (Math.hypot(x - o.x, z - o.z) < o.r + r + 6) return false;
    if (treeNear(x, z, r + 1.2)) return false;
    return true;
  };
  const addRock = (x, z, r) => {
    const h = r * rng.range(0.65, 1.15);
    map.rocks.push({
      x,
      z,
      y: hf.heightAt(x, z) - r * 0.22,
      r,
      h,
      rot: rng.range(0, Math.PI * 2),
      variant: rng.int(0, 3),
      stretch: rng.range(0.8, 1.25),
    });
  };
  // dekking rond de veroveringspunten
  for (const p of map.points) {
    let placed = 0;
    for (let tries = 0; tries < 80 && placed < 4; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(p.radius + 5, p.clearing - 2);
      const r = rng.range(1.6, 2.8);
      const x = p.x + Math.cos(a) * d;
      const z = p.z + Math.sin(a) * d;
      if (rockOk(x, z, r)) {
        addRock(x, z, r);
        placed++;
      }
    }
  }
  guard = 0;
  while (map.rocks.length < mc.rockCount && guard++ < 4000) {
    const x = rng.range(-half + 10, half - 10);
    const z = rng.range(-half + 10, half - 10);
    const r = rng.range(0.9, 3.0);
    if (rockOk(x, z, r)) addRock(x, z, r);
  }

  yield { progress: 0.76, label: 'Botsingsraster opbouwen' };

  // ---------------------------------------------------------------- obstakels voor de simulatie
  const grid = new ObstacleGrid(-half - 20, -half - 20, mc.size + 40, 8);
  for (const t of map.trees) {
    if (Math.abs(t.x) > half + 12 || Math.abs(t.z) > half + 12) continue;
    t.obstacle = grid.add({ x: t.x, z: t.z, r: t.r, h: t.h * 0.92, base: t.y - 0.5, kind: 'tree' });
  }
  for (const r of map.rocks) {
    r.obstacle = grid.add({ x: r.x, z: r.z, r: r.r * 0.9, h: r.h + r.r * 0.22, base: r.y - 0.3, kind: 'rock' });
  }
  map.obstacles = grid;

  yield { progress: 0.82, label: 'Bodem en paden schilderen' };

  // ---------------------------------------------------------------- oppervlaktekaart (voor de terreinshader)
  // R = grind/pad, G = open plek (gras/aarde), B = modder/slijtage, A = schaduw van het bladerdak
  map.surface = buildSurface(map, mc, noiseA, noiseC);

  yield { progress: 1, label: 'Klaar' };
  return map;
}

export function generateMap(config) {
  const gen = mapGenerator(config);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

function makeBase(team, x, z, yaw) {
  // spawnplekken in een rij, loodrecht op de kijkrichting
  const fx = Math.cos(yaw);
  const fz = -Math.sin(yaw);
  const rx = -fz; // rechts = (sin, 0, cos) van yaw
  const rz = fx;
  const spawns = [];
  const offsets = [-27.5, -16.5, -5.5, 5.5, 16.5, 27.5];
  for (let i = 0; i < offsets.length; i++) {
    const side = offsets[i];
    const back = i % 2 === 0 ? 0 : -8;
    spawns.push({ x: x + rx * side + fx * back, z: z + rz * side + fz * back, yaw });
  }
  return { team, x, z, yaw, spawns };
}

// Kronkelende weg van a naar b met een afgevlakt hoogteprofiel.
function makeRoad(a, b, width, rng, hf) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const nx = -dz / len;
  const nz = dx / len;
  const ctrl = [{ x: a.x, z: a.z }];
  const segments = 4;
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const off = rng.range(-1, 1) * Math.min(28, len * 0.1);
    ctrl.push({ x: a.x + dx * t + nx * off, z: a.z + dz * t + nz * off });
  }
  ctrl.push({ x: b.x, z: b.z });
  // Catmull-Rom bemonsteren, elke ~2 m
  const pts = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const n = Math.max(2, Math.ceil(segLen / 2));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (q0, q1, q2, q3) =>
        0.5 * (2 * q1 + (-q0 + q2) * t + (2 * q0 - 5 * q1 + 4 * q2 - q3) * t2 + (-q0 + 3 * q1 - 3 * q2 + q3) * t3);
      pts.push({ x: cr(p0.x, p1.x, p2.x, p3.x), z: cr(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  pts.push({ x: b.x, z: b.z });
  // hoogteprofiel glad maken (voortschrijdend gemiddelde over ±20 m)
  const raw = pts.map((p) => hf.heightAt(p.x, p.z));
  const win = 10;
  const samples = pts.map((p, i) => {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, i - win); k <= Math.min(pts.length - 1, i + win); k++) {
      s += raw[k];
      n++;
    }
    return { x: p.x, z: p.z, h: s / n };
  });
  return { from: a, to: b, width, samples };
}

function buildSurface(map, mc, noiseA, noiseC) {
  const res = SURFACE_RES;
  const size = map.worldSize;
  const texel = size / res;
  const half = size / 2;
  const data = new Uint8Array(res * res * 4);
  const road = new Float32Array(res * res);
  const meadow = new Float32Array(res * res);
  const mud = new Float32Array(res * res);
  const shade = new Float32Array(res * res);
  const toIdx = (x, z) => {
    const i = Math.floor((x + half) / texel);
    const j = Math.floor((z + half) / texel);
    return [i, j];
  };
  const stamp = (x, z, radius, fn) => {
    const [ci, cj] = toIdx(x, z);
    const r = Math.ceil(radius / texel);
    for (let j = Math.max(0, cj - r); j <= Math.min(res - 1, cj + r); j++) {
      const wz = -half + (j + 0.5) * texel;
      for (let i = Math.max(0, ci - r); i <= Math.min(res - 1, ci + r); i++) {
        const wx = -half + (i + 0.5) * texel;
        const d = Math.hypot(wx - x, wz - z);
        if (d <= radius) fn(j * res + i, d, wx, wz);
      }
    }
  };
  const rw = mc.roadWidth / 2;
  for (const r of map.roads) {
    for (const s of r.samples) {
      stamp(s.x, s.z, rw + 3, (k, d, wx, wz) => {
        const edge = rw - 0.8 + 1.4 * noiseC.noise(wx / 6, wz / 6);
        const w = 1 - smoothstep(edge - 1.2, edge + 1.0, d);
        if (w > road[k]) road[k] = w;
        const rut = Math.abs(d - rw * 0.45); // karrensporen
        const m = (1 - smoothstep(0.3, 1.1, rut)) * 0.6 * w;
        if (m > mud[k]) mud[k] = m;
      });
    }
  }
  for (const p of map.points) {
    stamp(p.x, p.z, p.clearing + 8, (k, d, wx, wz) => {
      const g = 1 - smoothstep(p.clearing - 6, p.clearing + 6, d);
      if (g > meadow[k]) meadow[k] = g;
      const worn = (1 - smoothstep(p.radius - 3, p.radius + 4, d)) * (0.55 + 0.35 * noiseC.noise(wx / 5, wz / 5));
      if (worn > road[k]) road[k] = worn;
      const m = (1 - smoothstep(p.radius - 6, p.radius + 6, d)) * (0.5 + 0.5 * noiseA.noise(wx / 7, wz / 7));
      if (m > mud[k]) mud[k] = m;
    });
  }
  for (const b of map.bases) {
    const br = mc.baseClearingRadius;
    stamp(b.x, b.z, br + 8, (k, d, wx, wz) => {
      const g = 1 - smoothstep(br - 6, br + 6, d);
      if (g > meadow[k]) meadow[k] = g;
      const worn = (1 - smoothstep(br * 0.45, br * 0.8, d)) * (0.6 + 0.4 * noiseC.noise(wx / 8, wz / 8));
      if (worn > road[k]) road[k] = worn;
    });
  }
  for (const m of map.meadows) {
    stamp(m.x, m.z, m.r * 1.4, (k, d, wx, wz) => {
      const wob = m.r * (1 + 0.25 * noiseC.noise(Math.atan2(wz - m.z, wx - m.x) * 1.6 + m.x, m.z * 0.01));
      const g = 1 - smoothstep(wob - 8, wob + 3, d);
      if (g > meadow[k]) meadow[k] = g;
    });
  }
  for (const t of map.trees) {
    const rr = 2.5 + t.scale * 2.5;
    stamp(t.x, t.z, rr, (k, d) => {
      shade[k] = Math.min(1, shade[k] + 0.28 * (1 - d / rr));
    });
  }
  for (let k = 0; k < res * res; k++) {
    const i = k % res;
    const j = (k - i) / res;
    const wx = -half + (i + 0.5) * texel;
    const wz = -half + (j + 0.5) * texel;
    const patch = 0.5 + 0.5 * noiseA.fbm(wx / 45, wz / 45, 3);
    const r = road[k];
    const g = meadow[k] * (1 - r);
    const b = Math.max(mud[k], smoothstep(0.62, 0.9, patch) * 0.35 * (1 - r));
    data[k * 4] = Math.round(clamp(r, 0, 1) * 255);
    data[k * 4 + 1] = Math.round(clamp(g, 0, 1) * 255);
    data[k * 4 + 2] = Math.round(clamp(b, 0, 1) * 255);
    data[k * 4 + 3] = Math.round(clamp(shade[k] * (1 - g * 0.8), 0, 1) * 255);
  }
  return { res, size, data };
}
