// Gesynthetiseerde geluiden met de Web Audio API (geen audiobestanden nodig):
// kanon, explosies, treffers, motor, rupsen, torenmotor, omgeving en UI-geluiden, met afstand en stereo.

const STORAGE_KEY = 'woudfront.muted';

function loadMuted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(m) {
  try {
    localStorage.setItem(STORAGE_KEY, m ? '1' : '0');
  } catch {
    // opslag niet beschikbaar: alleen voor deze sessie
  }
}

export class SoundEngine {
  constructor(volume = 0.7) {
    this.volume = volume;
    this.muted = loadMuted();
    this.ctx = null;
    this.listener = { x: 0, y: 0, z: 0, fx: 1, fz: 0 };
    this.engine = null;
    this.ambient = null;
  }

  // AudioContext mag pas na een gebruikersactie starten
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  setMuted(m) {
    this.muted = m;
    saveMuted(m);
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  setListener(x, y, z, fx, fz) {
    const l = this.listener;
    l.x = x;
    l.y = y;
    l.z = z;
    const len = Math.hypot(fx, fz) || 1;
    l.fx = fx / len;
    l.fz = fz / len;
  }

  // gain, stereo en vertraging (geluidssnelheid) voor een bron op positie p
  spatial(p) {
    const l = this.listener;
    const dx = p.x - l.x;
    const dy = p.y - l.y;
    const dz = p.z - l.z;
    const d = Math.hypot(dx, dy, dz);
    const rx = -l.fz;
    const rz = l.fx;
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, ((dx * rx + dz * rz) / d) * 0.85)) : 0;
    const gain = 1 / Math.pow(1 + d / 35, 1.25);
    const delay = d > 40 ? d / 343 : 0;
    const muffle = Math.max(0.12, 1 - d / 700);
    return { gain, pan, delay, muffle, dist: d };
  }

  output(gain, pan) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(this.master);
    return g;
  }

  noiseSource(t, duration, loop = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = loop;
    src.start(t, Math.random() * 1.5);
    if (!loop) src.stop(t + duration);
    return src;
  }

  envelope(param, t, peak, attack, decay) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // ------------------------------------------------------------ eenmalige geluiden
  cannon(pos, own = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const s = own ? { gain: 1, pan: 0, delay: 0, muffle: 1 } : this.spatial(pos);
    if (s.gain < 0.01) return;
    const t = ctx.currentTime + s.delay;
    const out = this.output(s.gain * (own ? 1.0 : 0.9), s.pan);
    // dreun
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(32, t + 0.45);
    const og = ctx.createGain();
    this.envelope(og.gain, t, 1.1, 0.004, 0.7);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.8);
    // knal
    const n = this.noiseSource(t, 1.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200 * s.muffle, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + 0.9);
    const ng = ctx.createGain();
    this.envelope(ng.gain, t, 1.0, 0.003, 1.2);
    n.connect(lp).connect(ng).connect(out);
    if (own) {
      // scherpe klap van de mondingsrem
      const c = this.noiseSource(t, 0.12);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      const cg = ctx.createGain();
      this.envelope(cg.gain, t, 0.55, 0.002, 0.09);
      c.connect(hp).connect(cg).connect(out);
    }
  }

  explosion(pos, big = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const s = this.spatial(pos);
    if (s.gain < 0.01) return;
    const t = ctx.currentTime + s.delay;
    const out = this.output(s.gain * (big ? 1.25 : 0.8), s.pan);
    const n = this.noiseSource(t, big ? 3 : 1.6);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2200 * s.muffle, t);
    lp.frequency.exponentialRampToValueAtTime(110, t + (big ? 2.2 : 1.2));
    const ng = ctx.createGain();
    this.envelope(ng.gain, t, 1, 0.006, big ? 2.6 : 1.4);
    n.connect(lp).connect(ng).connect(out);
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(big ? 60 : 75, t);
    osc.frequency.exponentialRampToValueAtTime(24, t + 0.9);
    const og = ctx.createGain();
    this.envelope(og.gain, t, big ? 1.2 : 0.7, 0.01, big ? 1.4 : 0.8);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 1.6);
    if (big) {
      // nagekraak van munitie
      for (let i = 0; i < 7; i++) {
        const tt = t + 0.3 + Math.random() * 1.8;
        const c = this.noiseSource(tt, 0.08);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 600 + Math.random() * 1400;
        const cg = ctx.createGain();
        this.envelope(cg.gain, tt, 0.35, 0.002, 0.07);
        c.connect(bp).connect(cg).connect(out);
      }
    }
  }

  // metalen klap als een granaat een tank raakt
  hitMetal(pos, own = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const s = own ? { gain: 1, pan: 0, delay: 0 } : this.spatial(pos);
    if (s.gain < 0.01) return;
    const t = ctx.currentTime + s.delay;
    const out = this.output(s.gain * (own ? 1 : 0.7), s.pan);
    const n = this.noiseSource(t, 0.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 2.5;
    const ng = ctx.createGain();
    this.envelope(ng.gain, t, 0.9, 0.002, 0.25);
    n.connect(bp).connect(ng).connect(out);
    for (const f of [540, 910, 1480]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f * (0.97 + Math.random() * 0.06);
      const g = ctx.createGain();
      this.envelope(g.gain, t, 0.22, 0.002, 0.6);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.7);
    }
  }

  // bevestiging dat jouw granaat raak was
  hitConfirm(kill = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const out = this.output(0.35, 0);
    const freqs = kill ? [660, 880, 1320] : [1250];
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = ctx.createGain();
      this.envelope(g.gain, t + i * 0.07, 0.25, 0.003, 0.12);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3000;
      o.connect(lp).connect(g).connect(out);
      o.start(t + i * 0.07);
      o.stop(t + i * 0.07 + 0.2);
    });
  }

  impactGround(pos) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const s = this.spatial(pos);
    if (s.gain < 0.01) return;
    const t = ctx.currentTime + s.delay;
    const out = this.output(s.gain * 0.75, s.pan);
    const n = this.noiseSource(t, 1.0);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1500 * s.muffle, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.7);
    const g = ctx.createGain();
    this.envelope(g.gain, t, 0.9, 0.004, 0.8);
    n.connect(lp).connect(g).connect(out);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.4);
    const og = ctx.createGain();
    this.envelope(og.gain, t, 0.6, 0.005, 0.45);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.6);
  }

  reloadDone() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.output(0.5, 0);
    [0, 0.09].forEach((dt, i) => {
      const n = this.noiseSource(t + dt, 0.06);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = i ? 2400 : 1500;
      bp.Q.value = 4;
      const g = ctx.createGain();
      this.envelope(g.gain, t + dt, 0.9, 0.002, 0.05);
      n.connect(bp).connect(g).connect(out);
    });
  }

  chime(notes, gain = 0.25, type = 'triangle', step = 0.11, length = 0.5) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const out = this.output(gain, 0);
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      this.envelope(g.gain, t + i * step, 0.5, 0.01, length);
      o.connect(g).connect(out);
      o.start(t + i * step);
      o.stop(t + i * step + length + 0.05);
    });
  }

  pointCaptured(ours) {
    if (ours) this.chime([523.25, 659.25, 783.99, 1046.5]);
    else this.chime([440, 349.23, 293.66], 0.25, 'sawtooth', 0.14, 0.4);
  }

  countdownBeep(final = false) {
    this.chime([final ? 880 : 587.33], 0.2, 'square', 0, final ? 0.45 : 0.15);
  }

  matchEnd(win) {
    if (win) this.chime([392, 523.25, 659.25, 783.99, 1046.5], 0.3, 'triangle', 0.16, 1.2);
    else this.chime([392, 311.13, 261.63, 196], 0.3, 'sawtooth', 0.22, 1.1);
  }

  uiClick() {
    if (!this.ensure()) return;
    this.chime([760], 0.12, 'sine', 0, 0.06);
  }

  // ------------------------------------------------------------ doorlopende geluiden
  startEngine() {
    if (!this.ctx || this.engine) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    lp.Q.value = 1.2;
    lp.connect(out);
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = 36;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = 54;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    o1.connect(lp);
    o2.connect(g2).connect(lp);
    const rumble = this.noiseSource(ctx.currentTime, 0, true);
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.value = 180;
    const rg = ctx.createGain();
    rg.gain.value = 0.6;
    rumble.connect(rlp).connect(rg).connect(out);
    // rupsgeratel: ruis, gemoduleerd in het ritme van de schakels
    const trackSrc = this.noiseSource(ctx.currentTime, 0, true);
    const tbp = ctx.createBiquadFilter();
    tbp.type = 'bandpass';
    tbp.frequency.value = 1100;
    tbp.Q.value = 1.4;
    const tg = ctx.createGain();
    tg.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0;
    const tmod = ctx.createGain();
    tmod.gain.value = 0;
    lfo.connect(lfoGain).connect(tmod.gain);
    trackSrc.connect(tbp).connect(tmod).connect(tg).connect(this.master);
    // torenmotor
    const tw = ctx.createOscillator();
    tw.type = 'triangle';
    tw.frequency.value = 210;
    const tw2 = ctx.createOscillator();
    tw2.type = 'sine';
    tw2.frequency.value = 417;
    const twg = ctx.createGain();
    twg.gain.value = 0;
    tw.connect(twg);
    tw2.connect(twg);
    twg.connect(this.master);
    for (const o of [o1, o2, lfo, tw, tw2]) o.start();
    this.engine = { out, lp, o1, o2, tg, lfo, lfoGain, tmod, twg, sources: [o1, o2, lfo, tw, tw2, rumble, trackSrc] };
  }

  updateEngine(throttle, speedFrac, turretMoving, silent = false) {
    const e = this.engine;
    if (!e) return;
    const t = this.ctx.currentTime;
    const rpm = 0.3 + 0.7 * Math.max(Math.abs(throttle) * 0.75, speedFrac);
    e.o1.frequency.setTargetAtTime(30 + rpm * 40, t, 0.18);
    e.o2.frequency.setTargetAtTime(45 + rpm * 60, t, 0.18);
    e.lp.frequency.setTargetAtTime(220 + rpm * 900, t, 0.2);
    e.out.gain.setTargetAtTime(silent ? 0 : 0.09 + rpm * 0.13, t, 0.2);
    e.tg.gain.setTargetAtTime(silent ? 0 : speedFrac * 0.16, t, 0.15);
    e.tmod.gain.setTargetAtTime(0.5, t, 0.1);
    e.lfoGain.gain.setTargetAtTime(0.5, t, 0.1);
    e.lfo.frequency.setTargetAtTime(3 + speedFrac * 16, t, 0.2);
    e.twg.gain.setTargetAtTime(turretMoving ? 0.025 : 0, t, 0.06);
  }

  stopEngine() {
    const e = this.engine;
    if (!e) return;
    const t = this.ctx.currentTime;
    e.out.gain.setTargetAtTime(0, t, 0.1);
    e.tg.gain.setTargetAtTime(0, t, 0.1);
    e.twg.gain.setTargetAtTime(0, t, 0.05);
    for (const s of e.sources) s.stop(t + 0.6);
    this.engine = null;
  }

  startAmbient() {
    if (!this.ctx || this.ambient) return;
    const ctx = this.ctx;
    const wind = this.noiseSource(ctx.currentTime, 0, true);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lg = ctx.createGain();
    lg.gain.value = 0.03;
    lfo.connect(lg).connect(g.gain);
    wind.connect(lp).connect(g).connect(this.master);
    lfo.start();
    this.ambient = { sources: [wind, lfo], gain: g, birdTimer: 2 };
  }

  updateAmbient(dt) {
    const a = this.ambient;
    if (!a) return;
    a.birdTimer -= dt;
    if (a.birdTimer <= 0) {
      a.birdTimer = 3 + Math.random() * 9;
      this.bird();
    }
  }

  bird() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.output(0.045 + Math.random() * 0.04, Math.random() * 1.6 - 0.8);
    const base = 2600 + Math.random() * 1600;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const tt = t + i * (0.12 + Math.random() * 0.08);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(base, tt);
      o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.5), tt + 0.06);
      o.frequency.exponentialRampToValueAtTime(base * 0.9, tt + 0.1);
      const g = ctx.createGain();
      this.envelope(g.gain, tt, 0.5, 0.01, 0.09);
      o.connect(g).connect(out);
      o.start(tt);
      o.stop(tt + 0.13);
    }
  }

  stopAmbient() {
    const a = this.ambient;
    if (!a) return;
    const t = this.ctx.currentTime;
    a.gain.gain.setTargetAtTime(0, t, 0.2);
    for (const s of a.sources) s.stop(t + 1);
    this.ambient = null;
  }
}
