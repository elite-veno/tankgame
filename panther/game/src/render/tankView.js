// Weergave van de tanks uit de simulatie: vloeiende interpolatie tussen simulatiestappen, toren/loop,
// terugslag, meedraaiende rupsen en wielen, stof, uitlaatgassen, rupssporen, brandende wrakken.
import { Vector3 } from 'three';
import { TRACK_HALF_GAUGE } from './runningGear.js';

const _v = new Vector3();
const EXHAUSTS = [new Vector3(-3.35, 2.2, 0.5), new Vector3(-3.35, 2.2, -0.5)];
const TRACK_REAR = [new Vector3(-3.1, 0.25, 1.45), new Vector3(-3.1, 0.25, -1.45)];
const TRACK_OFFSET = 1.36;
const TRACK_WIDTH = 0.66;

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class TankViews {
  // roster: [{ skin }] per tank-id (skin null = camouflage van het team)
  constructor(scene, factory, world, effects, trail, playerId, roster) {
    this.scene = scene;
    this.factory = factory;
    this.world = world;
    this.effects = effects;
    this.trail = trail;
    this.views = world.tanks.map((t) => this.createView(t, t.id === playerId, roster[t.id]?.skin || null));
    this.wrecks = new Map();
  }

  createView(tank, isPlayer, skin) {
    const model = this.factory.create(tank.team, isPlayer ? 'player' : 'ai', skin);
    this.scene.add(model.root);
    const view = {
      tank,
      model,
      skin,
      // afgelegde weg van de linker- en rechterrupsband
      travelL: 0,
      travelR: 0,
      prevPos: tank.pos.clone(),
      prevQuat: tank.quat.clone(),
      prevTurret: tank.turretYaw,
      prevGun: tank.gunPitch,
      renderPos: tank.pos.clone(),
      renderQuat: tank.quat.clone(),
      shotAge: 10,
      dustAcc: 0,
      exhaustAcc: 0,
      lastStamp: tank.pos.clone(),
      emitter: null,
      burnt: 0,
      turretBaseY: model.turrets.map((t) => t.position.y),
    };
    this.apply(view, 0);
    return view;
  }

  // voor elke simulatiestap: huidige stand bewaren als vorige
  snapshot() {
    for (const v of this.views) {
      v.prevPos.copy(v.tank.pos);
      v.prevQuat.copy(v.tank.quat);
      v.prevTurret = v.tank.turretYaw;
      v.prevGun = v.tank.gunPitch;
    }
  }

  apply(v, alpha) {
    const t = v.tank;
    v.renderPos.lerpVectors(v.prevPos, t.pos, alpha);
    v.renderQuat.slerpQuaternions(v.prevQuat, t.quat, alpha);
    v.model.root.position.copy(v.renderPos);
    v.model.root.quaternion.copy(v.renderQuat);
    v.model.setAim(lerpAngle(v.prevTurret, t.turretYaw, alpha), v.prevGun + (t.gunPitch - v.prevGun) * alpha);
  }

  update(dt, alpha) {
    for (const v of this.views) {
      this.apply(v, alpha);
      const t = v.tank;
      // terugslag: snel naar achteren, langzaam terug
      v.shotAge += dt;
      const s = v.shotAge;
      v.model.setRecoil(s < 0.05 ? (s / 0.05) * 0.4 : 0.4 * Math.exp(-(s - 0.05) * 5.5));
      // rupsen: bij draaien loopt de buitenste band sneller (positieve draaisnelheid = naar links);
      // ook een vernietigde tank rolt nog even uit
      v.travelL += (t.speed - t.turnRate * TRACK_HALF_GAUGE) * dt;
      v.travelR += (t.speed + t.turnRate * TRACK_HALF_GAUGE) * dt;
      v.model.setTrackTravel(v.travelL, v.travelR);
      if (!t.alive) {
        v.burnt = Math.min(1, v.burnt + dt * 1.5);
        v.model.setBurnt(v.burnt);
        continue;
      }
      const speedFrac = Math.min(1, Math.abs(t.speed) / t.cfg.maxForwardSpeed);
      const fx = Math.cos(t.yaw);
      const fz = -Math.sin(t.yaw);
      // stof achter de rupsen
      if (speedFrac > 0.18) {
        v.dustAcc += dt * (4 + speedFrac * 10);
        while (v.dustAcc > 1) {
          v.dustAcc -= 1;
          for (const p of TRACK_REAR) {
            _v.copy(p).applyQuaternion(v.renderQuat).add(v.renderPos);
            this.effects.trackDust(_v, speedFrac, fx * Math.sign(t.speed), fz * Math.sign(t.speed));
          }
        }
      }
      // uitlaat: meer rook bij gas geven
      const load = Math.abs(t.throttle);
      v.exhaustAcc += dt * (2 + load * 9);
      while (v.exhaustAcc > 1) {
        v.exhaustAcc -= 1;
        for (const p of EXHAUSTS) {
          _v.copy(p).applyQuaternion(v.renderQuat).add(v.renderPos);
          this.effects.exhaust(_v, 0.5 + load);
        }
      }
      // rupssporen in de sporenkaart
      const moved = Math.hypot(v.renderPos.x - v.lastStamp.x, v.renderPos.z - v.lastStamp.z);
      if (moved > 0.7) {
        const mx = (v.renderPos.x + v.lastStamp.x) / 2;
        const mz = (v.renderPos.z + v.lastStamp.z) / 2;
        const rx = -fz;
        const rz = fx;
        for (const side of [-1, 1]) {
          this.trail.stamp(mx + rx * side * TRACK_OFFSET, mz + rz * side * TRACK_OFFSET, t.yaw, moved + 0.25, TRACK_WIDTH, 0.8, 0);
        }
        v.lastStamp.copy(v.renderPos);
      }
    }
    for (const [id, w] of this.wrecks) {
      if (w.removing) {
        w.sink += dt;
        w.model.root.position.y = w.baseY - w.sink * 0.9;
        if (w.sink > 3) {
          this.scene.remove(w.model.root);
          w.model.dispose();
          this.wrecks.delete(id);
        }
      }
    }
  }

  view(id) {
    return this.views[id];
  }

  // LOD-afstanden schalen met de zoom van de camera (zie TankModel.setLodScale)
  setLodScale(scale) {
    for (const v of this.views) v.model.setLodScale(scale);
    for (const w of this.wrecks.values()) w.model.setLodScale(scale);
  }

  onShot(tankId) {
    this.views[tankId].shotAge = 0;
  }

  onDestroyed(tankId) {
    const v = this.views[tankId];
    // toren licht verschoven door de explosie
    v.model.turrets.forEach((t, i) => {
      t.position.y = v.turretBaseY[i] + 0.14;
      t.rotation.x = (Math.random() - 0.5) * 0.12;
      t.rotation.z = (Math.random() - 0.5) * 0.1;
    });
    v.emitter = this.effects.addEmitter(() => v.renderPos, 'burning', this.world.config.match.respawnTime + 0.5);
  }

  onRespawned(tankId) {
    const v = this.views[tankId];
    const t = v.tank;
    v.prevPos.copy(t.pos);
    v.prevQuat.copy(t.quat);
    v.prevTurret = t.turretYaw;
    v.prevGun = t.gunPitch;
    v.lastStamp.copy(t.pos);
    v.burnt = 0;
    v.model.setBurnt(0);
    v.model.turrets.forEach((tt, i) => {
      tt.position.y = v.turretBaseY[i];
      tt.rotation.x = 0;
      tt.rotation.z = 0;
    });
    if (v.emitter) this.effects.removeEmitter(v.emitter);
    v.emitter = null;
    this.apply(v, 1);
  }

  onWreckCreated(wreck) {
    const src = this.views[wreck.tankId];
    const model = this.factory.create(wreck.team, 'ai', src.skin);
    model.setTrackTravel(src.travelL, src.travelR);
    model.root.position.copy(wreck.pos);
    model.root.quaternion.copy(wreck.quat);
    model.setAim(wreck.turretYaw, wreck.gunPitch);
    model.setBurnt(1);
    model.turrets.forEach((t, i) => {
      const s = src.model.turrets[Math.min(i, src.model.turrets.length - 1)];
      t.position.y = s.position.y;
      t.rotation.x = s.rotation.x;
      t.rotation.z = s.rotation.z;
    });
    this.scene.add(model.root);
    const pos = wreck.pos.clone();
    const emitter = this.effects.addEmitter(() => pos, 'smoking', 22);
    this.wrecks.set(wreck.id, { model, emitter, baseY: wreck.pos.y, sink: 0, removing: false });
  }

  onWreckRemoved(wreckId) {
    const w = this.wrecks.get(wreckId);
    if (w) {
      w.removing = true;
      this.effects.removeEmitter(w.emitter);
    }
  }

  dispose() {
    for (const v of this.views) {
      this.scene.remove(v.model.root);
      v.model.dispose();
    }
    for (const w of this.wrecks.values()) {
      this.scene.remove(w.model.root);
      w.model.dispose();
    }
    this.wrecks.clear();
  }
}
