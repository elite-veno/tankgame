// Minimap: vooraf getekende kaart (reliëf, bos, paden) met daarop punten, eigen tank, teamgenoten,
// gespotte vijanden en de kijkrichting van de camera.

const _display = { side: -1, frac: 0, draining: false };

export class Minimap {
  constructor(canvas, world, config, playerId, cssSize = 230) {
    this.canvas = canvas;
    this.world = world;
    this.config = config;
    this.playerId = playerId;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.px = Math.round(cssSize * dpr);
    this.dpr = this.px / cssSize;
    canvas.width = this.px;
    canvas.height = this.px;
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    this.ctx = canvas.getContext('2d');
    this.scale = this.px / world.map.size;
    this.bg = this.renderBackground();
    this.teamColors = config.teams.map((t) => t.color);
  }

  toCanvas(x, z) {
    const h = this.world.map.half;
    return [(x + h) * this.scale, (z + h) * this.scale];
  }

  renderBackground() {
    const map = this.world.map;
    const N = this.px;
    const c = document.createElement('canvas');
    c.width = N;
    c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    const hf = map.heightfield;
    const surf = map.surface;
    const n = { x: 0, y: 0, z: 0 };
    const L = { x: -0.5, y: 0.75, z: -0.43 };
    for (let j = 0; j < N; j++) {
      const z = -map.half + ((j + 0.5) / N) * map.size;
      for (let i = 0; i < N; i++) {
        const x = -map.half + ((i + 0.5) / N) * map.size;
        const si = Math.min(surf.res - 1, Math.floor((x / surf.size + 0.5) * surf.res));
        const sj = Math.min(surf.res - 1, Math.floor((z / surf.size + 0.5) * surf.res));
        const k = (sj * surf.res + si) * 4;
        const road = surf.data[k] / 255;
        const meadow = surf.data[k + 1] / 255;
        const shade = surf.data[k + 3] / 255;
        // bos -> open plek -> pad
        let r = 52 - shade * 18, gg = 66 - shade * 16, b = 40 - shade * 12;
        r += (104 - r) * meadow;
        gg += (112 - gg) * meadow;
        b += (68 - b) * meadow;
        r += (150 - r) * road;
        gg += (132 - gg) * road;
        b += (98 - b) * road;
        hf.normalAt(x, z, n, 3);
        const lit = Math.max(0.55, Math.min(1.35, 0.72 + (n.x * L.x + n.y * L.y + n.z * L.z) * 0.9 - 0.35));
        const o = (j * N + i) * 4;
        img.data[o] = r * lit;
        img.data[o + 1] = gg * lit;
        img.data[o + 2] = b * lit;
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // raster van 100 m
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 1;
    for (let m = 100; m < map.size; m += 100) {
      const p = m * this.scale;
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, N);
      g.moveTo(0, p);
      g.lineTo(N, p);
      g.stroke();
    }
    // teambases
    for (const base of map.bases) {
      const [bx, bz] = this.toCanvas(base.x, base.z);
      const col = this.config.teams[base.team].color;
      g.fillStyle = col + '30';
      g.strokeStyle = col + 'aa';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(bx, bz, this.config.map.baseClearingRadius * 0.6 * this.scale, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    return c;
  }

  arrow(x, y, angle, size, fill, stroke) {
    const g = this.ctx;
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.beginPath();
    g.moveTo(size, 0);
    g.lineTo(-size * 0.7, size * 0.62);
    g.lineTo(-size * 0.35, 0);
    g.lineTo(-size * 0.7, -size * 0.62);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = Math.max(1, size * 0.18);
    g.strokeStyle = stroke;
    g.stroke();
    g.restore();
  }

  draw(cameraYaw, fov) {
    const g = this.ctx;
    const w = this.world;
    const dpr = this.dpr;
    g.drawImage(this.bg, 0, 0);
    // veroveringspunten
    for (const p of w.points) {
      const [x, y] = this.toCanvas(p.x, p.z);
      const r = Math.max(9 * dpr, p.radius * this.scale);
      const own = p.owner >= 0 ? this.teamColors[p.owner] : this.config.neutralColor;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = own + '55';
      g.fill();
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = p.contested ? '#ffffff' : own;
      g.stroke();
      const d = p.display(_display);
      if (d.side >= 0 && d.frac > 0) {
        g.beginPath();
        g.arc(x, y, r + 2.5 * dpr, -Math.PI / 2, -Math.PI / 2 + d.frac * Math.PI * 2);
        g.lineWidth = 2.5 * dpr;
        g.strokeStyle = this.teamColors[d.side];
        g.stroke();
      }
      g.fillStyle = '#f2ecd8';
      g.font = `600 ${12 * dpr}px Oswald, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(p.id, x, y + 0.5 * dpr);
    }
    // wrakken
    g.strokeStyle = 'rgba(20,20,20,0.8)';
    g.lineWidth = 1.5 * dpr;
    for (const wr of w.wrecks) {
      const [x, y] = this.toCanvas(wr.pos.x, wr.pos.z);
      const s = 3 * dpr;
      g.beginPath();
      g.moveTo(x - s, y - s);
      g.lineTo(x + s, y + s);
      g.moveTo(x + s, y - s);
      g.lineTo(x - s, y + s);
      g.stroke();
    }
    const player = w.tanks[this.playerId];
    const spotted = w.spotted[player.team];
    for (const t of w.tanks) {
      if (t === player || !t.alive) continue;
      if (t.team !== player.team && !spotted.has(t.id)) continue;
      const [x, y] = this.toCanvas(t.pos.x, t.pos.z);
      this.arrow(x, y, -t.yaw, 6 * dpr, this.teamColors[t.team], 'rgba(0,0,0,0.7)');
    }
    // kijkrichting en eigen tank
    const [px, py] = this.toCanvas(player.pos.x, player.pos.z);
    const half = ((fov * Math.PI) / 180) * 0.75;
    const grad = g.createRadialGradient(px, py, 0, px, py, 60 * dpr);
    grad.addColorStop(0, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(px, py);
    g.arc(px, py, 60 * dpr, -cameraYaw - half, -cameraYaw + half);
    g.closePath();
    g.fill();
    if (player.alive) this.arrow(px, py, -player.yaw, 8 * dpr, '#ffe28a', 'rgba(0,0,0,0.85)');
    else {
      g.fillStyle = '#ffe28a';
      g.beginPath();
      g.arc(px, py, 3 * dpr, 0, Math.PI * 2);
      g.fill();
    }
    // rand
    g.strokeStyle = 'rgba(214,190,128,0.35)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, this.px - 2, this.px - 2);
  }
}
