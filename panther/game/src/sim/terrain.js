// Hoogteveld van het terrein: een regelmatig raster met bilineaire interpolatie.
// Wordt gedeeld door de simulatie (rijden, granaten, zichtlijnen) en de weergave (terreinmesh).

export class Heightfield {
  constructor(worldSize, resolution) {
    this.size = worldSize;
    this.res = resolution; // aantal cellen per zijde
    this.half = worldSize / 2;
    this.cell = worldSize / resolution;
    this.heights = new Float32Array((resolution + 1) * (resolution + 1));
  }

  index(ix, iz) {
    return iz * (this.res + 1) + ix;
  }

  // wereldcoördinaat van rasterpunt
  pointX(ix) {
    return -this.half + ix * this.cell;
  }

  pointZ(iz) {
    return -this.half + iz * this.cell;
  }

  heightAt(x, z) {
    const res = this.res;
    let fx = (x + this.half) / this.cell;
    let fz = (z + this.half) / this.cell;
    if (fx < 0) fx = 0;
    else if (fx > res - 1e-6) fx = res - 1e-6;
    if (fz < 0) fz = 0;
    else if (fz > res - 1e-6) fz = res - 1e-6;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const row = res + 1;
    const i00 = iz * row + ix;
    const h = this.heights;
    // zelfde driehoekssplitsing als de terreinmesh (PlaneGeometry: diagonaal van (0,1) naar (1,0))
    if (tx + tz <= 1) {
      return h[i00] + (h[i00 + 1] - h[i00]) * tx + (h[i00 + row] - h[i00]) * tz;
    }
    const h11 = h[i00 + row + 1];
    return h11 + (h[i00 + row] - h11) * (1 - tx) + (h[i00 + 1] - h11) * (1 - tz);
  }

  // normaal via centrale verschillen; out = {x,y,z}
  normalAt(x, z, out, eps = 1.5) {
    const hl = this.heightAt(x - eps, z);
    const hr = this.heightAt(x + eps, z);
    const hd = this.heightAt(x, z - eps);
    const hu = this.heightAt(x, z + eps);
    let nx = hl - hr;
    let ny = 2 * eps;
    let nz = hd - hu;
    const len = Math.hypot(nx, ny, nz);
    out.x = nx / len;
    out.y = ny / len;
    out.z = nz / len;
    return out;
  }

  // helling in graden
  slopeAt(x, z) {
    const n = this.normalAt(x, z, { x: 0, y: 0, z: 0 });
    return (Math.acos(Math.min(1, n.y)) * 180) / Math.PI;
  }

  // straal tegen terrein. origin/dir: {x,y,z}, dir genormaliseerd. Geeft afstand of -1.
  raycast(origin, dir, maxDist, step = 2) {
    let prevT = 0;
    let prevAbove = origin.y - this.heightAt(origin.x, origin.z);
    if (prevAbove < 0) return 0;
    for (let t = step; t <= maxDist + step; t += step) {
      const tt = Math.min(t, maxDist);
      const x = origin.x + dir.x * tt;
      const y = origin.y + dir.y * tt;
      const z = origin.z + dir.z * tt;
      const above = y - this.heightAt(x, z);
      if (above < 0) {
        // verfijnen met bisectie
        let a = prevT;
        let b = tt;
        for (let i = 0; i < 10; i++) {
          const m = (a + b) / 2;
          const my = origin.y + dir.y * m;
          const mh = this.heightAt(origin.x + dir.x * m, origin.z + dir.z * m);
          if (my - mh < 0) b = m;
          else a = m;
        }
        return (a + b) / 2;
      }
      prevT = tt;
      prevAbove = above;
      if (tt >= maxDist) break;
    }
    return -1;
  }

  // zichtlijn tussen twee punten: true als het terrein niet in de weg zit
  lineClear(ax, ay, az, bx, by, bz, step = 3) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const n = Math.max(2, Math.ceil(len / step));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (ay + dy * t < this.heightAt(ax + dx * t, az + dz * t) + 0.2) return false;
    }
    return true;
  }
}
