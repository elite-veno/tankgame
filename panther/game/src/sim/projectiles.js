// Granaten: vlucht met snelheid en lichte zwaartekracht, botsing met tanks, wrakken, bomen, rotsen en terrein,
// en schade (inclusief pantserhoek en scherfschade). Ook de gedeelde lijnstuk-test (traceSegment).
import { Vector3, Quaternion } from 'three';

const _qi = new Quaternion();
const _la = new Vector3();
const _lb = new Vector3();
const _c = new Vector3();
const _v = new Vector3();
const _f = new Vector3();
const _o = [0, 0, 0];
const _d = [0, 0, 0];
const _boxResult = { axis: -1, sign: 0 };

export class Projectile {
  constructor(id, ownerId, team, pos, vel) {
    this.id = id;
    this.ownerId = ownerId;
    this.team = team;
    this.pos = pos.clone();
    this.prev = pos.clone();
    this.vel = vel.clone();
    this.age = 0;
  }
}

// Lijnstuk a->b tegen georiënteerde doos (center, quat, half[3]). Geeft t in [0,1] of -1.
export function segmentBox(a, b, center, quat, half, result = _boxResult) {
  _qi.copy(quat).invert();
  _la.copy(a).sub(center).applyQuaternion(_qi);
  _lb.copy(b).sub(center).applyQuaternion(_qi);
  _o[0] = _la.x; _o[1] = _la.y; _o[2] = _la.z;
  _d[0] = _lb.x - _la.x; _d[1] = _lb.y - _la.y; _d[2] = _lb.z - _la.z;
  let tmin = 0;
  let tmax = 1;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const h = half[i];
    if (Math.abs(_d[i]) < 1e-9) {
      if (_o[i] < -h || _o[i] > h) return -1;
      continue;
    }
    const inv = 1 / _d[i];
    let t1 = (-h - _o[i]) * inv;
    let t2 = (h - _o[i]) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  result.axis = axis;
  result.sign = sign;
  return tmin;
}

// Doosmiddelpunten van romp en toren van een tank of wrak.
function hullCenter(body, cfg, out) {
  const hb = cfg.hullBox.center;
  return out.set(hb[0], hb[1], hb[2]).applyQuaternion(body.quat).add(body.pos);
}

function turretCenter(body, cfg, out) {
  const tp = cfg.turretPivot;
  const tb = cfg.turretBox.center;
  _v.set(tp[0], tp[1], tp[2]).applyQuaternion(body.quat).add(body.pos);
  return out.set(tb[0], tb[1], tb[2]).applyQuaternion(body.turretQuat).add(_v);
}

function testBody(body, cfg, a, b, best, kind) {
  // snelle afwijzing met een omhullende bol
  _c.copy(body.pos);
  _c.y += 1.4;
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? ((_c.x - a.x) * abx + (_c.y - a.y) * aby + (_c.z - a.z) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + abx * t - _c.x, py = a.y + aby * t - _c.y, pz = a.z + abz * t - _c.z;
  if (px * px + py * py + pz * pz > 36) return;
  const hc = hullCenter(body, cfg, new Vector3());
  const th = segmentBox(a, b, hc, body.quat, cfg.hullBox.half);
  if (th >= 0 && th < best.t) {
    best.t = th;
    best.kind = kind;
    best.body = body;
    best.part = 'hull';
    best.axis = _boxResult.axis;
    best.sign = _boxResult.sign;
    best.quat = body.quat;
  }
  const tc = turretCenter(body, cfg, new Vector3());
  const tt = segmentBox(a, b, tc, body.turretQuat, cfg.turretBox.half);
  if (tt >= 0 && tt < best.t) {
    best.t = tt;
    best.kind = kind;
    best.body = body;
    best.part = 'turret';
    best.axis = _boxResult.axis;
    best.sign = _boxResult.sign;
    best.quat = body.turretQuat;
  }
}

function terrainHit(hf, a, b) {
  if (a.y < hf.heightAt(a.x, a.z)) return 0;
  const len = a.distanceTo(b);
  const n = Math.max(1, Math.ceil(len / 1.5));
  let prevT = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    if (y < hf.heightAt(x, z)) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 8; k++) {
        const m = (lo + hi) / 2;
        const my = a.y + (b.y - a.y) * m;
        if (my < hf.heightAt(a.x + (b.x - a.x) * m, a.z + (b.z - a.z) * m)) hi = m;
        else lo = m;
      }
      return (lo + hi) / 2;
    }
    prevT = t;
  }
  return -1;
}

