// Tankstatus en -fysica: rijden met acceleratie, terrein volgen, botsen, toren/kanon richten en vuren.
// Pure simulatie: gebruikt alleen Three.js-wiskunde (geen rendering), zodat dit later op een server kan draaien.
import { Vector3, Quaternion, Matrix4 } from 'three';
import { DEG } from '../config.js';
import {
  clamp,
  approach,
  approachAngle,
  wrapAngle,
  dampFactor,
  ballisticElevation,
} from '../core/mathUtils.js';

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _X = new Vector3();
const _Y = new Vector3();
const _Z = new Vector3();
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

export class Tank {
  constructor(id, team, name, isPlayer, cfg) {
    this.id = id;
    this.team = team;
    this.name = name;
    this.isPlayer = isPlayer;
    this.cfg = cfg;

    this.pos = new Vector3();
    this.yaw = 0; // rompkoers; voorwaarts = (cos yaw, 0, -sin yaw)
    this.speed = 0; // m/s langs de romp
    this.turnRate = 0; // rad/s
    this.quat = new Quaternion(); // uiteindelijke rompstand (terrein + vering)
    this.terrainQuat = new Quaternion();
    this.pitchSway = 0;
    this.pitchSwayVel = 0;
    this.rollSway = 0;
    this.rollSwayVel = 0;
    this.velocity = new Vector3();

    this.turretYaw = 0; // t.o.v. romp
    this.gunPitch = 0; // t.o.v. toren, positief = omhoog
    this.aimPoint = new Vector3();
    this.hasAim = false;

    this.hp = cfg.maxHp;
    this.alive = true;
    this.respawnTimer = 0;
    this.reload = 0;

    this.throttle = 0; // laatst toegepaste invoer (voor geluid/effecten)
    this.steer = 0;
    this.collided = false;

    this.kills = 0;
    this.deaths = 0;
    this.captures = 0;
    this.damageDealt = 0;
    this.lastAttacker = -1;
    this.lastHitTime = -100;
    this.onPoint = null;

    // afgeleide wereldposities (bijgewerkt door updateTankFrames)
    this.turretQuat = new Quaternion();
    this.gunQuat = new Quaternion();
    this.gunOrigin = new Vector3();
    this.gunDir = new Vector3(1, 0, 0);
    this.muzzle = new Vector3();
  }

  get forwardX() {
    return Math.cos(this.yaw);
  }

  get forwardZ() {
    return -Math.sin(this.yaw);
  }
}

// Zet een tank direct neer (spawn), inclusief terreinstand zonder demping.
export function placeTank(tank, x, z, yaw, hf) {
  tank.pos.set(x, 0, z);
  tank.yaw = yaw;
  tank.speed = 0;
  tank.turnRate = 0;
  tank.pitchSway = tank.pitchSwayVel = tank.rollSway = tank.rollSwayVel = 0;
  tank.turretYaw = 0;
  tank.gunPitch = 0;
  tank.velocity.set(0, 0, 0);
  const y = terrainTarget(tank, hf, tank.terrainQuat);
  tank.pos.y = y;
  tank.quat.copy(tank.terrainQuat);
  updateTankFrames(tank);
}

// Doel-stand op het terrein: gemiddelde hoogte van vier hoekpunten en de bijbehorende kanteling.
function terrainTarget(tank, hf, outQuat) {
  const c = tank.cfg;
  const L = c.hullHalfLength * 0.82;
  const W = c.hullHalfWidth * 0.85;
  const fx = Math.cos(tank.yaw);
  const fz = -Math.sin(tank.yaw);
  const rx = Math.sin(tank.yaw);
  const rz = Math.cos(tank.yaw);
  const x = tank.pos.x;
  const z = tank.pos.z;
  const hFR = hf.heightAt(x + fx * L + rx * W, z + fz * L + rz * W);
  const hFL = hf.heightAt(x + fx * L - rx * W, z + fz * L - rz * W);
  const hBR = hf.heightAt(x - fx * L + rx * W, z - fz * L + rz * W);
  const hBL = hf.heightAt(x - fx * L - rx * W, z - fz * L - rz * W);
  const slopeF = (hFR + hFL - hBR - hBL) / 2 / (2 * L);
  const slopeR = (hFR + hBR - hFL - hBL) / 2 / (2 * W);
  _X.set(fx, slopeF, fz).normalize();
  _Z.set(rx, slopeR, rz).normalize();
  _Y.crossVectors(_Z, _X).normalize();
  _Z.crossVectors(_X, _Y);
  _m.makeBasis(_X, _Y, _Z);
  outQuat.setFromRotationMatrix(_m);
  return (hFR + hFL + hBR + hBL) / 4;
}

