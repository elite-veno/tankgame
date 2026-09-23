// AI-tanks: kiezen een veroveringspunt, rijden erheen via het navigatieraster, ontwijken bomen en elkaar,
// komen los als ze vastzitten, en vallen vijanden binnen zicht aan met enige onnauwkeurigheid.
// De AI leest alleen de wereldstatus en schrijft een commando, net als de speler (dus ook server-geschikt).
import { Vector3 } from 'three';
import { RNG } from '../core/rng.js';
import { clamp, lerp, wrapAngle, pointSegmentDistance2D } from '../core/mathUtils.js';
import { DEG } from '../config.js';
import { aimErrorAngle } from '../sim/tank.js';

const _eye = new Vector3();
const _tgt = new Vector3();
const _los = new Vector3();
const _right = new Vector3();
const _upv = new Vector3();
const _UP = new Vector3(0, 1, 0);
const WRECK_KEY = 1000; // sleutels in AICoordinator.blocks: tank-id, of WRECK_KEY + wrak-id

export class AICoordinator {
  constructor(world, nav) {
    this.world = world;
    this.nav = nav;
    this.controllers = [];
    this.blocks = new Map(); // sleutel -> {x, z}: wrakken en vernietigde tanks in het navigatieraster
    this.currentBlocks = new Set();
  }

  add(tank, seed) {
    const c = new AIController(tank, this, new RNG(seed));
    this.controllers.push(c);
    return c;
  }

  countAssigned(team, pointId, except) {
    let n = 0;
    for (const c of this.controllers) {
      if (c !== except && c.tank.team === team && c.tank.alive && c.objective === pointId) n++;
    }
    return n;
  }

  // vult commands[tank.id] voor alle AI-tanks
  update(dt, commands) {
    this.syncBlocks();
    for (const c of this.controllers) c.update(dt, commands[c.tank.id]);
  }

  // Stilstaande lichamen (vernietigde tanks en wrakken) als tijdelijke blokkade in het navigatieraster.
  // Sleutels zijn getallen (tank-id, of WRECK_KEY + wrak-id) en de set wordt hergebruikt: dit draait
  // elke simulatiestap en mag geen afval voor de garbage collector maken.
  syncBlocks() {
    const current = this.currentBlocks;
    current.clear();
    for (const t of this.world.tanks) if (!t.alive) current.add(t.id);
    for (const w of this.world.wrecks) current.add(WRECK_KEY + w.id);
    let changed = false;
    for (const [key, b] of this.blocks) {
      if (!current.has(key)) {
        this.nav.stampBlock(b.x, b.z, -1);
        this.blocks.delete(key);
        changed = true;
      }
    }
    for (const key of current) {
      if (this.blocks.has(key)) continue;
      const body = key < WRECK_KEY ? this.world.tanks[key] : this.world.wrecks.find((w) => WRECK_KEY + w.id === key);
      const b = { x: body.pos.x, z: body.pos.z };
      this.nav.stampBlock(b.x, b.z, 1);
      this.blocks.set(key, b);
      changed = true;
    }
    if (changed) {
      // paden die langs een nieuw obstakel lopen snel opnieuw berekenen
      for (const c of this.controllers) c.repathTimer = Math.min(c.repathTimer, c.rng.range(0.1, 0.6));
    }
  }
}

export class AIController {
  constructor(tank, coordinator, rng) {
    this.tank = tank;
    this.coord = coordinator;
    this.world = coordinator.world;
    this.nav = coordinator.nav;
    this.cfg = this.world.config.ai;
    this.rng = rng;
    this.objective = null;
    this.goal = null;
    this.path = null;
    this.pathIndex = 0;
    this.segT = 0;
    this.decisionTimer = rng.range(0, 1);
    this.repathTimer = 0;
    this.retryTimer = 0; // wachttijd na een pad dat niet te berekenen was
    this.blockedTime = 0; // hoe lang een andere tank ons al de weg verspert
    this.scanTimer = rng.range(0, this.cfg.targetScanInterval);
    this.stuckTime = 0;
    this.unstuckTimer = 0;
    this.unstuckSteer = 1;
    this.target = null;
    this.blockedTarget = null; // doel dat vanaf de loopmond niet te raken bleek
    this.blockedUntil = 0;
    this.reactionTimer = 0;
    this.aimTime = 0;
    this.errAngle = 0; // richting van de richtfout, loodrecht op de schietlijn
    this.aimPoint = new Vector3();
    this.wasAlive = tank.alive;
    this.stats = { stuckEvents: 0, repaths: 0, pathFailures: 0, partialPaths: 0 };
  }