// Eerste treffer langs lijnstuk a->b. opts: { ignoreId, tanks: true, obstacles: true, terrain: true }
// Geeft { t, point, normal, kind, body, part, obstacle } of null.
export function traceSegment(world, a, b, opts = {}) {
  const ignoreId = opts.ignoreId ?? -1;
  const cfg = world.config.tank;
  const best = { t: Infinity, kind: null, body: null, part: null, obstacle: null, axis: -1, sign: 0, quat: null };
  if (opts.tanks !== false) {
    for (const tank of world.tanks) {
      if (tank.id === ignoreId || tank.hidden) continue;
      testBody(tank, cfg, a, b, best, 'tank');
    }
    for (const wreck of world.wrecks) testBody(wreck, cfg, a, b, best, 'wreck');
  }
  if (opts.obstacles !== false) {
    const hit = world.map.obstacles.raycastSegment(a.x, a.y, a.z, b.x, b.y, b.z);
    if (hit && hit.t < best.t) {
      best.t = hit.t;
      best.kind = hit.ob.kind;
      best.obstacle = hit.ob;
      best.body = null;
    }
  }
  if (opts.terrain !== false) {
    const tt = terrainHit(world.map.heightfield, a, b);
    if (tt >= 0 && tt < best.t) {
      best.t = tt;
      best.kind = 'terrain';
      best.body = null;
      best.obstacle = null;
    }
  }
  if (best.kind === null) return null;
  const point = new Vector3().lerpVectors(a, b, best.t);
  const normal = new Vector3();
  if (best.kind === 'terrain') {
    world.map.heightfield.normalAt(point.x, point.z, normal);
  } else if (best.kind === 'tree' || best.kind === 'rock') {
    normal.set(point.x - best.obstacle.x, 0, point.z - best.obstacle.z).normalize();
    if (best.kind === 'rock') normal.y = 0.6;
    normal.normalize();
  } else if (best.axis >= 0) {
    normal.set(0, 0, 0).setComponent(best.axis, best.sign).applyQuaternion(best.quat);
  } else {
    normal.subVectors(a, b).normalize();
  }
  return { t: best.t, point, normal, kind: best.kind, body: best.body, part: best.part, obstacle: best.obstacle };
}

// Granaten een stap verder laten vliegen en inslagen afhandelen.
export function updateProjectiles(world, dt) {
  const cfg = world.config.tank;
  const lim = world.map.worldSize / 2;
  const list = world.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.prev.copy(p.pos);
    p.vel.y -= cfg.shellGravity * dt;
    p.pos.addScaledVector(p.vel, dt);
    p.age += dt;
    const hit = traceSegment(world, p.prev, p.pos, { ignoreId: p.ownerId });
    if (hit) {
      p.pos.copy(hit.point);
      resolveShellHit(world, p, hit);
      list.splice(i, 1);
      continue;
    }
    if (p.age > cfg.shellMaxLifetime || Math.abs(p.pos.x) > lim || Math.abs(p.pos.z) > lim || p.pos.y < -200) {
      list.splice(i, 1);
      world.emit({ type: 'shellExpired', id: p.id });
    }
  }
}

function armorFacing(body, part, shellVel) {
  // richting waaruit de granaat komt, vergeleken met de voorkant van het getroffen deel
  _f.set(1, 0, 0).applyQuaternion(part === 'turret' ? body.turretQuat : body.quat);
  _f.y = 0;
  _f.normalize();
  _v.copy(shellVel);
  _v.y = 0;
  _v.normalize().negate();
  const cos = _f.dot(_v);
  if (cos > 0.5) return 'front';
  if (cos < -0.5) return 'rear';
  return 'side';
}

function resolveShellHit(world, shell, hit) {
  const cfg = world.config.tank;
  const shooter = world.tanks[shell.ownerId];
  const p = hit.point;
  let directTarget = null;
  let damage = 0;
  let facing = null;
  if (hit.kind === 'tank' && hit.body.alive) {
    const target = hit.body;
    const friendly = target.team === shell.team;
    if (!friendly || world.config.match.friendlyFire) {
      facing = armorFacing(target, hit.part, shell.vel);
      const mult = cfg.armorMultiplier[facing];
      damage = cfg.damage * mult * (1 + cfg.damageVariance * (world.rng.next() * 2 - 1));
      world.damageTank(target, shooter, damage, facing, p);
    }
    directTarget = target;
  }
  world.emit({
    type: 'shellImpact',
    id: shell.id,
    shooterId: shell.ownerId,
    kind: hit.kind,
    x: p.x,
    y: p.y,
    z: p.z,
    nx: hit.normal.x,
    ny: hit.normal.y,
    nz: hit.normal.z,
    targetId: hit.kind === 'tank' ? hit.body.id : -1,
    damage: Math.round(damage),
    facing,
  });
  // scherfschade rondom de inslag
  const R = cfg.splashRadius;
  for (const tank of world.tanks) {
    if (!tank.alive || tank === directTarget) continue;
    if (tank.team === shell.team && !world.config.match.friendlyFire) continue;
    _c.copy(tank.pos);
    _c.y += 1.2;
    const d = Math.max(0, _c.distanceTo(p) - 1.8);
    if (d < R) world.damageTank(tank, shooter, cfg.splashDamage * (1 - d / R), 'splash', p);
  }
}
