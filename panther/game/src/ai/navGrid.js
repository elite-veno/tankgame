// Navigatieraster voor de AI: cellen zijn geblokkeerd als een tank er niet tussen de bomen past.
// A* met 8 buren, voorkeur voor paden, extra kosten dicht bij obstakels, daarna padvereenvoudiging.

const SQRT2 = Math.SQRT2;
const POCKET_LIMIT = 4096; // cellen: een kleiner afgesloten gebied rond start of doel is een ingesloten holte
const SOFT_BLOCK_COST = 3; // extra kosten per wrakcel als de start ingesloten zit

export class NavGrid {
  constructor(map, config, cellSize = 2.5) {
    this.map = map;
    this.cell = cellSize;
    this.half = map.half;
    this.cols = Math.ceil(map.size / cellSize);
    const n = this.cols * this.cols;
    this.walk = new Uint8Array(n).fill(1);
    this.cost = new Float32Array(n).fill(1);
    this.dyn = new Uint16Array(n); // tijdelijke blokkades (wrakken, vernietigde tanks)
    this.dynCount = 0; // aantal gestempelde tijdelijke blokkades
    this.region = new Int32Array(n); // samenhangend gebied per cel (alleen vaste obstakels), -1 = geblokkeerd
    this.mainRegion = -1; // het grootste gebied: daar liggen de punten en de basissen
    this.mark = new Uint32Array(n); // bezochte cellen bij het zoeken naar ingesloten holtes
    this.markId = 0;
    this.fillStack = new Int32Array(n);
    this.lastPartial = false; // haalde het laatste pad het doel niet (alleen tot de dichtstbijzijnde bereikbare cel)?
    this.lastExpanded = 0; // uitgebreide cellen bij de laatste A*-zoektocht
    this.gScore = new Float32Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.search = 0;
    this.heapNodes = new Int32Array(n);
    this.heapF = new Float32Array(n);
    this.build(config);
    this.labelRegions();
  }