// Rijden: gas, remmen, sturen, hellingen. cmd: { throttle, steer }
export function updateTankDrive(tank, cmd, dt, enabled) {
  const c = tank.cfg;
  const throttle = enabled ? clamp(cmd.throttle || 0, -1, 1) : 0;
  let steer = enabled ? clamp(cmd.steer || 0, -1, 1) : 0;
  tank.throttle = throttle;
  tank.steer = steer;

  const prevSpeed = tank.speed;
  let target = 0;
  if (throttle > 0) target = throttle * c.maxForwardSpeed;
  else if (throttle < 0) target = throttle * c.maxReverseSpeed;

  let rate;
  if (throttle === 0) rate = c.rollingResistance;
  else if (tank.speed * target < 0) rate = c.brakeDeceleration;
  else if (Math.abs(target) > Math.abs(tank.speed)) rate = c.acceleration * (1 - 0.45 * Math.abs(tank.speed) / c.maxForwardSpeed);
  else rate = c.rollingResistance;
  tank.speed = approach(tank.speed, target, rate * dt);

  // helling: zwaartekracht langs de rijrichting (x-as van de romp)
  _v.set(1, 0, 0).applyQuaternion(tank.terrainQuat);
  tank.speed -= 9.81 * _v.y * c.slopeFactor * dt;
  tank.speed = clamp(tank.speed, -c.maxReverseSpeed * 1.15, c.maxForwardSpeed * 1.1);
  if (throttle === 0 && Math.abs(tank.speed) < 0.05) tank.speed = 0;

  // sturen (achteruit eventueel omgekeerd, zoals een auto)
  if (c.invertSteeringInReverse && throttle < 0 && tank.speed < 0.3) steer = -steer;
  const speedFrac = Math.min(1, Math.abs(tank.speed) / c.maxForwardSpeed);
  const maxTurn = (c.hullTurnRate + (c.hullTurnRateAtSpeed - c.hullTurnRate) * speedFrac) * DEG;
  tank.turnRate = approach(tank.turnRate, steer * maxTurn, c.hullTurnAcceleration * DEG * dt);
  tank.yaw = wrapAngle(tank.yaw + tank.turnRate * dt);

  tank.pos.x += Math.cos(tank.yaw) * tank.speed * dt;
  tank.pos.z += -Math.sin(tank.yaw) * tank.speed * dt;

  // vering: neus omhoog bij optrekken, duikt bij remmen
  const accel = (tank.speed - prevSpeed) / dt;
  tank.pitchSwayVel += (-60 * tank.pitchSway - 9 * tank.pitchSwayVel + accel * 0.2) * dt;
  tank.pitchSway = clamp(tank.pitchSway + tank.pitchSwayVel * dt, -0.05, 0.05);
  tank.rollSwayVel += (-60 * tank.rollSway - 9 * tank.rollSwayVel + tank.turnRate * Math.abs(tank.speed) * 0.08) * dt;
  tank.rollSway = clamp(tank.rollSway + tank.rollSwayVel * dt, -0.04, 0.04);
}

// Na de botsingen: hoogte en stand volgen het terrein (gedempt), plus vering.
export function updateTankGround(tank, hf, dt) {
  const targetY = terrainTarget(tank, hf, _q);
  tank.terrainQuat.slerp(_q, dampFactor(14, dt));
  let y = tank.pos.y + (targetY - tank.pos.y) * dampFactor(18, dt);
  if (y < targetY - 0.08) y = targetY - 0.08; // nooit in de grond zakken
  tank.pos.y = y;
  _q2.setFromAxisAngle(AXIS_Z, tank.pitchSway);
  tank.quat.copy(tank.terrainQuat).multiply(_q2);
  _q2.setFromAxisAngle(AXIS_X, tank.rollSway);
  tank.quat.multiply(_q2);
}

