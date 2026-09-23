// Kleine wiskundige hulpfuncties zonder afhankelijkheden (bruikbaar op client en server).

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// hoek naar (-PI, PI]
export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

// beweeg `value` richting `target` met hoogstens `maxDelta`
export function approach(value, target, maxDelta) {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}

// zoals approach, maar voor hoeken via de kortste weg
export function approachAngle(value, target, maxDelta) {
  const diff = wrapAngle(target - value);
  if (Math.abs(diff) <= maxDelta) return target;
  return wrapAngle(value + Math.sign(diff) * maxDelta);
}

// framerate-onafhankelijk dempen: fractie die na dt overblijft bij snelheid `rate` (1/s)
export const dampFactor = (rate, dt) => 1 - Math.exp(-rate * dt);

// afstand van punt P tot lijnstuk AB in 2D; geeft ook t (0..1) terug
export function pointSegmentDistance2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return { dist: Math.hypot(px - cx, pz - cz), t };
}

// snijpunt lijnstuk (p0 -> p1, 2D) met cirkel; geeft kleinste t in [0,1] of -1
export function segmentCircle2D(x0, z0, x1, z1, cx, cz, r) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const fx = x0 - cx;
  const fz = z0 - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0; // start binnen de cirkel
  if (a < 1e-9) return -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = (-b - s) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

// ballistische elevatie (lage baan) om een doel op horizontale afstand d en hoogteverschil h te raken
export function ballisticElevation(d, h, v, g) {
  if (g <= 0 || d < 0.01) return Math.atan2(h, Math.max(d, 0.01));
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * d * d + 2 * h * v2);
  if (disc < 0) return Math.PI / 4; // buiten bereik: maximale dracht
  return Math.atan((v2 - Math.sqrt(disc)) / (g * d));
}
