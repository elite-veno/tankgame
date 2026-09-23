"""Photoreal forest scene + final render for the detailed Panther.

    python panther/scripts/fetch_forest_assets.py              (once: CC0 Poly Haven assets)
    blender -b panther/panther_ausf_g_detailed.blend --python panther/scripts/render_forest.py -- [options]

Options
    --preview            quick low-resolution test (960 x 540, 48 samples)
    --res WxH            output resolution (default 3840x2160)
    --samples N          max Cycles samples (default 1024, adaptive)
    --camera NAME        hero (default) | low | rear
    --out PATH           output image (default panther/renders/forest_<camera>.png)
    --no-render          only build and save panther/panther_forest_scene.blend

The detailed model file is not modified: the scene (tank weathering, ground, vegetation,
lighting, camera) is saved as panther/panther_forest_scene.blend.
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
ASSETS = os.path.join(ROOT, "forest_assets")
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


PREVIEW = "--preview" in argv
CAMERA = arg("--camera", "hero")
RES = tuple(int(v) for v in arg("--res", "960x540" if PREVIEW else "3840x2160").split("x"))
SAMPLES = int(arg("--samples", "48" if PREVIEW else "1024"))
OUT = arg("--out", os.path.join(ROOT, "renders", f"forest_{CAMERA}{'_preview' if PREVIEW else ''}.png"))
D = bpy.data
sc = bpy.context.scene
rng = random.Random(1944)

TRACK_Y = 1.31          # track centre lines (from the model)
RUT_X0 = -2.6           # ruts start behind the tank
SUN_AZ, SUN_EL = math.radians(62), math.radians(38)      # desired sun direction (world, from +X towards +Y)

CAMERAS = {   # location, look-at, focal length, f-stop
    "hero": ((10.2, 7.6, 1.35), (0.2, 0.15, 1.15), 42, 4.0),
    "low": ((7.4, 3.8, 0.55), (0.6, 0.0, 1.35), 30, 3.2),
    "rear": ((-10.5, 6.8, 1.6), (-0.4, 0.0, 1.2), 42, 4.0),
}


# ============================================================================= helpers
def smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def rut_centre(x):
    """Lateral offset of the path the tank drove in on (curves away into the forest)."""
    return 0.0 if x > RUT_X0 else 0.0045 * (x - RUT_X0) ** 2


def terrain(x, y):
    """Macro terrain height (m): flat around the tank, gentle rises and hollows further out."""
    r = math.hypot(x - 0.3, y)
    far = smooth(7.0, 22.0, r)
    h = 0.55 * noise.noise(Vector((x * 0.045, y * 0.045, 0.3))) + 0.18 * noise.noise(Vector((x * 0.16, y * 0.16, 1.7)))
    h += 0.04 * noise.noise(Vector((x * 0.9, y * 0.9, 4.1)))
    rise = 0.025 * max(0.0, -x - 6) + 0.02 * max(0.0, -y - 8)          # forest floor rises behind the tank
    return far * (h + rise) + (1 - far) * 0.04 * noise.noise(Vector((x * 0.9, y * 0.9, 4.1)))


def in_tank(x, y, pad=0.0):
    return -4.0 - pad < x < 6.2 + pad and -2.7 - pad < y < 2.7 + pad


def in_ruts(x, y, pad=0.0):
    if x > RUT_X0 + 0.5:
        return False
    c = rut_centre(x)
    return any(abs(y - (c + s * TRACK_Y)) < 0.45 + pad for s in (1, -1))


def in_view(x, y, cam, pad=1.5):
    """Inside the camera -> tank sight-line wedge (kept free of tall vegetation)."""
    cx, cy = cam[0], cam[1]
    tgt = Vector((0.4, 0.0))
    d = tgt - Vector((cx, cy))
    L = d.length
    d.normalize()
    p = Vector((x - cx, y - cy))
    t = p.dot(d)
    if t < -1.0 or t > L + 2.5:
        return False
    half = 1.0 + (5.2 + pad) * max(t, 0) / L          # widens to cover the whole tank
    return abs(p.x * d.y - p.y * d.x) < half


# ============================================================================= tank weathering
def insert_color_layer(mat, build):
    """Re-route the Base Color / Roughness of a Principled BSDF through `build`."""
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return
    def src(sock):
        if sock.is_linked:
            return sock.links[0].from_socket
        v = nt.nodes.new("ShaderNodeRGB" if sock.type == "RGBA" else "ShaderNodeValue")
        v.outputs[0].default_value = sock.default_value if sock.type != "RGBA" else sock.default_value[:]
        return v.outputs[0]
    col, rough = src(bsdf.inputs["Base Color"]), src(bsdf.inputs["Roughness"])
    c2, r2, n2 = build(nt, col, rough, bsdf)
    nt.links.new(c2, bsdf.inputs["Base Color"])
    nt.links.new(r2, bsdf.inputs["Roughness"])
    if n2 is not None:
        nt.links.new(n2, bsdf.inputs["Normal"])


def weather_build(strength=1.0, chips=True, mud_height=1.05, tone=1.0):
    def build(nt, col, rough, bsdf):
        N = nt.nodes.new
        L = nt.links.new
        geo = N("ShaderNodeNewGeometry")
        sep = N("ShaderNodeSeparateXYZ")
        L(geo.outputs["Position"], sep.inputs[0])
        tc = N("ShaderNodeTexCoord")

        def noise_(scale, detail=8.0, w=0.0, vec=None, rough_=0.6):
            n = N("ShaderNodeTexNoise")
            n.noise_dimensions = "4D"
            n.inputs["Scale"].default_value = scale
            n.inputs["Detail"].default_value = detail
            n.inputs["Roughness"].default_value = rough_
            n.inputs["W"].default_value = w
            L(vec if vec is not None else geo.outputs["Position"], n.inputs["Vector"])
            return n

        def mr(src, a, b, c=0.0, d=1.0):
            m = N("ShaderNodeMapRange")
            m.clamp = True
            m.inputs["From Min"].default_value, m.inputs["From Max"].default_value = a, b
            m.inputs["To Min"].default_value, m.inputs["To Max"].default_value = c, d
            L(src, m.inputs["Value"])
            return m.outputs["Result"]

        def math_(op, a, b):
            m = N("ShaderNodeMath")
            m.operation = op
            m.use_clamp = True
            for i, v in enumerate((a, b)):
                if isinstance(v, (int, float)):
                    m.inputs[i].default_value = v
                else:
                    L(v, m.inputs[i])
            return m.outputs[0]

        def mix(fac, a, b, blend="MIX"):
            m = N("ShaderNodeMix")
            m.data_type = "RGBA"
            m.blend_type = blend
            m.clamp_factor = True
            for sock, v in ((m.inputs["Factor"], fac), (m.inputs["A"], a), (m.inputs["B"], b)):
                if isinstance(v, tuple):
                    sock.default_value = (*v, 1) if len(v) == 3 else v
                elif isinstance(v, (int, float)):
                    sock.default_value = v
                else:
                    L(v, sock)
            return m.outputs["Result"]

        def fmix(fac, a, b):
            m = N("ShaderNodeMix")
            m.data_type = "FLOAT"
            m.clamp_factor = True
            for sock, v in ((m.inputs["Factor"], fac), (m.inputs["A"], a), (m.inputs["B"], b)):
                if isinstance(v, (int, float)):
                    sock.default_value = v
                else:
                    L(v, sock)
            return m.outputs["Result"]

        # --- rain / dust streaks on vertical faces (noise stretched along Z)
        if tone != 1.0:          # faded, sun-bleached field paint is darker and greyer than fresh RAL chips
            hsv = N("ShaderNodeHueSaturation")
            hsv.inputs["Saturation"].default_value = 0.85
            hsv.inputs["Value"].default_value = tone
            L(col, hsv.inputs["Color"])
            col = hsv.outputs["Color"]
        mp = N("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (9.0, 9.0, 0.6)
        L(geo.outputs["Position"], mp.inputs["Vector"])
        streak = mr(noise_(3.0, 4.0, 2.2, mp.outputs["Vector"]).outputs["Fac"], 0.52, 0.72, 0.0, 0.35 * strength)
        c = mix(streak, col, (0.30, 0.25, 0.19), "MULTIPLY")
        # --- dust on upward-facing surfaces
        nsep = N("ShaderNodeSeparateXYZ")
        L(geo.outputs["Normal"], nsep.inputs[0])
        up = mr(nsep.outputs["Z"], 0.45, 0.9)
        dn = noise_(1.6, 10.0, 5.5).outputs["Fac"]
        dust = math_("MULTIPLY", up, mr(dn, 0.40, 0.66, 0.05, 0.38 * strength))
        c = mix(dust, c, (0.24, 0.20, 0.145))
        # --- mud from the tracks: height gradient broken up by splatter noise
        hmask = mr(sep.outputs["Z"], mud_height, 0.25)
        spl = noise_(6.0, 12.0, 8.8, rough_=0.75).outputs["Fac"]
        mud = math_("MULTIPLY", hmask, mr(spl, 0.36, 0.50, 0.0, 1.0))
        mud = math_("MULTIPLY", mud, strength)
        mud_col = mix(mr(noise_(14.0, 6.0, 1.1).outputs["Fac"], 0.3, 0.7), (0.035, 0.027, 0.019), (0.11, 0.085, 0.06))
        c = mix(mud, c, mud_col)
        r = fmix(mud, rough, 0.93)
        r = fmix(math_("MULTIPLY", dust, 0.8), r, 0.9)
        nrm = None
        if chips:
            # --- chipped paint on edges (Cycles bevel normal vs. real normal) -> primer / bare steel
            bev = N("ShaderNodeBevel")
            bev.samples = 6
            bev.inputs["Radius"].default_value = 0.012
            dot = N("ShaderNodeVectorMath")
            dot.operation = "DOT_PRODUCT"
            L(bev.outputs["Normal"], dot.inputs[0])
            L(geo.outputs["Normal"], dot.inputs[1])
            edge = mr(dot.outputs["Value"], 0.985, 0.90)
            cn = noise_(28.0, 8.0, 3.3, rough_=0.8).outputs["Fac"]
            chip = math_("MULTIPLY", edge, mr(cn, 0.50, 0.58))
            chip = math_("MULTIPLY", chip, 1.0 - 0.8 * 0)          # full strength on edges
            c = mix(chip, c, mix(mr(cn, 0.58, 0.66), (0.20, 0.06, 0.035), (0.08, 0.075, 0.07)))
            r = fmix(chip, r, 0.5)
            # small dents / scratches in the bump
            bump = N("ShaderNodeBump")
            bump.inputs["Strength"].default_value = 0.12
            L(math_("ADD", math_("MULTIPLY", mud, 0.6), math_("MULTIPLY", noise_(90.0, 4.0, 0.7).outputs["Fac"], 0.25)),
              bump.inputs["Height"])
            if bsdf.inputs["Normal"].is_linked:
                L(bsdf.inputs["Normal"].links[0].from_socket, bump.inputs["Normal"])
            nrm = bump.outputs["Normal"]
        return c, r, nrm
    return build


def weather_tank():
    for m in D.materials:
        if not m.name.startswith("PZ_") or m.node_tree is None:
            continue
        if m.name.startswith(("PZ_paint", )):
            insert_color_layer(m, weather_build(1.0, chips=True, tone=0.8))
        elif m.name in ("PZ_track_steel", "PZ_rubber", "PZ_dark_steel", "PZ_wire_rope"):
            insert_color_layer(m, weather_build(1.3, chips=m.name == "PZ_track_steel", mud_height=1.3))


# ============================================================================= world / light / haze
def hdri_sun(img):
    """Direction of the brightest region of the equirectangular HDRI (Blender convention)."""
    import numpy as np
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    lum = px.reshape(h, w, 4)[..., :3].sum(axis=2)
    lum = lum[::4, ::4]
    row, col = np.unravel_index(np.argmax(lum), lum.shape)
    u, v = (col * 4 + 2) / w, (row * 4 + 2) / h
    az = (u - 0.5) * 2 * math.pi            # angle of atan2(d.y, -d.x)
    el = (v - 0.5) * math.pi
    return az, el


def setup_world():
    path = os.path.join(ASSETS, "hdri", "forest_slope_8k.hdr")
    w = D.worlds.new("Forest_HDRI")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = D.images.load(path, check_existing=True)
    mapn = nt.nodes.new("ShaderNodeMapping")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(tc.outputs["Generated"], mapn.inputs["Vector"])
    nt.links.new(mapn.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bg.inputs["Strength"].default_value = 0.9
    az_img, el_img = hdri_sun(env.image)
    # world sun azimuth measured like the image: atan2(d.y, -d.x); we want d = (cos SUN_AZ, sin SUN_AZ)
    want = math.atan2(math.sin(SUN_AZ), -math.cos(SUN_AZ))
    rot = az_img - want
    mapn.inputs["Rotation"].default_value = (0, 0, rot)
    print(f"HDRI sun: az {math.degrees(az_img):.1f}  el {math.degrees(el_img):.1f}  -> rotation {math.degrees(rot):.1f}", flush=True)
    el = max(el_img, math.radians(20))
    sun_d = D.lights.new("Sun_forest", "SUN")
    sun_d.energy = 3.2
    sun_d.angle = math.radians(0.8)
    sun_d.color = (1.0, 0.93, 0.82)
    sun = D.objects.new("Sun_forest", sun_d)
    sc.collection.objects.link(sun)
    d = Vector((math.cos(SUN_AZ) * math.cos(el), math.sin(SUN_AZ) * math.cos(el), math.sin(el)))
    sun.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    for o in list(sc.objects):     # the model's own studio sun / camera are not used here
        if o.type == "LIGHT" and o is not sun:
            o.hide_render = True
    # light haze: aerial perspective + light shafts through the canopy
    me = D.meshes.new("haze")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    haze = D.objects.new("Haze_volume", me)
    haze.scale = (130, 130, 40)
    haze.location = (0, 0, 15)
    sc.collection.objects.link(haze)
    hm = D.materials.new("Haze")
    hm.use_nodes = True
    hn = hm.node_tree
    hn.nodes.clear()
    ho = hn.nodes.new("ShaderNodeOutputMaterial")
    pv = hn.nodes.new("ShaderNodeVolumePrincipled")
    pv.inputs["Density"].default_value = 0.0025
    pv.inputs["Anisotropy"].default_value = 0.55
    pv.inputs["Color"].default_value = (0.85, 0.88, 0.92, 1)
    hn.links.new(pv.outputs[0], ho.inputs["Volume"])
    me.materials.append(hm)
    haze.visible_shadow = False


# ============================================================================= ground
def pbr_nodes(nt, name, res, vec, L):
    base = os.path.join(ASSETS, "textures", name)
    def tex(short, color):
        for ext in ("jpg", "png", "exr"):
            p = os.path.join(base, f"{name}_{short}_{res}.{ext}")
            if os.path.exists(p):
                t = nt.nodes.new("ShaderNodeTexImage")
                t.image = D.images.load(p, check_existing=True)
                if not color:
                    t.image.colorspace_settings.name = "Non-Color"
                L(vec, t.inputs["Vector"])
                return t
        return None
    return {k: tex(k, k == "diff") for k in ("diff", "rough", "nor_gl", "disp", "ao")}


def build_ground():
    size, seg = 130.0, 520
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=seg, y_segments=seg, size=size / 2)
    for v in bm.verts:
        v.co.z = terrain(v.co.x, v.co.y)
    me = D.meshes.new("Forest_ground")
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    g = D.objects.new("Forest_ground", me)
    sc.collection.objects.link(g)
    sub = g.modifiers.new("adaptive", "SUBSURF")
    sub.subdivision_type = "SIMPLE"
    sub.use_adaptive_subdivision = True
    sub.adaptive_pixel_size = 2.0 if not PREVIEW else 3.0
    sub.levels = 0
    # ---- material: needles/leaf litter + leaves + mud in the ruts and around the tank
    m = D.materials.new("Forest_floor")
    m.displacement_method = "BOTH"
    nt = m.node_tree
    nt.nodes.clear()
    L = nt.links.new
    N = nt.nodes.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    L(bsdf.outputs[0], out.inputs["Surface"])
    tc = N("ShaderNodeTexCoord")
    sep = N("ShaderNodeSeparateXYZ")
    L(tc.outputs["Object"], sep.inputs[0])

    def mapping(scale, rotz=0.0, offs=(0, 0, 0)):
        mp = N("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (scale, scale, scale)
        mp.inputs["Rotation"].default_value = (0, 0, rotz)
        mp.inputs["Location"].default_value = offs
        L(tc.outputs["Object"], mp.inputs["Vector"])
        return mp.outputs["Vector"]

    A = pbr_nodes(nt, "forest_ground_04", "4k", mapping(0.42), L)
    Bt = pbr_nodes(nt, "forest_leaves_02", "4k", mapping(0.37, 0.7, (3.1, 1.7, 0)), L)
    Cm = pbr_nodes(nt, "brown_mud_leaves_01", "4k", mapping(0.45, 1.9, (0.4, 7.3, 0)), L)

    def M(op, a, b=None, clamp=False):
        n = N("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                L(v, n.inputs[i])
        return n.outputs[0]

    def mixc(fac, a, b):
        n = N("ShaderNodeMix")
        n.data_type = "RGBA"
        n.clamp_factor = True
        L(fac, n.inputs["Factor"])
        L(a, n.inputs["A"])
        L(b, n.inputs["B"])
        return n.outputs["Result"]

    def mixf(fac, a, b):
        n = N("ShaderNodeMix")
        n.data_type = "FLOAT"
        n.clamp_factor = True
        L(fac, n.inputs["Factor"])
        for s, v in ((n.inputs["A"], a), (n.inputs["B"], b)):
            if isinstance(v, (int, float)):
                s.default_value = v
            else:
                L(v, s)
        return n.outputs["Result"]

    def smoothstep(v, a, b):
        n = N("ShaderNodeMapRange")
        n.interpolation_type = "SMOOTHSTEP"
        n.inputs["From Min"].default_value, n.inputs["From Max"].default_value = a, b
        L(v, n.inputs["Value"])
        return n.outputs["Result"]

    x, y = sep.outputs["X"], sep.outputs["Y"]
    # rut centre line y_c = 0.0045 * min(x - RUT_X0, 0)^2
    dx = M("MINIMUM", M("SUBTRACT", x, RUT_X0), 0.0)
    yc = M("MULTIPLY", M("MULTIPLY", dx, dx), 0.0045)
    behind = smoothstep(x, RUT_X0 + 0.6, RUT_X0 - 0.4)          # 1 behind the tank
    rut, rim = None, None
    for s in (1, -1):
        d = M("ABSOLUTE", M("SUBTRACT", y, M("ADD", yc, s * TRACK_Y)))
        r = smoothstep(d, 0.37, 0.26)
        e = M("SUBTRACT", smoothstep(d, 0.66, 0.40), r, clamp=True)
        rut = r if rut is None else M("MAXIMUM", rut, r)
        rim = e if rim is None else M("MAXIMUM", rim, e)
    rut = M("MULTIPLY", rut, behind)
    rim = M("MULTIPLY", rim, behind)
    # grouser imprints every track pitch along the direction of travel
    wave = M("SINE", M("MULTIPLY", x, 2 * math.pi / 0.156))
    grousers = smoothstep(wave, 0.2, 0.8)
    # disturbed mud patch around the tank
    tank_area = M("MULTIPLY", smoothstep(M("ABSOLUTE", M("SUBTRACT", x, 0.1)), 4.4, 3.0),
                  smoothstep(M("ABSOLUTE", y), 2.6, 1.7))
    nz = N("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 0.35
    nz.inputs["Detail"].default_value = 6.0
    L(tc.outputs["Object"], nz.inputs["Vector"])
    leaves_mask = smoothstep(nz.outputs["Fac"], 0.36, 0.52)
    mud_mask = M("MAXIMUM", M("MAXIMUM", rut, M("MULTIPLY", rim, 0.7)), M("MULTIPLY", tank_area, 0.8))
    nz2 = N("ShaderNodeTexNoise")
    nz2.inputs["Scale"].default_value = 2.2
    nz2.inputs["Detail"].default_value = 10.0
    L(tc.outputs["Object"], nz2.inputs["Vector"])
    mud_mask = M("MULTIPLY", mud_mask, smoothstep(nz2.outputs["Fac"], 0.25, 0.5))
    col = mixc(leaves_mask, A["diff"].outputs["Color"], Bt["diff"].outputs["Color"])
    col = mixc(mud_mask, col, Cm["diff"].outputs["Color"])
    wet = N("ShaderNodeMix")          # slightly darker, wetter soil at the bottom of the ruts
    wet.data_type = "RGBA"
    wet.blend_type = "MULTIPLY"
    L(M("MULTIPLY", rut, 0.55), wet.inputs["Factor"])
    L(col, wet.inputs["A"])
    wet.inputs["B"].default_value = (0.55, 0.5, 0.45, 1)
    L(wet.outputs["Result"], bsdf.inputs["Base Color"])
    rough = mixf(leaves_mask, A["rough"].outputs["Color"], Bt["rough"].outputs["Color"])
    rough = mixf(mud_mask, rough, Cm["rough"].outputs["Color"])
    rough = M("SUBTRACT", rough, M("MULTIPLY", rut, 0.25), clamp=True)
    L(rough, bsdf.inputs["Roughness"])
    # normal maps
    def nmap(t):
        n = N("ShaderNodeNormalMap")
        L(t["nor_gl"].outputs["Color"], n.inputs["Color"])
        return n.outputs["Normal"]
    nv = N("ShaderNodeMix")
    nv.data_type = "VECTOR"
    nv.clamp_factor = True
    L(leaves_mask, nv.inputs["Factor"])
    L(nmap(A), nv.inputs["A"])
    L(nmap(Bt), nv.inputs["B"])
    nv2 = N("ShaderNodeMix")
    nv2.data_type = "VECTOR"
    nv2.clamp_factor = True
    L(mud_mask, nv2.inputs["Factor"])
    L(nv.outputs["Result"], nv2.inputs["A"])
    L(nmap(Cm), nv2.inputs["B"])
    L(nv2.outputs["Result"], bsdf.inputs["Normal"])
    # displacement: texture height + ruts with grouser imprints + pushed-up rims
    h = mixf(leaves_mask, A["disp"].outputs["Color"], Bt["disp"].outputs["Color"])
    h = mixf(mud_mask, h, Cm["disp"].outputs["Color"])
    h = M("MULTIPLY", M("SUBTRACT", h, 0.5), 0.07)
    h = M("ADD", h, M("MULTIPLY", rut, M("ADD", -0.095, M("MULTIPLY", grousers, 0.025))))
    h = M("ADD", h, M("MULTIPLY", rim, 0.055))
    disp = N("ShaderNodeDisplacement")
    disp.inputs["Midlevel"].default_value = 0.0
    disp.inputs["Scale"].default_value = 1.0
    L(h, disp.inputs["Height"])
    L(disp.outputs["Displacement"], out.inputs["Displacement"])
    me.materials.append(m)
    return g


# ============================================================================= vegetation
import re  # noqa: E402

# which objects of each Poly Haven blend are complete plants (the rest are building blocks)
VARIANTS = {
    "pine_tree_01": r"^pine_tree_01_[abc]_LOD[01]$", "fir_tree_01": r"^fir_tree_01_[abc]_LOD[01]$",
    "fir_sapling": r"^fir_sapling_[abc]$", "fir_sapling_medium": r"^fir_sapling_medium_[abc]_LOD[01]$",
    "pine_sapling_medium": r"^pine_sapling_medium_[abc]_LOD[01]$", "fern_02": r"^fern_02_[a-d]$",
    "grass_medium_01": r"^grass_medium_01_(tall|mid|large|small)_[abc]_LOD0$", "grass_medium_02": r"^grass_medium_02_[a-e]$",
    "tree_stump_01": r"^tree_stump_01$", "dead_tree_trunk": r"^dead_tree_trunk$", "root_cluster_01": r"^root_cluster_01$",
    "rock_moss_set_01": r"^rock_moss_set_01_rock0[1-6]$",
    "nettle_plant": r"^nettle_plant_(tall|medium)_[ab]_LOD0$",
}
_LIB = None


def get_lib():
    global _LIB
    if _LIB is None:
        _LIB = D.collections.new("Forest_asset_library")
        sc.collection.children.link(_LIB)
        bpy.context.view_layer.layer_collection.children[_LIB.name].exclude = True
    return _LIB


def load_asset(name):
    """Append one Poly Haven blend; returns {variant_name: (collection, height)} with every mesh
    re-centred so its base sits on the object origin."""
    folder = os.path.join(ASSETS, "models", name)
    blend = next(os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".blend"))
    with D.libraries.load(blend, link=False) as (src, dst):
        dst.objects = list(src.objects)
    pat = re.compile(VARIANTS[name])
    lib = get_lib()
    out = {}
    done = set()
    for o in dst.objects:
        if o is None:
            continue
        if o.type != "MESH" or not pat.search(o.name):
            D.objects.remove(o, do_unlink=True)
            continue
        o.parent = None
        o.matrix_world = Matrix.Diagonal((*o.matrix_world.to_scale(), 1))
        if o.data.name not in done:
            bb = [Vector(v) for v in o.bound_box]
            base = Vector((sum(v.x for v in bb) / 8, sum(v.y for v in bb) / 8, min(v.z for v in bb)))
            o.data.transform(Matrix.Translation(-base))
            done.add(o.data.name)
        c = D.collections.new(f"ASSET_{o.name}")
        lib.children.link(c)
        c.objects.link(o)
        out[o.name] = (c, o.dimensions.z)
    for m in list(D.meshes):
        if m.users == 0:
            D.meshes.remove(m)
    print(f"asset {name}: " + ", ".join(f"{k} {h:.2f}m" for k, (c, h) in out.items()), flush=True)
    return out


def place(coll, var, x, y, scale, tilt=3.0, sink=0.0):
    c, h = var
    e = D.objects.new(f"inst_{c.name[6:]}", None)
    e.instance_type = "COLLECTION"
    e.instance_collection = c
    e.location = (x, y, terrain(x, y) - sink)
    e.rotation_euler = (math.radians(rng.uniform(-tilt, tilt)), math.radians(rng.uniform(-tilt, tilt)),
                        rng.uniform(0, 2 * math.pi))
    e.scale = (scale, scale, scale)
    coll.objects.link(e)
    return e


def scatter_points(n, rmin, rmax, cam, spacing=0.0, tall=True, cluster=None, pad=0.4, cam_min=1.6):
    placed, tries = [], 0
    while len(placed) < n and tries < n * 80:
        tries += 1
        ang = rng.uniform(0, 2 * math.pi)
        r = math.sqrt(rng.uniform(rmin * rmin, rmax * rmax))
        x, y = 0.3 + r * math.cos(ang), r * math.sin(ang)
        if in_tank(x, y, pad) or in_ruts(x, y) or math.hypot(x - cam[0], y - cam[1]) < cam_min:
            continue
        if tall and in_view(x, y, cam):
            continue
        if cluster is not None and rng.random() > smooth(-0.15, 0.35, noise.noise(Vector((x * cluster, y * cluster, 7.7)))):
            continue
        if spacing and any((x - px) ** 2 + (y - py) ** 2 < spacing * spacing for px, py in placed):
            continue
        placed.append((x, y))
    return placed


def lod_pick(variants, x, y, cam, near=26.0):
    """Full-detail LOD0 close to the camera, LOD1 further away."""
    want = "LOD0" if math.hypot(x - cam[0], y - cam[1]) < near else "LOD1"
    pool = [v for k, v in variants.items() if k.endswith(want)] or list(variants.values())
    return rng.choice(pool)


def gn_scatter(name, base_mesh, variants, dens_fn, max_density, scale=(0.7, 1.3), tilt=0.12, seed=0):
    """Geometry-nodes scatter of collection instances over the ground; density from a vertex attribute."""
    me = base_mesh.copy()
    me.name = f"scatter_{name}"
    me.materials.clear()
    vals = [dens_fn(v.co.x, v.co.y) for v in me.vertices]
    attr = me.attributes.new("density", "FLOAT", "POINT")
    attr.data.foreach_set("value", vals)
    obj = D.objects.new(f"Scatter_{name}", me)
    sc.collection.objects.link(obj)
    src = D.collections.new(f"SCATTER_{name}")
    get_lib().children.link(src)
    for (c, h) in variants.values():
        for o in c.objects:
            src.objects.link(o)
    ng = D.node_groups.new(f"scatter_{name}", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N, L = ng.nodes.new, ng.links.new
    gi, go = N("NodeGroupInput"), N("NodeGroupOutput")
    dist = N("GeometryNodeDistributePointsOnFaces")
    dist.distribute_method = "RANDOM"
    na = N("GeometryNodeInputNamedAttribute")
    na.data_type = "FLOAT"
    na.inputs["Name"].default_value = "density"
    mul = N("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = max_density
    L(na.outputs["Attribute"], mul.inputs[0])
    L(gi.outputs[0], dist.inputs["Mesh"])
    L(mul.outputs[0], dist.inputs["Density"])
    dist.inputs["Seed"].default_value = seed
    ci = N("GeometryNodeCollectionInfo")
    ci.transform_space = "ORIGINAL"
    ci.inputs["Collection"].default_value = src
    ci.inputs["Separate Children"].default_value = True
    ci.inputs["Reset Children"].default_value = True
    iop = N("GeometryNodeInstanceOnPoints")
    L(dist.outputs["Points"], iop.inputs["Points"])
    L(ci.outputs[0], iop.inputs["Instance"])
    iop.inputs["Pick Instance"].default_value = True
    ri = N("FunctionNodeRandomValue")
    ri.data_type = "INT"
    ri.inputs["Min"].default_value = 0          # Blender 5 shows only the sockets of the chosen data type
    ri.inputs["Max"].default_value = len(variants) - 1
    ri.inputs["Seed"].default_value = seed + 1
    L(ri.outputs[0], iop.inputs["Instance Index"])
    rr = N("FunctionNodeRandomValue")
    rr.data_type = "FLOAT_VECTOR"
    rr.inputs["Min"].default_value = (-tilt, -tilt, 0.0)
    rr.inputs["Max"].default_value = (tilt, tilt, 6.2832)
    rr.inputs["Seed"].default_value = seed + 2
    e2r = N("FunctionNodeEulerToRotation")
    L(rr.outputs[0], e2r.inputs[0])
    L(e2r.outputs[0], iop.inputs["Rotation"])
    rs = N("FunctionNodeRandomValue")
    rs.data_type = "FLOAT"
    rs.inputs["Min"].default_value = scale[0]
    rs.inputs["Max"].default_value = scale[1]
    rs.inputs["Seed"].default_value = seed + 3
    L(rs.outputs[0], iop.inputs["Scale"])
    L(iop.outputs[0], go.inputs[0])
    mod = obj.modifiers.new("scatter", "NODES")
    mod.node_group = ng
    return obj


def build_vegetation(cam):
    veg = D.collections.new("Forest_vegetation")
    sc.collection.children.link(veg)
    A = {k: load_asset(k) for k in VARIANTS}
    trees = {**A["pine_tree_01"], **A["fir_tree_01"]}
    for (x, y) in scatter_points(170, 9.0, 62.0, cam, spacing=3.4):
        place(veg, lod_pick(trees, x, y, cam), x, y, rng.uniform(0.85, 1.25), tilt=1.5, sink=0.05)
    young = {**A["fir_sapling_medium"], **A["pine_sapling_medium"]}
    for (x, y) in scatter_points(45, 7.0, 45.0, cam, spacing=2.5, cluster=0.1):
        place(veg, lod_pick(young, x, y, cam), x, y, rng.uniform(0.6, 1.1), tilt=2.0)
    for (x, y) in scatter_points(70, 3.5, 30.0, cam, spacing=0.8, cluster=0.14):
        place(veg, rng.choice(list(A["fir_sapling"].values())), x, y, rng.uniform(0.6, 1.4))
    for (x, y) in scatter_points(12, 6.0, 40.0, cam, spacing=2.0):
        place(veg, A["tree_stump_01"]["tree_stump_01"], x, y, rng.uniform(1.2, 1.8), sink=0.05)
    for (x, y) in scatter_points(4, 7.0, 30.0, cam, spacing=4.0):
        place(veg, A["dead_tree_trunk"]["dead_tree_trunk"], x, y, rng.uniform(1.8, 2.6), tilt=1.0, sink=0.10)
    for (x, y) in scatter_points(10, 6.0, 30.0, cam, spacing=3.0):
        place(veg, A["root_cluster_01"]["root_cluster_01"], x, y, rng.uniform(0.8, 1.2), sink=0.1)
    for (x, y) in scatter_points(24, 4.0, 40.0, cam, spacing=1.5, tall=True, cluster=0.15, cam_min=9.0):
        place(veg, rng.choice(list(A["rock_moss_set_01"].values())), x, y, rng.uniform(0.25, 0.6), tilt=8.0, sink=0.1)
    # ground cover with geometry nodes
    base = D.objects["Forest_ground"].data
    cx, cy = cam[0], cam[1]

    def falloff(x, y, r0=18.0, r1=45.0):
        return 1.0 - 0.75 * smooth(r0, r1, math.hypot(x - cx, y - cy))

    def keep(x, y, pad=0.25):
        return 0.0 if (in_tank(x, y, pad) or in_ruts(x, y, 0.02)) else 1.0

    def grass_d(x, y):
        if not keep(x, y, 0.1):
            return 0.0
        cl = smooth(-0.3, 0.45, noise.noise(Vector((x * 0.22, y * 0.22, 3.3))))
        between = 1.0 if (x < RUT_X0 and abs(y - rut_centre(x)) < 0.8) else 0.0
        near_tank = 0.45 if in_tank(x, y, 1.6) else 1.0
        return max(cl, 0.8 * between) * falloff(x, y) * near_tank

    def fern_d(x, y):
        if not keep(x, y, 0.8):
            return 0.0
        if in_view(x, y, cam, pad=0.3) and math.hypot(x - cx, y - cy) > 4.5:
            return 0.0
        return smooth(-0.2, 0.35, noise.noise(Vector((x * 0.13, y * 0.13, 9.1)))) * falloff(x, y, 14, 35)

    def nettle_d(x, y):
        if not keep(x, y, 0.5) or in_view(x, y, cam, pad=0.0):
            return 0.0
        return smooth(0.1, 0.5, noise.noise(Vector((x * 0.17, y * 0.17, 5.4)))) * falloff(x, y, 12, 30)

    def branch_d(x, y):
        return keep(x, y, 0.2) * falloff(x, y, 10, 30)

    grass = {**A["grass_medium_01"], **A["grass_medium_02"]}
    gn_scatter("grass", base, grass, grass_d, 30.0, scale=(0.8, 1.7), seed=11)
    gn_scatter("ferns", base, A["fern_02"], fern_d, 3.5, scale=(1.1, 2.1), seed=23)
    gn_scatter("nettles", base, A["nettle_plant"], nettle_d, 5.0, scale=(1.3, 2.4), seed=37)
    return veg


# ============================================================================= camera / render
def setup_camera():
    loc, tgt, lens, fstop = CAMERAS[CAMERA]
    cd = D.cameras.new("Forest_camera")
    cd.lens = lens
    cd.sensor_width = 36
    cd.clip_start, cd.clip_end = 0.05, 400
    cd.dof.use_dof = True
    cd.dof.aperture_fstop = fstop
    cd.dof.aperture_blades = 7
    cd.dof.focus_distance = (Vector(tgt) - Vector(loc)).length
    cam = D.objects.new("Forest_camera", cd)
    sc.collection.objects.link(cam)
    lz = terrain(loc[0], loc[1])
    cam.location = (loc[0], loc[1], loc[2] + lz)
    cam.rotation_euler = (Vector(tgt) - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    return loc


def setup_render():
    sc.render.engine = "CYCLES"
    cy = sc.cycles
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for t in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = t
            prefs.get_devices()
            if any(d.type == t for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == t
                cy.device = "GPU"
                print("render device", t, flush=True)
                break
        except Exception:
            continue
    cy.samples = SAMPLES
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.006 if not PREVIEW else 0.03
    cy.use_denoising = True
    try:
        cy.denoiser = "OPENIMAGEDENOISE"          # OIDN (GPU) gives the cleanest foliage detail
        cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
        cy.denoising_quality = "HIGH"
        cy.denoising_use_gpu = True
    except Exception:
        pass
    cy.max_bounces = 12
    cy.diffuse_bounces = 4
    cy.glossy_bounces = 4
    cy.transmission_bounces = 8
    cy.volume_bounces = 1
    cy.transparent_max_bounces = 64
    cy.sample_clamp_indirect = 8.0
    cy.use_light_tree = True
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.volume_step_rate = 2.0 if not PREVIEW else 4.0
    cy.dicing_rate = 1.0
    try:
        cy.use_guiding = True
    except Exception:
        pass
    sc.render.resolution_x, sc.render.resolution_y = RES
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_depth = "16"
    sc.view_settings.view_transform = "AgX"
    for look in ("AgX - Medium High Contrast", "Medium High Contrast", "AgX - Base Contrast"):
        try:
            sc.view_settings.look = look
            break
        except Exception:
            continue
    sc.view_settings.exposure = 0.0


def pose_tank():
    c = D.objects.get("Panther_Controls")
    if c is None:
        return
    c["turret_traverse"] = 12.0
    c["gun_elevation"] = 2.5
    c["cupola_hatch"] = 1.0
    c["cutaway"] = 0
    c["skirts"] = 0
    for o in D.objects:          # studio camera from the model file is not used
        if o.type == "CAMERA" and o.name == "Camera":
            o.hide_render = True
    bpy.context.view_layer.update()


def main():
    missing = not os.path.exists(os.path.join(ASSETS, "hdri", "forest_slope_8k.hdr"))
    if missing:
        raise SystemExit("forest assets missing -- run: python panther/scripts/fetch_forest_assets.py")
    pose_tank()
    weather_tank()
    setup_world()
    cam = setup_camera()
    build_ground()
    build_vegetation(cam)
    setup_render()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, "panther_forest_scene.blend"), compress=True,
                                relative_remap=True)
    print("SAVED scene", flush=True)
    if "--no-render" in argv:
        return
    sc.render.filepath = OUT
    import time
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"RENDERED {OUT} in {time.time() - t0:.0f} s", flush=True)


main()
