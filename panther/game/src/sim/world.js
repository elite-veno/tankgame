// De volledige spelstatus en de vaste simulatiestap. Alles wat een server later autoritatief moet
// berekenen gebeurt hier; invoer komt binnen als commando's per tank, uitvoer gaat naar buiten als events.
import { Vector3 } from 'three';
import { RNG } from '../core/rng.js';
import { clamp } from '../core/mathUtils.js';
import {
  Tank,
  placeTank,
  updateTankDrive,
  updateTankGround,
  updateTankAim,
  updateTankFrames,
  collideTankWithObstacles,
  obstaclePenetration,
  applyContactToSpeed,
  forEachTankCircle,
  dispersedDirection,
} from './tank.js';
import { Projectile, updateProjectiles, traceSegment } from './projectiles.js';
import { CapturePoint, updateCapturePoints, updateTickets } from './capturePoints.js';

// Invoer voor één tank voor één simulatiestap (van speler of AI; later over het netwerk).
export function createCommand() {
  return { throttle: 0, steer: 0, hasAim: false, aimX: 0, aimY: 0, aimZ: 0, fire: false };
}

const IDLE = createCommand();
const _dir = new Vector3();

export class GameWorld {
  // roster: [{ name, team, isPlayer }]
  constructor(map, config, roster) {
    this.map = map;
    this.config = config;
    this.rng = new RNG((config.map.seed ^ 0x5eed1234) >>> 0);
    this.time = 0;
    this.battleTime = 0;
    this.phase = 'countdown'; // countdown -> battle -> ended
    this.countdown = config.match.startCountdown;
    this.winner = -1;
    this.endReason = null;
    this.events = [];
    this.projectiles = [];
    this.wrecks = [];
    this.nextProjectileId = 1;
    this.nextWreckId = 1;
    this.teams = [0, 1].map((t) => ({
      id: t,
      name: config.teams[t].name,
      tickets: config.match.startTickets,
      kills: 0,
      held: 0,
    }));
    this.points = map.points.map((p) => new CapturePoint(p));
    this.tanks = roster.map((r, i) => new Tank(i, r.team, r.name, !!r.isPlayer, config.tank));
    // welke vijandelijke tanks elk team op dit moment ziet (voor markeringen en minimap)
    this.spotted = [new Set(), new Set()];
    this.spotTimer = 0;
    const slotCounter = [0, 0];
    for (const tank of this.tanks) {
      const base = map.bases[tank.team];
      const slot = base.spawns[slotCounter[tank.team]++ % base.spawns.length];
      placeTank(tank, slot.x, slot.z, slot.yaw, map.heightfield);
      this.initialAim(tank);
    }
  }

  get battleActive() {
    return this.phase === 'battle';
  }

  get timeLeft() {
    return Math.max(0, this.config.match.timeLimit - this.battleTime);
  }

  emit(event) {
    event.time = this.time;
    this.events.push(event);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  initialAim(tank) {
    updateTankFrames(tank);
    tank.aimPoint.copy(tank.gunOrigin).addScaledVector(tank.gunDir, 100);
    tank.hasAim = true;
  }

  // Eén vaste stap. commands[tankId] = createCommand()-object (mag ontbreken).
  step(dt, commands) {
    this.time += dt;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'battle';
        this.emit({ type: 'battleStart' });
      }
    } else if (this.phase === 'battle') {
      this.battleTime += dt;
    }
    const canAct = this.phase === 'battle';
    const hf = this.map.heightfield;

    for (const tank of this.tanks) {
      tank._px = tank.pos.x;
      tank._py = tank.pos.y;
      tank._pz = tank.pos.z;
      tank._pyaw = tank.yaw;
      const cmd = (commands && commands[tank.id]) || IDLE;
      if (tank.alive) {
        updateTankDrive(tank, cmd, dt, canAct);
        if (this.phase !== 'ended') updateTankAim(tank, cmd, dt);
      } else {
        updateTankDrive(tank, IDLE, dt, false);
      }
      if (tank.reload > 0) tank.reload = Math.max(0, tank.reload - dt);
    }

    // botsingen
    // (ook vernietigde tanks: die rollen nog even uit)
    const obstacles = this.map.obstacles;
    for (const tank of this.tanks) {
      tank.collided = false;
      collideTankWithObstacles(tank, obstacles);
      // klem tussen twee hindernissen aan weerszijden: de duwen heffen elkaar op, dus de draai
      // van deze stap terugnemen in plaats van door de stammen heen te draaien
      if (tank.yaw !== tank._pyaw && obstaclePenetration(tank, obstacles) > 0.02) {
        tank.yaw = tank._pyaw;
        tank.turnRate = 0;
        collideTankWithObstacles(tank, obstacles);
      }
    }
    this.collideTanks();
    this.clampToBounds();

    for (const tank of this.tanks) {
      updateTankGround(tank, hf, dt);
      updateTankFrames(tank);
      tank.velocity.set((tank.pos.x - tank._px) / dt, (tank.pos.y - tank._py) / dt, (tank.pos.z - tank._pz) / dt);
    }

