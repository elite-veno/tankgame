"""Panther Ausf. G (Pz.Kpfw. V, Sd.Kfz. 171) -- high-detail Blender model, exterior + full interior.

Run headless from the repository root:
    blender -b --factory-startup --python panther/scripts/build_panther_detailed.py
Writes panther/panther_ausf_g_detailed.blend (re-runnable, builds from an empty scene).

Scene layout
  Panther_Ausf_G (root empty)
    hull armour shell (real plate thicknesses, openings), weld seams, running gear with
    interleaved 860 mm road wheels, 2 x 87 individual Kgs 64/660/150 track links,
    engine deck grilles/fans, exhausts, stowage, tools, towing gear, optional Schuerzen
    turret_root (traverse) -> turret armour, cupola, periscopes, hatches, turret interior
      gun_pivot (elevation) -> chin mantlet, KwK 42 L/70 barrel + muzzle brake, breech,
                               recoil system, deflector guard, TZF 12a, coaxial MG 34
    interior: driver / radio operator stations, AK 7-200 gearbox, steering unit, bow MG 34,
    Fu 5 radios, sponson ammunition racks, turret basket, firewall, Maybach HL 230 P30,
    radiators + cooling fans, fuel tanks

Control rig: object "Panther_Controls" (custom properties drive everything)
  turret_traverse (deg), gun_elevation (deg, -8..+18), cupola_hatch, driver_hatch,
  radio_hatch, turret_rear_hatch (0 = closed .. 1 = open), cutaway (0/1 cuts the left
  side away to show the interior), skirts (0/1 shows the side skirts).
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib  # noqa: E402
import pz_geom  # noqa: E402
importlib.reload(pz_geom)
from pz_geom import *  # noqa: E402,F401,F403

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(ROOT, "panther_ausf_g_detailed.blend")
D = bpy.data
S2 = math.sqrt(0.5)

# armour (m)
T_GLACIS, T_NOSE, T_USIDE, T_LSIDE, T_REAR, T_ROOF, T_FLOOR, T_SPONSON = 0.08, 0.05, 0.05, 0.04, 0.04, 0.035, 0.025, 0.02
TT_FRONT, TT_SIDE, TT_REAR, TT_ROOF = 0.11, 0.045, 0.045, 0.03


# ============================================================================= materials
def _nodes(m):
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (900, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (600, 0)
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    return nt, bsdf


def simple_mat(name, color, rough=0.5, metal=0.0, emit=0.0, alpha=1.0, grime=0.0):
    m = D.materials.new(name)
    nt, bsdf = _nodes(m)
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    m.diffuse_color = (*color, 1)
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*color, 1)
        bsdf.inputs["Emission Strength"].default_value = emit
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
    if grime:
        # subtle procedural variation so large surfaces do not look flat
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 6.0
        nz.inputs["Detail"].default_value = 6.0
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.inputs["A"].default_value = (*color, 1)
        mix.inputs["B"].default_value = (color[0] * 0.55, color[1] * 0.5, color[2] * 0.45, 1)
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["From Min"].default_value = 0.45
        mr.inputs["From Max"].default_value = 0.75
        mr.inputs["To Max"].default_value = grime
        nt.links.new(nz.outputs["Fac"], mr.inputs["Value"])
        nt.links.new(mr.outputs["Result"], mix.inputs["Factor"])
        nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.05
        nz2 = nt.nodes.new("ShaderNodeTexNoise")
        nz2.inputs["Scale"].default_value = 80.0
        nt.links.new(tc.outputs["Object"], nz2.inputs["Vector"])
        nt.links.new(nz2.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def camo_mat(name, ref):
    """Late-war three-tone scheme (Dunkelgelb RAL 7028 / Olivgruen RAL 6003 / Rotbraun RAL 8017)
    with dust towards the running gear, cast-steel bump and crevice darkening."""
    m = D.materials.new(name)
    nt, bsdf = _nodes(m)
    L = nt.links
    dg, og, rb = (0.46, 0.33, 0.13), (0.075, 0.085, 0.040), (0.105, 0.035, 0.018)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.object = ref
    tc.location = (-1400, 0)

    def noise(scale, w, detail=3.0, loc=(0, 0)):
        n = nt.nodes.new("ShaderNodeTexNoise")
        n.noise_dimensions = "4D"
        n.inputs["Scale"].default_value = scale
        n.inputs["W"].default_value = w
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = 0.55
        n.location = loc
        L.new(tc.outputs["Object"], n.inputs["Vector"])
        return n

    def ramp(src, pos, soft=0.022, loc=(0, 0)):
        r = nt.nodes.new("ShaderNodeMapRange")
        r.inputs["From Min"].default_value = pos - soft
        r.inputs["From Max"].default_value = pos + soft
        r.location = loc
        L.new(src.outputs["Fac"], r.inputs["Value"])
        return r

    n1 = noise(0.42, 1.3, loc=(-1100, 300))
    n2 = noise(0.50, 7.9, loc=(-1100, 0))
    g_mask = ramp(n1, 0.57, loc=(-850, 300))
    b_mask = ramp(n2, 0.585, loc=(-850, 0))
    mix1 = nt.nodes.new("ShaderNodeMix")
    mix1.data_type = "RGBA"
    mix1.inputs["A"].default_value = (*dg, 1)
    mix1.inputs["B"].default_value = (*rb, 1)
    mix1.location = (-600, 100)
    L.new(b_mask.outputs["Result"], mix1.inputs["Factor"])
    mix2 = nt.nodes.new("ShaderNodeMix")
    mix2.data_type = "RGBA"
    mix2.inputs["B"].default_value = (*og, 1)
    mix2.location = (-400, 150)
    L.new(mix1.outputs["Result"], mix2.inputs["A"])
    L.new(g_mask.outputs["Result"], mix2.inputs["Factor"])
    # dust: world height gradient broken up by noise
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    geo.location = (-1100, -350)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-900, -350)
    L.new(geo.outputs["Position"], sep.inputs[0])
    hmr = nt.nodes.new("ShaderNodeMapRange")
    hmr.inputs["From Min"].default_value = 1.25
    hmr.inputs["From Max"].default_value = 0.2
    hmr.location = (-700, -350)
    L.new(sep.outputs["Z"], hmr.inputs["Value"])
    n3 = noise(3.0, 3.3, detail=8.0, loc=(-900, -600))
    dmix = nt.nodes.new("ShaderNodeMath")
    dmix.operation = "MULTIPLY"
    dmix.location = (-500, -400)
    L.new(hmr.outputs["Result"], dmix.inputs[0])
    L.new(n3.outputs["Fac"], dmix.inputs[1])
    dust_amt = nt.nodes.new("ShaderNodeMath")
    dust_amt.operation = "MULTIPLY"
    dust_amt.inputs[1].default_value = 1.25
    L.new(dmix.outputs[0], dust_amt.inputs[0])
    mix3 = nt.nodes.new("ShaderNodeMix")
    mix3.data_type = "RGBA"
    mix3.clamp_factor = True
    mix3.inputs["B"].default_value = (0.26, 0.20, 0.13, 1)
    mix3.location = (-200, 0)
    L.new(mix2.outputs["Result"], mix3.inputs["A"])
    L.new(dust_amt.outputs[0], mix3.inputs["Factor"])
    # crevice darkening
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = 0.15
    ao.location = (-200, -300)
    aomr = nt.nodes.new("ShaderNodeMapRange")
    aomr.inputs["To Min"].default_value = 0.55
    L.new(ao.outputs["AO"], aomr.inputs["Value"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    mul.location = (100, 0)
    L.new(mix3.outputs["Result"], mul.inputs["A"])
    L.new(aomr.outputs["Result"], mul.inputs["B"])
    L.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    # roughness + cast / rolled-plate texture
    rr = nt.nodes.new("ShaderNodeMapRange")
    rr.inputs["To Min"].default_value = 0.55
    rr.inputs["To Max"].default_value = 0.85
    L.new(n3.outputs["Fac"], rr.inputs["Value"])
    L.new(rr.outputs["Result"], bsdf.inputs["Roughness"])
    n4 = noise(55.0, 0.5, detail=4.0, loc=(-200, -700))
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.06
    bump.location = (300, -500)
    L.new(n4.outputs["Fac"], bump.inputs["Height"])
    L.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    m.diffuse_color = (*dg, 1)
    return m


def build_materials(hull_ref, turret_ref):
    M = {
        "paint": camo_mat("PZ_paint_hull", hull_ref),
        "paint_t": camo_mat("PZ_paint_turret", turret_ref),
        "ivory": simple_mat("PZ_interior_elfenbein", (0.62, 0.55, 0.38), rough=0.6, grime=0.35),
        "primer": simple_mat("PZ_red_oxide_primer", (0.24, 0.055, 0.03), rough=0.7, grime=0.4),
        "track": simple_mat("PZ_track_steel", (0.06, 0.05, 0.045), rough=0.75, metal=0.7, grime=0.8),
        "steel": simple_mat("PZ_bare_steel", (0.32, 0.31, 0.30), rough=0.35, metal=1.0),
        "dark": simple_mat("PZ_dark_steel", (0.035, 0.035, 0.033), rough=0.5, metal=0.6),
        "rubber": simple_mat("PZ_rubber", (0.018, 0.018, 0.018), rough=0.85, grime=0.6),
        "engine": simple_mat("PZ_engine_grey", (0.10, 0.10, 0.095), rough=0.55, metal=0.4, grime=0.5),
        "alu": simple_mat("PZ_aluminium", (0.55, 0.55, 0.53), rough=0.4, metal=1.0),
        "brass": simple_mat("PZ_brass", (0.62, 0.43, 0.15), rough=0.25, metal=1.0),
        "copper": simple_mat("PZ_copper", (0.55, 0.26, 0.13), rough=0.35, metal=1.0),
        "shell_ap": simple_mat("PZ_shell_black", (0.02, 0.02, 0.02), rough=0.4, metal=0.3),
        "shell_he": simple_mat("PZ_shell_olive", (0.09, 0.08, 0.035), rough=0.45),
        "leather": simple_mat("PZ_leather", (0.06, 0.03, 0.015), rough=0.55, grime=0.4),
        "canvas": simple_mat("PZ_canvas", (0.20, 0.17, 0.10), rough=0.95, grime=0.5),
        "wood": simple_mat("PZ_wood", (0.30, 0.17, 0.07), rough=0.6, grime=0.3),
        "glass": simple_mat("PZ_glass_periscope", (0.02, 0.04, 0.04), rough=0.03, metal=0.2),
        "lens": simple_mat("PZ_headlight_glass", (0.6, 0.6, 0.55), rough=0.05, metal=0.5),
        "white": simple_mat("PZ_white", (0.80, 0.78, 0.72), rough=0.5),
        "black": simple_mat("PZ_black", (0.012, 0.012, 0.012), rough=0.6),
        "red": simple_mat("PZ_red", (0.40, 0.02, 0.015), rough=0.5),
        "gauge": simple_mat("PZ_gauge_face", (0.85, 0.82, 0.72), rough=0.3),
        "radio": simple_mat("PZ_radio_grey", (0.10, 0.11, 0.10), rough=0.5, grime=0.2),
        "cable": simple_mat("PZ_wire_rope", (0.08, 0.07, 0.06), rough=0.6, metal=0.8, grime=0.6),
        "lamp": simple_mat("PZ_lamp", (1.0, 0.85, 0.55), emit=3.0),
        "floor": simple_mat("PZ_floor_plate", (0.16, 0.15, 0.13), rough=0.7, metal=0.5, grime=0.6),
        "radiator": simple_mat("PZ_radiator_core", (0.05, 0.05, 0.045), rough=0.6, metal=0.6),
    }
    return M


# ============================================================================= scene helpers
def P(name, frame=None):
    return Part(name, frame)


def finish(obj, bevel=0.0, smooth=math.radians(35), seg=2):
    me = obj.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=smooth)
    if bevel:
        b = obj.modifiers.new("Bevel", "BEVEL")
        b.width = bevel
        b.segments = seg
        b.limit_method = "ANGLE"
        b.angle_limit = math.radians(40)
        b.harden_normals = True
        b.miter_outer = "MITER_ARC"
    return obj


def build(part, coll, parent=None, bevel=0.0, smooth=math.radians(35), keep_world=True):
    """Build a Part whose coordinates are world coordinates; keep world placement under parent."""
    obj = part.build(coll, MATS)
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    finish(obj, bevel, smooth)
    return obj


def classify(obj, inner_sets, paint, inside_mat, engine_mat=None, x_bulk=None, tol=0.003):
    """Assign materials after a boolean: faces lying on the inner cavity surface get the
    interior material, everything else the paint."""
    me = obj.data
    mats = [paint, inside_mat] + ([engine_mat] if engine_mat else [])
    me.materials.clear()
    for m in mats:
        me.materials.append(m)
    W = obj.matrix_world
    for p in me.polygons:
        c = W @ p.center
        cc = np.array(c)
        inner = any(all(np.dot(n, cc) <= d + tol for n, d in planes) for planes in inner_sets)
        if inner:
            p.material_index = 2 if (engine_mat and x_bulk is not None and c.x < x_bulk) else 1
        else:
            p.material_index = 0


def set_parent(obj, parent):
    bpy.context.view_layer.update()          # matrix_world is stale right after setting location
    mw = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = mw


# ============================================================================= hull armour
def hull_plane_sets():
    up = hull_upper_planes()          # bottom, roof, glacis, rear, side+, side-
    lo = hull_lower_planes(top=Z_SPONSON + 0.02) + [up[2]]
    up_in = offset(up, [T_SPONSON, T_ROOF, T_GLACIS, T_REAR, T_USIDE, T_USIDE])
    lo_in = offset(hull_lower_planes(top=Z_SPONSON + 0.05), [T_FLOOR, 0, T_NOSE, T_REAR, T_REAR, T_LSIDE, T_LSIDE])
    lo_in += [offset([up[2]], T_GLACIS)[0], offset([up[3]], T_REAR)[0]]
    return up, lo, up_in, lo_in


ENGINE_HATCH = (-2.05, 0.0, 0.92, 0.78)          # x, y, lx, ly
DECK_GRILLES = [(-1.68, 0.78, 0.52, 0.50), (-2.74, 0.78, 0.36, 0.50)]  # x, |y|, lx, ly (rectangular louvres)
FANS = [(-2.22, 0.80, 0.26)]                       # x, |y|, r
HULL_HATCH_X, HULL_HATCH_Y, HULL_HATCH_R = 1.60, 0.58, 0.25
MG_BALL = (2.93, -0.52)
EXH_Y, EXH_Z = 0.45, 1.66


def on_glacis(x, y):
    return Vector((x, y, Z_SPONSON + (X_NOSE - x) / math.tan(math.radians(55))))


GL_N = Vector((math.cos(math.radians(55)), 0, math.sin(math.radians(55))))


def build_hull_armour(coll, root):
    up, lo, up_in, lo_in = hull_plane_sets()
    base = P("hull_armour")
    base.convex(up)
    lower = P("lo")
    lower.convex(lo)
    cav = [P("c1"), P("c2")]
    cav[0].convex(up_in)
    cav[1].convex(lo_in)
    holes = []

    def hole_cyl(p0, p1, r, seg=48):
        h = P("h")
        h.cyl(p0, p1, r, seg=seg)
        holes.append(h)

    hole_cyl((TURRET_X, 0, Z_ROOF - 0.2), (TURRET_X, 0, Z_ROOF + 0.1), RING_R + 0.01, seg=128)
    for s in (1, -1):
        hole_cyl((HULL_HATCH_X, s * HULL_HATCH_Y, Z_ROOF - 0.2), (HULL_HATCH_X, s * HULL_HATCH_Y, Z_ROOF + 0.1), HULL_HATCH_R, 64)
        hole_cyl((HULL_HATCH_X + 0.42, s * HULL_HATCH_Y, Z_ROOF - 0.2), (HULL_HATCH_X + 0.42, s * HULL_HATCH_Y, Z_ROOF + 0.1), 0.075, 32)
        for (x, y, lx, ly) in DECK_GRILLES:
            h = P("h")
            h.box((x, s * y, Z_ROOF), (lx - 0.06, ly - 0.06, 0.3))
            holes.append(h)
        for (x, y, r) in FANS:
            hole_cyl((x, s * y, Z_ROOF - 0.2), (x, s * y, Z_ROOF + 0.1), r - 0.02, 64)
        # exhaust ports in the rear plate
        p0 = Vector((rear_x_at(EXH_Z) + 0.15, s * EXH_Y, EXH_Z))
        hole_cyl(p0, p0 + Vector((-0.4, 0, 0)), 0.075, 32)
    h = P("h")
    h.box((ENGINE_HATCH[0], 0, Z_ROOF), (ENGINE_HATCH[2] - 0.12, ENGINE_HATCH[3] - 0.12, 0.3))
    holes.append(h)
    # bow MG ball socket
    c = on_glacis(*MG_BALL)
    h = P("h")
    h.sphere(c - GL_N * 0.03, 0.155, seg=32)
    holes.append(h)
    obj = csg("hull_armour", coll, base, [("UNION", [lower]), ("DIFFERENCE", cav + holes)])
    bm = bmesh.new()                       # split at the firewall so each compartment gets its own paint
    bm.from_mesh(obj.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(X_BULKHEAD, 0, 0), plane_no=(1, 0, 0))
    bm.to_mesh(obj.data)
    bm.free()
    classify(obj, [up_in, lo_in], MATS["paint"], MATS["ivory"], MATS["primer"], X_BULKHEAD)
    set_parent(obj, root)
    finish(obj, bevel=0.012)
    return obj


def weld_bead(part, a, b, r=0.014, n=None):
    part.cyl(a, b, r, mat="paint", seg=8)


def build_hull_exterior(coll, root):
    ext = P("hull_details")
    up = hull_upper_planes()
    # ---- weld seams along the main plate joints
    vs, fs = convex_from_planes(up)
    edges = set()
    for f in fs:
        for i in range(len(f)):
            a, b = f[i], f[(i + 1) % len(f)]
            edges.add((min(a, b), max(a, b)))
    for a, b in edges:
        A, B = vs[a], vs[b]
        if abs(A.z - Z_SPONSON) < 1e-4 and abs(B.z - Z_SPONSON) < 1e-4:
            continue
        ext.cyl(A, B, 0.013, mat="paint", seg=8)
    # interlocking plate joints (side plates keyed into the glacis)
    for s in (1, -1):
        for k in range(4):
            t = (k + 0.5) / 4
            z = Z_SPONSON + t * (Z_ROOF - Z_SPONSON)
            x = X_NOSE - (z - Z_SPONSON) * math.tan(math.radians(55))
            y = W_SPONSON - (z - Z_SPONSON) * math.tan(SIDE_SLOPE)
            ext.box((x - 0.03, s * (y - 0.01), z), (0.1, 0.05, 0.09), mat="paint",
                    rot=(s * -SIDE_SLOPE, math.radians(35), 0))
    # ---- towing lugs (lower side plates run past the nose) and shackles
    for s in (1, -1):
        lug = [(3.02, 0.86), (3.62, 0.86), (3.72, 0.95), (3.72, 1.05), (3.62, 1.12), (3.30, 1.12)]
        M = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        ext.prism(lug, s * (W_LOWER - 0.04), s * W_LOWER, mat="paint", M=M)
        ext.torus((3.63, s * (W_LOWER - 0.02), 0.99), (0, 1, 0), 0.07, 0.012, mat="dark", seg=24)
        # shackle (clevis) hanging from the lug
        ext.tube([(3.63, s * (W_LOWER + 0.02), 0.99), (3.70, s * (W_LOWER + 0.02), 0.90), (3.74, s * (W_LOWER - 0.02), 0.84),
                  (3.70, s * (W_LOWER - 0.06), 0.90), (3.63, s * (W_LOWER - 0.06), 0.99)], 0.018, mat="dark", seg=10)
        ext.cyl((3.63, s * (W_LOWER + 0.04), 0.99), (3.63, s * (W_LOWER - 0.08), 0.99), 0.016, mat="dark", seg=10)
    # rear lugs + shackles
    for s in (1, -1):
        lug = [(-3.25, 0.56), (-3.62, 0.60), (-3.68, 0.72), (-3.60, 0.84), (-3.42, 0.86), (-3.30, 0.75)]
        M = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        ext.prism(lug, s * (W_LOWER - 0.04), s * W_LOWER, mat="paint", M=M)
        ext.torus((-3.57, s * (W_LOWER - 0.02), 0.72), (0, 1, 0), 0.06, 0.012, mat="dark", seg=24)
    # ---- bow MG ball mount (Kugelblende 50) with MG 34
    c = on_glacis(*MG_BALL)
    ext.ring(c + GL_N * 0.015, GL_N, 0.155, 0.23, 0.05, mat="paint", seg=48)
    ext.sphere(c - GL_N * 0.03, 0.15, mat="paint", seg=32)
    mgd = Vector((1, 0, -0.04)).normalized()
    b0 = c - GL_N * 0.03 + mgd * 0.12
    ext.cyl(b0, b0 + mgd * 0.33, 0.028, mat="dark", seg=16)     # perforated jacket (simplified)
    for k in range(6):
        p = b0 + mgd * (0.05 + k * 0.045)
        ext.ring(p, mgd, 0.022, 0.03, 0.012, mat="black", seg=12)
    ext.cyl(b0 + mgd * 0.33, b0 + mgd * 0.40, 0.014, mat="dark", seg=12)
    ext.cyl(c - GL_N * 0.03 + Vector((0.13, 0.06, 0.05)), c - GL_N * 0.03 + Vector((0.16, 0.06, 0.06)), 0.012, mat="glass", seg=10)
    # ---- Bosch headlight (left glacis)
    hl = on_glacis(2.66, 0.98)
    ext.box(hl + GL_N * 0.02, (0.06, 0.06, 0.04), mat="paint", rot=(0, -math.radians(55), 0))
    ext.cyl(hl + GL_N * 0.02, hl + GL_N * 0.02 + Vector((0.02, 0, 0.12)), 0.018, mat="dark", seg=10)
    lc = hl + GL_N * 0.02 + Vector((0.04, 0, 0.19))
    ext.cyl(lc - Vector((0.08, 0, 0)), lc + Vector((0.05, 0, 0)), 0.09, r2=0.1, mat="dark", seg=32)
    ext.cyl(lc + Vector((0.05, 0, 0)), lc + Vector((0.065, 0, 0)), 0.085, mat="lens", seg=32)
    ext.box(lc + Vector((0.075, 0, 0.03)), (0.01, 0.17, 0.09), mat="dark")          # blackout cover
    ext.cyl(lc + Vector((-0.02, 0, 0.085)), lc + Vector((0.02, 0, 0.085)), 0.02, mat="dark", seg=8)
    # horn / Notek on the right glacis
    nt = on_glacis(2.66, -0.98)
    ext.cyl(nt + GL_N * 0.01, nt + GL_N * 0.1, 0.05, mat="dark", seg=16)
    # ---- driver / radio operator periscopes (rotating, with rain guard)
    for s in (1, -1):
        px = HULL_HATCH_X + 0.42
        ext.cyl((px, s * HULL_HATCH_Y, Z_ROOF - 0.01), (px, s * HULL_HATCH_Y, Z_ROOF + 0.07), 0.10, mat="paint", seg=32)
        ext.box((px + 0.02, s * HULL_HATCH_Y, Z_ROOF + 0.11), (0.10, 0.20, 0.08), mat="paint", bevel=0.01)
        ext.box((px + 0.075, s * HULL_HATCH_Y, Z_ROOF + 0.11), (0.012, 0.17, 0.045), mat="glass")
        ext.box((px + 0.05, s * HULL_HATCH_Y, Z_ROOF + 0.17), (0.18, 0.26, 0.012), mat="paint")    # rain guard
    # ---- engine deck: louvred grilles, fan covers, engine hatch, fillers, antenna
    for s in (1, -1):
        for (x, y, lx, ly) in DECK_GRILLES:
            for fx, fy, sx, sy in ((x, s * (y + ly / 2), lx, 0.03), (x, s * (y - ly / 2), lx, 0.03),
                                   (x + lx / 2, s * y, 0.03, ly), (x - lx / 2, s * y, 0.03, ly)):
                ext.box((fx, fy, Z_ROOF + 0.02), (sx, sy, 0.04), mat="paint")
            n = int(lx / 0.055)
            for k in range(n):
                xx = x - lx / 2 + (k + 0.5) * lx / n
                ext.box((xx, s * y, Z_ROOF + 0.015), (0.012, ly - 0.03, 0.045), mat="paint", rot=(0, math.radians(30), 0))
        for (x, y, r) in FANS:
            ext.ring((x, s * y, Z_ROOF + 0.02), (0, 0, 1), r - 0.025, r + 0.03, 0.04, mat="paint", seg=64)
            for k in range(-4, 5):   # mesh cover
                d = k * r / 4.6
                h = math.sqrt(max(r * r - d * d, 0.0))
                ext.box((x + d, s * y, Z_ROOF + 0.035), (0.008, 2 * h, 0.008), mat="dark")
                ext.box((x, s * y + d, Z_ROOF + 0.037), (2 * h, 0.008, 0.008), mat="dark")
            ext.cyl((x, s * y, Z_ROOF + 0.02), (x, s * y, Z_ROOF + 0.06), 0.06, mat="paint", seg=24)
        ext.cyl((-2.78, s * 0.24, Z_ROOF - 0.01), (-2.78, s * 0.24, Z_ROOF + 0.04), 0.07, mat="paint", seg=24)    # fuel fillers
        ext.cyl((-2.78, s * 0.24, Z_ROOF + 0.04), (-2.78, s * 0.24, Z_ROOF + 0.05), 0.05, mat="paint", seg=24)
    x, y, lx, ly = ENGINE_HATCH
    ext.box((x, y, Z_ROOF + 0.018), (lx, ly, 0.036), mat="paint", bevel=0.008)
    for k in (-1, 1):
        ext.torus((x + k * 0.3, 0, Z_ROOF + 0.05), (1, 0, 0), 0.04, 0.012, mat="paint", seg=16)
        ext.cyl((x + k * 0.22, 0.22 * k, Z_ROOF + 0.036), (x + k * 0.22, 0.22 * k, Z_ROOF + 0.07), 0.11, mat="paint", seg=32)
    for bx in (-0.40, 0.40):
        for by in (-0.33, 0.33):
            ext.cyl((x + bx, by, Z_ROOF + 0.036), (x + bx, by, Z_ROOF + 0.05), 0.02, mat="paint", seg=6)
    ext.cyl((-2.55, -0.55, Z_ROOF), (-2.55, -0.55, Z_ROOF + 0.12), 0.07, mat="paint", seg=24)   # antenna base
    ext.cyl((-2.55, -0.55, Z_ROOF + 0.12), (-2.55, -0.55, Z_ROOF + 2.1), 0.009, r2=0.004, mat="dark", seg=8)
    # ---- rear plate: exhausts with armoured collars, stowage bins, jack, pintle, idler adjusters
    rn = Vector(hull_upper_planes()[3][0])
    for s in (1, -1):
        p0 = Vector((rear_x_at(EXH_Z), s * EXH_Y, EXH_Z))
        ext.cyl(p0 - rn * 0.02, p0 + rn * 0.07, 0.16, mat="paint", seg=32)           # collar
        pipe = [p0 - Vector((0.05, 0, 0)), p0 + Vector((-0.20, 0, 0)), p0 + Vector((-0.28, 0, 0.08)),
                p0 + Vector((-0.30, 0, 0.25)), p0 + Vector((-0.30, 0, 0.72))]
        ext.tube(pipe, 0.075, mat="dark", seg=20)
        top = p0 + Vector((-0.30, 0, 0.72))
        ext.cyl(top - Vector((0, 0, 0.06)), top + Vector((0, 0, 0.05)), 0.10, mat="dark", seg=24)
        # stowage bins
        bx = rear_x_at(1.58)
        ext.box((bx - 0.19, s * 0.86, 1.58), (0.34, 0.46, 0.40), mat="paint", bevel=0.015)
        ext.box((bx - 0.19, s * 0.86, 1.785), (0.36, 0.48, 0.02), mat="paint")
        for k in (-1, 1):
            ext.box((bx - 0.365, s * 0.86 + k * 0.14, 1.70), (0.012, 0.04, 0.06), mat="dark")
        # idler adjuster housing
        ext.cyl((-3.22, s * (W_LOWER - 0.02), 0.66), (-3.22, s * (W_LOWER + 0.10), 0.66), 0.12, mat="paint", seg=24)
    # cooling tubes beside the left exhaust
    for dy in (0.18, 0.26):
        p0 = Vector((rear_x_at(1.55), dy, 1.55))
        ext.tube([p0, p0 + Vector((-0.12, 0, 0)), p0 + Vector((-0.16, 0, 0.1)), p0 + Vector((-0.16, 0, 0.6))], 0.035, mat="dark", seg=12)
    # jack (Wagenheber) on the rear plate
    jx = rear_x_at(1.25)
    ext.cyl((jx - 0.12, -0.30, 0.95), (jx - 0.12, -0.30, 1.45), 0.07, mat="paint", seg=20)
    ext.cyl((jx - 0.12, -0.30, 1.45), (jx - 0.12, -0.30, 1.52), 0.045, mat="paint", seg=20)
    ext.box((jx - 0.12, -0.30, 0.93), (0.18, 0.18, 0.04), mat="paint")
    # towing pintle
    ext.box((X_REAR_BOTTOM - 0.12, 0, 0.72), (0.22, 0.24, 0.16), mat="paint", bevel=0.01)
    ext.torus((X_REAR_BOTTOM - 0.26, 0, 0.72), (0, 0, 1), 0.07, 0.022, mat="dark", seg=24)
    # Notek rear light + starter crank cover
    ext.box((rear_x_at(1.45) - 0.06, 0.70, 1.45), (0.1, 0.14, 0.08), mat="dark")
    ext.cyl((rear_x_at(1.00) + 0.02, 0, 1.00), (rear_x_at(1.00) - 0.05, 0, 1.00), 0.10, mat="paint", seg=24)
    # ---- skirt rails
    for s in (1, -1):
        ext.box((-0.15, s * (W_SPONSON - 0.005), Z_SPONSON + 0.03), (5.6, 0.03, 0.05), mat="paint")
        for k in range(6):
            xx = -2.75 + k * 1.05
            ext.box((xx, s * (W_SPONSON + 0.02), Z_SPONSON + 0.02), (0.06, 0.06, 0.08), mat="paint")
    obj = build(ext, coll, root, bevel=0.004)
    return obj


def side_frame(s, x, z, out=0.0):
    """Matrix placing tool geometry on the upper side plate (local X along hull, Z = plate normal)."""
    y = W_SPONSON - (z - Z_SPONSON) * math.tan(SIDE_SLOPE)
    n = Vector((0, s * math.cos(SIDE_SLOPE), math.sin(SIDE_SLOPE)))
    X = Vector((1, 0, 0))
    Y = n.cross(X)
    Mr = Matrix((X, Y, n)).transposed().to_4x4()
    return Matrix.Translation(Vector((x, s * y, z)) + n * out) @ Mr


def build_tools(coll, root):
    t = P("hull_tools")

    def clamp(M, x, w=0.05, h=0.05):
        t.box(M @ Vector((x, 0, h / 2)), (0.03, w * 2.2, 0.012), mat="paint", rot=M.to_3x3())

    for s in (1, -1):
        # tow cable with thimble eyes
        M = side_frame(s, 0, 1.33)
        pts = [M @ Vector((x, 0.0, 0.03)) for x in (-2.4, 1.6)]
        for off in (-0.035, 0.035):
            o = M.to_3x3() @ Vector((0, off, 0))
            t.cyl(pts[0] + o, pts[1] + o, 0.022, mat="cable", seg=10)
        for x in (-2.45, 1.65):
            t.torus(M @ Vector((x, 0, 0.03)), M.to_3x3() @ Vector((0, 0, 1)), 0.07, 0.02, mat="cable", seg=16)
        for x in (-1.8, -0.4, 1.0):
            clamp(M, x)
    # left side: barrel cleaning rod tube + crowbar
    M = side_frame(1, 0, 1.62)
    t.cyl(M @ Vector((-2.2, 0, 0.07)), M @ Vector((1.25, 0, 0.07)), 0.065, mat="paint", seg=20)
    t.cyl(M @ Vector((1.25, 0, 0.07)), M @ Vector((1.29, 0, 0.07)), 0.07, mat="paint", seg=20)
    for x in (-1.7, -0.4, 0.9):
        t.box(M @ Vector((x, 0, 0.07)), (0.04, 0.17, 0.16), mat="paint", rot=M.to_3x3())
    M = side_frame(1, 0, 1.82)
    t.cyl(M @ Vector((-1.9, 0, 0.03)), M @ Vector((-0.4, 0, 0.03)), 0.022, mat="dark", seg=8)
    # right side: shovel, axe, sledgehammer, track-pin tool
    M = side_frame(-1, 0, 1.64)
    R3 = M.to_3x3()
    t.cyl(M @ Vector((-2.2, 0, 0.035)), M @ Vector((-1.25, 0, 0.035)), 0.02, mat="wood", seg=10)
    t.box(M @ Vector((-1.10, 0, 0.03)), (0.30, 0.22, 0.012), mat="dark", rot=R3)          # shovel blade
    t.cyl(M @ Vector((-0.9, 0.08, 0.03)), M @ Vector((0.0, 0.08, 0.03)), 0.02, mat="wood", seg=10)
    t.box(M @ Vector((0.03, 0.10, 0.03)), (0.05, 0.20, 0.04), mat="dark", rot=R3)          # axe head
    t.cyl(M @ Vector((0.3, 0, 0.035)), M @ Vector((1.15, 0, 0.035)), 0.022, mat="wood", seg=10)
    t.box(M @ Vector((1.20, 0, 0.05)), (0.10, 0.10, 0.09), mat="dark", rot=R3)            # sledge
    for x in (-1.9, -1.4, -0.7, -0.2, 0.6, 1.0):
        clamp(M, x)
    return build(t, coll, root, bevel=0.0)


# ============================================================================= running gear
M_XZ = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
DISC_PROF = [(0, -0.045), (0.09, -0.045), (0.12, -0.03), (0.30, -0.035), (0.345, -0.05), (0.372, -0.05),
             (0.372, 0.05), (0.345, 0.05), (0.30, 0.035), (0.15, 0.045), (0.12, 0.062), (0.075, 0.075), (0, 0.075)]
TYRE_PROF = [(0.365, -0.05), (0.405, -0.05), (0.428, -0.036), (0.432, 0), (0.428, 0.036), (0.405, 0.05), (0.365, 0.05)]


def wheel_disc(p, c, facing):
    """Road wheel disc (steel disc + rubber tyre + hub bolts) centred at c, hub face towards facing (+1/-1 Y)."""
    M = Matrix.Translation(c) @ Matrix.Rotation(-math.pi / 2 * facing, 4, "X")
    p.lathe(DISC_PROF, seg=64, mat="paint", M=M)
    p.lathe(TYRE_PROF, seg=64, mat="rubber", M=M, closed=True)
    for k in range(16):
        a = 2 * math.pi * k / 16
        q = c + Vector((0.095 * math.cos(a), facing * 0.068, 0.095 * math.sin(a)))
        p.cyl(q, q + Vector((0, facing * 0.02, 0)), 0.011, mat="dark", seg=6)
    for k in range(8):
        a = 2 * math.pi * k / 8 + 0.2
        q = c + Vector((0.335 * math.cos(a), facing * 0.045, 0.335 * math.sin(a)))
        p.cyl(q, q + Vector((0, facing * 0.012, 0)), 0.012, mat="dark", seg=6)


def build_running_gear(coll, root, s):
    side = "L" if s > 0 else "R"
    g = P(f"running_gear_{side}")
    # road wheel stations: outer row (even index) discs at Y_OUTER_ROW, inner row at Y_INNER_ROW
    for i, x in enumerate(STATION_X):
        ys = Y_OUTER_ROW if i % 2 == 0 else Y_INNER_ROW
        for j, yy in enumerate(ys):
            facing = s if j == 0 else -s
            wheel_disc(g, Vector((x, s * yy, WHEEL_Z)), facing)
        # hub axle through both discs and to the hull, torsion swing arm
        g.cyl((x, s * W_LOWER, WHEEL_Z), (x, s * (ys[0] - 0.04), WHEEL_Z), 0.06, mat="dark", seg=16)
        arm_p = Vector((x + 0.36, s * (W_LOWER + 0.04), WHEEL_Z + 0.20))
        g.box((arm_p + Vector((x, s * (W_LOWER + 0.04), WHEEL_Z))) / 2, ((arm_p - Vector((x, 0, WHEEL_Z))).xz.length, 0.07, 0.12),
              mat="paint", rot=(0, -math.atan2(arm_p.z - WHEEL_Z, arm_p.x - x), 0))
        g.cyl(arm_p - Vector((0, s * 0.05, 0)), arm_p + Vector((0, s * 0.05, 0)), 0.09, mat="paint", seg=20)
    # drive sprocket: final drive housing, two 17-tooth rings, hub with bolts
    gx, gz = SPROCKET
    g.cyl((gx, s * (W_LOWER - 0.02), gz), (gx, s * 1.05, gz), 0.33, mat="paint", seg=48)
    for k in range(16):
        a = 2 * math.pi * k / 16
        q = Vector((gx + 0.29 * math.cos(a), s * 1.05, gz + 0.29 * math.sin(a)))
        g.cyl(q, q + Vector((0, s * 0.02, 0)), 0.014, mat="dark", seg=6)
    gear = gear_outline(SPROCKET_TEETH, SPROCKET_RP - 0.05, SPROCKET_RP + 0.045, tooth_frac=0.45)
    for yy in (1.17, 1.45):
        g.prism(gear, s * (yy - 0.02), s * (yy + 0.02), mat="paint", M=Matrix.Translation((gx, 0, gz)) @ M_XZ)
    g.lathe([(0, 1.05), (0.30, 1.05), (0.30, 1.12), (0.25, 1.17), (0.25, 1.45), (0.21, 1.52), (0.12, 1.55), (0.08, 1.60), (0, 1.60)],
            seg=48, mat="paint", M=Matrix.Translation((gx, 0, gz)) @ Matrix.Rotation(-math.pi / 2 * s, 4, "X"))
    for k in range(10):
        a = 2 * math.pi * k / 10
        q = Vector((gx + 0.17 * math.cos(a), s * 1.53, gz + 0.17 * math.sin(a)))
        g.cyl(q, q + Vector((0, s * 0.03, 0)), 0.016, mat="dark", seg=6)
    # idler: two cast discs with six lightening holes each (separate object, cut with booleans)
    ix, iz = IDLER
    idl = P(f"idler_{side}")
    prof = [(0, -0.035), (0.10, -0.035), (0.29, -0.02), (0.33, -0.035), (0.335, 0), (0.33, 0.035), (0.29, 0.02),
            (0.10, 0.035), (0, 0.035)]
    idl.lathe(prof, seg=64, M=Matrix.Translation((ix, s * 1.20, iz)) @ Matrix.Rotation(-math.pi / 2, 4, "X"))
    idl2 = P("idler_b")
    idl2.lathe(prof, seg=64, M=Matrix.Translation((ix, s * 1.42, iz)) @ Matrix.Rotation(-math.pi / 2, 4, "X"))
    holes = []
    for k in range(6):
        a = 2 * math.pi * k / 6
        h = P("h")
        h.cyl((ix + 0.20 * math.cos(a), s * 1.0, iz + 0.20 * math.sin(a)), (ix + 0.20 * math.cos(a), s * 1.6, iz + 0.20 * math.sin(a)),
              0.065, seg=24)
        holes.append(h)
    io = csg(f"idler_{side}", coll, idl, [("UNION", [idl2]), ("DIFFERENCE", holes)])
    io.data.materials.clear()
    io.data.materials.append(MATS["paint"])
    set_parent(io, root)
    finish(io, bevel=0.006)
    g.cyl((ix, s * 1.05, iz), (ix, s * 1.56, iz), 0.10, mat="paint", seg=24)
    g.cyl((ix, s * 1.56, iz), (ix, s * 1.60, iz), 0.07, mat="paint", seg=24)
    g.box(((ix - 3.22) / 2 - 0.0, s * 1.00, (iz + 0.66) / 2), (0.40, 0.08, 0.10), mat="paint",
          rot=(0, -math.atan2(0.66 - iz, -3.22 - ix), 0))
    # return roller behind the sprocket
    g.cyl((2.22, s * (W_LOWER - 0.01), 0.86), (2.22, s * 1.12, 0.86), 0.04, mat="dark", seg=12)
    g.cyl((2.22, s * 1.12, 0.86), (2.22, s * 1.50, 0.86), 0.10, mat="rubber", seg=24)
    obj = build(g, coll, root, bevel=0.0, smooth=math.radians(40))
    return obj


def track_link_template():
    """Kgs 64/660/150 link in link space: X along the track (pitch), Y across, Z outward (ground)."""
    p = P("link")
    pw = TRACK_PITCH
    # shoe with chevron grousers
    p.box((0, 0, -0.015), (pw * 0.80, TRACK_W, 0.07), mat="track")
    for sgn in (1, -1):
        for k in range(2):
            y = sgn * (0.08 + k * 0.14)
            p.box((0.0, y, 0.035), (0.035, 0.12, 0.03), mat="track", rot=(0, 0, sgn * math.radians(18)))
    p.box((0, 0, 0.035), (0.035, 0.06, 0.03), mat="track")
    p.box((0, 0, -0.052), (pw * 0.55, 0.24, 0.006), mat="track")                                  # polished runway
    # hinge knuckles (4 on one end, 3 on the other)
    for k in range(4):
        y = -0.30 + k * 0.2
        p.cyl((pw / 2 - 0.03, y - 0.06, -0.02), (pw / 2 - 0.03, y + 0.06, -0.02), 0.03, mat="track", seg=10)
    for k in range(3):
        y = -0.20 + k * 0.2
        p.cyl((-pw / 2 + 0.03, y - 0.06, -0.02), (-pw / 2 + 0.03, y + 0.06, -0.02), 0.03, mat="track", seg=10)
    # central guide horn on the inner face
    p.prism([(-0.045, -0.04), (0.045, -0.04), (0.03, -0.155), (-0.03, -0.155)], -0.025, 0.025, mat="track",
            M=Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    bm = p.bm
    verts = [v.co.copy() for v in bm.verts]
    bm.verts.index_update()
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return verts, faces


def build_tracks(coll, root, s):
    verts, faces = track_link_template()
    pts, tans, L = resample_closed(track_centreline(), count=87)
    t = P(f"track_{'L' if s > 0 else 'R'}")
    for p, tg in zip(pts, tans):
        T = Vector((tg[0], 0, tg[1]))
        n = Vector((tg[1], 0, -tg[0]))           # outward
        Yv = n.cross(T)
        Mr = Matrix((T, Yv, n)).transposed().to_4x4()
        M = Matrix.Translation((p[0], s * Y_TRACK_C, p[1])) @ Mr
        t.mesh(verts, faces, mat="track", M=M)
    obj = t.build(coll, MATS)
    obj.data.shade_smooth()
    obj.data.set_sharp_from_angle(angle=math.radians(30))
    set_parent(obj, root)
    print(f"track {s}: loop {L:.3f} m, 87 links, pitch {L / 87 * 1000:.1f} mm", flush=True)
    return obj


def build_skirts(coll, root):
    sk = P("side_skirts")
    for s in (1, -1):
        for k in range(5):
            x0 = -2.85 + k * 1.13
            sk.box((x0 + 0.55, s * (W_SPONSON + 0.05), 0.93), (1.10, 0.005 + 0.0, 0.42), mat="paint")
            sk.box((x0 + 0.55, s * (W_SPONSON + 0.05), 0.93), (1.10, 0.006, 0.42), mat="paint")
    obj = build(sk, coll, root)
    return obj


# ============================================================================= turret
def turret_detail_planes():
    tp = turret_planes()
    # sloped front roof (roof drops towards the front plate)
    d = Vector((0.40, 0, -0.085)).normalized()
    n = Vector((-d.z, 0, d.x))
    tp.append(plane((0.42, 0, T_ROOF_Z), n))
    return tp


def build_turret_armour(coll, turret):
    TF = turret.matrix_world.copy()
    tp = turret_detail_planes()
    base = P("turret_armour", TF)
    base.convex(tp)
    inner = offset(tp, [-0.5, TT_ROOF, TT_FRONT, TT_REAR, TT_SIDE, TT_SIDE, TT_ROOF])
    cav = P("c", TF)
    cav.convex(inner)
    holes = []

    def hc(p0, p1, r, seg=48):
        h = P("h", TF)
        h.cyl(p0, p1, r, seg=seg)
        holes.append(h)
    hc((CUPOLA.x, CUPOLA.y, 0.5), (CUPOLA.x, CUPOLA.y, 1.2), 0.30, 64)            # cupola opening
    hc((0.28, -0.48, 0.6), (0.28, -0.48, 1.0), 0.07, 24)                          # loader periscope
    hc((0.30, 0.02, 0.6), (0.30, 0.02, 1.0), 0.09, 24)                            # ventilator
    hc((-0.62, -0.40, 0.6), (-0.62, -0.40, 1.0), 0.06, 24)                        # close defence weapon
    rn = Vector((-math.cos(T_REAR_SLOPE), 0, math.sin(T_REAR_SLOPE)))
    rc = Vector((T_REAR_X + 0.40 * math.tan(T_REAR_SLOPE), 0, 0.40))
    hc(rc + rn * 0.1, rc - rn * 0.2, 0.24, 64)                                    # rear escape hatch
    h = P("h", TF)
    h.box((T_FRONT_X - 0.05, 0, GUN_Z), (0.4, 0.50, 0.40))                        # gun opening behind mantlet
    holes.append(h)
    obj = csg("turret_armour", coll, base, [("DIFFERENCE", [cav] + holes)])
    # classify in world space: transform planes by TF
    Mi = TF.inverted()
    me = obj.data
    me.materials.clear()
    me.materials.append(MATS["paint_t"])
    me.materials.append(MATS["ivory"])
    for p in me.polygons:
        c = np.array(Mi @ p.center)
        p.material_index = 1 if all(np.dot(n, c) <= d + 0.003 for n, d in inner) else 0
    set_parent(obj, turret)
    finish(obj, bevel=0.012)
    return obj, rc, rn


def build_turret_exterior(coll, turret, rc, rn):
    TF = turret.matrix_world.copy()
    t = P("turret_details", TF)
    # ---- commander's cupola (cast), periscope hoods, AA ring
    c = Vector((CUPOLA.x, CUPOLA.y, 0))
    top = T_ROOF_Z + CUPOLA_TOP
    prof = [(0.30, T_ROOF_Z - 0.10), (CUPOLA_R + 0.02, T_ROOF_Z - 0.10), (CUPOLA_R + 0.02, T_ROOF_Z + 0.03),
            (CUPOLA_R - 0.02, T_ROOF_Z + 0.06), (CUPOLA_R - 0.035, T_ROOF_Z + 0.075), (CUPOLA_R - 0.035, T_ROOF_Z + 0.135),
            (CUPOLA_R, T_ROOF_Z + 0.15), (CUPOLA_R, top - 0.01), (CUPOLA_R - 0.01, top), (0.305, top), (0.305, T_ROOF_Z - 0.10)]
    t.lathe(prof, seg=96, mat="paint_t", M=Matrix.Translation(c), closed=True)
    for k in range(7):
        a = math.radians(-90 + k * 360 / 7)
        d = Vector((math.cos(a), math.sin(a), 0))
        q = c + d * (CUPOLA_R - 0.03) + Vector((0, 0, T_ROOF_Z + 0.105))
        R3 = Matrix((d, Vector((0, 0, 1)).cross(d), Vector((0, 0, 1)))).transposed()
        t.box(q, (0.03, 0.16, 0.05), mat="glass", rot=R3)
        t.box(q + d * 0.03 + Vector((0, 0, 0.045)), (0.07, 0.2, 0.012), mat="paint_t", rot=R3)    # rain guard
    # Fliegerbeschussgeraet (AA MG ring) on the cupola
    t.torus(c + Vector((0, 0, top + 0.045)), (0, 0, 1), CUPOLA_R - 0.02, 0.012, mat="dark", seg=64)
    for k in range(6):
        a = 2 * math.pi * k / 6
        q = c + Vector((math.cos(a), math.sin(a), 0)) * (CUPOLA_R - 0.02)
        t.cyl(q + Vector((0, 0, top - 0.005)), q + Vector((0, 0, top + 0.045)), 0.01, mat="dark", seg=6)
    # ---- loader periscope, ventilator, close-defence weapon, crane sockets, lifting lugs
    t.box((0.28, -0.48, T_ROOF_Z + 0.03), (0.2, 0.22, 0.09), mat="paint_t", bevel=0.01)
    t.box((0.385, -0.48, T_ROOF_Z + 0.04), (0.012, 0.16, 0.04), mat="glass")
    t.box((0.40, -0.48, T_ROOF_Z + 0.085), (0.1, 0.24, 0.01), mat="paint_t")
    t.cyl((0.30, 0.02, T_ROOF_Z - 0.03), (0.30, 0.02, T_ROOF_Z + 0.06), 0.14, r2=0.12, mat="paint_t", seg=40)
    t.cyl((0.30, 0.02, T_ROOF_Z + 0.06), (0.30, 0.02, T_ROOF_Z + 0.075), 0.08, mat="paint_t", seg=40)
    t.cyl((-0.62, -0.40, T_ROOF_Z - 0.02), (-0.62, -0.40, T_ROOF_Z + 0.07), 0.12, mat="paint_t", seg=40)
    t.cyl((-0.62, -0.40, T_ROOF_Z + 0.07), (-0.62, -0.40, T_ROOF_Z + 0.10), 0.06, mat="paint_t", seg=24)
    for (x, y) in ((0.52, 0.42), (0.52, -0.22), (-1.05, -0.12)):
        zr = T_ROOF_Z if x < 0.42 else T_ROOF_Z - (x - 0.42) * 0.21
        t.cyl((x, y, zr - 0.02), (x, y, zr + 0.05), 0.045, mat="paint_t", seg=16)
        t.cyl((x, y, zr + 0.05), (x, y, zr + 0.08), 0.06, r2=0.045, mat="paint_t", seg=16)
    # ---- rear escape hatch frame + hinge
    t.ring(rc + rn * 0.01, rn, 0.24, 0.28, 0.03, mat="paint_t", seg=64)
    # ---- spare track links on hooks on both turret sides
    lv, lf = track_link_template()
    tpl = turret_planes()
    for s, pl in ((1, tpl[4]), (-1, tpl[5])):
        n = Vector(pl[0])
        up = Vector((0, 0, 1)) - n * n.z
        up.normalize()
        along = up.cross(n) * s
        for k in range(4):
            x = -1.02 + k * 0.16
            z = 0.36
            hw = turret_halfwidth(x, z)
            p = Vector((x, s * hw, z)) + n * 0.055
            R3 = Matrix((along.normalized(), up, -n)).transposed()
            if R3.determinant() < 0:
                R3 = Matrix((-along.normalized(), up, -n)).transposed()
            t.mesh(lv, lf, mat="track", M=Matrix.Translation(p) @ R3.to_4x4())
        for x in (-1.08, -0.50):
            hw = turret_halfwidth(x, 0.62)
            p = Vector((x, s * hw, 0.62))
            t.cyl(p - n * 0.01, p + n * 0.12, 0.018, mat="paint_t", seg=8)
    obj = build(t, coll, turret, bevel=0.0)
    return obj


def build_mantlet_and_gun(coll, gun):
    GF = gun.matrix_world.copy() @ Matrix.Translation((-TRUNNION_X, 0, -GUN_Z))   # turret-local coordinates
    # chin mantlet (cast Topfblende with Kinn)
    m = P("mantlet", GF)
    prof = mantlet_profile(chin=True)
    m.prism(prof, -0.66, 0.66, mat="paint_t", M=Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    fr = P("mantlet_front", GF)                    # rounded shoulders seen from the front
    fr.prism(mantlet_front_profile(), 0.5, 1.6, M=Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    x_front = max(q[0] for q in prof)
    cuts = []
    for (y, z, r) in ((0.0, GUN_Z, 0.10), (-0.30, GUN_Z + 0.02, 0.035), (0.29, GUN_Z + 0.06, 0.04)):
        h = P("h", GF)
        h.cyl((0.6, y, z), (1.6, y, z), r, seg=32)
        cuts.append(h)
    mobj = csg("mantlet", coll, m, [("INTERSECT", [fr]), ("DIFFERENCE", cuts)])
    mobj.data.materials.clear()
    mobj.data.materials.append(MATS["paint_t"])
    set_parent(mobj, gun)
    finish(mobj, bevel=0.035, seg=3)
    # details: bolts, gun sleeve, coax MG muzzle, sight aperture ring
    g = P("gun", GF)
    x0 = x_front
    for k in range(8):
        a = 2 * math.pi * (k + 0.5) / 8
        q = Vector((x0 - 0.02, 0.14 * math.cos(a), GUN_Z + 0.14 * math.sin(a)))
        g.cyl(q, q + Vector((0.03, 0, 0)), 0.018, mat="paint_t", seg=6)
    g.cyl((x0 - 0.04, 0, GUN_Z), (x0 + 0.34, 0, GUN_Z), 0.125, r2=0.115, mat="paint_t", seg=48)     # Rohrwiege sleeve
    g.cyl((x0 + 0.34, 0, GUN_Z), (x0 + 0.40, 0, GUN_Z), 0.13, mat="paint_t", seg=48)
    # KwK 42 L/70 barrel (tapered monobloc) and double-baffle muzzle brake
    bprof = [(0, x0 + 0.40), (0.098, x0 + 0.40), (0.092, 2.3), (0.085, 3.3), (0.078, MUZZLE_X - 0.47),
             (0.082, MUZZLE_X - 0.46), (0, MUZZLE_X - 0.46)]
    g.lathe(bprof, seg=48, mat="paint_t", M=Matrix.Translation((0, 0, GUN_Z)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
    mb = P("mb", GF)
    mb.lathe([(0, MUZZLE_X - 0.47), (0.12, MUZZLE_X - 0.47), (0.125, MUZZLE_X - 0.44), (0.125, MUZZLE_X - 0.03),
              (0.115, MUZZLE_X), (0, MUZZLE_X)], seg=48, M=Matrix.Translation((0, 0, GUN_Z)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
    mcut = []
    for (xa, xb) in ((MUZZLE_X - 0.40, MUZZLE_X - 0.27), (MUZZLE_X - 0.20, MUZZLE_X - 0.07)):
        h = P("h", GF)
        h.box(((xa + xb) / 2, 0, GUN_Z), (xb - xa, 0.4, 0.17))
        mcut.append(h)
    h = P("h", GF)
    h.cyl((MUZZLE_X - 0.6, 0, GUN_Z), (MUZZLE_X + 0.1, 0, GUN_Z), 0.045, seg=32)
    mcut.append(h)
    mbo = csg("muzzle_brake", coll, mb, [("DIFFERENCE", mcut)])
    mbo.data.materials.clear()
    mbo.data.materials.append(MATS["paint_t"])
    set_parent(mbo, gun)
    finish(mbo, bevel=0.006)
    # bore visible at the muzzle
    g.cyl((MUZZLE_X - 0.5, 0, GUN_Z), (MUZZLE_X - 0.02, 0, GUN_Z), 0.038, mat="black", seg=24)
    g.cyl((1.45, -0.30, GUN_Z + 0.02), (1.52, -0.30, GUN_Z + 0.02), 0.022, mat="dark", seg=12)       # coax MG muzzle
    g.ring((1.40, 0.29, GUN_Z + 0.06), (1, 0, 0), 0.03, 0.05, 0.03, mat="dark", seg=16)
    # ---- inside: breech, cradle, recoil system, deflector guard, TZF 12a, coax MG 34, elevation arc
    g.box((-0.22, 0, GUN_Z), (0.34, 0.38, 0.34), mat="ivory")                                      # breech ring
    g.box((-0.26, 0, GUN_Z - 0.02), (0.20, 0.30, 0.44), mat="steel")                                # sliding breech block
    g.cyl((-0.395, 0, GUN_Z), (-0.39, 0, GUN_Z), 0.04, mat="black", seg=24)
    g.box((-0.30, -0.22, GUN_Z + 0.05), (0.05, 0.06, 0.16), mat="dark")                             # breech lever
    g.cyl((-0.30, -0.25, GUN_Z + 0.12), (-0.45, -0.28, GUN_Z + 0.20), 0.018, mat="dark", seg=10)
    g.box((0.40, 0, GUN_Z), (0.80, 0.34, 0.30), mat="ivory")                                        # cradle
    for y in (-0.09, 0.09):
        g.cyl((-0.05, y, GUN_Z + 0.22), (0.78, y, GUN_Z + 0.22), 0.065, mat="ivory", seg=20)      # recoil / recuperator
        g.cyl((-0.10, y, GUN_Z + 0.22), (-0.05, y, GUN_Z + 0.22), 0.04, mat="steel", seg=16)
    g.cyl((TRUNNION_X, -0.62, GUN_Z), (TRUNNION_X, 0.62, GUN_Z), 0.06, mat="dark", seg=20)          # trunnion
    # deflector guard
    for y in (-0.27, 0.27):
        g.box((-0.72, y, GUN_Z - 0.02), (0.70, 0.012, 0.42), mat="ivory")
    g.box((-1.07, 0, GUN_Z - 0.02), (0.012, 0.55, 0.42), mat="ivory")
    g.tube([(-0.40, -0.27, GUN_Z - 0.23), (-0.75, -0.27, GUN_Z - 0.45), (-1.07, -0.27, GUN_Z - 0.23)], 0.015, mat="ivory", seg=8)
    g.tube([(-0.40, 0.27, GUN_Z - 0.23), (-0.75, 0.27, GUN_Z - 0.45), (-1.07, 0.27, GUN_Z - 0.23)], 0.015, mat="ivory", seg=8)
    g.sphere((-0.74, 0, GUN_Z - 0.36), 0.22, mat="canvas", seg=20, scale=(1.4, 1.0, 0.7))           # case catch bag
    # TZF 12a monocular sight (left of the gun)
    g.cyl((0.02, 0.29, GUN_Z + 0.06), (1.00, 0.29, GUN_Z + 0.06), 0.045, mat="dark", seg=20)
    g.cyl((-0.12, 0.29, GUN_Z + 0.06), (0.02, 0.29, GUN_Z + 0.06), 0.06, mat="dark", seg=20)
    g.cyl((-0.20, 0.29, GUN_Z + 0.06), (-0.12, 0.29, GUN_Z + 0.06), 0.045, mat="rubber", seg=20)
    g.box((0.05, 0.22, GUN_Z + 0.06), (0.08, 0.10, 0.05), mat="dark")
    # coaxial MG 34 with ammunition bag
    g.box((0.50, -0.30, GUN_Z + 0.02), (0.55, 0.07, 0.10), mat="dark")
    g.cyl((0.78, -0.30, GUN_Z + 0.02), (1.45, -0.30, GUN_Z + 0.02), 0.025, mat="dark", seg=12)
    g.box((0.35, -0.38, GUN_Z - 0.05), (0.18, 0.10, 0.16), mat="canvas")
    g.box((0.10, -0.30, GUN_Z + 0.0), (0.15, 0.05, 0.08), mat="wood")
    # elevation arc
    g.lathe([(0.30, -0.02), (0.36, -0.02), (0.36, 0.02), (0.30, 0.02)], seg=24, mat="dark",
            M=Matrix.Translation((TRUNNION_X, 0.20, GUN_Z)) @ Matrix.Rotation(math.pi / 2, 4, "X"),
            a0=math.radians(200), a1=math.radians(250), closed=True)
    gobj = build(g, coll, gun, bevel=0.0)
    return mobj, gobj, mbo


# ============================================================================= hatches (rigged)
def pivot(name, coll, parent, loc_world):
    e = empty(name, coll, size=0.12, kind="ARROWS")
    e.location = loc_world
    set_parent(e, parent)
    return e


def build_hatches(coll, root, turret, rc, rn):
    TF = turret.matrix_world.copy()
    top = T_ROOF_Z + CUPOLA_TOP
    ang = math.radians(-135)
    pv_local = Vector((CUPOLA.x + (CUPOLA_R + 0.06) * math.cos(ang), CUPOLA.y + (CUPOLA_R + 0.06) * math.sin(ang), top))
    pv = pivot("pivot_cupola_hatch", coll, turret, TF @ pv_local)
    h = P("hatch_cupola", TF)
    c = Vector((CUPOLA.x, CUPOLA.y, top))
    h.lathe([(0, top - 0.01), (0.33, top - 0.01), (0.34, top + 0.02), (0.30, top + 0.045), (0.18, top + 0.06), (0, top + 0.065)],
            seg=64, mat="paint_t", M=Matrix.Translation((c.x, c.y, 0)))
    d = pv_local - c
    h.box(c + d / 2 + Vector((0, 0, 0.025)), (d.length, 0.10, 0.05), mat="paint_t", rot=(0, 0, math.atan2(d.y, d.x)))
    h.cyl(pv_local - Vector((0, 0, 0.06)), pv_local + Vector((0, 0, 0.09)), 0.055, mat="paint_t", seg=20)
    h.tube([c + Vector((-0.10, 0.08, 0.06)), c + Vector((-0.10, 0.08, 0.12)), c + Vector((0.10, 0.08, 0.12)),
            c + Vector((0.10, 0.08, 0.06))], 0.012, mat="dark", seg=8)
    h.lathe([(0, top - 0.06), (0.30, top - 0.06), (0.30, top - 0.01), (0, top - 0.01)], seg=64, mat="ivory",
            M=Matrix.Translation((c.x, c.y, 0)))
    ho = h.build(coll, MATS)
    set_parent(ho, pv)
    finish(ho, bevel=0.005)
    # hull hatches: lift and swing on an outboard post
    hulls = []
    for s, name in ((1, "driver"), (-1, "radio")):
        post = Vector((HULL_HATCH_X, s * (HULL_HATCH_Y + 0.34), Z_ROOF))
        pvh = pivot(f"pivot_{name}_hatch", coll, root, post)
        hp = P(f"hatch_{name}")
        cc = Vector((HULL_HATCH_X, s * HULL_HATCH_Y, Z_ROOF))
        hp.lathe([(0, Z_ROOF - 0.005), (0.30, Z_ROOF - 0.005), (0.31, Z_ROOF + 0.02), (0.27, Z_ROOF + 0.045),
                  (0, Z_ROOF + 0.055)], seg=64, mat="paint", M=Matrix.Translation((cc.x, cc.y, 0)))
        hp.lathe([(0, Z_ROOF - 0.045), (0.245, Z_ROOF - 0.045), (0.245, Z_ROOF - 0.004), (0, Z_ROOF - 0.004)], seg=64,
                 mat="ivory", M=Matrix.Translation((cc.x, cc.y, 0)))
        hp.box((cc + post) / 2 + Vector((0, 0, 0.03)), (0.10, (post - cc).length, 0.05), mat="paint")
        hp.cyl(post + Vector((0, 0, -0.10)), post + Vector((0, 0, 0.10)), 0.06, mat="paint", seg=20)
        hp.tube([cc + Vector((-0.12, 0, 0.05)), cc + Vector((-0.12, 0, 0.10)), cc + Vector((0.0, 0, 0.10)),
                 cc + Vector((0.0, 0, 0.05))], 0.012, mat="dark", seg=8)
        o = build(hp, coll, None, bevel=0.005)
        set_parent(o, pvh)
        hulls.append(pvh)
    # turret rear escape hatch, hinged at its upper edge
    TFi = TF
    hinge_l = rc + Vector((0, 0, 0.28)) + rn * 0.02
    side_axis = Vector((0, 1, 0))
    pvr = pivot("pivot_turret_rear_hatch", coll, turret, TFi @ hinge_l)
    rh = P("hatch_turret_rear", TF)
    R3 = track_to(rn)
    rh.lathe([(0, -0.03), (0.27, -0.03), (0.27, 0.02), (0.25, 0.04), (0, 0.05)], seg=64, mat="paint_t",
             M=Matrix.Translation(rc + rn * 0.005) @ R3.to_4x4())
    rh.lathe([(0, -0.07), (0.235, -0.07), (0.235, -0.03), (0, -0.03)], seg=64, mat="ivory",
             M=Matrix.Translation(rc + rn * 0.005) @ R3.to_4x4())
    rh.cyl(hinge_l - side_axis * 0.14, hinge_l + side_axis * 0.14, 0.035, mat="paint_t", seg=16)
    rh.tube([rc + rn * 0.05 + Vector((0, -0.08, -0.08)), rc + rn * 0.11 + Vector((0, -0.08, -0.08)),
             rc + rn * 0.11 + Vector((0, 0.08, -0.08)), rc + rn * 0.05 + Vector((0, 0.08, -0.08))], 0.012, mat="dark", seg=8)
    ro = rh.build(coll, MATS)
    set_parent(ro, pvr)
    finish(ro, bevel=0.005)
    return pv, hulls, pvr


# ============================================================================= interior: hull
def build_hull_interior(coll, root):
    i = P("hull_interior")
    zf = Z_BOTTOM + T_FLOOR
    wi = W_LOWER - T_LSIDE
    # floor plates (fighting compartment) and escape hatch
    i.box((0.3, 0, zf + 0.008), (3.1, 2 * wi - 0.02, 0.016), mat="floor")
    i.cyl((0.9, -0.45, zf), (0.9, -0.45, zf + 0.025), 0.22, mat="floor", seg=32)
    # ---- driver station (left)
    for s, who in ((1, "driver"), (-1, "radio")):
        y = s * 0.55
        i.box((1.86, y, zf + 0.30), (0.08, 0.08, 0.60), mat="dark")                                # seat post
        i.box((1.86, y, zf + 0.42), (0.42, 0.42, 0.10), mat="leather", bevel=0.02)                 # cushion
        i.box((1.62, y, zf + 0.78), (0.08, 0.40, 0.46), mat="leather", bevel=0.02, rot=(0, math.radians(-12), 0))
        i.box((1.66, y, zf + 0.78), (0.03, 0.44, 0.50), mat="dark", rot=(0, math.radians(-12), 0))
    for dy in (0.40, 0.70):   # steering levers with grips
        i.tube([(2.40, dy, zf + 0.10), (2.38, dy, zf + 0.55), (2.22, dy, zf + 0.92)], 0.022, mat="dark", seg=10)
        i.cyl((2.22, dy, zf + 0.92), (2.18, dy, zf + 1.02), 0.03, mat="rubber", seg=12)
    for dy, h in ((0.44, 0.18), (0.56, 0.18), (0.66, 0.14)):   # clutch / brake / accelerator pedals
        i.tube([(2.62, dy, zf + 0.05), (2.55, dy, zf + h)], 0.018, mat="dark", seg=8)
        i.box((2.54, dy, zf + h), (0.06, 0.08, 0.02), mat="dark", rot=(0, math.radians(-30), 0))
    # instrument panel (left, ahead of the driver) with gauges
    pc = Vector((2.02, 1.02, 1.42))
    i.box((2.02, 1.02, 1.28), (0.05, 0.05, 0.28), mat="ivory")
    i.box(pc, (0.34, 0.03, 0.26), mat="ivory")
    for k, (dx, dz) in enumerate(((-0.10, 0.06), (0.0, 0.06), (0.10, 0.06), (-0.10, -0.06), (0.0, -0.06), (0.10, -0.06))):
        q = pc + Vector((dx, -0.016, dz))
        i.cyl(q, q + Vector((0, -0.012, 0)), 0.04, mat="black", seg=20)
        i.cyl(q + Vector((0, -0.012, 0)), q + Vector((0, -0.014, 0)), 0.033, mat="gauge", seg=20)
    i.box((2.14, 0.84, 1.20), (0.20, 0.12, 0.16), mat="dark")                                      # gyro compass box
    # ---- AK 7-200 gearbox, steering unit, final drive shafts, gear lever
    i.box((2.28, 0, zf + 0.28), (0.72, 0.56, 0.56), mat="engine", bevel=0.03)
    i.cyl((2.28, 0, zf + 0.56), (2.28, 0, zf + 0.64), 0.18, mat="engine", seg=32)
    for k in range(6):
        i.box((1.95 + k * 0.13, 0, zf + 0.56), (0.02, 0.58, 0.03), mat="engine")
    i.cyl((2.62, -wi, zf + 0.32), (2.62, wi, zf + 0.32), 0.21, mat="engine", seg=40)
    for s in (1, -1):
        i.cyl((2.62, s * (wi - 0.16), zf + 0.32), (2.62, s * (wi - 0.02), zf + 0.32), 0.27, mat="engine", seg=40)   # brake drums
    i.tube([(2.00, 0.18, zf + 0.60), (1.98, 0.22, zf + 0.85)], 0.015, mat="dark", seg=8)
    i.sphere((1.98, 0.22, zf + 0.87), 0.035, mat="black", seg=12)
    # propeller shaft (under the turret basket) to the engine
    i.cyl((X_BULKHEAD - 0.1, 0, 0.68), (1.92, 0, 0.68), 0.055, mat="engine", seg=16)
    for x in (-0.6, 0.4, 1.4):
        i.box((x, 0, 0.62), (0.08, 0.20, 0.12), mat="dark")
    # ---- bow MG 34 (inside part) with sight, ammo bag, shoulder stock
    c = on_glacis(*MG_BALL) - GL_N * 0.03
    back = Vector((-1, 0, 0.04)).normalized()
    i.sphere(c, 0.15, mat="ivory", seg=24)
    i.box(c + back * 0.30, (0.45, 0.07, 0.11), mat="dark", rot=(0, math.radians(-2), 0))
    i.box(c + back * 0.62 + Vector((0, 0, -0.03)), (0.22, 0.05, 0.12), mat="wood")
    i.box(c + back * 0.30 + Vector((0, -0.07, -0.12)), (0.16, 0.10, 0.16), mat="canvas")
    i.cyl(c + back * 0.12 + Vector((0, 0.07, 0.09)), c + back * 0.40 + Vector((0, 0.07, 0.09)), 0.03, mat="dark", seg=12)
    # ---- Fu 5 radio sets on the right sponson shelf + intercom
    i.box((1.72, -1.12, 1.22), (0.70, 0.46, 0.03), mat="ivory")
    for k, (dx, h) in enumerate(((-0.17, 0.26), (0.17, 0.26))):
        q = Vector((1.72 + dx, -1.12, 1.235 + h / 2))
        i.box(q, (0.32, 0.36, h), mat="radio", bevel=0.01)
        for j in range(3):
            i.cyl(q + Vector((-0.08 + j * 0.08, 0.18, 0.04)), q + Vector((-0.08 + j * 0.08, 0.20, 0.04)), 0.022, mat="black", seg=12)
        i.box(q + Vector((0, 0.181, -0.05)), (0.22, 0.004, 0.07), mat="gauge")
    i.box((1.25, -0.90, 1.55), (0.14, 0.05, 0.12), mat="radio")
    # ---- sponson ammunition racks (75 mm KwK 42 rounds, horizontal, bins along the hull)
    rounds = P("ammo_hull")
    _, _, up_in_, _ = hull_plane_sets()
    inside = offset(up_in_, 0.005)
    for s in (1, -1):
        wall = [plane((0, s * 0.92, 0), (0, -s, 0))]
        for bx in (-1.05, -0.10):
            i.convex(inside + wall + [plane((bx - 0.01, 0, 0), (-1, 0, 0)), plane((bx + 0.91, 0, 0), (1, 0, 0)),
                                      plane((0, 0, Z_SPONSON + T_SPONSON + 0.02), (0, 0, 1))], mat="ivory")
            for k in (0, 1):
                xk = bx + k * 0.90
                i.convex(inside + wall + [plane((xk - 0.01, 0, 0), (-1, 0, 0)), plane((xk + 0.01, 0, 0), (1, 0, 0)),
                                          plane((0, 0, 1.78), (0, 0, 1))], mat="ivory")
        for zz in (1.23, 1.37, 1.51, 1.65):
            for yy in (0.99, 1.13, 1.27, 1.41):
                side_in = W_SPONSON - T_USIDE / math.cos(SIDE_SLOPE) - (zz + 0.08 - Z_SPONSON) * math.tan(SIDE_SLOPE)
                if yy + 0.075 > side_in:
                    continue
                for bx in (-1.05, -0.10):
                    kind = "shell_he" if (int(zz * 100) + int(yy * 100)) % 3 == 0 else "shell_ap"
                    ax = Matrix.Translation((bx + 0.02, s * yy, zz)) @ Matrix.Rotation(math.pi / 2, 4, "Y")
                    rounds.lathe([(0, 0), (0.072, 0), (0.072, 0.012), (0.066, 0.02), (0.063, 0.58), (0.047, 0.64), (0, 0.64)],
                                 seg=16, mat="brass", M=ax)
                    rounds.lathe([(0, 0.62), (0.0375, 0.62), (0.0375, 0.75), (0.03, 0.83), (0.008, 0.88), (0, 0.885)],
                                 seg=16, mat=kind, M=ax)
    build(rounds, coll, root)
    # ---- firewall (bulkhead) with access panels, fire extinguisher, batteries
    _, _, up_in, lo_in = hull_plane_sets()
    slab = [plane((X_BULKHEAD + 0.006, 0, 0), (1, 0, 0)), plane((X_BULKHEAD - 0.006, 0, 0), (-1, 0, 0))]
    i.convex(offset(up_in, -0.005) + slab, mat="ivory")
    i.convex(offset(lo_in[:1] + lo_in[2:], -0.005) + [plane((0, 0, Z_SPONSON + 0.03), (0, 0, 1))] + slab, mat="ivory")
    for y in (-0.45, 0.45):
        i.box((X_BULKHEAD + 0.012, y, 1.05), (0.012, 0.55, 0.50), mat="ivory")
        for dz in (-0.22, 0.22):
            for dy in (-0.24, 0.24):
                i.cyl((X_BULKHEAD + 0.018, y + dy, 1.05 + dz), (X_BULKHEAD + 0.028, y + dy, 1.05 + dz), 0.012, mat="dark", seg=6)
    i.cyl((X_BULKHEAD + 0.10, 0.75, zf + 0.10), (X_BULKHEAD + 0.10, 0.75, zf + 0.62), 0.07, mat="red", seg=20)
    i.box((X_BULKHEAD + 0.30, -0.66, zf + 0.14), (0.40, 0.30, 0.28), mat="black")
    return build(i, coll, root)


def build_engine_bay(coll, root):
    e = P("engine_bay")
    zf = Z_BOTTOM + T_FLOOR
    ex, ez = -2.22, zf + 0.12
    # Maybach HL 230 P30 V12 (60 deg): crankcase, sump, banks, heads, manifolds, carburettors
    e.box((ex, 0, ez + 0.20), (1.30, 0.62, 0.40), mat="engine", bevel=0.03)
    e.box((ex, 0, ez + 0.02), (1.20, 0.40, 0.10), mat="engine")
    for s in (1, -1):
        R3 = Matrix.Rotation(s * math.radians(-30), 3, "X")
        bank_c = Vector((ex, s * 0.20, ez + 0.52))
        e.box(bank_c, (1.20, 0.26, 0.36), mat="engine", rot=R3)
        for k in range(6):
            cx = ex - 0.50 + k * 0.20
            hc = bank_c + R3 @ Vector((cx - ex, 0, 0.23))
            e.box(hc, (0.17, 0.30, 0.10), mat="alu", rot=R3)
            e.cyl(hc + R3 @ Vector((0, s * 0.10, 0.02)), hc + R3 @ Vector((0, s * 0.20, 0.02)), 0.03, mat="engine", seg=10)
        e.cyl(bank_c + R3 @ Vector((-0.62, s * 0.18, 0.2)), bank_c + R3 @ Vector((0.62, s * 0.18, 0.2)), 0.05, mat="dark", seg=16)
    for k in range(4):
        e.box((ex - 0.36 + k * 0.24, 0, ez + 0.84), (0.14, 0.14, 0.14), mat="alu")
    for s in (1, -1):
        e.cyl((ex + 0.45, s * 0.25, ez + 0.85), (ex + 0.45, s * 0.25, ez + 1.15), 0.14, mat="engine", seg=32)   # air cleaners
        e.cyl((ex + 0.45, s * 0.25, ez + 1.15), (ex + 0.45, s * 0.25, ez + 1.18), 0.10, mat="engine", seg=32)
        # exhaust manifolds to the rear ports
        e.tube([(ex - 0.55, s * 0.40, ez + 0.62), (ex - 0.85, s * 0.44, EXH_Z - 0.04), (rear_x_at(EXH_Z) + 0.05, s * EXH_Y, EXH_Z)],
               0.07, mat="copper", seg=14)
        # radiators and fans in the side compartments
        for dx in (-0.45, 0.45):
            R3 = Matrix.Rotation(s * math.radians(-15), 3, "X")
            rc_ = Vector((-2.22 + dx, s * 1.20, 1.45))
            e.box(rc_, (0.55, 0.36, 0.50), mat="radiator", rot=R3)                        # core
            for fx in (-0.285, 0.285):                                                     # side tanks
                e.box(rc_ + R3 @ Vector((fx, 0, 0)), (0.03, 0.40, 0.54), mat="primer", rot=R3)
            for fz in (-0.26, 0.26):
                e.box(rc_ + R3 @ Vector((0, 0, fz)), (0.60, 0.40, 0.03), mat="primer", rot=R3)
            for k in range(11):                                                            # fin rows
                e.box(rc_ + R3 @ Vector((0, 0, -0.22 + k * 0.044)), (0.54, 0.372, 0.006), mat="alu", rot=R3)
            e.cyl(rc_ + R3 @ Vector((0.20, 0, 0.27)), rc_ + R3 @ Vector((0.20, 0, 0.33)), 0.035, mat="primer", seg=12)
        e.cyl((FANS[0][0], s * FANS[0][1], 1.55), (FANS[0][0], s * FANS[0][1], 1.86), FANS[0][2] - 0.01, mat="primer", seg=40)
        for k in range(8):
            a = 2 * math.pi * k / 8
            e.box((FANS[0][0] + 0.12 * math.cos(a), s * FANS[0][1] + 0.12 * math.sin(a), 1.70), (0.20, 0.05, 0.01),
                  mat="engine", rot=(math.radians(25), 0, a))
        # fuel tanks either side of the engine (lower hull)
        e.box((-1.72, s * 0.70, zf + 0.30), (0.62, 0.30, 0.60), mat="primer", bevel=0.02)
        e.box((-2.80, s * 0.66, zf + 0.30), (0.42, 0.40, 0.60), mat="primer", bevel=0.02)
    # generator, cooling-fan drive shafts, starter
    e.cyl((ex + 0.70, 0, ez + 0.35), (ex + 0.90, 0, ez + 0.35), 0.10, mat="engine", seg=24)
    e.cyl((ex - 0.70, 0, ez + 0.25), (ex - 0.95, 0, ez + 0.25), 0.12, mat="engine", seg=24)
    return build(e, coll, root)


# ============================================================================= interior: turret
def build_turret_interior(coll, turret):
    TF = turret.matrix_world.copy()
    t = P("turret_interior", TF)
    zb = 0.80 - TURRET_ORIGIN.z                     # basket floor (turret local)
    # turret ring race with internal gear teeth
    t.lathe([(RING_R - 0.02, -0.10), (RING_R + 0.05, -0.10), (RING_R + 0.05, 0.0), (RING_R - 0.02, 0.0)], seg=128,
            mat="ivory", closed=True)
    for k in range(96):
        a = 2 * math.pi * k / 96
        t.box((math.cos(a) * (RING_R - 0.03), math.sin(a) * (RING_R - 0.03), -0.07), (0.02, 0.025, 0.05),
              mat="steel", rot=(0, 0, a))
    # basket floor + hangers
    t.cyl((0, 0, zb), (0, 0, zb + 0.02), RING_R - 0.05, mat="floor", seg=96)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        q = Vector((math.cos(a), math.sin(a), 0)) * (RING_R - 0.07)
        t.tube([q + Vector((0, 0, -0.08)), q + Vector((0, 0, zb + 0.02))], 0.025, mat="ivory", seg=10)
    # hydraulic traverse unit + rotary joint + foot pedals
    t.cyl((0, 0, zb), (0, 0, zb + 0.35), 0.10, mat="engine", seg=24)
    t.box((0.38, 0.22, zb + 0.18), (0.36, 0.30, 0.34), mat="engine", bevel=0.02)
    for dy in (0.42, 0.56):
        t.box((0.42, dy, zb + 0.06), (0.16, 0.08, 0.03), mat="dark", rot=(0, math.radians(20), 0))
    # gunner: seat, traverse + elevation handwheels, azimuth indicator
    t.box((0.12, 0.52, -0.30), (0.32, 0.30, 0.07), mat="leather", bevel=0.015)
    t.box((-0.06, 0.52, -0.12), (0.06, 0.28, 0.28), mat="leather", bevel=0.015)
    t.tube([(0.12, 0.52, -0.34), (0.12, 0.52, zb + 0.02)], 0.025, mat="dark", seg=10)
    t.torus((0.44, 0.50, 0.08), (1, 0, 0), 0.11, 0.012, mat="dark", seg=32)
    t.cyl((0.44, 0.50, 0.08), (0.62, 0.50, 0.08), 0.02, mat="dark", seg=10)
    t.torus((0.35, 0.34, 0.22), (0, 1, 0), 0.10, 0.012, mat="dark", seg=32)
    t.cyl((0.35, 0.34, 0.22), (0.35, 0.18, 0.22), 0.02, mat="dark", seg=10)
    t.cyl((0.62, 0.62, 0.30), (0.66, 0.60, 0.30), 0.09, mat="black", seg=24)
    t.cyl((0.66, 0.60, 0.30), (0.665, 0.598, 0.30), 0.08, mat="gauge", seg=24)
    # commander: raised seat + backrest, foot rest
    t.box((-0.55, 0.40, 0.02), (0.30, 0.30, 0.07), mat="leather", bevel=0.015)
    t.box((-0.75, 0.40, 0.22), (0.06, 0.30, 0.32), mat="leather", bevel=0.015)
    t.tube([(-0.55, 0.40, -0.02), (-0.55, 0.62, -0.20), (-0.55, 0.62, zb + 0.02)], 0.025, mat="dark", seg=10)
    t.box((-0.35, 0.45, -0.35), (0.25, 0.25, 0.02), mat="dark")
    # loader: folding seat, spent-case bin, intercom
    t.box((-0.20, -0.58, -0.35), (0.30, 0.26, 0.06), mat="leather", bevel=0.015)
    t.tube([(-0.20, -0.72, -0.35), (-0.20, -0.78, -0.10)], 0.02, mat="dark", seg=8)
    t.box((-0.55, -0.40, zb + 0.20), (0.30, 0.30, 0.40), mat="ivory")
    t.box((-0.10, -0.95, 0.35), (0.14, 0.05, 0.12), mat="radio")
    # cupola interior ring, ventilator housing, turret lamp
    t.lathe([(0.30, T_ROOF_Z - 0.18), (0.36, T_ROOF_Z - 0.18), (0.36, T_ROOF_Z - 0.03), (0.30, T_ROOF_Z - 0.03)], seg=64,
            mat="ivory", M=Matrix.Translation((CUPOLA.x, CUPOLA.y, 0)), closed=True)
    t.cyl((0.30, 0.02, T_ROOF_Z - 0.20), (0.30, 0.02, T_ROOF_Z - TT_ROOF), 0.11, mat="ivory", seg=24)
    t.sphere((-0.10, 0.30, T_ROOF_Z - TT_ROOF - 0.04), 0.03, mat="lamp", seg=12)
    t.box((0.28, -0.48, T_ROOF_Z - 0.10), (0.12, 0.16, 0.14), mat="dark")          # loader periscope body
    return build(t, coll, turret)


# ============================================================================= decals
def text_mesh(body, size, name, extrude=0.0, offset_=0.0):
    cu = D.curves.new(name, "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.offset = offset_
    cu.extrude = extrude
    tmp = D.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(tmp)
    dg = bpy.context.evaluated_depsgraph_get()
    me = D.meshes.new_from_object(tmp.evaluated_get(dg))
    D.objects.remove(tmp, do_unlink=True)
    D.curves.remove(cu)
    return me


def place_mesh(me, coll, name, M, mat, parent):
    o = D.objects.new(name, me)
    coll.objects.link(o)
    me.transform(M)
    me.materials.clear()
    me.materials.append(mat)
    set_parent(o, parent)
    return o


def cross_mesh():
    """Late-war Balkenkreuz: white outline only (Ausf. G, 1944/45)."""
    def arm_poly(w, l):
        return [(-w, -l), (w, -l), (w, -w), (l, -w), (l, w), (w, w), (w, l), (-w, l), (-w, w), (-l, w), (-l, -w), (-w, -w)]
    outer = arm_poly(0.10, 0.34)
    inner = arm_poly(0.075, 0.315)
    bm = bmesh.new()
    vo = [bm.verts.new((x, y, 0)) for x, y in outer]
    vi = [bm.verts.new((x, y, 0)) for x, y in inner]
    for k in range(len(outer)):
        j = (k + 1) % len(outer)
        bm.faces.new((vo[k], vo[j], vi[j], vi[k]))
    me = D.meshes.new("balkenkreuz")
    bm.to_mesh(me)
    bm.free()
    return me


def build_decals(coll, root, turret):
    white, black = MATS["white"], MATS["black"]
    for s in (1, -1):
        n = Vector((0, s * math.cos(SIDE_SLOPE), math.sin(SIDE_SLOPE)))
        z = 1.52
        y = W_SPONSON - (z - Z_SPONSON) * math.tan(SIDE_SLOPE)
        X = Vector((1, 0, 0)) * s
        Yv = n.cross(X)
        M = Matrix.Translation(Vector((-0.55, s * y, z)) + n * 0.004) @ Matrix((X, Yv, n)).transposed().to_4x4()
        place_mesh(cross_mesh(), coll, f"decal_cross_{'L' if s > 0 else 'R'}", M, white, root)
    rn = Vector(hull_upper_planes()[3][0])
    X = Vector((0, -1, 0))
    M = Matrix.Translation(Vector((rear_x_at(1.30), 0.0, 1.30)) + rn * 0.004) @ Matrix((X, rn.cross(X), rn)).transposed().to_4x4()
    place_mesh(cross_mesh(), coll, "decal_cross_rear", M, white, root)
    # turret numbers (black with white outline) on both sides
    TF = turret.matrix_world.copy()
    tpl = turret_planes()
    for s, pl in ((1, tpl[4]), (-1, tpl[5])):
        n = Vector(pl[0])
        up = (Vector((0, 0, 1)) - n * n.z).normalized()
        X = up.cross(n)
        x, z = 0.02, 0.40
        p = Vector((x, s * turret_halfwidth(x, z), z))
        R4 = Matrix((X, up, n)).transposed().to_4x4()
        for body_off, mat, lift in ((0.018, white, 0.003), (0.0, black, 0.005)):
            me = text_mesh("421", 0.34, "num", offset_=body_off)
            place_mesh(me, coll, f"decal_number_{'L' if s > 0 else 'R'}", TF @ Matrix.Translation(p + n * lift) @ R4, mat, turret)


# ============================================================================= rig
def add_driver(obj, path, index, ctrl, prop, expr):
    fc = obj.driver_add(path, index) if index is not None else obj.driver_add(path)
    drv = fc.driver
    drv.type = "SCRIPTED"
    v = drv.variables.new()
    v.name = "v"
    v.type = "SINGLE_PROP"
    v.targets[0].id_type = "OBJECT"
    v.targets[0].id = ctrl
    v.targets[0].data_path = f'["{prop}"]'
    drv.expression = expr
    return fc


def build_rig(root, turret, gun, pv_cupola, pv_hull, pv_rear, cut_objs, skirts):
    ctrl = empty("Panther_Controls", root.users_collection[0], loc=(0, 0, 3.6), size=0.4, kind="SPHERE")
    ctrl.parent = root
    specs = [("turret_traverse", 0.0, -360.0, 360.0, "Turret traverse (deg, + = left)"),
             ("gun_elevation", 0.0, -8.0, 18.0, "Gun elevation (deg)"),
             ("cupola_hatch", 0.0, 0.0, 1.0, "Commander's cupola hatch: 0 closed, 1 open"),
             ("driver_hatch", 0.0, 0.0, 1.0, "Driver's hatch"),
             ("radio_hatch", 0.0, 0.0, 1.0, "Radio operator's hatch"),
             ("turret_rear_hatch", 0.0, 0.0, 1.0, "Turret rear escape hatch"),
             ("cutaway", 0, 0, 1, "Cut the left side away to show the interior"),
             ("skirts", 0, 0, 1, "Show the side skirts (Schuerzen)")]
    for name, val, lo, hi, desc in specs:
        ctrl[name] = val
        ui = ctrl.id_properties_ui(name)
        if isinstance(val, int):
            ui.update(min=lo, max=hi, description=desc)
        else:
            ui.update(min=lo, max=hi, soft_min=lo, soft_max=hi, description=desc)
    k = 0.017453292519943295
    add_driver(turret, "rotation_euler", 2, ctrl, "turret_traverse", f"v*{k}")
    add_driver(gun, "rotation_euler", 1, ctrl, "gun_elevation", f"-v*{k}")
    add_driver(pv_cupola, "location", 2, ctrl, "cupola_hatch", f"{pv_cupola.location.z}+min(v*4,1)*0.03")
    add_driver(pv_cupola, "rotation_euler", 2, ctrl, "cupola_hatch", f"-max(v*1.25-0.25,0)*100*{k}")
    for pvh, prop, s in ((pv_hull[0], "driver_hatch", 1), (pv_hull[1], "radio_hatch", -1)):
        add_driver(pvh, "location", 2, ctrl, prop, f"{pvh.location.z}+min(v*4,1)*0.03")
        add_driver(pvh, "rotation_euler", 2, ctrl, prop, f"{s}*max(v*1.25-0.25,0)*95*{k}")
    add_driver(pv_rear, "rotation_euler", 1, ctrl, "turret_rear_hatch", f"v*80*{k}")
    for o, mod in cut_objs:
        add_driver(mod, "show_viewport", None, ctrl, "cutaway", "v>0.5")
        add_driver(mod, "show_render", None, ctrl, "cutaway", "v>0.5")
    for o in bpy.data.objects:        # left-side markings disappear with the cut
        if o.name.startswith(("decal_cross_L", "decal_number_L")):
            add_driver(o, "hide_render", None, ctrl, "cutaway", "v>0.5")
            add_driver(o, "hide_viewport", None, ctrl, "cutaway", "v>0.5")
    add_driver(skirts, "hide_render", None, ctrl, "skirts", "v<0.5")
    add_driver(skirts, "hide_viewport", None, ctrl, "skirts", "v<0.5")
    return ctrl


def add_cutaway(coll, root, targets):
    """Box cutter removing the left half above the tracks; toggled by Panther_Controls['cutaway']."""
    p = P("cutaway_cutter")
    p.box((0.0, 1.30, 2.35), (9.5, 2.3, 2.3))
    p.box((0.0, 1.95, 1.2), (9.5, 1.0, 1.3))
    cut = p.build(coll)
    cut.display_type = "WIRE"
    cut.hide_render = True
    cut.parent = root
    mods = []
    for o in targets:
        m = o.modifiers.new("cutaway", "BOOLEAN")
        m.operation, m.solver, m.object = "DIFFERENCE", "EXACT", cut
        m.use_self = True             # detail meshes are built from overlapping pieces
        m.use_hole_tolerant = True
        m.show_viewport = False
        m.show_render = False
        # keep the cut before the bevel so the section stays sharp
        o.modifiers.move(o.modifiers.find("cutaway"), 0)
        mods.append((o, m))
    return cut, mods


# ============================================================================= main
def main():
    global MATS
    clear_scene()
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    col_root = get_coll("Panther_Ausf_G")
    c_ext = get_coll("Exterior", col_root)
    c_run = get_coll("Running_gear", col_root)
    c_tur = get_coll("Turret", col_root)
    c_int = get_coll("Interior", col_root)
    c_dec = get_coll("Markings", col_root)
    c_rig = get_coll("Rig", col_root)
    c_opt = get_coll("Optional", col_root)
    root = empty("Panther_Ausf_G", c_rig, size=1.0, kind="PLAIN_AXES")
    turret = empty("turret_root", c_rig, loc=TURRET_ORIGIN, parent=root, size=0.6, kind="CIRCLE")
    turret.rotation_mode = "XYZ"
    bpy.context.view_layer.update()
    gun = empty("gun_pivot", c_rig, size=0.3, kind="ARROWS")
    gun.location = turret.matrix_world @ Vector((TRUNNION_X, 0, GUN_Z))
    set_parent(gun, turret)
    bpy.context.view_layer.update()
    MATS = build_materials(root, turret)

    hull = build_hull_armour(c_ext, root)
    hdet = build_hull_exterior(c_ext, root)
    htools = build_tools(c_ext, root)
    for s in (1, -1):
        build_running_gear(c_run, root, s)
        build_tracks(c_run, root, s)
    skirts = build_skirts(c_opt, root)
    tur, rc, rn = build_turret_armour(c_tur, turret)
    tdet = build_turret_exterior(c_tur, turret, rc, rn)
    mant, gobj, mb = build_mantlet_and_gun(c_tur, gun)
    pv_c, pv_h, pv_r = build_hatches(c_ext, root, turret, rc, rn)
    for o in (pv_c, pv_r):
        for ch in o.children:
            for c in list(ch.users_collection):
                c.objects.unlink(ch)
            c_tur.objects.link(ch)
    build_hull_interior(c_int, root)
    build_engine_bay(c_int, root)
    build_turret_interior(c_int, turret)
    build_decals(c_dec, root, turret)
    hatch_objs = [ch for pv in [pv_c] + list(pv_h) for ch in pv.children]
    cut, mods = add_cutaway(c_rig, root, [hull, tur, mant, hdet, htools, tdet] + hatch_objs)
    build_rig(root, turret, gun, pv_c, pv_h, pv_r, mods, skirts)

    # scene defaults: camera, sun, sky
    cam_d = D.cameras.new("Camera")
    cam_d.lens = 45
    cam = D.objects.new("Camera", cam_d)
    c_rig.objects.link(cam)
    cam.location = (9.8, -8.2, 4.6)
    cam.rotation_euler = (Vector((0.3, 0, 1.2)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    sun_d = D.lights.new("Sun", "SUN")
    sun_d.energy = 4.0
    sun_d.angle = math.radians(3)
    sun = D.objects.new("Sun", sun_d)
    c_rig.objects.link(sun)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    w = sc.world or D.worlds.new("World")
    sc.world = w
    bg = w.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.55, 0.62, 0.72, 1)
        bg.inputs["Strength"].default_value = 0.8
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 128
    sc.view_settings.view_transform = "AgX"
    # stats
    nv = sum(len(o.data.vertices) for o in sc.objects if o.type == "MESH")
    nf = sum(len(o.data.polygons) for o in sc.objects if o.type == "MESH")
    print(f"DETAILED objects={len(sc.objects)} verts={nv} faces={nf}", flush=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUT, compress=True)
    print("SAVED", OUT, flush=True)


MATS = {}
main()
