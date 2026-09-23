// Eén singleplayer-match: laadt de kaart, koppelt simulatie, AI, invoer, weergave, HUD en geluid,
// en draait de vaste simulatiestappen met vloeiende weergave daartussen.
//
// Scheiding voor fase 2 (multiplayer): alles in src/sim en src/ai draait zonder browser. Deze klasse
// is de "client": hij verzamelt invoer als commando's, laat de wereld een stap zetten en tekent de
// uitkomst op basis van de status en events. Later komen de stappen van de server in plaats van lokaal.
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { CONFIG } from '../config.js';
import { mapGenerator } from '../sim/mapGen.js';
import { GameWorld, createCommand } from '../sim/world.js';
import { NavGrid } from '../ai/navGrid.js';
import { AICoordinator } from '../ai/ai.js';
import { Environment } from '../render/environment.js';
import { createTerrain, TrailMap } from '../render/terrainView.js';
import { ForestView } from '../render/forestView.js';
import { TankViews } from '../render/tankView.js';
import { Effects } from '../render/effects.js';
import { CapturePointViews } from '../render/capturePointView.js';
import { ThirdPersonCamera } from '../render/cameraController.js';
import { PlayerInput } from '../input/playerInput.js';
import { Hud } from '../ui/hud.js';

const STEP = 1 / CONFIG.sim.tickRate;
const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
const _v = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _vel = new Vector3();

export class Match {
  constructor(app) {
    this.app = app;
    this.config = CONFIG;
    this.onFinished = null;
    this.onQuit = null;
    this.paused = true;
    this.finished = false;
    this.reported = false;
    this.acc = 0;
    this.time = 0;
    this.fps = 0;
    this.aimPoint = new Vector3();
    this.gunImpact = new Vector3();
    this.hasGunImpact = false;
    this.playerStats = { shots: 0, hits: 0 };
    this.lastCountdown = -1;
    this.lastReload = 0;
    this.turretMoving = false;
    this.engineTimer = 0;
    this.lodScaleBase = Math.tan((CONFIG.camera.fov * Math.PI) / 360); // bij de normale FOV: schaal 1
    this.initialPixelRatio = app.renderer.getPixelRatio();
    // meetvensters voor de dynamische resolutie (zie adaptResolution)
    this.perf = {
      dts: new Float32Array(1024),
      sorted: new Float32Array(1024),
      count: 0,
      time: 0,
      refreshDt: Infinity,
      good: 0,
      settle: 1,
      justRaised: false,
      ceiling: Infinity,
      dropCheck: null, // { from, median, missedFrac } van het venster vóór de laatste stap omlaag
      hold: 0, // aantal vensters zonder stap omlaag
    };
    this.shadowFrame = false;
    this.frameDtAvg = 0; // gedempte frametijd (s)
  }

  async load(progress) {
    const app = this.app;
    progress(0.02, 'Tankmodellen laden');
    await app.assets.loadTank();
    this.textures = await app.assets.loadWorld((p) => progress(0.05 + p * 0.3, 'Bos, terrein en lucht laden'));

    const gen = mapGenerator(CONFIG);
    let r = gen.next();
    while (!r.done) {
      progress(0.36 + r.value.progress * 0.32, `Kaart: ${r.value.label.toLowerCase()}`);
      await yieldFrame();
      r = gen.next();
    }
    this.map = r.value;

    progress(0.7, 'Navigatie voor de AI berekenen');
    await yieldFrame();
    this.nav = new NavGrid(this.map, CONFIG);

    // teams: speler + AI tegen AI
    const names = [...CONFIG.ai.names];
    const roster = [];
    for (let team = 0; team < 2; team++) {
      for (let i = 0; i < CONFIG.match.playersPerTeam; i++) {
        // skin is alleen voor de weergave; AI-tanks rijden in de camouflage van hun team
        if (team === 0 && i === 0) roster.push({ team, name: CONFIG.player.name, isPlayer: true, skin: this.app.profile.skin });
        else roster.push({ team, name: names.shift() || `Tank ${roster.length}`, isPlayer: false, skin: null });
      }
    }
    this.roster = roster;
    this.world = new GameWorld(this.map, CONFIG, roster);
    this.playerId = 0;
    this.player = this.world.tanks[this.playerId];
    this.ai = new AICoordinator(this.world, this.nav);
    for (const t of this.world.tanks) if (!t.isPlayer) this.ai.add(t, CONFIG.map.seed * 31 + t.id * 7919);
    this.commands = this.world.tanks.map(() => createCommand());

    progress(0.76, 'Wereld opbouwen');
    await yieldFrame();
    this.buildScene();
    progress(0.9, 'Shaders voorbereiden');
    await yieldFrame();
    this.updateView(0);
    await app.renderer.compileAsync(this.scene, this.camera);
    progress(1, 'Klaar');
  }

