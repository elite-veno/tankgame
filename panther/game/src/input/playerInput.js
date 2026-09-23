// Toetsenbord en muis van de speler -> commando voor de simulatie (zelfde formaat als de AI en later het netwerk).
// De camera krijgt de muisbeweging; de simulatie krijgt alleen gas, sturen, richtpunt en vuren.

export class PlayerInput {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
    this.fireQueued = false;
    this.zoom = false;
    this.scoreboard = false;
    this.enabled = true;
    this.onLockChange = null;
    this.onEscape = null;
    this.handlers = {
      keydown: (e) => {
        if (e.code === 'Tab') {
          e.preventDefault();
          this.scoreboard = true;
          return;
        }
        if (e.code === 'Escape') {
          this.onEscape?.();
          return;
        }
        this.keys.add(e.code);
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      },
      keyup: (e) => {
        if (e.code === 'Tab') {
          e.preventDefault();
          this.scoreboard = false;
          return;
        }
        this.keys.delete(e.code);
      },
      mousemove: (e) => {
        if (!this.locked) return;
        this.lookX += e.movementX;
        this.lookY += e.movementY;
      },
      mousedown: (e) => {
        if (!this.locked) return;
        if (e.button === 0) this.fireQueued = true;
        if (e.button === 2) this.zoom = true;
      },
      mouseup: (e) => {
        if (e.button === 2) this.zoom = false;
      },
      wheel: (e) => {
        if (!this.locked) return;
        this.wheel += e.deltaY;
      },
      contextmenu: (e) => e.preventDefault(),
      blur: () => {
        this.keys.clear();
        this.zoom = false;
        this.scoreboard = false;
      },
      lockchange: () => {
        if (!this.locked) {
          this.keys.clear();
          this.zoom = false;
        }
        this.onLockChange?.(this.locked);
      },
    };
    window.addEventListener('keydown', this.handlers.keydown);
    window.addEventListener('keyup', this.handlers.keyup);
    document.addEventListener('mousemove', this.handlers.mousemove);
    document.addEventListener('mousedown', this.handlers.mousedown);
    document.addEventListener('mouseup', this.handlers.mouseup);
    document.addEventListener('wheel', this.handlers.wheel, { passive: true });
    document.addEventListener('contextmenu', this.handlers.contextmenu);
    window.addEventListener('blur', this.handlers.blur);
    document.addEventListener('pointerlockchange', this.handlers.lockchange);
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  requestLock() {
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch {
      // aanvraag geweigerd (bijv. te snel na het verlaten); de speler kan opnieuw klikken
    }
  }

  releaseLock() {
    if (this.locked) document.exitPointerLock();
  }

  axis(neg, pos) {
    let v = 0;
    for (const k of neg) if (this.keys.has(k)) v -= 1;
    for (const k of pos) if (this.keys.has(k)) v += 1;
    return Math.max(-1, Math.min(1, v));
  }

  // vult een simulatiecommando; aim = wereldpunt onder het vizier
  fillCommand(cmd, aim) {
    cmd.throttle = this.enabled ? this.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']) : 0;
    cmd.steer = this.enabled ? this.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']) : 0;
    if (aim) {
      cmd.hasAim = true;
      cmd.aimX = aim.x;
      cmd.aimY = aim.y;
      cmd.aimZ = aim.z;
    }
    cmd.fire = this.enabled && this.fireQueued;
    this.fireQueued = false;
  }

  consumeLook() {
    const r = { dx: this.lookX, dy: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return r;
  }

  consumeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  dispose() {
    window.removeEventListener('keydown', this.handlers.keydown);
    window.removeEventListener('keyup', this.handlers.keyup);
    document.removeEventListener('mousemove', this.handlers.mousemove);
    document.removeEventListener('mousedown', this.handlers.mousedown);
    document.removeEventListener('mouseup', this.handlers.mouseup);
    document.removeEventListener('wheel', this.handlers.wheel);
    document.removeEventListener('contextmenu', this.handlers.contextmenu);
    window.removeEventListener('blur', this.handlers.blur);
    document.removeEventListener('pointerlockchange', this.handlers.lockchange);
    this.releaseLock();
  }
}
