// Resultaatscherm na de match: overwinning/nederlaag, eindstand, persoonlijke score en scorebord.
import { CONFIG } from '../config.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function scoreTable(tanks, team) {
  const rows = tanks
    .filter((t) => t.team === team)
    .sort((a, b) => b.kills * 3 + b.captures * 2 - b.deaths - (a.kills * 3 + a.captures * 2 - a.deaths))
    .map(
      (t) => `<tr class="${t.isPlayer ? 'me' : ''} ${t.alive === false ? 'dead' : ''}">
        <td>${escapeHtml(t.name)}${t.isPlayer ? '' : ' <span style="color:var(--text-faint)">AI</span>'}</td>
        <td>${t.kills}</td><td>${t.deaths}</td><td>${t.captures}</td><td>${Math.round(t.damage)}</td></tr>`,
    )
    .join('');
  const color = team === 0 ? 'var(--blue)' : 'var(--red)';
  return `<div><h3 style="color:${color}">Team ${CONFIG.teams[team].name}</h3>
    <table><tr><th>Tank</th><th>Kills</th><th>Dood</th><th>Punten</th><th>Schade</th></tr>${rows}</table></div>`;
}

export class ResultsScreen {
  constructor(app) {
    this.app = app;
    this.onBack = null;
    this.el = document.createElement('div');
    this.el.className = 'screen results hidden';
    app.uiRoot.appendChild(this.el);
  }

  // summary: { winner, playerTeam, reason, tickets:[a,b], duration, player:{...}, tanks:[...] }
  show(s) {
    const outcome = s.winner === -1 ? 'draw' : s.winner === s.playerTeam ? 'win' : 'lose';
    const title = outcome === 'win' ? 'OVERWINNING' : outcome === 'lose' ? 'NEDERLAAG' : 'GELIJKSPEL';
    const reason =
      s.reason === 'time'
        ? 'De tijd is om'
        : outcome === 'win'
          ? 'De tickets van de vijand zijn op'
          : outcome === 'lose'
            ? 'De tickets van je team zijn op'
            : 'Beide teams zijn gelijk geëindigd';
    const mins = Math.floor(s.duration / 60);
    const secs = String(Math.floor(s.duration % 60)).padStart(2, '0');
    const p = s.player;
    this.el.className = `screen results ${outcome}`;
    this.el.innerHTML = `
      <div class="r-title">${title}</div>
      <div class="r-sub">${reason} · speelduur ${mins}:${secs}</div>
      <div class="r-score">
        <div class="team" style="color:var(--blue)"><div class="n">${Math.round(s.tickets[0])}</div><div class="l">Tickets ${CONFIG.teams[0].name}</div></div>
        <div class="vs">—</div>
        <div class="team" style="color:var(--red)"><div class="n">${Math.round(s.tickets[1])}</div><div class="l">Tickets ${CONFIG.teams[1].name}</div></div>
      </div>
      <div class="r-personal">
        <div><b>${p.kills}</b><span>Vernietigd</span></div>
        <div><b>${p.deaths}</b><span>Verloren</span></div>
        <div><b>${p.captures}</b><span>Punten veroverd</span></div>
        <div><b>${Math.round(p.damage)}</b><span>Schade</span></div>
        <div><b>${p.shots > 0 ? Math.round((p.hits / p.shots) * 100) : 0}%</b><span>Trefzekerheid</span></div>
      </div>
      <div class="r-tables">${scoreTable(s.tanks, 0)}${scoreTable(s.tanks, 1)}</div>
      <button class="menu-btn primary">Terug naar de hangaar</button>`;
    this.el.querySelector('button').addEventListener('click', () => {
      this.app.audio.uiClick();
      this.onBack?.();
    });
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }
}