  buildScene() {
    const app = this.app;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(CONFIG.camera.fov, w / h, 0.3, 2600);
    this.env = new Environment(this.scene, this.textures.env, CONFIG);
    this.trail = new TrailMap(app.renderer, this.map.size + 40);
    this.terrain = createTerrain(this.map, this.textures, this.trail);
    this.scene.add(this.terrain.mesh);
    this.forest = new ForestView(this.scene, this.map, this.textures, CONFIG);
    this.effects = new Effects(this.scene, this.trail);
    this.tankViews = new TankViews(this.scene, app.tankFactory, this.world, this.effects, this.trail, this.playerId, this.roster);
    this.pointViews = new CapturePointViews(this.scene, this.world, CONFIG);
    this.camCtl = new ThirdPersonCamera(this.camera, this.world, CONFIG);
    this.camCtl.snapBehind(this.player);
    this.input = new PlayerInput(app.canvas);
    this.hud = new Hud(app, this.world, this.playerId, CONFIG);
  }

  start() {
    // het venster kan tijdens het laden van grootte veranderd zijn
    this.resize(window.innerWidth, window.innerHeight);
    this.hud.show();
    this.input.onLockChange = (locked) => {
      if (locked) this.resume();
      else if (!this.finished) this.pause();
    };
    this.onCanvasClick = () => {
      if (!this.finished && !this.input.locked) this.input.requestLock();
    };
    this.app.canvas.addEventListener('click', this.onCanvasClick);
    // terug in beeld (ander tabblad, ander scherm): de verversingsfrequentie opnieuw meten
    this.onVisibility = () => {
      if (!document.hidden) this.resetFrameStats();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.hud.showPause('start', { resume: () => this.input.requestLock(), quit: () => this.quit() });
    this.app.audio.startAmbient();
    this.app.audio.startEngine();
  }

  resume() {
    if (this.finished) return;
    this.paused = false;
    this.hud.showPause(null);
    this.app.audio.ensure();
    // het meetvenster rond de pauze is niet representatief
    this.perf.time = 0;
    this.perf.count = 0;
    this.perf.settle = 1;
    this.perf.dropCheck = null;
  }

  pause() {
    this.paused = true;
    this.hud.showPause('pause', { resume: () => this.input.requestLock(), quit: () => this.quit() });
  }

  quit() {
    this.input.releaseLock();
    this.onQuit?.();
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.hud.resize(w, h);
    this.resetFrameStats();
  }

  // Dynamische resolutie. Een gemist beeld is een frame dat duidelijk langer duurt dan de verversingstijd
  // van het scherm (bij 239 Hz: 4,2 ms). Gebeurt dat vaak, dan gaat de pixelratio een stap omlaag; blijft
  // het een tijd vlekkeloos, dan weer een stap omhoog. Een stap die meteen weer te zwaar bleek, wordt
  // daarna pas na lange tijd opnieuw geprobeerd, zodat de resolutie niet heen en weer blijft springen.
  adaptResolution(dt) {
    const p = this.perf;
    const g = CONFIG.graphics;
    if (!g.adaptiveResolution || dt <= 0) return;
    if (p.count < p.dts.length) p.dts[p.count++] = dt;
    p.time += dt;
    if (p.time < 1.5) return;
    const n = p.count;
    const fps = n / p.time;
    p.time = 0;
    p.count = 0;
    // verversingstijd van het scherm: de laagste mediane frametijd die we gezien hebben
    const sorted = p.sorted.subarray(0, n);
    sorted.set(p.dts.subarray(0, n));
    sorted.sort();
    const median = sorted[n >> 1];
    p.refreshDt = Math.min(p.refreshDt, median);
    let missed = 0;
    for (let i = 0; i < n; i++) if (p.dts[i] > p.refreshDt * 1.5) missed++;
    const missedFrac = missed / n;
    if (p.settle > 0) {
      // eerste venster na een wijziging (of na een pauze) telt niet mee
      p.settle--;
      return;
    }
    if (p.hold > 0) p.hold--;
    const r = this.app.renderer;
    const max = Math.min(window.devicePixelRatio || 1, g.maxPixelRatio);
    const cur = r.getPixelRatio();
    // Na een stap omlaag: werd het niet beter, dan ligt het niet aan de GPU (het scherm ververst trager,
    // bv. 120 -> 60 Hz, of de processor is de beperking). Dan de stap terugdraaien, de huidige frametijd
    // als verversingstijd nemen en een halve minuut niet meer omlaag gaan.
    const check = p.dropCheck;
    p.dropCheck = null;
    if (check && median > check.median * 0.95 && missedFrac > check.missedFrac * 0.8 && fps >= 45) {
      p.refreshDt = median;
      p.hold = 20;
      this.setPixelRatio(check.from);
      p.justRaised = false;
      return;
    }
    // onder de schermresolutie (ratio 1) alleen bij een echt lage framerate
    const floor = fps < 50 ? g.minPixelRatio : Math.min(1, max);
    let next = cur;
    if (missedFrac > 0.08 || fps < 45) {
      p.good = 0;
      if (p.justRaised) p.ceiling = cur; // deze stap omhoog was te zwaar
      if (cur > floor && p.hold === 0) {
        next = Math.max(floor, cur - 0.25);
        p.dropCheck = { from: cur, median, missedFrac };
      }
    } else if (missedFrac < 0.01) {
      if (p.justRaised && cur >= p.ceiling) p.ceiling = Infinity; // nu houdt hij het wel
      p.good++;
      const target = Math.min(max, cur + 0.25);
      if (cur < max && p.good >= (target >= p.ceiling ? 24 : 4)) next = target;
    } else {
      p.good = 0;
    }
    // een twijfelachtig venster direct na een stap omhoog telt nog als "net verhoogd"
    p.justRaised = next > cur || (p.justRaised && next === cur && missedFrac >= 0.01);
    if (next !== cur) this.setPixelRatio(next);
  }

  setPixelRatio(ratio) {
    const r = this.app.renderer;
    this.perf.good = 0;
    this.perf.settle = 1;
    r.setPixelRatio(ratio);
    r.setSize(window.innerWidth, window.innerHeight, false);
  }

  // na een venstergrootte- of schermwissel opnieuw meten hoe snel het scherm ververst
  resetFrameStats() {
    const p = this.perf;
    p.refreshDt = Infinity;
    p.count = 0;
    p.time = 0;
    p.settle = 1;
    p.dropCheck = null;
  }

  // -------------------------------------------------------------------- per frame
  frame(dt) {
    this.time += dt;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    if (dt > 0) this.frameDtAvg += (dt - this.frameDtAvg) * 0.1;
    // vóór het tekenen: een nieuwe pixelratio maakt de tekenbuffer leeg, dus dit beeld moet er al op
    if (!this.paused) this.adaptResolution(dt);
    const look = this.input.consumeLook();
    this.camCtl.look(look.dx, look.dy);
    this.camCtl.wheel(this.input.consumeWheel());
    this.camCtl.zoomed = this.input.zoom && this.player.alive && !this.paused;

    let alpha = 1;
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP && steps < CONFIG.sim.maxStepsPerFrame) {
        this.tankViews.snapshot();
        this.input.fillCommand(this.commands[this.playerId], this.aimPoint);
        this.ai.update(STEP, this.commands);
        this.world.step(STEP, this.commands);
        for (const e of this.world.drainEvents()) this.handleEvent(e);
        this.acc -= STEP;
        steps++;
      }
      if (steps >= CONFIG.sim.maxStepsPerFrame) this.acc = 0;
      alpha = this.acc / STEP;
      // torenmotor: per simulatiestap bepalen (per frame hangt het af van de verversingsfrequentie)
      if (steps > 0) {
        const yaw = this.player.turretYaw;
        this.turretMoving = Math.abs(yaw - (this.lastTurretYaw ?? yaw)) > 1e-4;
        this.lastTurretYaw = yaw;
      }
    }
    this.updateView(this.paused ? 0 : dt, alpha);
    this.updateAudio(dt);

