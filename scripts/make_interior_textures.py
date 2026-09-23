"""Generates the image textures used by the T-34-85 interior.

Run headless:  blender -b --python scripts/make_interior_textures.py
Writes into  <repo>/textures/ :
  interior_paint_basecolor.png   1024^2 tileable ivory interior paint with grime
  interior_floor_basecolor.png   1024^2 tileable scuffed floor / lower-wall paint
  interior_instruments.png       2048x1024 atlas: 6 gauge faces, radio dial, data plate
Atlas cells are 512x512, row-major from the top-left (see ATLAS_CELLS in build_interior.py).
"""
import bpy, os, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "textures")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(1944)


# ------------------------------------------------------------ tileable noise helpers
def fbm(n, beta, seed_scale=1.0):
    """Periodic 1/f^beta noise via FFT (tiles seamlessly), normalised to 0..1."""
    white = rng.standard_normal((n, n)) * seed_scale
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f, f)
    r = np.sqrt(fx * fx + fy * fy)
    r[0, 0] = 1.0
    spec = np.fft.fft2(white) / r ** beta
    spec[0, 0] = 0
    img = np.real(np.fft.ifft2(spec))
    img -= img.min()
    return img / img.max()


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def scratches(n, count, length, width_px, seed):
    """Thin periodic scratch mask (wraps around edges)."""
    r = np.random.default_rng(seed)
    m = np.zeros((n, n))
    for _ in range(count):
        x, y = r.uniform(0, n, 2)
        ang = r.uniform(0, math.pi)
        L = r.uniform(0.3, 1.0) * length
        steps = int(L)
        xs = (x + np.cos(ang) * np.arange(steps)) % n
        ys = (y + np.sin(ang) * np.arange(steps)) % n
        for w in range(width_px):
            m[(ys.astype(int) + w) % n, xs.astype(int)] = r.uniform(0.5, 1.0)
    return m