  reset() {
    this.objective = null;
    this.goal = null;
    this.path = null;
    this.target = null;
    this.stuckTime = 0;
    this.unstuckTimer = 0;
    this.retryTimer = 0;
    this.blockedTime = 0;
    this.decisionTimer = 0;
  }

  update(dt, cmd) {
    const t = this.tank;
    cmd.throttle = 0;
    cmd.steer = 0;
    cmd.fire = false;
    if (!t.alive) {
      this.wasAlive = false;
      cmd.hasAim = false;
      return;
    }
    if (!this.wasAlive) {
      this.reset();
      this.wasAlive = true;
    }
    if (this.world.phase === 'ended') {
      cmd.hasAim = false;
      return;
    }
    this.decisionTimer -= dt;
    this.repathTimer -= dt;
    this.retryTimer -= dt;
    this.scanTimer -= dt;
    if (this.objective === null || this.decisionTimer <= 0) {
      this.decisionTimer = this.cfg.decisionInterval * this.rng.range(0.8, 1.3);
      this.chooseObjective();
    }
    if (this.scanTimer <= 0) {
      this.scanTimer = this.cfg.targetScanInterval;
      this.scanTargets();
    }
    if (this.world.phase === 'battle') this.drive(dt, cmd);
    this.aimAndFire(dt, cmd);
  }

  chooseObjective() {
    const t = this.tank;
    const w = this.world;
    const enemy = 1 - t.team;
    let best = null;
    let bestScore = -Infinity;
    for (const p of w.points) {
      const d = Math.hypot(p.x - t.pos.x, p.z - t.pos.z);
      let value;
      if (p.owner !== t.team) value = p.owner === -1 ? 1.25 : 1.0;
      else value = p.counts[enemy] > 0 || p.capturingTeam === enemy ? 1.4 : 0.2;
      let score = (value * 420) / (d + 120);
      const mates = this.coord.countAssigned(t.team, p.id, this);
      score -= mates * (p.owner === t.team ? 0.7 : 0.5);
      if (p.id === this.objective) score += 0.2;
      score += this.rng.range(0, 0.12);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best) return;
    if (best.id !== this.objective || !this.goal) {
      this.objective = best.id;
      this.pickGoal(best);
    }
  }

  pickGoal(point) {
    for (let i = 0; i < 12; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * point.radius * 0.55;
      const x = point.x + Math.cos(a) * r;
      const z = point.z + Math.sin(a) * r;
      if (this.nav.isWalkable(x, z)) {
        this.goal = { x, z };
        this.path = null;
        return;
      }
    }
    this.goal = this.nav.nearestWalkablePoint(point.x, point.z) || { x: point.x, z: point.z };
    this.path = null;
  }

