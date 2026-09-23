// Third-person camera achter de tank: draaien met de muis, zoomen met de rechtermuisknop,
// botsing met terrein, rotsen, tanks en wrakken, en het richtpunt onder het vizier (midden van het scherm).
// Boomstammen houden de camera niet tegen (dat gaf bij het rijden door het bos steeds sprongen);
// bomen tussen camera en tank worden in plaats daarvan doorzichtig (zie forestView.js).
import { Vector3 } from 'three';
import { DEG } from '../config.js';
import { clamp, dampFactor } from '../core/mathUtils.js';

const _dir = new Vector3();
const _tgt = new Vector3();
const _cam = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

export class ThirdPersonCamera {
  constructor(camera, world, config) {
    this.camera = camera;
    this.world = world;
    this.cfg = config.camera;
    this.yaw = 0;
    this.pitch = -8 * DEG;
    this.distance = this.cfg.distance;
    this.targetDistance = this.cfg.distance;
    this.zoomed = false;
    this.zoom = 0; // 0..1 gedempt
    this.shake = 0;
    this.aimPoint = new Vector3();
    this.aimHit = null;
    this.forward = new Vector3(1, 0, 0);
    this.lookTarget = new Vector3(); // punt boven de tank waar de camera naar kijkt
    this.boomLimit = Infinity; // ingekorte lengte van de camera-arm na een botsing (gedempt)
  }

  snapBehind(tank) {
    this.yaw = tank.yaw;
    this.pitch = -8 * DEG;
    this.boomLimit = Infinity; // ingekorte arm van vóór een respawn niet meenemen
  }

  look(dx, dy) {
    const s = this.cfg.mouseSensitivity * (1 - this.zoom * (1 - this.cfg.zoomSensitivityFactor));
    this.yaw -= dx * s;
    this.pitch = clamp(this.pitch - dy * s, this.cfg.minPitch * DEG, this.cfg.maxPitch * DEG);
  }

  wheel(delta) {
    this.targetDistance = clamp(this.targetDistance + delta * 0.01, this.cfg.minDistance, this.cfg.maxDistance);
  }

  addShake(amount) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  // focusPos: (geïnterpoleerde) positie van de tank; ignoreId: de eigen tank
  update(dt, focusPos, ignoreId) {
    const c = this.cfg;
    this.zoom += ((this.zoomed ? 1 : 0) - this.zoom) * dampFactor(12, dt);
    this.distance += (this.targetDistance - this.distance) * dampFactor(8, dt);
    const cp = Math.cos(this.pitch);
    _dir.set(cp * Math.cos(this.yaw), Math.sin(this.pitch), -cp * Math.sin(this.yaw));
    this.forward.copy(_dir);
    const height = c.targetHeight + (c.zoomTargetHeight - c.targetHeight) * this.zoom;
    _tgt.set(focusPos.x, focusPos.y + height, focusPos.z);
    this.lookTarget.copy(_tgt);
    const dist = this.distance + (c.zoomDistance - this.distance) * this.zoom;
    _cam.copy(_tgt).addScaledVector(_dir, -dist);
    // niet in rotsen, andere tanks of wrakken: de arm snel inkorten en daarna rustig weer uitschuiven,
    // zodat de camera niet heen en weer springt
    let free = dist;
    const hit = this.world.map.obstacles.raycastSegment(_tgt.x, _tgt.y, _tgt.z, _cam.x, _cam.y, _cam.z, 0.4, 'tree');
    if (hit) free = Math.min(free, hit.t * dist - 0.3);
    const body = this.world.trace(_tgt, _cam, { ignoreId, obstacles: false, terrain: false });
    if (body) free = Math.min(free, body.t * dist - 0.5);
    free = Math.max(free, dist * 0.12);
    if (free < dist - 0.01) {
      if (this.boomLimit > dist) this.boomLimit = dist;
      this.boomLimit += (free - this.boomLimit) * dampFactor(free < this.boomLimit ? 22 : 4, dt);
    } else if (this.boomLimit < Infinity) {
      this.boomLimit += (dist - this.boomLimit) * dampFactor(4, dt);
      if (this.boomLimit > dist - 0.02) this.boomLimit = Infinity;
    }
    if (this.boomLimit < dist) _cam.copy(_tgt).addScaledVector(_dir, -this.boomLimit);
    // niet onder het terrein
    const ground = this.world.map.heightfield.heightAt(_cam.x, _cam.z) + 1.1;
    if (_cam.y < ground) _cam.y = ground;
    // schudden na schoten en inslagen
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const sh = this.shake * this.shake * 0.35;
    const t = performance.now() * 0.001;
    this.camera.position.set(
      _cam.x + Math.sin(t * 57) * sh,
      _cam.y + Math.sin(t * 43 + 1) * sh,
      _cam.z + Math.cos(t * 51) * sh,
    );
    _a.copy(this.camera.position).add(_dir);
    this.camera.lookAt(_a);
    const fov = c.fov + (c.zoomFov - c.fov) * this.zoom;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // HUD-markeringen en de loopindicator projecteren met deze stand, niet met die van het vorige frame
    this.camera.updateMatrixWorld();
  }

  // Richtpunt: eerste treffer langs de kijkrichting vanaf de camera (voorbij de eigen tank).
  computeAim(ignoreId, focusPos) {
    const c = this.cfg;
    const origin = this.camera.position;
    _dir.copy(this.forward);
    // begin pas ter hoogte van de tank, zodat bomen tussen camera en tank het richten niet verstoren
    _tgt.set(focusPos.x - origin.x, focusPos.y + 1.5 - origin.y, focusPos.z - origin.z);
    const start = Math.max(0, _tgt.dot(_dir)) + 2;
    _a.copy(origin).addScaledVector(_dir, start);
    _b.copy(origin).addScaledVector(_dir, c.maxAimDistance);
    const hit = this.world.trace(_a, _b, { ignoreId });
    this.aimHit = hit;
    if (hit) this.aimPoint.copy(hit.point);
    else this.aimPoint.copy(_b);
    return this.aimPoint;
  }
}