    if (this.finished && !this.reported) {
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.reported = true;
        this.input.releaseLock();
        this.onFinished?.(this.summary());
      }
    }
  }

  updateView(dt, alpha = 1) {
    this.tankViews.update(dt, alpha);
    const pv = this.tankViews.view(this.playerId);
    this.camCtl.update(dt > 0 ? dt : 1 / 120, pv.renderPos, this.playerId);
    this.tankViews.setLodScale(this.lodScaleBase / Math.tan((this.camera.fov * Math.PI) / 360));
    this.camCtl.computeAim(this.playerId, pv.renderPos);
    this.aimPoint.copy(this.camCtl.aimPoint);
    this.predictGunImpact();
    // schaduw scherp vóór de speler in de kijkrichting
    const fwd = this.camCtl.forward;
    _v.set(pv.renderPos.x + fwd.x * 45, pv.renderPos.y, pv.renderPos.z + fwd.z * 45);
    this.env.update(_v, this.camera);
    this.forest.update(this.time, this.camera.position, this.camCtl.lookTarget);
    this.pointViews.update(dt, this.time);
    // pixels per meter op afstand 1 (resolutie, pixelratio en zoom-FOV): voor de minimale deeltjesgrootte
    this.effects.setViewport(window.innerHeight * this.app.renderer.getPixelRatio(), this.camera.fov);
    this.effects.syncTracers(this.world.projectiles, alpha, this.camera);
    this.effects.update(dt);
    this.trail.flush();
    this.hud.update(dt, {
      camera: this.camera,
      cameraYaw: this.camCtl.yaw,
      fov: this.camera.fov,
      gunImpact: this.hasGunImpact ? this.gunImpact : null,
      tankViews: this.tankViews,
      scoreboard: this.input.scoreboard,
    });
    // bij meer dan 100 beelden per seconde de schaduwkaart om het andere beeld tekenen: scheelt GPU-tijd,
    // en een schaduw die één beeld (hooguit 10 ms) achterloopt is niet te zien
    const shadows = this.app.renderer.shadowMap;
    shadows.autoUpdate = false;
    this.shadowFrame = !this.shadowFrame;
    shadows.needsUpdate = this.shadowFrame || !(this.frameDtAvg > 0 && this.frameDtAvg < 1 / 100);
    this.app.renderer.render(this.scene, this.camera);
  }

  // waar zou de granaat nu inslaan als je vuurt (volgt de echte stand van de loop)
  predictGunImpact() {
    const t = this.player;
    this.hasGunImpact = false;
    if (!t.alive) return;
    const cfg = CONFIG.tank;
    _a.copy(t.muzzle);
    _vel.copy(t.gunDir).multiplyScalar(cfg.muzzleVelocity);
    const dt = 0.04;
    for (let i = 0; i < 90; i++) {
      _b.copy(_a).addScaledVector(_vel, dt);
      _vel.y -= cfg.shellGravity * dt;
      const hit = this.world.trace(_a, _b, { ignoreId: t.id });
      if (hit) {
        this.gunImpact.copy(hit.point);
        this.hasGunImpact = true;
        return;
      }
      _a.copy(_b);
    }
    this.gunImpact.copy(_a);
    this.hasGunImpact = true;
  }

  updateAudio(dt) {
    const audio = this.app.audio;
    const cam = this.camera;
    audio.setListener(cam.position.x, cam.position.y, cam.position.z, this.camCtl.forward.x, this.camCtl.forward.z);
    const p = this.player;
    // motorgeluid hooguit 60 keer per seconde bijsturen (op een 240 Hz-scherm anders duizenden
    // automatiseringsstappen per seconde voor de audiothread)
    this.engineTimer -= dt;
    if (this.engineTimer <= 1e-3) {
      this.engineTimer = 1 / 60;
      const speedFrac = Math.min(1, Math.abs(p.speed) / CONFIG.tank.maxForwardSpeed);
      audio.updateEngine(p.alive ? p.throttle : 0, p.alive ? speedFrac : 0, p.alive && this.turretMoving && !this.paused, this.paused || !p.alive);
    }
    audio.updateAmbient(dt);
    if (this.world.phase === 'countdown' && !this.paused) {
      const c = Math.ceil(this.world.countdown);
      if (c !== this.lastCountdown && c <= 3) audio.countdownBeep(false);
      this.lastCountdown = c;
    }
    if (this.lastReload > 0 && p.reload <= 0 && p.alive) audio.reloadDone();
    this.lastReload = p.reload;
  }

  // -------------------------------------------------------------------- events uit de simulatie
  handleEvent(e) {
    this.hud.onEvent(e);
    const me = this.playerId;
    const audio = this.app.audio;
    const hf = this.map.heightfield;
    switch (e.type) {
      case 'shotFired': {
        this.tankViews.onShot(e.tankId);
        _v.set(e.x, e.y, e.z);
        _a.set(e.dx, e.dy, e.dz);
        this.effects.muzzleFlash(_v, _a, hf.heightAt(e.x, e.z));
        audio.cannon(_v, e.tankId === me);
        if (e.tankId === me) {
          this.camCtl.addShake(0.5);
          this.playerStats.shots++;
        }
        break;
      }
      case 'shellImpact': {
        _v.set(e.x, e.y, e.z);
        _a.set(e.nx, e.ny, e.nz);
        this.effects.impact(_v, _a, e.kind);
        if (e.kind === 'tank' || e.kind === 'wreck') audio.hitMetal(_v, e.targetId === me);
        else audio.impactGround(_v);
        const d = _v.distanceTo(this.camera.position);
        if (d < 25) this.camCtl.addShake(0.35 * (1 - d / 25));
        break;
      }
      case 'tankHit':
        if (e.targetId === me) this.camCtl.addShake(0.7);
        if (e.shooterId === me && this.world.tanks[e.targetId].team !== this.player.team) {
          if (e.facing !== 'splash') this.playerStats.hits++;
          if (e.hp > 0) audio.hitConfirm(false);
        }
        break;
      case 'tankDestroyed': {
        _v.set(e.x, e.y, e.z);
        this.effects.tankExplosion(_v);
        this.tankViews.onDestroyed(e.tankId);
        audio.explosion(_v, true);
        if (e.killerId === me && this.world.tanks[e.tankId].team !== this.player.team) audio.hitConfirm(true);
        if (e.tankId === me) this.camCtl.addShake(1.1);
        break;
      }
      case 'tankRespawned':
        this.tankViews.onRespawned(e.tankId);
        if (e.tankId === me) this.camCtl.snapBehind(this.player);
        break;
      case 'wreckCreated': {
        const wreck = this.world.wrecks.find((w) => w.id === e.wreckId);
        if (wreck) this.tankViews.onWreckCreated(wreck);
        break;
      }
      case 'wreckRemoved':
        this.tankViews.onWreckRemoved(e.wreckId);
        break;
      case 'pointCaptured':
        audio.pointCaptured(e.team === this.player.team);
        break;
      case 'pointNeutralized':
        if (e.lostBy === this.player.team) audio.pointCaptured(false);
        break;
      case 'battleStart':
        audio.countdownBeep(true);
        break;
      case 'matchEnd':
        this.onMatchEnd(e);
        break;
      default:
        break;
    }
  }

  onMatchEnd(e) {
    this.finished = true;
    this.endTimer = CONFIG.match.resultDelay;
    const myTeam = this.player.team;
    const outcome = e.winner === -1 ? 'draw' : e.winner === myTeam ? 'win' : 'lose';
    const sub =
      e.reason === 'time'
        ? 'De tijd is om'
        : outcome === 'win'
          ? 'De vijand heeft geen tickets meer'
          : 'Je team heeft geen tickets meer';
    this.hud.showBanner(outcome, sub);
    this.hud.showPause(null);
    this.app.audio.matchEnd(outcome === 'win');
  }

  summary() {
    const w = this.world;
    const p = this.player;
    return {
      winner: w.winner,
      playerTeam: p.team,
      reason: w.endReason,
      tickets: [w.teams[0].tickets, w.teams[1].tickets],
      duration: w.battleTime,
      player: {
        kills: p.kills,
        deaths: p.deaths,
        captures: p.captures,
        damage: p.damageDealt,
        shots: this.playerStats.shots,
        hits: this.playerStats.hits,
      },
      tanks: w.tanks.map((t) => ({
        name: t.isPlayer ? CONFIG.player.name : t.name,
        team: t.team,
        kills: t.kills,
        deaths: t.deaths,
        captures: t.captures,
        damage: t.damageDealt,
        isPlayer: t.isPlayer,
      })),
    };
  }

  // Werkt ook na een mislukte load(): alleen wat al gebouwd is wordt opgeruimd.
  dispose() {
    if (this.onCanvasClick) this.app.canvas.removeEventListener('click', this.onCanvasClick);
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    this.input?.dispose();
    this.app.audio.stopEngine();
    this.app.audio.stopAmbient();
    this.hud?.dispose();
    this.tankViews?.dispose();
    this.pointViews?.dispose();
    this.effects?.dispose();
    this.forest?.dispose();
    this.terrain?.dispose();
    this.trail?.dispose();
    this.env?.dispose();
    const r = this.app.renderer;
    r.shadowMap.autoUpdate = true; // de hangaar tekent zijn schaduwen weer elk beeld
    r.renderLists.dispose();
    if (r.getPixelRatio() !== this.initialPixelRatio) {
      r.setPixelRatio(this.initialPixelRatio);
      r.setSize(window.innerWidth, window.innerHeight, false);
    }
  }
}