    // vuren (na het bijwerken van de monding)
    if (canAct) {
      for (const tank of this.tanks) {
        const cmd = commands && commands[tank.id];
        if (tank.alive && cmd && cmd.fire && tank.reload <= 0) this.fire(tank);
      }
    }

    updateProjectiles(this, dt);

    if (canAct) {
      updateCapturePoints(this, dt);
      updateTickets(this, dt);
    }

    this.updateRespawns(dt);
    this.updateWrecks(dt);
    this.spotTimer -= dt;
    if (this.spotTimer <= 0) {
      this.spotTimer = 0.25;
      this.updateSpotting();
    }
    if (canAct) this.checkEnd();
  }

  updateSpotting() {
    const range = this.config.ai.viewDistance;
    const eye = new Vector3();
    const target = new Vector3();
    for (let team = 0; team < 2; team++) {
      const set = this.spotted[team];
      set.clear();
      for (const enemy of this.tanks) {
        if (!enemy.alive || enemy.team === team) continue;
        target.copy(enemy.pos);
        target.y += 1.6;
        for (const mate of this.tanks) {
          if (!mate.alive || mate.team !== team) continue;
          if (mate.pos.distanceTo(enemy.pos) > range) continue;
          eye.copy(mate.pos);
          eye.y += 2.9;
          if (this.lineOfSight(eye, target)) {
            set.add(enemy.id);
            break;
          }
        }
      }
    }
  }

  fire(tank) {
    const cfg = tank.cfg;
    dispersedDirection(tank.gunDir, cfg.dispersion, this.rng, _dir);
    const vel = _dir.clone().multiplyScalar(cfg.muzzleVelocity);
    const p = new Projectile(this.nextProjectileId++, tank.id, tank.team, tank.muzzle, vel);
    this.projectiles.push(p);
    tank.reload = cfg.reloadTime;
    // terugslag op de vering
    tank.pitchSwayVel += 0.9 * Math.cos(tank.turretYaw);
    tank.rollSwayVel += 0.9 * Math.sin(tank.turretYaw);
    this.emit({
      type: 'shotFired',
      tankId: tank.id,
      projectileId: p.id,
      x: tank.muzzle.x,
      y: tank.muzzle.y,
      z: tank.muzzle.z,
      dx: _dir.x,
      dy: _dir.y,
      dz: _dir.z,
    });
  }

  damageTank(target, shooter, damage, facing, point) {
    if (!target.alive || this.phase === 'ended') return;
    target.hp -= damage;
    target.lastAttacker = shooter ? shooter.id : -1;
    target.lastHitTime = this.time;
    if (shooter) shooter.damageDealt += damage;
    this.emit({
      type: 'tankHit',
      targetId: target.id,
      shooterId: shooter ? shooter.id : -1,
      damage: Math.round(damage),
      facing,
      hp: Math.max(0, Math.round(target.hp)),
      x: point.x,
      y: point.y,
      z: point.z,
    });
    if (target.hp <= 0) this.destroyTank(target, shooter);
  }

  destroyTank(target, shooter) {
    target.hp = 0;
    target.alive = false;
    target.deaths++;
    target.respawnTimer = this.config.match.respawnTime;
    target.speed *= 0.3;
    if (shooter && shooter.team !== target.team) {
      shooter.kills++;
      this.teams[shooter.team].kills++;
    }
    const team = this.teams[target.team];
    team.tickets = Math.max(0, team.tickets - this.config.match.ticketsPerDestroyedTank);
    this.emit({
      type: 'tankDestroyed',
      tankId: target.id,
      killerId: shooter ? shooter.id : -1,
      x: target.pos.x,
      y: target.pos.y,
      z: target.pos.z,
    });
  }

  updateRespawns(dt) {
    if (this.phase === 'ended') return;
    for (const tank of this.tanks) {
      if (tank.alive) continue;
      tank.respawnTimer -= dt;
      if (tank.respawnTimer > 0) continue;
      // wrak achterlaten op de plek van vernietiging
      const wreck = {
        id: this.nextWreckId++,
        tankId: tank.id,
        team: tank.team,
        pos: tank.pos.clone(),
        yaw: tank.yaw,
        quat: tank.quat.clone(),
        turretQuat: tank.turretQuat.clone(),
        turretYaw: tank.turretYaw,
        gunPitch: tank.gunPitch,
        life: this.config.match.wreckLifetime,
      };
      this.wrecks.push(wreck);
      this.emit({ type: 'wreckCreated', wreckId: wreck.id, tankId: tank.id });
      this.respawnTank(tank);
    }
  }

  respawnTank(tank) {
    const base = this.map.bases[tank.team];
    let best = null;
    let bestScore = -Infinity;
    for (const s of base.spawns) {
      let nearest = Infinity;
      // ook vernietigde tanks tellen: hun romp blijft liggen tot er een wrak van gemaakt wordt
      for (const o of this.tanks) {
        if (o === tank) continue;
        nearest = Math.min(nearest, Math.hypot(o.pos.x - s.x, o.pos.z - s.z));
      }
      for (const w of this.wrecks) nearest = Math.min(nearest, Math.hypot(w.pos.x - s.x, w.pos.z - s.z));
      const score = Math.min(nearest, 30) + this.rng.next();
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    placeTank(tank, best.x, best.z, best.yaw, this.map.heightfield);
    tank.hp = tank.cfg.maxHp;
    tank.alive = true;
    tank.reload = 0;
    tank.respawnTimer = 0;
    tank.lastAttacker = -1;
    this.initialAim(tank);
    this.emit({ type: 'tankRespawned', tankId: tank.id });
  }

  updateWrecks(dt) {
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.life -= dt;
      if (w.life <= 0) {
        this.wrecks.splice(i, 1);
        this.emit({ type: 'wreckRemoved', wreckId: w.id });
      }
    }
  }

  collideTanks() {
    const cfg = this.config.tank;
    const tanks = this.tanks;
    const resolve = (a, b, movA, movB) => {
      forEachTankCircle(a.pos, a.yaw, cfg, (ax, az, ra) => {
        forEachTankCircle(b.pos, b.yaw, cfg, (bx, bz, rb) => {
          const dx = bx - ax;
          const dz = bz - az;
          const d = Math.hypot(dx, dz);
          const min = ra + rb;
          if (d >= min || d < 1e-6) return;
          const pen = min - d;
          const nx = dx / d;
          const nz = dz / d;
          const share = movA && movB ? 0.5 : 1;
          if (movA) {
            a.pos.x -= nx * pen * share;
            a.pos.z -= nz * pen * share;
            applyContactToSpeed(a, nx, nz);
            a.collided = true;
          }
          if (movB) {
            b.pos.x += nx * pen * share;
            b.pos.z += nz * pen * share;
            applyContactToSpeed(b, -nx, -nz);
            b.collided = true;
          }
        });
      });
    };
    for (let i = 0; i < tanks.length; i++) {
      const a = tanks[i];
      for (let j = i + 1; j < tanks.length; j++) {
        const b = tanks[j];
        if (!a.alive && !b.alive) continue;
        if (Math.abs(a.pos.x - b.pos.x) > 9 || Math.abs(a.pos.z - b.pos.z) > 9) continue;
        resolve(a, b, a.alive, b.alive);
      }
      if (!a.alive) continue;
      for (const w of this.wrecks) {
        if (Math.abs(a.pos.x - w.pos.x) > 9 || Math.abs(a.pos.z - w.pos.z) > 9) continue;
        resolve(a, w, true, false);
      }
    }
  }

  clampToBounds() {
    const lim = this.map.half - this.config.tank.hullHalfLength * 0.7;
    for (const tank of this.tanks) {
      if (tank.pos.x > lim) {
        tank.pos.x = lim;
        applyContactToSpeed(tank, 1, 0);
      } else if (tank.pos.x < -lim) {
        tank.pos.x = -lim;
        applyContactToSpeed(tank, -1, 0);
      }
      if (tank.pos.z > lim) {
        tank.pos.z = lim;
        applyContactToSpeed(tank, 0, 1);
      } else if (tank.pos.z < -lim) {
        tank.pos.z = -lim;
        applyContactToSpeed(tank, 0, -1);
      }
    }
  }

  checkEnd() {
    const [t0, t1] = this.teams;
    let winner = null;
    let reason = null;
    if (t0.tickets <= 0 || t1.tickets <= 0) {
      reason = 'tickets';
      winner = t0.tickets > t1.tickets ? 0 : t1.tickets > t0.tickets ? 1 : -1;
    } else if (this.battleTime >= this.config.match.timeLimit) {
      reason = 'time';
      winner = t0.tickets > t1.tickets ? 0 : t1.tickets > t0.tickets ? 1 : -1;
    }
    if (reason) {
      this.phase = 'ended';
      this.winner = winner;
      this.endReason = reason;
      for (const p of this.points) p.capturingTeam = -1;
      this.emit({ type: 'matchEnd', winner, reason });
    }
  }

  // Zichtlijn (terrein + boomstammen/rotsen) tussen twee punten.
  lineOfSight(a, b) {
    if (!this.map.heightfield.lineClear(a.x, a.y, a.z, b.x, b.y, b.z)) return false;
    return this.map.obstacles.raycastSegment(a.x, a.y, a.z, b.x, b.y, b.z) === null;
  }

  // Eerste treffer langs een lijnstuk (voor richten van de camera en AI).
  trace(a, b, opts) {
    return traceSegment(this, a, b, opts);
  }

  clampToPlayable(v, margin = 6) {
    const lim = this.map.half - margin;
    v.x = clamp(v.x, -lim, lim);
    v.z = clamp(v.z, -lim, lim);
    return v;
  }
}
