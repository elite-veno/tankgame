// Ruimtelijk raster voor ronde obstakels (boomstammen en rotsen).
// Obstakel: { id, x, z, r, h, base, kind } — een verticale cilinder van y=base tot y=base+h.
import { segmentCircle2D } from '../core/mathUtils.js';

// grootste marge die raycastSegment ondersteunt; obstakels worden in de cellen van r + deze marge gezet
const MAX_PADDING = 1;

export class ObstacleGrid {
  constructor(minX, minZ, size, cellSize) {
    this.minX = minX;
    this.minZ = minZ;
    this.cellSize = cellSize;
    this.cols = Math.ceil(size / cellSize);
    this.cells = new Array(this.cols * this.cols);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    this.list = [];
    this.queryStamp = 0;
  }

  add(ob) {
    ob.id = this.list.length;
    ob.stamp = 0;
    this.list.push(ob);
    const reach = ob.r + MAX_PADDING;
    const c0x = this.cellX(ob.x - reach);
    const c1x = this.cellX(ob.x + reach);
    const c0z = this.cellZ(ob.z - reach);
    const c1z = this.cellZ(ob.z + reach);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) this.cells[cz * this.cols + cx].push(ob);
    }
    return ob;
  }

  cellX(x) {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / this.cellSize)));
  }

  cellZ(z) {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((z - this.minZ) / this.cellSize)));
  }

  // roept fn(ob) aan voor elk obstakel waarvan de cirkel binnen `radius` van (x,z) kan liggen
  forEachNear(x, z, radius, fn) {
    const stamp = ++this.queryStamp;
    const c0x = this.cellX(x - radius);
    const c1x = this.cellX(x + radius);
    const c0z = this.cellZ(z - radius);
    const c1z = this.cellZ(z + radius);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const cell = this.cells[cz * this.cols + cx];
        for (let i = 0; i < cell.length; i++) {
          const ob = cell[i];
          if (ob.stamp === stamp) continue;
          ob.stamp = stamp;
          const dx = ob.x - x;
          const dz = ob.z - z;
          const rr = radius + ob.r;
          if (dx * dx + dz * dz <= rr * rr) {
            if (fn(ob) === false) return;
          }
        }
      }
    }
  }

  // eerste obstakel dat het 3D-lijnstuk p0->p1 raakt. Geeft { t, ob } of null.
  // Loopt door de rastercellen langs het lijnstuk (Amanatides-Woo), dus ook geschikt voor lange zichtlijnen.
  // padding (hoogstens MAX_PADDING) vergroot de straal van elk obstakel; skipKind slaat één soort over.
  raycastSegment(x0, y0, z0, x1, y1, z1, padding = 0, skipKind = null) {
    padding = Math.min(padding, MAX_PADDING);
    const stamp = ++this.queryStamp;
    const cs = this.cellSize;
    let cx = this.cellX(x0);
    let cz = this.cellZ(z0);
    const endX = this.cellX(x1);
    const endZ = this.cellZ(z1);
    const dx = x1 - x0;
    const dz = z1 - z0;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDz = dz !== 0 ? 1 / dz : Infinity;
    const nextBoundX = this.minX + (cx + (stepX > 0 ? 1 : 0)) * cs;
    const nextBoundZ = this.minZ + (cz + (stepZ > 0 ? 1 : 0)) * cs;
    let tMaxX = dx !== 0 ? (nextBoundX - x0) * invDx : Infinity;
    let tMaxZ = dz !== 0 ? (nextBoundZ - z0) * invDz : Infinity;
    const tDeltaX = dx !== 0 ? cs * Math.abs(invDx) : Infinity;
    const tDeltaZ = dz !== 0 ? cs * Math.abs(invDz) : Infinity;
    let best = null;
    let bestT = Infinity;
    let guard = this.cols * 4;
    while (guard-- > 0) {
      const cell = this.cells[cz * this.cols + cx];
      for (let i = 0; i < cell.length; i++) {
        const ob = cell[i];
        if (ob.stamp === stamp) continue;
        ob.stamp = stamp;
        if (ob.kind === skipKind) continue;
        const t = segmentCircle2D(x0, z0, x1, z1, ob.x, ob.z, ob.r + padding);
        if (t < 0 || t >= bestT) continue;
        const y = y0 + (y1 - y0) * t;
        if (y < ob.base - 0.5 || y > ob.base + ob.h) continue;
        bestT = t;
        best = ob;
      }
      // een treffer in deze cel is altijd dichterbij dan alles in latere cellen (met marge voor cel-overlap)
      if (best && bestT <= Math.min(tMaxX, tMaxZ)) break;
      if (cx === endX && cz === endZ) break;
      if (tMaxX < tMaxZ) {
        if (tMaxX > 1) break;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        if (tMaxZ > 1) break;
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.cols) break;
    }
    return best ? { t: bestT, ob: best } : null;
  }
}
