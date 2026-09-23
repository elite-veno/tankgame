// Lobby in War Thunder-stijl: 3D-hangar met de tank, tankstatistieken, modusselectie en "TEN STRIJDE".
import { CONFIG } from '../config.js';
import { HangarScene } from '../render/hangarScene.js';
import { saveSkin } from './profile.js';

const LOGO_SVG = `
<svg class="logo-mark" viewBox="0 0 34 34" aria-hidden="true">
  <path d="M17 2 L31 9 V21 C31 27 24 31 17 33 C10 31 3 27 3 21 V9 Z" fill="none" stroke="#e0a642" stroke-width="2"/>
  <path d="M9 21 h16 l-1.5 3.5 h-13 z M11.5 16.5 h9 l1.5 4.5 h-12 z M19.5 17.6 l7.5 -2.4 v1.6 l-7 2.2 z" fill="#e0a642"/>
  <path d="M17 6 l2 4 h-4 z" fill="#e0a642" opacity="0.7"/>
</svg>`;

const SPEAKER_ON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>`;
const SPEAKER_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>`;

function fmt(n, digits = 0) {
  return n.toLocaleString('nl-NL', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// klein voorbeeldvlakje van een skin in CSS (de tank in de hangaar toont het echte patroon)
function swatch(s) {
  const blob = (x, y, r, c) => `radial-gradient(circle at ${x}% ${y}%, ${c} 0 ${r}%, transparent ${r + 1}%)`;
  switch (s.pattern) {
    case 'effen':
      return s.base;
    case 'stippen':
      return [blob(30, 34, 4, s.base), blob(70, 64, 4, s.base), blob(62, 58, 3, s.base), blob(30, 34, 24, s.a), blob(72, 64, 22, s.b), blob(86, 18, 12, s.a), s.base].join(',');
    case 'winter':
      return [blob(28, 62, 16, s.a), blob(66, 30, 10, s.a), blob(74, 76, 7, s.b), s.base].join(',');
    case 'strepen':
      return `repeating-linear-gradient(115deg, ${s.base} 0 8px, ${s.a} 8px 13px, ${s.base} 13px 20px, ${s.b} 20px 24px)`;
    case 'splinter':
      return `linear-gradient(128deg, transparent 34%, ${s.a} 34% 55%, transparent 55%), linear-gradient(35deg, transparent 58%, ${s.b} 58% 76%, transparent 76%), linear-gradient(160deg, ${s.b} 0 18%, transparent 18%), ${s.base}`;
    case 'digitaal':
      return `conic-gradient(${s.a} 25%, transparent 0 50%, ${s.b} 0 75%, transparent 0) 0 0 / 14px 14px, conic-gradient(transparent 25%, ${s.a} 0 50%, transparent 0) 3px 5px / 9px 9px, ${s.base}`;
    default:
      return [blob(30, 34, 24, s.a), blob(72, 64, 22, s.b), blob(86, 18, 12, s.a), s.base].join(',');
  }
}

export class Lobby {
  constructor(app) {
    this.app = app;
    this.onStart = null;
    this.hangar = null;
    this.el = document.createElement('div');
    this.el.className = 'screen lobby hidden';
    this.el.innerHTML = this.template();
    app.uiRoot.appendChild(this.el);
    this.el.querySelector('.battle-btn').addEventListener('click', () => {
      this.app.audio.uiClick();
      this.onStart?.({ mode: 'singleplayer' });
    });
    this.muteBtn = this.el.querySelector('.mute');
    this.muteBtn.addEventListener('click', () => {
      this.app.audio.setMuted(!this.app.audio.muted);
      this.updateMute();
    });
    this.updateMute();
    for (const m of this.el.querySelectorAll('.mode:not(.disabled)')) {
      m.addEventListener('click', () => this.app.audio.uiClick());
    }
    for (const b of this.el.querySelectorAll('.skin')) {
      b.addEventListener('click', () => this.selectSkin(b.dataset.skin));
    }
    this.showSkin(this.app.profile.skin);
  }

  selectSkin(id) {
    if (id === this.app.profile.skin) return;
    this.app.audio.uiClick();
    saveSkin(this.app.profile, id);
    this.hangar?.tank.setSkin(id);
    this.showSkin(id);
  }

  showSkin(id) {
    const skin = CONFIG.skins.find((s) => s.id === id) || CONFIG.skins[0];
    for (const b of this.el.querySelectorAll('.skin')) {
      const on = b.dataset.skin === skin.id;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.el.querySelector('.skin-name').textContent = skin.name;
    this.el.querySelector('.skin-desc').textContent = skin.info;
  }

  template() {
    const t = CONFIG.tank;
    const m = CONFIG.match;
    const bar = (v) => `<div class="stat-bar"><i style="width:${Math.round(Math.max(0.04, Math.min(1, v)) * 100)}%"></i></div>`;
    const stat = (label, value, frac) =>
      `<div class="stat"><div class="stat-row"><span class="label">${label}</span><span class="value">${value}</span></div>${bar(frac)}</div>`;
    const speed = t.maxForwardSpeed * 3.6;
    return `
      <div class="topbar">
        <div class="logo">${LOGO_SVG}<div><div class="logo-text">${CONFIG.game.name}</div><div class="logo-sub">${CONFIG.game.subtitle}</div></div></div>
        <div class="topnav"><div class="active">Hangaar</div></div>
        <div class="spacer"></div>
        <div class="phase">${CONFIG.game.phase}</div>
        <button class="icon-btn mute" title="Geluid aan/uit"></button>
      </div>

      <div class="panel tank-card">
        <div class="panel-title">Geselecteerd voertuig</div>
        <div class="head">
          <div><div class="name">${t.name}</div><div class="role">${t.role} · ${t.nation}</div></div>
          <div class="rank">RANG IV</div>
        </div>
        <div class="stats">
          ${stat('Snelheid', `${fmt(speed)} km/h`, speed / 60)}
          ${stat('Achteruit', `${fmt(t.maxReverseSpeed * 3.6)} km/h`, (t.maxReverseSpeed * 3.6) / 30)}
          ${stat('Structuurpunten', `${fmt(t.maxHp)} HP`, t.maxHp / 1500)}
          ${stat('Schade per granaat', `${fmt(t.damage)}`, t.damage / 400)}
          ${stat('Herlaadtijd', `${fmt(t.reloadTime, 1)} s`, (10 - t.reloadTime) / 8)}
          ${stat('Torendraaisnelheid', `${fmt(t.turretTraverseSpeed)}°/s`, t.turretTraverseSpeed / 50)}
        </div>
        <div class="extra">
          <div>Kanon<b>7,5 cm KwK 42</b></div>
          <div>Mondingssnelheid<b>${fmt(t.muzzleVelocity)} m/s</b></div>
          <div>Loophoek<b>${t.gunMinElevation}° / +${t.gunMaxElevation}°</b></div>
          <div>Pantser voor / zij / achter<b>×${fmt(t.armorMultiplier.front, 2)} / ×${fmt(t.armorMultiplier.side, 1)} / ×${fmt(t.armorMultiplier.rear, 1)}</b></div>
        </div>
      </div>

      <div class="lobby-right">
      <div class="panel mode-panel">
        <div class="panel-title">Spelmodus</div>
        <div class="mode selected">
          <div class="radio"></div>
          <div><div class="m-title">Singleplayer</div><div class="m-sub">Jij + ${m.playersPerTeam - 1} AI tegen ${m.playersPerTeam} AI</div></div>
        </div>
        <div class="mode disabled" title="Komt in fase 2">
          <div class="radio"></div>
          <div><div class="m-title">Multiplayer</div><div class="m-sub">Online tegen andere spelers</div></div>
          <div class="badge">Binnenkort</div>
        </div>
        <div class="map-info">
          <b>Kaart:</b> Dennenwoud · ${CONFIG.map.size} × ${CONFIG.map.size} m<br />
          <b>Missie:</b> Verovering — punten A, B en C<br />
          <b>Tickets:</b> ${fmt(m.startTickets)} per team<br />
          <b>Winst:</b> het vijandelijke team op 0 tickets brengen
        </div>
      </div>

      <div class="panel skin-panel">
        <div class="panel-title">Camouflage</div>
        <div class="skin-grid">
          ${CONFIG.skins.map((s) => `<button class="skin" data-skin="${s.id}" title="${s.name}" aria-label="${s.name}" style="background:${swatch(s)}"></button>`).join('')}
        </div>
        <div class="skin-info"><div class="skin-name"></div><div class="skin-desc"></div></div>
      </div>
      </div>

      <div class="orbit-hint">Sleep om te draaien · scroll om te zoomen</div>

      <div class="battle-wrap">
        <div class="battle-glow"></div>
        <button class="battle-btn">TEN STRIJDE</button>
        <div class="battle-sub">Verovering · Dennenwoud · ${m.playersPerTeam} tegen ${m.playersPerTeam}</div>
      </div>

      <div class="controls-hint">
        <span><kbd>W</kbd><kbd>S</kbd>vooruit / achteruit</span>
        <span><kbd>A</kbd><kbd>D</kbd>romp draaien</span>
        <span><kbd>Muis</kbd>toren richten</span>
        <span><kbd>LMB</kbd>vuren</span>
        <span><kbd>RMB</kbd>zoom</span>
        <span><kbd>Tab</kbd>scorebord</span>
        <span><kbd>Esc</kbd>menu</span>
      </div>`;
  }

  updateMute() {
    this.muteBtn.innerHTML = this.app.audio.muted ? SPEAKER_OFF : SPEAKER_ON;
  }

  ensureHangar() {
    if (!this.hangar) this.hangar = new HangarScene(this.app.renderer, this.app.tankFactory, this.app.profile.skin);
  }

  show() {
    this.ensureHangar();
    this.el.classList.remove('hidden');
    this.hangar.setActive(true);
    this.hangar.resize(window.innerWidth, window.innerHeight);
    this.updateMute();
  }

  hide() {
    this.el.classList.add('hidden');
    if (this.hangar) this.hangar.setActive(false);
  }

  resize(w, h) {
    this.hangar?.resize(w, h);
  }

  update(dt) {
    this.hangar.update(dt);
  }

  render() {
    this.hangar.render();
  }
}
