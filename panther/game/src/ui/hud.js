// HUD tijdens de match. Leest alleen de spelstatus (geen eigen spellogica) en toont:
// tickets + punten A/B/C, timer, vizier met loopindicator en herlaadring, HP/snelheid/herladen,
// markeringen boven tanks, meldingen, killfeed, minimap, scorebord, pauze- en eindschermen.
import { Vector3 } from 'three';
import { Minimap } from './minimap.js';
import { scoreTable } from './endScreen.js';

const RING = 2 * Math.PI * 31;
const _p = new Vector3();
const _display = { side: -1, frac: 0, draining: false };

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const FACING = { front: 'voorkant', side: 'zijkant', rear: 'achterkant', splash: 'scherven' };

export class Hud {
  constructor(app, world, playerId, config) {
    this.app = app;
    this.world = world;
    this.playerId = playerId;
    this.config = config;
    this.player = world.tanks[playerId];
    this.root = el('div', 'hud hidden', app.uiRoot);
    this.markersEl = el('div', 'markers', this.root);
    this.vignette = el('div', 'damage-vignette', this.root);
    this.deathVeil = el('div', 'death-veil', this.root);

    // bovenbalk
    const top = el('div', 'hud-top', this.root);
    const row = el('div', 'score-row', top);
    this.tickets = [0, 1].map((t) => {
      const box = el('div', `team-tickets ${t === 0 ? 'blue' : 'red'}`, null);
      box.innerHTML = `<div class="tt-top"><span>${config.teams[t].name}</span><span class="tt-value">${config.match.startTickets}</span></div><div class="tt-bar"><div class="tt-fill"></div></div>`;
      return { box, value: box.querySelector('.tt-value'), fill: box.querySelector('.tt-fill'), last: -1 };
    });
    row.appendChild(this.tickets[0].box);
    const pts = el('div', 'points', row);
    this.pointEls = world.points.map((p) => {
      const cp = el('div', 'cp', pts, `<div class="cp-fill"></div><div class="cp-letter">${p.id}</div>`);
      return { el: cp, fill: cp.querySelector('.cp-fill'), key: '' };
    });
    row.appendChild(this.tickets[1].box);
    this.timerEl = el('div', 'match-timer', top, '');
    this.zoneEl = el(
      'div',
      'zone-status hidden',
      this.root,
      '<div class="zs-label"></div><div class="zs-bar"><i></i></div>',
    );
    this.zoneLabel = this.zoneEl.querySelector('.zs-label');
    this.zoneFill = this.zoneEl.querySelector('.zs-bar i');

    this.messagesEl = el('div', 'messages', this.root);
    this.killfeedEl = el('div', 'killfeed', this.root);

    // vizier + herlaadring
    this.crosshair = el(
      'div',
      'crosshair',
      this.root,
      `<svg viewBox="-40 -40 80 80" width="80" height="80">
        <circle r="31" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="4"/>
        <circle class="ring" r="31" fill="none" stroke="#e0a642" stroke-width="2.5" stroke-dasharray="${RING}" stroke-dashoffset="0" transform="rotate(-90)"/>
        <g stroke="#f4eedc" stroke-width="1.6" opacity="0.95">
          <line x1="-22" y1="0" x2="-9" y2="0"/><line x1="9" y1="0" x2="22" y2="0"/>
          <line x1="0" y1="9" x2="0" y2="22"/><line x1="0" y1="-22" x2="0" y2="-9"/>
        </g>
        <circle r="1.6" fill="#f4eedc"/>
      </svg>`,
    );
    this.ring = this.crosshair.querySelector('.ring');
    this.gunMarker = el(
      'div',
      'gun-marker',
      this.root,
      `<svg viewBox="-17 -17 34 34" width="34" height="34">
        <circle r="11" fill="none" stroke="rgba(0,0,0,0.5)" stroke-width="3.5"/>
        <circle class="gm" r="11" fill="none" stroke="#9ff07a" stroke-width="1.8"/>
        <g class="gm-ticks" stroke="#9ff07a" stroke-width="1.8"><line x1="0" y1="-16" x2="0" y2="-12"/><line x1="0" y1="12" x2="0" y2="16"/><line x1="-16" y1="0" x2="-12" y2="0"/><line x1="12" y1="0" x2="16" y2="0"/></g>
      </svg>`,
    );
    this.gunCircle = this.gunMarker.querySelector('.gm');
    this.gunTicks = this.gunMarker.querySelector('.gm-ticks');
    this.hitmarker = el(
      'div',
      'hitmarker',
      this.root,
      `<svg viewBox="-23 -23 46 46" width="46" height="46"><g stroke="#ffffff" stroke-width="2.4"><line x1="-15" y1="-15" x2="-6" y2="-6"/><line x1="15" y1="-15" x2="6" y2="-6"/><line x1="-15" y1="15" x2="-6" y2="6"/><line x1="15" y1="15" x2="6" y2="6"/></g></svg>`,
    );
    this.hitmarkerLines = this.hitmarker.querySelector('g');
    this.hitText = el('div', 'hit-text', this.root);
    this.reloadText = el('div', 'reload-text', this.root);
    // richting van waaruit je geraakt wordt
    this.damageDir = el(
      'div',
      'damage-dir',
      this.root,
      `<svg viewBox="-110 -110 220 220" width="220" height="220"><path d="M -38 -92 A 100 100 0 0 1 38 -92" fill="none" stroke="#ff4a34" stroke-width="9" stroke-linecap="round"/></svg>`,
    );
    this.damageFrom = null;
    this.damageTimer = 0;

    // tankpaneel
    const panel = el('div', 'panel tank-panel', this.root);
    panel.innerHTML = `
      <div class="tp-name">${config.tank.name}</div>
      <svg class="tp-diagram" viewBox="-43 -43 86 86">
        <circle r="41" fill="rgba(0,0,0,0.3)" stroke="rgba(214,190,128,0.25)"/>
        <path d="M0 0 L-16 -40 L16 -40 Z" fill="rgba(255,255,255,0.07)"/>
        <g class="dg-hull"><rect x="-12" y="-21" width="24" height="42" rx="2" fill="rgba(160,170,150,0.25)" stroke="#c9d1bd" stroke-width="1.4"/><line x1="-12" y1="-14" x2="12" y2="-14" stroke="#c9d1bd" stroke-width="1"/></g>
        <g class="dg-turret"><circle r="8.5" fill="rgba(20,24,20,0.8)" stroke="#e0a642" stroke-width="1.6"/><line x1="0" y1="-8" x2="0" y2="-33" stroke="#e0a642" stroke-width="2.6"/></g>
      </svg>
      <div><div class="tp-label"><span>Structuur</span><b class="tp-hp-val"></b></div><div class="tp-bar tp-hp"><i></i></div></div>
      <div><div class="tp-label"><span>Kanon</span><b class="tp-reload-val"></b></div><div class="tp-bar tp-reload"><i></i></div></div>
      <div class="tp-speed"><span class="tp-speed-val">0</span><small>km/h</small></div>`;
    this.hpVal = panel.querySelector('.tp-hp-val');
    this.hpBar = panel.querySelector('.tp-hp');
    this.hpFill = panel.querySelector('.tp-hp i');
    this.reloadVal = panel.querySelector('.tp-reload-val');
    this.reloadBar = panel.querySelector('.tp-reload');
    this.reloadFill = panel.querySelector('.tp-reload i');
    this.speedVal = panel.querySelector('.tp-speed-val');
    this.dgHull = panel.querySelector('.dg-hull');
    this.dgTurret = panel.querySelector('.dg-turret');

    const mm = el('div', 'panel minimap', this.root);
    this.minimap = new Minimap(el('canvas', '', mm), world, config, playerId);
    this.minimapTimer = 0;

    // overlays
    this.countdownEl = el('div', 'overlay-center countdown hidden', this.root, '<div class="small">De slag begint over</div><div class="big">5</div>');
    this.countdownNum = this.countdownEl.querySelector('.big');
    this.respawnEl = el(
      'div',
      'overlay-center respawn hidden',
      this.root,
      '<div class="big">Vernietigd</div><div class="small"></div><div class="timer"></div>',
    );
    this.respawnBy = this.respawnEl.querySelector('.small');
    this.respawnTimer = this.respawnEl.querySelector('.timer');
    this.scoreboardEl = el('div', 'panel scoreboard hidden', this.root);
    this.scoreTimer = 0;
    this.pauseEl = el('div', 'pause hidden', this.root);
    this.bannerEl = el('div', 'banner hidden', this.root);

    this.markers = new Map();
    for (const t of world.tanks) {
      if (t.id === playerId) continue;
      const ally = t.team === this.player.team;
      const m = el(
        'div',
        `marker ${ally ? 'ally' : 'enemy'}`,
        this.markersEl,
        ally
          ? `<div class="mk-name">${t.name}</div><div class="mk-hp"><i></i></div><div class="mk-arrow"></div>`
          : `<div class="mk-name"></div><div class="mk-arrow"></div>`,
      );
      this.markers.set(t.id, { el: m, name: m.querySelector('.mk-name'), hp: m.querySelector('.mk-hp i'), visible: true, lastText: '' });
    }

    this.lastReload = -1;
    this.lastHp = -1;
    this.lastSpeed = -1;
    this.killerName = '';
    this.width = window.innerWidth;
    this.height = window.innerHeight;
  }