  drive(dt, cmd) {
    const t = this.tank;
    if (this.unstuckTimer > 0) {
      this.unstuckTimer -= dt;
      cmd.throttle = -1;
      cmd.steer = this.unstuckSteer;
      if (this.unstuckTimer <= 0) this.path = null;
      return;
    }
    if (!this.goal) return;
    const point = this.world.points.find((p) => p.id === this.objective);
    const dGoal = Math.hypot(this.goal.x - t.pos.x, this.goal.z - t.pos.z);
    const inZone = point && t.onPoint === point.id;
    const nearCenter = point && Math.hypot(point.x - t.pos.x, point.z - t.pos.z) < point.radius * 0.75;
    if (inZone && (dGoal < 8 || nearCenter)) {
      // in het punt: stilstaan en verdedigen/veroveren
      this.stuckTime = 0;
      return;
    }
    if (point && !inZone && dGoal < 5) {
      // aangekomen bij een vervangend doel buiten het punt (het punt zelf was onbereikbaar):
      // straks een andere plek proberen
      this.stuckTime = 0;
      this.pickGoal(point);
      this.retryTimer = this.rng.range(1, 2);
      return;
    }
    if (!this.path && this.retryTimer > 0) return;
    if (!this.path || this.repathTimer <= 0) {
      this.repathTimer = this.cfg.repathInterval * this.rng.range(0.8, 1.2);
      const path = this.nav.findPath(t.pos.x, t.pos.z, this.goal.x, this.goal.z);
      this.pathIndex = 0;
      this.segT = 0;
      this.stats.repaths++;
      if (!path) {
        // start of doel ligt midden in geblokkeerd gebied: een andere plek in het punt kiezen en zo meteen
        // opnieuw proberen
        this.stats.pathFailures++;
        if (point) this.pickGoal(point);
        this.path = null;
        this.retryTimer = this.rng.range(0.4, 0.8);
        return;
      }
      const end = path[path.length - 1];
      if (this.nav.lastPartial || Math.hypot(end.x - this.goal.x, end.z - this.goal.z) > 4) {
        // doel onbereikbaar (bv. ingesloten door wrakken): het bereikbare eindpunt wordt het doel
        this.goal = { x: end.x, z: end.z };
        this.stats.partialPaths++;
      }
      // Het pad begint in de startcel. Ligt de tank zelf in een andere cel (start verschoven naar vrij gebied),
      // dan de echte positie ervoor zetten, zodat het eerste stuk niet dwars door de bomen loopt.
      if (this.nav.indexOf(path[0].x, path[0].z) !== this.nav.indexOf(t.pos.x, t.pos.z)) {
        path.unshift({ x: t.pos.x, z: t.pos.z });
      } else {
        path[0] = { x: t.pos.x, z: t.pos.z };
      }
      if (path.length < 2) path.push({ x: this.goal.x, z: this.goal.z });
      this.path = path;
    }
    // pure pursuit: stuur naar een punt een stuk verder op het pad, rem af voor bochten
    this.projectOnPath();
    const near = this.lookAhead(7);
    const far = this.lookAhead(17);
    const err = wrapAngle(Math.atan2(-(near.z - t.pos.z), near.x - t.pos.x) - t.yaw);
    const errFar = wrapAngle(Math.atan2(-(far.z - t.pos.z), far.x - t.pos.x) - t.yaw);
    let steer = clamp(err * 2.6, -1, 1);
    const turnNeed = Math.max(Math.abs(err), Math.abs(errFar) * 0.85);
    let throttle = Math.abs(err) > 0.75 ? 0.1 : clamp(1.05 - turnNeed / 0.75, 0.28, 1);
    if (dGoal < 18) throttle *= clamp(dGoal / 18, 0.4, 1);

    // andere tanks voor ons: afremmen en uitwijken
    const fx = Math.cos(t.yaw);
    const fz = -Math.sin(t.yaw);
    let blocked = false;
    for (const o of this.world.tanks) {
      if (o === t || !o.alive) continue;
      const dx = o.pos.x - t.pos.x;
      const dz = o.pos.z - t.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 14) continue;
      const ahead = (dx * fx + dz * fz) / d;
      if (ahead > 0.6) {
        throttle *= clamp((d - 7) / 7, 0.1, 1);
        const side = dx * -fz + dz * fx; // >0: rechts van ons
        steer = clamp(steer + (side > 0 ? 0.6 : -0.6), -1, 1);
        // alleen een teamgenoot telt als versperring (bij een vijand is stilstaan in een duel prima)
        if (d < 10 && o.team === t.team) blocked = true;
      }
    }
    cmd.throttle = throttle;
    cmd.steer = steer;

    // lang achter een stilstaande tank blijven wachten (bv. aan de rand van een punt): ander doel kiezen
    if (blocked && Math.abs(t.speed) < 0.8) this.blockedTime += dt;
    else this.blockedTime = 0;
    if (this.blockedTime > 2.5 && point) {
      this.blockedTime = 0;
      this.pickGoal(point);
      return;
    }

