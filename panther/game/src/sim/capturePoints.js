// Veroveringspunten (Domination) en het ticketsysteem.
// progress loopt van -1 (volledig Rood) via 0 (neutraal) tot +1 (volledig Blauw).
import { approach, clamp } from '../core/mathUtils.js';

export class CapturePoint {
  constructor(def) {
    this.id = def.id;
    this.index = def.index;
    this.x = def.x;
    this.z = def.z;
    this.y = def.y;
    this.radius = def.radius;
    this.owner = -1; // -1 neutraal, 0 Blauw, 1 Rood
    this.progress = 0;
    this.counts = [0, 0];
    this.contested = false;
    this.capturingTeam = -1; // team dat nu de voortgang verschuift
  }

  // voortgang van team `team` naar eigendom, 0..1 (voor HUD-balken)
  progressFor(team) {
    return team === 0 ? Math.max(0, this.progress) : Math.max(0, -this.progress);
  }

  // Wat de weergave toont: welk team de voortgang nu verschuift (side, -1 = niets aan de hand) en hoe
  // ver die actie is (frac 0..1). Neutraliseren van een punt van de tegenstander telt ook op van 0 tot 1.
  // draining = de eigenaar raakt het punt kwijt.
  display(out) {
    const cap = this.capturingTeam;
    out.side = -1;
    out.frac = 0;
    out.draining = false;
    if (cap >= 0) {
      const other = this.progressFor(1 - cap);
      if (other > 0) {
        out.side = cap;
        out.frac = 1 - other;
        out.draining = this.owner === 1 - cap;
      } else if (!(this.owner === cap && this.progressFor(cap) >= 0.999)) {
        out.side = cap;
        out.frac = this.progressFor(cap);
      }
    } else if (Math.abs(this.progress) > 0.001 && !(this.owner >= 0 && Math.abs(this.progress) >= 0.999)) {
      // leeg punt zakt terug, of betwist: de stand blijft staan
      out.side = this.progress > 0 ? 0 : 1;
      out.frac = Math.abs(this.progress);
    }
    return out;
  }
}

export function updateCapturePoints(world, dt) {
  const cc = world.config.capture;
  for (const tank of world.tanks) tank.onPoint = null;
  for (const p of world.points) {
    p.counts[0] = 0;
    p.counts[1] = 0;
    const r2 = p.radius * p.radius;
    for (const tank of world.tanks) {
      if (!tank.alive) continue;
      const dx = tank.pos.x - p.x;
      const dz = tank.pos.z - p.z;
      if (dx * dx + dz * dz <= r2) {
        p.counts[tank.team]++;
        tank.onPoint = p.id;
      }
    }
    p.contested = p.counts[0] > 0 && p.counts[1] > 0;
    if (p.contested) {
      p.capturingTeam = -1; // geblokkeerd: beide teams aanwezig
      continue;
    }
    const present = p.counts[0] > 0 ? 0 : p.counts[1] > 0 ? 1 : -1;
    if (present === -1) {
      // leeg punt zakt terug naar de toestand van de eigenaar
      const target = p.owner === 0 ? 1 : p.owner === 1 ? -1 : 0;
      p.progress = approach(p.progress, target, cc.decayRate * dt);
      p.capturingTeam = -1;
      continue;
    }
    const dir = present === 0 ? 1 : -1;
    if (p.owner === present && p.progress * dir >= 1) {
      p.capturingTeam = -1;
      continue;
    }
    const n = p.counts[present];
    const mult = Math.min(cc.maxRateMultiplier, 1 + (n - 1) * cc.extraTankBonus);
    p.progress = clamp(p.progress + (dir * mult * dt) / cc.captureTime, -1, 1);
    p.capturingTeam = present;
    const other = 1 - present;
    if (p.owner === other && p.progress * dir >= 0) {
      p.owner = -1;
      world.emit({ type: 'pointNeutralized', pointId: p.id, team: present, lostBy: other });
    }
    if (p.progress * dir >= 1 && p.owner !== present) {
      p.owner = present;
      p.progress = dir;
      const capturers = [];
      for (const tank of world.tanks) {
        if (tank.alive && tank.team === present && tank.onPoint === p.id) {
          tank.captures++;
          capturers.push(tank.id);
        }
      }
      world.emit({ type: 'pointCaptured', pointId: p.id, team: present, capturers });
    }
  }
}

// Het team met minder punten verliest tickets over tijd (per punt verschil).
export function updateTickets(world, dt) {
  const held = [0, 0];
  for (const p of world.points) if (p.owner >= 0) held[p.owner]++;
  const diff = held[0] - held[1];
  const rate = world.config.match.ticketBleedPerPoint;
  if (diff > 0) world.teams[1].tickets -= diff * rate * dt;
  else if (diff < 0) world.teams[0].tickets -= -diff * rate * dt;
  for (const t of world.teams) t.tickets = Math.max(0, t.tickets);
  world.teams[0].held = held[0];
  world.teams[1].held = held[1];
}
