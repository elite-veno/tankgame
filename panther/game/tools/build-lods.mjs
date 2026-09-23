// Bouwt vereenvoudigde LOD-versies van panther.glb voor tanks op afstand.
//
//   node tools/build-lods.mjs
//
// Schrijft public/assets/panther_lod1.glb, panther_lod2.glb en panther_lod3.glb.
// De node-hiërarchie (Panther > hull / turret > turret_mesh / gun > gun_mesh) en de
// materiaalnamen blijven behouden, zodat de game dezelfde toren/loop-nodes en camo kan gebruiken.
//
// Werkwijze per primitive:
//  1. vertices samenvoegen op positie (normaal-naden verdwijnen, zodat de simplifier over randen heen kan)
//  2. meshoptimizer simplify met 'Prune' (verwijdert kleine losse onderdelen zoals bouten)
//  3. valt het resultaat te hoog uit, dan simplifySloppy als vangnet
//  4. nieuwe normalen met een kreukhoek (harde randen blijven hard, rondingen glad)
import { NodeIO } from '@gltf-transform/core';
import { weld, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, '..', 'public', 'assets');
const io = new NodeIO();

// budget = gewenst totaal aantal driehoeken, error = maximale afwijking in meters
const LEVELS = [
  { name: 'panther_lod1.glb', budget: 48000, error: 0.012 },
  { name: 'panther_lod2.glb', budget: 14000, error: 0.05 },
  { name: 'panther_lod3.glb', budget: 4500, error: 0.14 },
];
const CREASE_ANGLE = (38 * Math.PI) / 180;

function readPrimitive(prim) {
  const pos = prim.getAttribute('POSITION').getArray();
  const idxAcc = prim.getIndices();
  let indices;
  if (idxAcc) indices = Uint32Array.from(idxAcc.getArray());
  else indices = Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  return { positions: Float32Array.from(pos), indices };
}

function simplifyPrimitive(positions, indices, targetTris, error) {
  // stap 1: welden op positie
  const remap = MeshoptSimplifier.generatePositionRemap(positions, 3);
  const welded = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) welded[i] = remap[indices[i]];
  const targetIndexCount = Math.max(3, Math.floor(targetTris) * 3);
  // stap 2: topologie-bewuste vereenvoudiging
  let [result] = MeshoptSimplifier.simplify(welded, positions, 3, targetIndexCount, error, ['Prune', 'ErrorAbsolute']);
  // stap 3: vangnet
  if (result.length > targetIndexCount * 1.6) {
    const [sloppy] = MeshoptSimplifier.simplifySloppy(welded, positions, 3, null, targetIndexCount, error * 1.5);
    if (sloppy.length >= 3 && sloppy.length < result.length) result = sloppy;
  }
  return result;
}

// Niet-geïndexeerde driehoeken met gekreukte normalen (zoals BufferGeometryUtils.toCreasedNormals).
function creasedTriangles(positions, indices) {
  const triCount = indices.length / 3;
  const faceNormals = new Float32Array(triCount * 3);
  const vertexFaces = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az;
    const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    // lengte = 2x oppervlak -> gewogen middeling via ongenormaliseerde normaal bewaren
    faceNormals[t * 3] = nx / len;
    faceNormals[t * 3 + 1] = ny / len;
    faceNormals[t * 3 + 2] = nz / len;
    for (const v of [a, b, c]) {
      let list = vertexFaces.get(v);
      if (!list) vertexFaces.set(v, (list = []));
      list.push(t);
    }
  }
  const cosCrease = Math.cos(CREASE_ANGLE);
  const outPos = new Float32Array(triCount * 9);
  const outNor = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    const fx = faceNormals[t * 3], fy = faceNormals[t * 3 + 1], fz = faceNormals[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      let sx = 0, sy = 0, sz = 0;
      for (const o of vertexFaces.get(v)) {
        const ox = faceNormals[o * 3], oy = faceNormals[o * 3 + 1], oz = faceNormals[o * 3 + 2];
        if (fx * ox + fy * oy + fz * oz >= cosCrease) { sx += ox; sy += oy; sz += oz; }
      }
      const len = Math.hypot(sx, sy, sz) || 1;
      const o = (t * 3 + k) * 3;
      outPos[o] = positions[v * 3];
      outPos[o + 1] = positions[v * 3 + 1];
      outPos[o + 2] = positions[v * 3 + 2];
      outNor[o] = sx / len;
      outNor[o + 1] = sy / len;
      outNor[o + 2] = sz / len;
    }
  }
  return { positions: outPos, normals: outNor };
}

function countTriangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      n += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
    }
  }
  return n;
}

await MeshoptSimplifier.ready;
for (const level of LEVELS) {
  const doc = await io.read(path.join(assets, 'panther.glb'));
  const total = countTriangles(doc);
  const ratio = Math.min(1, level.budget / total);
  const buffer = doc.getRoot().listBuffers()[0];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const { positions, indices } = readPrimitive(prim);
      const simplified = simplifyPrimitive(positions, indices, (indices.length / 3) * ratio, level.error);
      if (simplified.length < 3) {
        mesh.removePrimitive(prim);
        prim.dispose();
        continue;
      }
      const tri = creasedTriangles(positions, simplified);
      for (const semantic of prim.listSemantics()) {
        const acc = prim.getAttribute(semantic);
        prim.setAttribute(semantic, null);
        if (acc.listParents().length <= 1) acc.dispose();
      }
      const oldIdx = prim.getIndices();
      prim.setIndices(null);
      if (oldIdx && oldIdx.listParents().length <= 1) oldIdx.dispose();
      prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(tri.positions).setBuffer(buffer));
      prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(tri.normals).setBuffer(buffer));
    }
  }
  await doc.transform(weld(), prune());
  await io.write(path.join(assets, level.name), doc);
  console.log(`${level.name}: ${total} -> ${countTriangles(doc)} driehoeken`);
}