// Toren en kanon richten op cmd.aimPoint (wereldpunt), met ballistische compensatie.
export function updateTankAim(tank, cmd, dt) {
  const c = tank.cfg;
  if (cmd && cmd.hasAim) {
    tank.aimPoint.set(cmd.aimX, cmd.aimY, cmd.aimZ);
    tank.hasAim = true;
  }
  let desiredYaw = tank.turretYaw;
  let desiredPitch = tank.gunPitch;
  if (tank.hasAim) {
    const P = tank.gunOrigin;
    const dx = tank.aimPoint.x - P.x;
    const dz = tank.aimPoint.z - P.z;
    const dh = tank.aimPoint.y - P.y;
    const d = Math.hypot(dx, dz);
    if (d > 0.5) {
      const elev = ballisticElevation(d, dh, c.muzzleVelocity, c.shellGravity);
      _v.set((dx / d) * Math.cos(elev), Math.sin(elev), (dz / d) * Math.cos(elev));
      _q.copy(tank.quat).invert();
      _v.applyQuaternion(_q);
      desiredYaw = Math.atan2(-_v.z, _v.x);
      desiredPitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
    }
  }
  tank.turretYaw = approachAngle(tank.turretYaw, desiredYaw, c.turretTraverseSpeed * DEG * dt);
  const pitchTarget = clamp(desiredPitch, c.gunMinElevation * DEG, c.gunMaxElevation * DEG);
  tank.gunPitch = approach(tank.gunPitch, pitchTarget, c.gunElevationSpeed * DEG * dt);
}

// Wereldposities van toren, kanon en monding uit romp + torenhoek + kanonhoek.
export function updateTankFrames(tank) {
  const c = tank.cfg;
  _q.setFromAxisAngle(AXIS_Y, tank.turretYaw);
  tank.turretQuat.copy(tank.quat).multiply(_q);
  _q.setFromAxisAngle(AXIS_Z, tank.gunPitch);
  tank.gunQuat.copy(tank.turretQuat).multiply(_q);
  // torenring
  _v.set(c.turretPivot[0], c.turretPivot[1], c.turretPivot[2]).applyQuaternion(tank.quat).add(tank.pos);
  // tappen van het kanon
  _v2.set(c.gunPivot[0], c.gunPivot[1], c.gunPivot[2]).applyQuaternion(tank.turretQuat);
  tank.gunOrigin.copy(_v).add(_v2);
  tank.gunDir.set(1, 0, 0).applyQuaternion(tank.gunQuat);
  tank.muzzle.copy(tank.gunOrigin).addScaledVector(tank.gunDir, c.muzzleLength);
}

// Hoek (rad) tussen huidige loop en de richting die nodig is om aimPoint te raken.
export function aimErrorAngle(tank) {
  if (!tank.hasAim) return Math.PI;
  const c = tank.cfg;
  const P = tank.gunOrigin;
  const dx = tank.aimPoint.x - P.x;
  const dz = tank.aimPoint.z - P.z;
  const dh = tank.aimPoint.y - P.y;
  const d = Math.hypot(dx, dz);
  if (d < 0.5) return 0;
  const elev = ballisticElevation(d, dh, c.muzzleVelocity, c.shellGravity);
  _v.set((dx / d) * Math.cos(elev), Math.sin(elev), (dz / d) * Math.cos(elev));
  return Math.acos(clamp(_v.dot(tank.gunDir), -1, 1));
}

// Cirkels waarmee tanks elkaar (en wrakken) raken. Callback per cirkel: fn(x, z, r)
export function forEachTankCircle(pos, yaw, cfg, fn) {
  const fx = Math.cos(yaw);
  const fz = -Math.sin(yaw);
  const cc = cfg.collisionCircles;
  for (let i = 0; i < cc.offsets.length; i++) fn(pos.x + fx * cc.offsets[i], pos.z + fz * cc.offsets[i], cc.radius);
}