def save_rgb(name, rgb):
    h, w, _ = rgb.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    px = np.ones((h, w, 4), dtype=np.float32)
    px[:, :, :3] = np.clip(rgb, 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = os.path.join(OUT, name)
    img.file_format = "PNG"
    img.save()
    print("wrote", img.filepath_raw)


def paint_textures():
    n = 1024
    base = np.array([0.80, 0.775, 0.69])  # sRGB ivory ("white" Soviet interior enamel)
    mott = fbm(n, 1.1)
    grime = fbm(n, 1.6)
    fine = fbm(n, 0.6)
    scr = scratches(n, 90, 160, 1, 7)
    col = base[None, None, :] * (0.93 + 0.1 * mott[..., None])
    dirt = smooth(grime, 0.55, 0.9)[..., None] * 0.28
    col = col * (1 - dirt) + np.array([0.36, 0.31, 0.22]) * dirt
    col *= (0.97 + 0.05 * fine[..., None])
    col = col * (1 - 0.35 * scr[..., None]) + np.array([0.42, 0.40, 0.37]) * 0.35 * scr[..., None]
    save_rgb("interior_paint_basecolor.png", col)

    # floor: same enamel but scuffed through to dark primer / bare steel, boot dirt
    wear = smooth(fbm(n, 1.3), 0.62, 0.9)
    mud = smooth(fbm(n, 1.8), 0.6, 0.95)
    scr2 = scratches(n, 220, 200, 1, 11)
    col = base[None, None, :] * 0.82 * (0.92 + 0.12 * mott[..., None])
    col = col * (1 - wear[..., None] * 0.65) + np.array([0.20, 0.19, 0.17]) * wear[..., None] * 0.65
    col = col * (1 - mud[..., None] * 0.55) + np.array([0.26, 0.20, 0.13]) * mud[..., None] * 0.55
    col = col * (1 - 0.5 * scr2[..., None]) + np.array([0.46, 0.45, 0.43]) * 0.5 * scr2[..., None]
    save_rgb("interior_floor_basecolor.png", col)


# ------------------------------------------------------------ instrument atlas (rendered)
FACE = (0.018, 0.018, 0.016, 1)
INK = (0.86, 0.83, 0.72, 1)
RED = (0.60, 0.07, 0.04, 1)

GAUGES = [
    # cell, label, unit, lo, hi, major step, minor per major, red zone start (or None)
    (0, "СПИДОМЕТР", "КМ/ЧАС", 0, 60, 10, 5, None),
    (1, "ТАХОМЕТР", "ОБ/МИН ×100", 0, 25, 5, 5, 20),
    (2, "МАСЛО", "КГ/СМ²", 0, 15, 5, 5, None),
    (3, "МАСЛО", "°C", 0, 125, 25, 5, 100),
    (4, "ВОДА", "°C", 0, 125, 25, 5, 105),
    (5, "АМПЕРМЕТР", "А", -30, 30, 10, 2, None),
]
SWEEP = 270.0  # degrees, clockwise from lower-left; needle angle documented in build_interior.py


def emissive(name, rgba):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = rgba
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(e.outputs[0], o.inputs["Surface"])
    return m


def add_mesh(name, verts, faces, mat, z=0.0):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x, y, z) for x, y in verts], [], faces)
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def disc(name, cx, cy, r, mat, z=0.0, seg=96):
    v = [(cx, cy)] + [(cx + r * math.cos(2 * math.pi * i / seg), cy + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
    f = [(0, 1 + i, 1 + (i + 1) % seg) for i in range(seg)]
    return add_mesh(name, v, f, mat, z)


def ring(name, cx, cy, r0, r1, a0, a1, mat, z=0.0, seg=64):
    v, f = [], []
    for i in range(seg + 1):
        a = a0 + (a1 - a0) * i / seg
        v += [(cx + r0 * math.cos(a), cy + r0 * math.sin(a)), (cx + r1 * math.cos(a), cy + r1 * math.sin(a))]
        if i:
            k = 2 * i
            f.append((k - 2, k - 1, k + 1, k))
    return add_mesh(name, v, f, mat, z)


def quad(name, cx, cy, w, h, ang, mat, z=0.0):
    c, s = math.cos(ang), math.sin(ang)
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    v = [(cx + x * c - y * s, cy + x * s + y * c) for x, y in pts]
    return add_mesh(name, v, [(0, 1, 2, 3)], mat, z)


def text(body, x, y, size, mat, z=0.01, align="CENTER", rot=0.0):
    cu = bpy.data.curves.new("t", "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = align
    cu.align_y = "CENTER"
    ob = bpy.data.objects.new("t", cu)
    ob.location = (x, y, z)
    ob.rotation_euler[2] = rot
    cu.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def cell_origin(cell):
    col, row = cell % 4, cell // 4
    return 0.25 + 0.5 * col, 0.75 - 0.5 * row  # atlas spans x 0..2, y 0..1


def gauge_angle(t):
    """t in 0..1 -> math angle (rad, CCW from +x). 0 at lower-left (225 deg), sweeping clockwise."""
    return math.radians(225.0 - SWEEP * t)


def build_atlas():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    face = emissive("face", FACE)
    ink = emissive("ink", INK)
    red = emissive("red", RED)
    bg = emissive("bg", (0.05, 0.05, 0.045, 1))
    add_mesh("bg", [(0, 0), (2, 0), (2, 1), (0, 1)], [(0, 1, 2, 3)], bg, -0.01)

    for cell, label, unit, lo, hi, step, minor, redz in GAUGES:
        cx, cy = cell_origin(cell)
        disc(f"face{cell}", cx, cy, 0.245, face)
        span = hi - lo
        nmaj = int(round(span / step))
        for i in range(nmaj * minor + 1):
            t = i / (nmaj * minor)
            a = gauge_angle(t)
            major = i % minor == 0
            L = 0.045 if major else 0.022
            w = 0.009 if major else 0.004
            r = 0.215 - L / 2
            quad(f"tk{cell}_{i}", cx + r * math.cos(a), cy + r * math.sin(a), L, w, a, ink, 0.005)
            if major:
                val = lo + step * (i // minor)
                rr = 0.145
                text(str(val), cx + rr * math.cos(a), cy + rr * math.sin(a), 0.042, ink)
        if redz is not None:
            t0 = (redz - lo) / span
            ring(f"red{cell}", cx, cy, 0.222, 0.238, gauge_angle(1.0), gauge_angle(t0), red, 0.004)
        text(label, cx, cy + 0.075, 0.026 if len(label) > 8 else 0.03, ink)
        text(unit, cx, cy - 0.065, 0.026, ink)
        disc(f"hub{cell}", cx, cy, 0.018, ink, 0.006)

    # cell 6: 9-RS radio frequency dial (linear scale, 3.75 - 5.0 MHz)
    cx, cy = cell_origin(6)
    quad("dial", cx, cy, 0.46, 0.30, 0, face)
    for i in range(26):
        x = cx - 0.2 + 0.4 * i / 25
        major = i % 5 == 0
        quad(f"dt{i}", x, cy + 0.03 + (0.02 if major else 0.01), 0.004, 0.05 if major else 0.025, 0, ink, 0.005)
        if major:
            text(f"{3.75 + 1.25 * i / 25:.2f}", x, cy - 0.03, 0.026, ink)
    text("9-РС   ПРИЁМНИК", cx, cy + 0.115, 0.03, ink)
    text("МГЦ", cx, cy - 0.09, 0.028, ink)

    # cell 7: factory data plate (brass, engraved)
    cx, cy = cell_origin(7)
    brass = emissive("brass", (0.52, 0.38, 0.16, 1))
    etch = emissive("etch", (0.06, 0.045, 0.02, 1))
    quad("plate", cx, cy, 0.46, 0.30, 0, brass)
    for dx in (-0.2, 0.2):
        for dy in (-0.12, 0.12):
            disc("rivet", cx + dx, cy + dy, 0.012, etch, 0.004, 24)
    text("Т-34-85", cx, cy + 0.075, 0.06, etch)
    text("ЗАВОД № 183", cx, cy + 0.005, 0.034, etch)
    text("№ 4-1827   1944 г.", cx, cy - 0.05, 0.03, etch)
    text("ОТК", cx, cy - 0.1, 0.028, etch)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2.0
    cam.location = (1.0, 0.5, 5)
    sc.camera = cam
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 16
    sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = 2048, 1024
    sc.view_settings.view_transform = "Standard"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.filepath = os.path.join(OUT, "interior_instruments.png")
    bpy.ops.render.render(write_still=True)
    print("wrote", sc.render.filepath)


paint_textures()
build_atlas()