    // vastzitten herkennen: gas geven maar niet vooruitkomen
    if (throttle > 0.3 && Math.abs(t.speed) < 0.6) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    if (this.stuckTime > this.cfg.stuckTime) {
      this.stuckTime = 0;
      this.unstuckTimer = this.rng.range(1.2, 2.0);
      this.unstuckSteer = err > 0 ? -1 : 1;
      this.stats.stuckEvents++;
    }
  }

  // zoek het dichtstbijzijnde punt op het pad (alleen vooruit) en onthoud segment + fractie
  projectOnPath() {
    const path = this.path;
    const t = this.tank;
    if (path.length < 2) {
      this.pathIndex = 0;
      this.segT = 0;
      return;
    }
    let bestD = Infinity;
    let bestSeg = this.pathIndex;
    let bestT = 0;
    const last = Math.min(path.length - 2, this.pathIndex + 3);
    for (let s = this.pathIndex; s <= last; s++) {
      const a = path[s];
      const b = path[s + 1];
      const { dist, t: u } = pointSegmentDistance2D(t.pos.x, t.pos.z, a.x, a.z, b.x, b.z);
      if (dist < bestD - 0.01) {
        bestD = dist;
        bestSeg = s;
        bestT = u;
      }
    }
    this.pathIndex = bestSeg;
    this.segT = bestT;
  }

  // punt `dist` meter verder langs het pad vanaf de projectie
  lookAhead(dist) {
    const path = this.path;
    if (path.length < 2) return path[0];
    let s = this.pathIndex;
    let a = path[s];
    let b = path[s + 1];
    let segLen = Math.hypot(b.x - a.x, b.z - a.z);
    let remaining = dist + this.segT * segLen;
    while (remaining > segLen && s < path.length - 2) {
      remaining -= segLen;
      s++;
      a = path[s];
      b = path[s + 1];
      segLen = Math.hypot(b.x - a.x, b.z - a.z);
    }
    const u = segLen > 0 ? Math.min(1, remaining / segLen) : 1;
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
  }

  scanTargets() {
    const t = this.tank;
    const w = this.world;
    const maxD = this.cfg.viewDistance;
    _eye.copy(t.pos);
    _eye.y += 2.9;
    let best = null;
    let bestScore = Infinity;
    let currentVisible = false;
    for (const o of w.tanks) {
      if (!o.alive || o.team === t.team) continue;
      const d = t.pos.distanceTo(o.pos);
      if (d > maxD) continue;
      _tgt.copy(o.pos);
      _tgt.y += 1.6;
      if (!w.lineOfSight(_eye, _tgt)) continue;
      // kan het kanon hem ook raken? (vanaf het draaipunt van de loop, dus los van waar de toren nu wijst;
      // een wrak, vernietigde tank, teamgenoot of boom op die lijn maakt hem geen bruikbaar doel)
      _tgt.y = o.pos.y + 1.3;
      const h = w.trace(t.gunOrigin, _tgt, { ignoreId: t.id });
      if (h && !(h.kind === 'tank' && h.body.alive && h.body.team !== t.team)) continue;
      let score = d;
      if (o.id === t.lastAttacker && w.time - t.lastHitTime < 8) score *= 0.5;
      // net onschietbaar gebleken (vanaf de loopmond): even liever een ander doel
      if (o === this.blockedTarget && w.time < this.blockedUntil) score *= 4;
      if (o === this.target) {
        currentVisible = true;
        score *= 0.6;
      }
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    if (best !== this.target) {
      if (best) {
        // nieuw doel: reactietijd en richtfout beginnen opnieuw (minder als het oude doel nog zichtbaar was)
        const [r0, r1] = this.cfg.reactionTime;
        this.reactionTimer = this.rng.range(r0, r1) * (currentVisible ? 0.5 : 1);
        this.aimTime = 0;
        this.randomizeError();
      }
      this.target = best;
    }
  }

  randomizeError() {
    this.errAngle = this.rng.range(0, Math.PI * 2);
  }

  aimAndFire(dt, cmd) {
    const t = this.tank;
    const target = this.target;
    const c = this.cfg;
    if (target && target.alive) {
      this.aimTime += dt;
      this.reactionTimer -= dt;
      const d = t.gunOrigin.distanceTo(target.pos);
      const tof = d / t.cfg.muzzleVelocity;
      this.aimPoint.copy(target.pos).addScaledVector(target.velocity, tof * c.leadFactor);
      this.aimPoint.y += 1.3;
      const settle = 1 - Math.exp(-this.aimTime / (c.aimSettleTime / 3));
      let errDeg = lerp(c.aimErrorStart, c.aimErrorMin, settle);
      if (Math.abs(t.speed) > 3) errDeg *= c.movingErrorFactor;
      // fout loodrecht op de schietlijn (zijwaarts, en half zo veel omhoog/omlaag), zodat de kompasrichting
      // niet uitmaakt
      _los.subVectors(this.aimPoint, t.gunOrigin).normalize();
      _right.crossVectors(_los, _UP).normalize();
      _upv.crossVectors(_right, _los);
      const e = d * Math.tan(errDeg * DEG);
      this.aimPoint
        .addScaledVector(_right, Math.cos(this.errAngle) * e)
        .addScaledVector(_upv, 0.5 * Math.sin(this.errAngle) * e);
      cmd.hasAim = true;
      cmd.aimX = this.aimPoint.x;
      cmd.aimY = this.aimPoint.y;
      cmd.aimZ = this.aimPoint.z;
      if (
        this.world.phase === 'battle' &&
        this.reactionTimer <= 0 &&
        t.reload <= 0 &&
        this.gunOnTarget(target, d) &&
        this.lineOfFireClear(target)
      ) {
        if (this.shotClear(target)) {
          cmd.fire = true;
          this.randomizeError();
          this.aimTime *= 0.6;
        } else {
          // doel verscholen achter een wrak, vernietigde tank of boom: snel een ander doel zoeken
          this.scanTimer = Math.min(this.scanTimer, 0.1);
          this.blockedTarget = target;
          this.blockedUntil = this.world.time + 2.5;
        }
      }
      return;
    }
    // geen doel: kijk richting het doelpunt of vooruit
    const point = this.world.points.find((p) => p.id === this.objective);
    const fx = Math.cos(t.yaw);
    const fz = -Math.sin(t.yaw);
    let ax = t.pos.x + fx * 80;
    let az = t.pos.z + fz * 80;
    if (point && t.onPoint === point.id) {
      // in het punt: kijk naar de vijandelijke kant
      const base = this.world.map.bases[1 - t.team];
      ax = point.x + (base.x - point.x) * 0.3;
      az = point.z + (base.z - point.z) * 0.3;
    }
    cmd.hasAim = true;
    cmd.aimX = ax;
    cmd.aimY = this.world.map.heightfield.heightAt(ax, az) + 2.5;
    cmd.aimZ = az;
  }

  // Staat de loop goed genoeg? Op afstand: hoekfout klein genoeg. Dichtbij (waar de loop soms niet ver
  // genoeg kan zakken): raakt de rechte lijn uit de loop de doeltank?
  gunOnTarget(target, dist) {
    const t = this.tank;
    if (aimErrorAngle(t) < this.cfg.fireTolerance * DEG) return true;
    if (dist > 140) return false;
    _tgt.copy(t.muzzle).addScaledVector(t.gunDir, dist + 10);
    const hit = this.world.trace(t.muzzle, _tgt, { ignoreId: t.id });
    return !!hit && hit.kind === 'tank' && hit.body === target;
  }

  // Rechte lijn van de loopmond naar het midden van het doel: niets geraakt of eerst een levende vijand?
  shotClear(target) {
    const t = this.tank;
    _tgt.copy(target.pos);
    _tgt.y += 1.3;
    const h = this.world.trace(t.muzzle, _tgt, { ignoreId: t.id });
    return !h || (h.kind === 'tank' && h.body.alive && h.body.team !== t.team);
  }

  // geen teamgenoten in de vuurlijn
  lineOfFireClear(target) {
    const t = this.tank;
    const o = t.gunOrigin;
    for (const m of this.world.tanks) {
      if (m === t || !m.alive || m.team !== t.team) continue;
      const { dist, t: s } = pointSegmentDistance2D(m.pos.x, m.pos.z, o.x, o.z, target.pos.x, target.pos.z);
      if (s > 0 && s < 1 && dist < 4.5) return false;
    }
    return true;
  }
}