// Contact tussen de romp (georiënteerde rechthoek) en een ronde hindernis. Geeft de indringdiepte
// (0 = geen contact) en zet in `out` de richting van de romp naar de hindernis (wereld, x/z).
const _contact = { x: 0, z: 0 };
function hullObstacleContact(tank, ob, out) {
  const c = tank.cfg;
  const hl = c.hullHalfLength;
  const hw = c.hullHalfWidth;
  const fx = Math.cos(tank.yaw);
  const fz = -Math.sin(tank.yaw);
  const rx = -fz;
  const rz = fx;
  const dx = ob.x - tank.pos.x;
  const dz = ob.z - tank.pos.z;
  const lx = dx * fx + dz * fz;
  const lz = dx * rx + dz * rz;
  let nx = lx - clamp(lx, -hl, hl);
  let nz = lz - clamp(lz, -hw, hw);
  const dist = Math.hypot(nx, nz);
  let pen;
  if (dist > 1e-6) {
    if (dist >= ob.r) return 0;
    pen = ob.r - dist;
    nx /= dist;
    nz /= dist;
  } else {
    const px = hl - Math.abs(lx);
    const pz = hw - Math.abs(lz);
    if (px < pz) {
      nx = Math.sign(lx) || 1;
      nz = 0;
      pen = px + ob.r;
    } else {
      nx = 0;
      nz = Math.sign(lz) || 1;
      pen = pz + ob.r;
    }
  }
  out.x = nx * fx + nz * rx;
  out.z = nx * fz + nz * rz;
  return pen;
}

function obstacleReach(tank) {
  return Math.hypot(tank.cfg.hullHalfLength, tank.cfg.hullHalfWidth) + 3.5;
}

// Duw een tank uit bomen en rotsen.
export function collideTankWithObstacles(tank, grid) {
  let hit = false;
  grid.forEachNear(tank.pos.x, tank.pos.z, obstacleReach(tank), (ob) => {
    const pen = hullObstacleContact(tank, ob, _contact);
    if (pen <= 0) return;
    tank.pos.x -= _contact.x * pen;
    tank.pos.z -= _contact.z * pen;
    applyContactToSpeed(tank, _contact.x, _contact.z);
    hit = true;
  });
  if (hit) tank.collided = true;
}

// Diepste overlap met een boom of rots na het botsen (0 = vrij).
export function obstaclePenetration(tank, grid) {
  let max = 0;
  grid.forEachNear(tank.pos.x, tank.pos.z, obstacleReach(tank), (ob) => {
    max = Math.max(max, hullObstacleContact(tank, ob, _contact));
  });
  return max;
}

// Snelheidscomponent richting het contactpunt wegnemen (frontaal: stoppen, schampend: doorglijden).
export function applyContactToSpeed(tank, nx, nz) {
  const fx = Math.cos(tank.yaw);
  const fz = -Math.sin(tank.yaw);
  const vn = tank.speed * (fx * nx + fz * nz);
  if (vn > 0) {
    const vx = fx * tank.speed - nx * vn;
    const vz = fz * tank.speed - nz * vn;
    tank.speed = vx * fx + vz * fz;
  }
}

// Kleine willekeurige afwijking op de looprichting (dispersie).
export function dispersedDirection(dir, degrees, rng, out) {
  const spread = degrees * DEG;
  // twee loodrechte vectoren
  const up = Math.abs(dir.y) < 0.95 ? AXIS_Y : AXIS_X;
  _X.crossVectors(dir, up).normalize();
  _Y.crossVectors(_X, dir).normalize();
  const a = rng.next() * Math.PI * 2;
  const r = Math.sqrt(rng.next()) * Math.tan(spread);
  out.copy(dir).addScaledVector(_X, Math.cos(a) * r).addScaledVector(_Y, Math.sin(a) * r).normalize();
  return out;
}