  show() {
    this.root.classList.remove('hidden');
  }

  resize(w, h) {
    this.width = w;
    this.height = h;
  }

  // -------------------------------------------------------------- meldingen
  message(text, cls = '', duration = 3.2) {
    const m = el('div', `msg ${cls}`, this.messagesEl, text);
    while (this.messagesEl.children.length > 3) this.messagesEl.firstChild.remove();
    setTimeout(() => {
      m.style.opacity = 0;
      setTimeout(() => m.remove(), 650);
    }, duration * 1000);
  }

  killfeed(killer, victim) {
    const name = (t) =>
      `<span class="t${t.team} ${t.id === this.playerId ? 'me' : ''}">${t.id === this.playerId ? this.config.player.name : t.name}</span>`;
    const k = el('div', 'kf', this.killfeedEl, `${killer ? name(killer) : '<span class="icon">?</span>'}<span class="icon">▸</span>${name(victim)}`);
    while (this.killfeedEl.children.length > 5) this.killfeedEl.firstChild.remove();
    setTimeout(() => {
      k.style.opacity = 0;
      setTimeout(() => k.remove(), 650);
    }, 7000);
  }

  flashHit(text, color, kill = false) {
    this.hitmarker.classList.remove('show');
    void this.hitmarker.offsetWidth;
    this.hitmarkerLines.setAttribute('stroke', kill ? '#e0a642' : '#ffffff');
    this.hitmarker.classList.add('show');
    this.hitText.textContent = text;
    this.hitText.style.color = color;
    this.hitText.style.opacity = 1;
    clearTimeout(this.hitTextTimer);
    this.hitTextTimer = setTimeout(() => (this.hitText.style.opacity = 0), kill ? 1800 : 1100);
  }

