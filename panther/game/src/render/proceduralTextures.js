// Procedurele textures (canvas) voor de hangar en de effecten, zodat er geen extra bestanden nodig zijn.
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, NoColorSpace } from 'three';
import { RNG } from '../core/rng.js';

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(c, { repeat = false, srgb = true } = {}) {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Betonvloer met vlekken, naden en scheurtjes. Geeft { map, roughnessMap }.
export function concreteTextures(size = 1024, seed = 4) {
  const rng = new RNG(seed);
  const c = canvas(size);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#5b5b58';
  g.fillRect(0, 0, size, size);
  // korrel
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng.next() - 0.5) * 22;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n * 0.9;
  }
  g.putImageData(img, 0, 0);
  // wolkige vlekken
  for (let i = 0; i < 140; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(20, 160);
    const dark = rng.chance(0.6);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, dark ? `rgba(20,18,15,${rng.range(0.05, 0.2)})` : `rgba(140,138,130,${rng.range(0.04, 0.12)})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // olievlekken
  for (let i = 0; i < 10; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(15, 60);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(12,10,8,0.55)');
    grad.addColorStop(0.7, 'rgba(12,10,8,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(x, y, r, r * rng.range(0.5, 1), rng.range(0, 3), 0, Math.PI * 2);
    g.fill();
  }
  // scheurtjes
  g.strokeStyle = 'rgba(25,24,22,0.55)';
  for (let i = 0; i < 18; i++) {
    let x = rng.range(0, size);
    let y = rng.range(0, size);
    let a = rng.range(0, Math.PI * 2);
    g.lineWidth = rng.range(0.6, 1.6);
    g.beginPath();
    g.moveTo(x, y);
    const n = rng.int(8, 30);
    for (let k = 0; k < n; k++) {
      a += rng.range(-0.6, 0.6);
      x += Math.cos(a) * rng.range(4, 12);
      y += Math.sin(a) * rng.range(4, 12);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // dilatatievoegen
  g.strokeStyle = 'rgba(18,18,16,0.8)';
  g.lineWidth = 3;
  for (const p of [0, size / 2]) {
    g.beginPath();
    g.moveTo(p + 1, 0);
    g.lineTo(p + 1, size);
    g.moveTo(0, p + 1);
    g.lineTo(size, p + 1);
    g.stroke();
  }
  // ruwheid: donkere (olie)plekken zijn gladder
  const rc = canvas(size);
  const rg = rc.getContext('2d');
  const src = g.getImageData(0, 0, size, size);
  const out = rg.createImageData(size, size);
  for (let i = 0; i < src.data.length; i += 4) {
    const l = (src.data[i] + src.data[i + 1] + src.data[i + 2]) / 3;
    const r = Math.max(70, Math.min(250, 90 + l * 1.3));
    out.data[i] = out.data[i + 1] = out.data[i + 2] = r;
    out.data[i + 3] = 255;
  }
  rg.putImageData(out, 0, 0);
  return { map: toTexture(c, { repeat: true }), roughnessMap: toTexture(rc, { repeat: true, srgb: false }) };
}

// Golfplaat met roestvegen. Geeft { map, bumpMap }.
export function corrugatedTextures(size = 512, seed = 9) {
  const rng = new RNG(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  const bc = canvas(size);
  const bg = bc.getContext('2d');
  const waves = 16;
  for (let x = 0; x < size; x++) {
    const s = Math.sin((x / size) * waves * Math.PI * 2);
    const shade = 58 + s * 14;
    g.fillStyle = `rgb(${shade * 0.78},${shade * 0.84},${shade * 0.74})`;
    g.fillRect(x, 0, 1, size);
    const b = 128 + s * 120;
    bg.fillStyle = `rgb(${b},${b},${b})`;
    bg.fillRect(x, 0, 1, size);
  }
  // roest- en vuilstrepen
  for (let i = 0; i < 40; i++) {
    const x = rng.range(0, size);
    const w = rng.range(2, 9);
    const y0 = rng.range(0, size * 0.6);
    const len = rng.range(40, size);
    const grad = g.createLinearGradient(0, y0, 0, y0 + len);
    const rust = rng.chance(0.55);
    grad.addColorStop(0, rust ? 'rgba(110,55,25,0.45)' : 'rgba(15,15,12,0.4)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x, y0, w, len);
  }
  const grad = g.createLinearGradient(0, size * 0.7, 0, size);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(20,16,10,0.55)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return { map: toTexture(c, { repeat: true }), bumpMap: toTexture(bc, { repeat: true, srgb: false }) };
}

// Houten planken (kisten).
export function woodTexture(size = 256, seed = 3) {
  const rng = new RNG(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  const planks = 4;
  const ph = size / planks;
  for (let p = 0; p < planks; p++) {
    const base = rng.range(70, 100);
    g.fillStyle = `rgb(${base},${base * 0.78},${base * 0.5})`;
    g.fillRect(0, p * ph, size, ph);
    for (let i = 0; i < 40; i++) {
      const y = p * ph + rng.range(0, ph);
      g.strokeStyle = `rgba(40,25,10,${rng.range(0.08, 0.25)})`;
      g.lineWidth = rng.range(0.5, 2);
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(size * 0.3, y + rng.range(-4, 4), size * 0.6, y + rng.range(-4, 4), size, y + rng.range(-3, 3));
      g.stroke();
    }
    g.fillStyle = 'rgba(20,12,5,0.7)';
    g.fillRect(0, p * ph, size, 2);
  }
  // stencil-achtige markering
  g.fillStyle = 'rgba(230,220,190,0.55)';
  g.font = `bold ${size * 0.13}px sans-serif`;
  g.textAlign = 'center';
  g.fillText('7,5 cm PZGR', size / 2, size * 0.55);
  return toTexture(c);
}

// Zachte ronde vlek (stof, vonken, gloed).
export function softDotTexture(size = 64) {
  const c = canvas(size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return toTexture(c, { srgb: false });
}

// Rookwolk-atlas: 4 varianten naast elkaar (alfa = dichtheid, kleur wit).
export function smokeAtlasTexture(tile = 128, seed = 21) {
  const rng = new RNG(seed);
  const c = canvas(tile * 4, tile);
  const g = c.getContext('2d');
  for (let v = 0; v < 4; v++) {
    const ox = v * tile;
    for (let i = 0; i < 26; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, tile * 0.24);
      const x = ox + tile / 2 + Math.cos(a) * d;
      const y = tile / 2 + Math.sin(a) * d;
      const r = rng.range(tile * 0.12, tile * 0.28);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(255,255,255,${rng.range(0.25, 0.45)})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  return toTexture(c, { srgb: false });
}

// Vuurbal/flits-atlas: 4 varianten.
export function fireAtlasTexture(tile = 128, seed = 5) {
  const rng = new RNG(seed);
  const c = canvas(tile * 4, tile);
  const g = c.getContext('2d');
  for (let v = 0; v < 4; v++) {
    const ox = v * tile;
    // zwakke gloed als basis, daarboven onregelmatige hete kernen: leest als vlam in plaats van schijf
    const grad = g.createRadialGradient(ox + tile / 2, tile / 2, 0, ox + tile / 2, tile / 2, tile / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(ox, 0, tile, tile);
    for (let i = 0; i < 22; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.pow(rng.next(), 0.7) * tile * 0.34;
      const x = ox + tile / 2 + Math.cos(a) * d;
      const y = tile / 2 + Math.sin(a) * d;
      const r = rng.range(tile * 0.05, tile * 0.16) * (1 - d / (tile * 0.5));
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,255,255,${rng.range(0.45, 0.9)})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  return toTexture(c, { srgb: false });
}

// Brandplek op de grond.
export function scorchTexture(size = 128, seed = 12) {
  const rng = new RNG(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(8,6,4,0.95)');
  grad.addColorStop(0.5, 'rgba(15,11,8,0.7)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 30; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(size * 0.2, size * 0.45);
    g.fillStyle = `rgba(10,8,6,${rng.range(0.2, 0.5)})`;
    g.beginPath();
    g.arc(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, rng.range(1, 5), 0, Math.PI * 2);
    g.fill();
  }
  return toTexture(c);
}

// Letterbadge boven een veroveringspunt.
export function drawPointBadge(ctx, size, letter, fill, ring, progress, progressColor) {
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(12,14,12,0.72)';
  ctx.fill();
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = ring;
  ctx.stroke();
  if (progress > 0.001) {
    ctx.beginPath();
    ctx.arc(c, c, size * 0.46, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.lineWidth = size * 0.07;
    ctx.strokeStyle = progressColor;
    ctx.stroke();
  }
  ctx.fillStyle = fill;
  ctx.font = `700 ${size * 0.46}px Oswald, 'Barlow Condensed', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, c, c + size * 0.02);
}

export function makeCanvas(w, h) {
  return canvas(w, h);
}