  build(config) {
    const { map, cols, cell } = this;
    const hf = map.heightfield;
    const clearance = config.tank.hullHalfWidth + 1.15;
    this.bodyBlockRadius = Math.hypot(config.tank.hullHalfLength, config.tank.hullHalfWidth) + clearance;
    const margin = 6;
    // randen, hellingen en wegen
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const x = this.cellX(i);
        const z = this.cellZ(j);
        if (Math.abs(x) > this.half - margin || Math.abs(z) > this.half - margin) {
          this.walk[k] = 0;
          continue;
        }
        if (hf.slopeAt(x, z) > 30) {
          this.walk[k] = 0;
          continue;
        }
        if (map.roadDistanceAt(x, z) < config.map.roadWidth / 2) this.cost[k] = 0.6;
      }
    }
    // obstakels stempelen: kern blokkeert, ring eromheen is duurder
    const extra = 3;
    for (const ob of map.obstacles.list) {
      const block = ob.r + clearance;
      const reach = block + extra;
      const i0 = Math.max(0, Math.floor((ob.x - reach + this.half) / cell));
      const i1 = Math.min(cols - 1, Math.ceil((ob.x + reach + this.half) / cell));
      const j0 = Math.max(0, Math.floor((ob.z - reach + this.half) / cell));
      const j1 = Math.min(cols - 1, Math.ceil((ob.z + reach + this.half) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(this.cellX(i) - ob.x, this.cellZ(j) - ob.z);
          const k = j * cols + i;
          if (d < block) this.walk[k] = 0;
          else if (d < reach) this.cost[k] += 1.4 * (1 - (d - block) / extra);
        }
      }
    }
  }

  // Samenhangende gebieden labelen. Vier buren volstaat: A* snijdt geen hoeken af, dus een diagonale stap
  // verbindt niets wat niet ook recht verbonden is. Losse zakjes tussen de bomen krijgen een eigen label.
  labelRegions() {
    const { walk, region, fillStack: stack, cols } = this;
    const n = cols * cols;
    region.fill(-1);
    let id = 0;
    let bestSize = 0;
    for (let s = 0; s < n; s++) {
      if (!walk[s] || region[s] !== -1) continue;
      let sp = 0;
      let size = 0;
      region[s] = id;
      stack[sp++] = s;
      while (sp > 0) {
        const k = stack[--sp];
        size++;
        const i = k % cols;
        if (i > 0 && walk[k - 1] && region[k - 1] === -1) {
          region[k - 1] = id;
          stack[sp++] = k - 1;
        }
        if (i < cols - 1 && walk[k + 1] && region[k + 1] === -1) {
          region[k + 1] = id;
          stack[sp++] = k + 1;
        }
        if (k >= cols && walk[k - cols] && region[k - cols] === -1) {
          region[k - cols] = id;
          stack[sp++] = k - cols;
        }
        if (k < n - cols && walk[k + cols] && region[k + cols] === -1) {
          region[k + cols] = id;
          stack[sp++] = k + cols;
        }
      }
      if (size > bestSize) {
        bestSize = size;
        this.mainRegion = id;
      }
      id++;
    }
  }

  cellX(i) {
    return -this.half + (i + 0.5) * this.cell;
  }

  cellZ(j) {
    return -this.half + (j + 0.5) * this.cell;
  }

  indexOf(x, z) {
    const i = Math.max(0, Math.min(this.cols - 1, Math.floor((x + this.half) / this.cell)));
    const j = Math.max(0, Math.min(this.cols - 1, Math.floor((z + this.half) / this.cell)));
    return j * this.cols + i;
  }

  open(k) {
    return this.walk[k] === 1 && this.dyn[k] === 0;
  }

  isWalkable(x, z) {
    return this.open(this.indexOf(x, z));
  }

  // tijdelijke blokkade (cirkel rond een wrak) toevoegen (+1) of weghalen (-1)
  stampBlock(x, z, delta) {
    const r = this.bodyBlockRadius;
    const cols = this.cols;
    this.dynCount = Math.max(0, this.dynCount + delta);
    const i0 = Math.max(0, Math.floor((x - r + this.half) / this.cell));
    const i1 = Math.min(cols - 1, Math.ceil((x + r + this.half) / this.cell));
    const j0 = Math.max(0, Math.floor((z - r + this.half) / this.cell));
    const j1 = Math.min(cols - 1, Math.ceil((z + r + this.half) / this.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (Math.hypot(this.cellX(i) - x, this.cellZ(j) - z) < r) {
          const k = j * cols + i;
          this.dyn[k] = Math.max(0, this.dyn[k] + delta);
        }
      }
    }
  }

  // Dichtstbijzijnde begaanbare cel (ringen rond k). Met region >= 0 liefst een cel in dat gebied (anders de
  // dichtstbijzijnde vrije cel), met skipMarked nooit een cel uit de laatst gevonden ingesloten holte.
  nearestWalkable(k, maxRing = 12, region = -1, skipMarked = false) {
    const found = this.ringSearch(k, maxRing, region, skipMarked);
    if (found >= 0 || region < 0 || skipMarked) return found;
    return this.ringSearch(k, maxRing, -1, false);
  }

  cellOk(k, region, skipMarked) {
    if (!this.open(k)) return false;
    if (region >= 0 && this.region[k] !== region) return false;
    return !skipMarked || this.mark[k] !== this.markId;
  }

  ringSearch(k, maxRing, region, skipMarked) {
    if (this.cellOk(k, region, skipMarked)) return k;
    const cols = this.cols;
    const ci = k % cols;
    const cj = (k - ci) / cols;
    for (let r = 1; r <= maxRing; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= cols) continue;
        // alleen de rand van het vierkant: boven- en onderrij helemaal, daartussen de twee zijkanten
        const step = dj === -r || dj === r ? 1 : 2 * r;
        for (let di = -r; di <= r; di += step) {
          const i = ci + di;
          if (i < 0 || i >= cols) continue;
          const kk = j * cols + i;
          if (!this.cellOk(kk, region, skipMarked)) continue;
          const d = di * di + dj * dj;
          if (d < bestD) {
            bestD = d;
            best = kk;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  nearestWalkablePoint(x, z) {
    const k = this.nearestWalkable(this.indexOf(x, z), 12, this.mainRegion);
    if (k < 0) return null;
    const i = k % this.cols;
    return { x: this.cellX(i), z: this.cellZ((k - i) / this.cols) };
  }

  // Ligt cel k in een kleine afgesloten holte (bv. omringd door wrakken en bomen) waar cel `other` niet in ligt?
  // Begrensd vullen vanaf k; de bezochte cellen houden markId, zodat nearestWalkable ze kan overslaan.
  enclosed(k, other) {
    const { walk, dyn, mark, fillStack: stack, cols } = this;
    const n = cols * cols;
    const id = this.markId;
    let sp = 0;
    let count = 0;
    mark[k] = id;
    stack[sp++] = k;
    while (sp > 0) {
      const c = stack[--sp];
      if (c === other || ++count >= POCKET_LIMIT) return false;
      const i = c % cols;
      if (i > 0 && mark[c - 1] !== id && walk[c - 1] && !dyn[c - 1]) {
        mark[c - 1] = id;
        stack[sp++] = c - 1;
      }
      if (i < cols - 1 && mark[c + 1] !== id && walk[c + 1] && !dyn[c + 1]) {
        mark[c + 1] = id;
        stack[sp++] = c + 1;
      }
      if (c >= cols && mark[c - cols] !== id && walk[c - cols] && !dyn[c - cols]) {
        mark[c - cols] = id;
        stack[sp++] = c - cols;
      }
      if (c < n - cols && mark[c + cols] !== id && walk[c + cols] && !dyn[c + cols]) {
        mark[c + cols] = id;
        stack[sp++] = c + cols;
      }
    }
    return true;
  }

  // Kan een tank in een rechte lijn van a naar b rijden?
  lineWalkable(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(d / (this.cell * 0.5)));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      if (!this.open(this.indexOf(ax + (bx - ax) * t, az + (bz - az) * t))) return false;
    }
    return true;
  }

  // A*: geeft een vereenvoudigde lijst wereldpunten [{x,z}], of null als start of doel midden in geblokkeerd
  // gebied ligt. Is het doel onbereikbaar, dan loopt het pad naar de bereikbare cel die het dichtst bij het doel
  // ligt (lastPartial).
  findPath(sx, sz, tx, tz, maxIterations = 70000) {
    const cols = this.cols;
    // start liefst in het grootste gebied (niet in een los zakje tussen de bomen), doel in hetzelfde gebied
    // als de start
    const start = this.nearestWalkable(this.indexOf(sx, sz), 12, this.mainRegion);
    if (start < 0) return null;
    const reg = this.region[start];
    let goal = this.nearestWalkable(this.indexOf(tx, tz), 12, reg);
    if (goal < 0) return null;
    if (this.dynCount > 0) {
      // Doel ingesloten door wrakken of vernietigde tanks: dan zou A* de hele kaart afzoeken. Neem de dichtstbijzijnde
      // vrije cel buiten die holte (een paar keer, voor holtes die naast elkaar liggen).
      this.markId++;
      for (let n = 0; n < 4 && this.enclosed(goal, start); n++) {
        const g = this.nearestWalkable(goal, 40, reg, true);
        if (g < 0) break;
        goal = g;
      }
    }
    let end = this.astar(start, goal, maxIterations, false);
    if (end !== goal && this.dynCount > 0 && this.lastExpanded < POCKET_LIMIT) {
      // De start zelf zit ingesloten (A* had de holte snel doorzocht). De blokkade rond een wrak is ruim genomen en
      // in het echt past een tank er vaak tussendoor: wrakcellen dan als duur maar begaanbaar behandelen, zodat het
      // pad door de smalste opening naar buiten gaat.
      end = this.astar(start, goal, maxIterations, true);
    }
    this.lastPartial = end !== goal;
    const cells = [];
    for (let k = end; k !== -1; k = this.from[k]) cells.push(k);
    cells.reverse();
    const pts = cells.map((k) => {
      const i = k % cols;
      return { x: this.cellX(i), z: this.cellZ((k - i) / cols) };
    });
    return this.simplify(pts);
  }

  // A* van cel start naar cel goal; geeft goal terug, of de uitgebreide cel die het dichtst bij goal ligt als goal
  // niet bereikbaar is. Met soft zijn tijdelijke blokkades begaanbaar tegen extra kosten.
  astar(start, goal, maxIterations, soft) {
    const cols = this.cols;
    const search = ++this.search;
    const { gScore, from, stamp, closed, walk, dyn, cost, heapNodes, heapF } = this;
    const gi = goal % cols;
    const gj = (goal - gi) / cols;
    const hMin = 0.6;
    const heur = (k) => {
      const i = k % cols;
      const j = (k - i) / cols;
      const dx = Math.abs(i - gi);
      const dz = Math.abs(j - gj);
      return hMin * (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz));
    };
    let heapSize = 0;
    const push = (k, f) => {
      let n = heapSize++;
      while (n > 0) {
        const p = (n - 1) >> 1;
        if (heapF[p] <= f) break;
        heapNodes[n] = heapNodes[p];
        heapF[n] = heapF[p];
        n = p;
      }
      heapNodes[n] = k;
      heapF[n] = f;
    };
    const pop = () => {
      const top = heapNodes[0];
      const lastK = heapNodes[--heapSize];
      const lastF = heapF[heapSize];
      let n = 0;
      for (;;) {
        let c = 2 * n + 1;
        if (c >= heapSize) break;
        if (c + 1 < heapSize && heapF[c + 1] < heapF[c]) c++;
        if (heapF[c] >= lastF) break;
        heapNodes[n] = heapNodes[c];
        heapF[n] = heapF[c];
        n = c;
      }
      heapNodes[n] = lastK;
      heapF[n] = lastF;
      return top;
    };
    stamp[start] = search;
    gScore[start] = 0;
    from[start] = -1;
    push(start, heur(start));
    let iter = 0;
    let expanded = 0;
    let bestK = start; // uitgebreide cel die het dichtst bij het doel ligt, voor als het doel onbereikbaar blijkt
    let bestH = heur(start);
    while (heapSize > 0 && iter++ < maxIterations) {
      const k = pop();
      if (closed[k] === search) continue;
      closed[k] = search;
      expanded++;
      if (k === goal) {
        bestK = goal;
        break;
      }
      const h = heur(k);
      if (h < bestH) {
        bestH = h;
        bestK = k;
      }
      const i = k % cols;
      const j = (k - i) / cols;
      for (let dj = -1; dj <= 1; dj++) {
        const nj = j + dj;
        if (nj < 0 || nj >= cols) continue;
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di;
          if (ni < 0 || ni >= cols) continue;
          const nk = nj * cols + ni;
          if (!walk[nk] || (dyn[nk] && !soft) || closed[nk] === search) continue;
          const diag = di !== 0 && dj !== 0;
          if (diag) {
            // geen hoeken afsnijden
            const a = j * cols + ni;
            const b = nj * cols + i;
            if (!walk[a] || !walk[b] || (!soft && (dyn[a] || dyn[b]))) continue;
          }
          let g = gScore[k] + (diag ? SQRT2 : 1) * 0.5 * (cost[k] + cost[nk]);
          if (soft && dyn[nk]) g += SOFT_BLOCK_COST;
          if (stamp[nk] !== search || g < gScore[nk]) {
            stamp[nk] = search;
            gScore[nk] = g;
            from[nk] = k;
            push(nk, g + heur(nk));
          }
        }
      }
    }
    this.lastExpanded = expanded;
    return bestK;
  }

  // string pulling: sla tussenpunten over zolang de rechte lijn begaanbaar is
  simplify(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 60);
      while (j > i + 1 && !this.lineWalkable(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}