  onEvent(e) {
    const w = this.world;
    const me = this.playerId;
    const myTeam = this.player.team;
    const teamName = (t) => this.config.teams[t].name;
    switch (e.type) {
      case 'battleStart':
        this.message('Vecht!', 'gold', 2);
        break;
      case 'pointCaptured':
        this.message(`Punt ${e.pointId} veroverd door ${teamName(e.team)}`, e.team === myTeam ? 'blue' : 'red');
        break;
      case 'pointNeutralized':
        if (e.lostBy === myTeam) this.message(`Punt ${e.pointId} verloren!`, 'red');
        else this.message(`Punt ${e.pointId} geneutraliseerd`, 'blue');
        break;
      case 'tankHit':
        if (e.shooterId === me && e.targetId !== me) {
          const target = w.tanks[e.targetId];
          if (target.team !== myTeam && e.hp > 0) this.flashHit(`Treffer · ${FACING[e.facing] || ''} · ${e.damage}`, '#ffffff');
        }
        if (e.targetId === me && e.shooterId >= 0 && e.shooterId !== me) {
          const s = w.tanks[e.shooterId];
          this.damageFrom = { x: s.pos.x, z: s.pos.z };
          this.damageTimer = 1.8;
        }
        if (e.targetId === me) {
          this.vignette.style.transition = 'none';
          this.vignette.style.opacity = 1;
          void this.vignette.offsetWidth;
          this.vignette.style.transition = 'opacity 0.9s';
          this.vignette.style.opacity = 0;
        }
        break;
      case 'tankDestroyed': {
        const victim = w.tanks[e.tankId];
        const killer = e.killerId >= 0 ? w.tanks[e.killerId] : null;
        this.killfeed(killer, victim);
        if (e.killerId === me && victim.team !== myTeam) this.flashHit('Vijand vernietigd', '#e0a642', true);
        if (e.tankId === me) this.killerName = killer ? killer.name : '';
        break;
      }
      case 'tankRespawned':
        if (e.tankId === me) this.message('Terug in de strijd', 'gold', 2);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------- overlays
  showPause(mode, handlers) {
    if (!mode) {
      this.pauseEl.classList.add('hidden');
      return;
    }
    const start = mode === 'start';
    this.pauseEl.innerHTML = `
      <div class="panel">
        <div class="panel-title">${start ? 'Klaar voor de strijd' : 'Gepauzeerd'}</div>
        <div class="hint">${start ? 'Klik om de muis te vergrendelen en te beginnen.' : 'De singleplayer-match staat stil.'}<br/>
          <kbd>W</kbd><kbd>S</kbd> rijden · <kbd>A</kbd><kbd>D</kbd> draaien · muis richten<br/>
          <kbd>LMB</kbd> vuren · <kbd>RMB</kbd> zoom · <kbd>Tab</kbd> scorebord</div>
        <button class="menu-btn primary resume">${start ? 'Beginnen' : 'Hervatten'}</button>
        <button class="menu-btn quit">Match verlaten</button>
      </div>`;
    this.pauseEl.querySelector('.resume').addEventListener('click', () => handlers.resume());
    this.pauseEl.querySelector('.quit').addEventListener('click', () => handlers.quit());
    this.pauseEl.classList.remove('hidden');
  }

  showBanner(outcome, sub) {
    const title = outcome === 'win' ? 'Overwinning' : outcome === 'lose' ? 'Nederlaag' : 'Gelijkspel';
    this.bannerEl.className = `banner ${outcome}`;
    this.bannerEl.innerHTML = `<div class="title">${title.toUpperCase()}</div><div class="sub">${sub}</div>`;
  }

  // -------------------------------------------------------------- per frame
  update(dt, f) {
    const w = this.world;
    const p = this.player;
    const cfg = this.config;
    // tickets
    for (let t = 0; t < 2; t++) {
      const tk = this.tickets[t];
      const v = Math.ceil(w.teams[t].tickets);
      if (v !== tk.last) {
        tk.last = v;
        tk.value.textContent = v;
        tk.fill.style.width = `${(v / cfg.match.startTickets) * 100}%`;
      }
      const other = w.teams[1 - t].held || 0;
      tk.box.classList.toggle('bleeding', other > (w.teams[t].held || 0) && w.phase === 'battle');
    }
    // punten
    w.points.forEach((pt, i) => {
      const pe = this.pointEls[i];
      const d = pt.display(_display);
      // eenmalige waarschuwing als de vijand een punt van jouw team begint te neutraliseren
      const attacked = d.draining && pt.owner === p.team;
      if (attacked && !pe.attacked && w.phase === 'battle') this.message(`Punt ${pt.id} wordt aangevallen!`, 'red');
      pe.attacked = attacked;
      const key = `${pt.owner}|${d.side}|${Math.round(d.frac * 40)}|${d.draining}|${pt.contested}|${p.onPoint === pt.id}`;
      if (key === pe.key) return;
      pe.key = key;
      pe.el.className = `cp owner-${pt.owner >= 0 ? pt.owner : 'n'} ${pt.contested ? 'contested' : ''} ${d.draining ? 'attacked' : ''} ${p.onPoint === pt.id ? 'mine' : ''}`;
      if (d.side >= 0) {
        pe.fill.style.height = `${d.frac * 140}%`;
        pe.fill.style.background = cfg.teams[d.side].color;
      } else {
        pe.fill.style.height = '0';
      }
    });
    this.timerEl.textContent = w.phase === 'countdown' ? fmtTime(cfg.match.timeLimit) : fmtTime(w.timeLeft);

    // zone waarin de speler staat
    const zone = p.alive && p.onPoint ? w.points.find((q) => q.id === p.onPoint) : null;
    if (zone && w.phase === 'battle') {
      this.zoneEl.classList.remove('hidden');
      let label;
      let frac;
      let color;
      if (zone.contested) {
        label = `Punt ${zone.id} betwist`;
        frac = Math.abs(zone.progress);
        color = '#ffffff';
      } else if (zone.owner === p.team && Math.abs(zone.progress) >= 0.999) {
        label = `Punt ${zone.id} in bezit`;
        frac = 1;
        color = cfg.teams[p.team].color;
      } else {
        // eigen punt dat deels is leeggetrokken: herstellen; anders veroveren
        label = zone.owner === p.team ? `Punt ${zone.id} herstellen` : `Punt ${zone.id} veroveren`;
        frac = zone.progressFor(p.team);
        color = cfg.teams[p.team].color;
        if (zone.progressFor(1 - p.team) > 0) {
          // eerst de voortgang van de vijand wegwerken
          label = zone.owner === 1 - p.team ? `Punt ${zone.id} neutraliseren` : `Punt ${zone.id} terugdringen`;
          frac = 1 - zone.progressFor(1 - p.team);
        }
      }
      this.zoneLabel.textContent = `${label} · ${Math.round(frac * 100)}%`;
      this.zoneFill.style.width = `${frac * 100}%`;
      this.zoneFill.style.background = color;
    } else {
      this.zoneEl.classList.add('hidden');
    }

    // tankpaneel
    const hp = Math.max(0, Math.ceil(p.hp));
    if (hp !== this.lastHp) {
      this.lastHp = hp;
      this.hpVal.textContent = `${hp} / ${cfg.tank.maxHp}`;
      this.hpFill.style.width = `${(hp / cfg.tank.maxHp) * 100}%`;
      this.hpBar.classList.toggle('low', hp / cfg.tank.maxHp < 0.3);
    }
    const reloadFrac = 1 - p.reload / cfg.tank.reloadTime;
    const ready = p.reload <= 0;
    this.reloadFill.style.width = `${reloadFrac * 100}%`;
    this.reloadBar.classList.toggle('ready', ready);
    const reloadStr = ready ? 'Geladen' : `${p.reload.toFixed(1).replace('.', ',')} s`;
    if (reloadStr !== this.lastReload) {
      this.lastReload = reloadStr;
      this.reloadVal.textContent = reloadStr;
      this.reloadText.textContent = ready ? '' : reloadStr;
    }
    this.ring.setAttribute('stroke-dashoffset', `${RING * (1 - reloadFrac)}`);
    this.ring.setAttribute('stroke', ready ? '#9ff07a' : '#e0a642');
    this.ring.setAttribute('opacity', ready ? '0.55' : '1');
    const kmh = Math.round(Math.abs(p.speed) * 3.6);
    if (kmh !== this.lastSpeed) {
      this.lastSpeed = kmh;
      this.speedVal.textContent = kmh;
    }
    const rel = ((p.yaw - f.cameraYaw) * 180) / Math.PI;
    this.dgHull.setAttribute('transform', `rotate(${-rel})`);
    this.dgTurret.setAttribute('transform', `rotate(${-rel - (p.turretYaw * 180) / Math.PI})`);

    // loopindicator: waar de granaat nu echt zou inslaan
    const cam = f.camera;
    const showAim = p.alive && w.phase !== 'ended';
    this.crosshair.style.display = showAim ? '' : 'none';
    this.reloadText.style.display = showAim ? '' : 'none';
    if (showAim && f.gunImpact) {
      _p.copy(f.gunImpact).project(cam);
      if (_p.z < 1) {
        const x = ((_p.x + 1) / 2) * this.width;
        const y = ((1 - _p.y) / 2) * this.height;
        this.gunMarker.style.display = '';
        this.gunMarker.style.transform = `translate(${x}px, ${y}px)`;
        const off = Math.hypot(x - this.width / 2, y - this.height / 2);
        const color = off < 10 ? '#9ff07a' : '#ffffff';
        this.gunCircle.setAttribute('stroke', color);
        this.gunTicks.setAttribute('stroke', color);
      } else {
        this.gunMarker.style.display = 'none';
      }
    } else {
      this.gunMarker.style.display = 'none';
    }

    // markeringen boven tanks
    const spotted = w.spotted[p.team];
    for (const [id, m] of this.markers) {
      const t = w.tanks[id];
      const view = f.tankViews.view(id);
      const ally = t.team === p.team;
      let visible = t.alive && (ally || spotted.has(id));
      if (visible) {
        _p.copy(view.renderPos);
        _p.y += 4.3;
        const dist = cam.position.distanceTo(_p);
        _p.project(cam);
        visible = _p.z < 1 && Math.abs(_p.x) < 1.1 && Math.abs(_p.y) < 1.1 && dist < 700;
        if (visible) {
          const x = ((_p.x + 1) / 2) * this.width;
          const y = ((1 - _p.y) / 2) * this.height;
          const s = Math.max(0.7, Math.min(1, 60 / dist + 0.6));
          m.el.style.transform = `translate(${x}px, ${y}px) scale(${s}) translate(-50%, -100%)`;
          m.el.style.opacity = dist > 350 ? 0.7 : 1;
          if (ally) m.hp.style.width = `${(t.hp / cfg.tank.maxHp) * 100}%`;
          else {
            const txt = `${Math.round(dist)} m`;
            if (txt !== m.lastText) {
              m.lastText = txt;
              m.name.textContent = txt;
            }
          }
        }
      }
      if (visible !== m.visible) {
        m.visible = visible;
        m.el.style.display = visible ? '' : 'none';
      }
    }

    // schaderichting: boog rond het vizier, gedraaid naar de schutter (t.o.v. de kijkrichting)
    if (this.damageTimer > 0 && this.damageFrom && p.alive) {
      this.damageTimer -= dt;
      const bearing = Math.atan2(-(this.damageFrom.z - p.pos.z), this.damageFrom.x - p.pos.x);
      const rel = ((f.cameraYaw - bearing) * 180) / Math.PI;
      this.damageDir.style.opacity = Math.min(1, this.damageTimer / 0.6);
      this.damageDir.style.transform = `translate(-50%, -50%) rotate(${rel}deg)`;
    } else {
      this.damageDir.style.opacity = 0;
    }

    // aftellen / vernietigd
    if (w.phase === 'countdown') {
      this.countdownEl.classList.remove('hidden');
      this.countdownNum.textContent = Math.max(1, Math.ceil(w.countdown));
    } else {
      this.countdownEl.classList.add('hidden');
    }
    if (!p.alive && w.phase !== 'ended') {
      this.respawnEl.classList.remove('hidden');
      this.respawnBy.textContent = this.killerName ? `door ${this.killerName}` : '';
      this.respawnTimer.textContent = `Terug bij de basis over ${Math.max(0, p.respawnTimer).toFixed(1).replace('.', ',')} s`;
      this.deathVeil.style.opacity = 1;
    } else {
      this.respawnEl.classList.add('hidden');
      this.deathVeil.style.opacity = 0;
    }

    // scorebord
    if (f.scoreboard) {
      this.scoreTimer -= dt;
      if (this.scoreboardEl.classList.contains('hidden') || this.scoreTimer <= 0) {
        this.scoreTimer = 0.5;
        const rows = w.tanks.map((t) => ({
          name: t.id === this.playerId ? cfg.player.name : t.name,
          team: t.team,
          kills: t.kills,
          deaths: t.deaths,
          captures: t.captures,
          damage: t.damageDealt,
          isPlayer: t.id === this.playerId,
          alive: t.alive,
        }));
        this.scoreboardEl.innerHTML = scoreTable(rows, 0) + scoreTable(rows, 1);
        this.scoreboardEl.classList.remove('hidden');
      }
    } else {
      this.scoreboardEl.classList.add('hidden');
    }

    // minimap: hooguit 120 keer per seconde (goedkoop, en vloeiend genoeg op snelle schermen)
    this.minimapTimer -= dt;
    if (this.minimapTimer <= 1e-3) {
      this.minimapTimer = 1 / 120;
      this.minimap.draw(f.cameraYaw, f.fov);
    }
  }

  dispose() {
    clearTimeout(this.hitTextTimer);
    this.root.remove();
  }
}
