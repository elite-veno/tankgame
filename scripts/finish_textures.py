"""Texture finishing pass for t34_85_preview.blend.

- paint_green_turret: turret paint with the "124" tactical number decal on both sides.
- paint_green: exhaust soot on the rear plate / deck around the two exhaust pipes.
- paint_green_gun: barrel paint with muzzle blast soot and heavier wear at the muzzle.
"""
import bpy, os

BLEND_DIR = os.path.dirname(bpy.data.filepath)
NUM_PATH = os.path.join(BLEND_DIR, "textures", "turret_number_124.png")


def node(nt, type_, loc, **inputs):
    n = nt.nodes.new(type_)
    n.location = loc
    for k, v in inputs.items():
        if k.startswith("_"):
            setattr(n, k[1:], v)
        else:
            n.inputs[k].default_value = v
    return n


def math(nt, op, loc, a=None, b=None, clamp=False):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    n.location = loc
    n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, bpy.types.NodeSocket):
            nt.links.new(v, n.inputs[i])
        else:
            n.inputs[i].default_value = v
    return n


def map_range(nt, src, fmin, fmax, tmin=0.0, tmax=1.0, loc=(0, 0), smooth=False):
    n = nt.nodes.new("ShaderNodeMapRange")
    n.location = loc
    n.clamp = True
    if smooth:
        n.interpolation_type = "SMOOTHSTEP"
    n.inputs["From Min"].default_value = fmin
    n.inputs["From Max"].default_value = fmax
    n.inputs["To Min"].default_value = tmin
    n.inputs["To Max"].default_value = tmax
    nt.links.new(src, n.inputs["Value"])
    return n


def mix_rgb(nt, fac, a, b, loc):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    n.blend_type = "MIX"
    n.location = loc
    nt.links.new(fac, n.inputs["Factor"])
    for sock, v in ((n.inputs["A"], a), (n.inputs["B"], b)):
        if isinstance(v, bpy.types.NodeSocket):
            nt.links.new(v, sock)
        else:
            sock.default_value = v
    return n


def mix_float(nt, fac, a, b, loc):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "FLOAT"
    n.location = loc
    nt.links.new(fac, n.inputs["Factor"])
    for i, v in ((2, a), (3, b)):
        if isinstance(v, bpy.types.NodeSocket):
            nt.links.new(v, n.inputs[i])
        else:
            n.inputs[i].default_value = v
    return n


def frame(nt, label, nodes):
    f = nt.nodes.new("NodeFrame")
    f.label = label
    for n in nodes:
        n.parent = f
    return f


def reroute_input(nt, to_sock):
    """Return the socket currently feeding to_sock."""
    return to_sock.links[0].from_socket


def remove_by_label(nt, prefix):
    # frames are removed after children
    frames = [n for n in nt.nodes if n.type == "FRAME" and n.label.startswith(prefix)]
    for f in frames:
        for n in list(nt.nodes):
            if n.parent == f:
                nt.nodes.remove(n)
        nt.nodes.remove(f)


def out_sockets(nt):
    bsdf = nt.nodes["Principled BSDF"]
    return bsdf, bsdf.inputs["Base Color"], bsdf.inputs["Roughness"]


# ---------------------------------------------------------------- exhaust soot
def add_exhaust_soot(mat):
    nt = mat.node_tree
    remove_by_label(nt, "FX exhaust soot")
    bsdf, base_in, rough_in = out_sockets(nt)
    base_src, rough_src = reroute_input(nt, base_in), reroute_input(nt, rough_in)
    x0, y0 = 1900, -1400
    geo = node(nt, "ShaderNodeNewGeometry", (x0, y0))
    created = [geo]
    masks = []
    for i, cy in enumerate((-0.6, 0.6)):
        # plume centre sits just above/behind the pipe; ellipsoid falloff stretched upward
        sub = node(nt, "ShaderNodeVectorMath", (x0 + 200, y0 - 180 * i), _operation="SUBTRACT")
        sub.inputs[1].default_value = (-2.93, cy, 1.0)
        nt.links.new(geo.outputs["Position"], sub.inputs[0])
        scl = node(nt, "ShaderNodeVectorMath", (x0 + 380, y0 - 180 * i), _operation="MULTIPLY")
        scl.inputs[1].default_value = (1.0, 0.85, 0.55)
        nt.links.new(sub.outputs[0], scl.inputs[0])
        ln = node(nt, "ShaderNodeVectorMath", (x0 + 560, y0 - 180 * i), _operation="LENGTH")
        nt.links.new(scl.outputs[0], ln.inputs[0])
        masks.append(ln.outputs["Value"])
        created += [sub, scl, ln]
    dmin = math(nt, "MINIMUM", (x0 + 740, y0), masks[0], masks[1])
    # vertically stretched noise -> streaky deposits rather than a clean blob
    streak = node(nt, "ShaderNodeVectorMath", (x0 + 380, y0 - 420), _operation="MULTIPLY")
    streak.inputs[1].default_value = (5.0, 5.0, 1.2)
    nt.links.new(geo.outputs["Position"], streak.inputs[0])
    noise = node(nt, "ShaderNodeTexNoise", (x0 + 560, y0 - 420), Scale=3.0, Detail=7.0, Roughness=0.68)
    nt.links.new(streak.outputs[0], noise.inputs["Vector"])
    jitter = math(nt, "MULTIPLY_ADD", (x0 + 740, y0 - 300), noise.outputs["Fac"], 0.36)
    jitter.inputs[2].default_value = -0.18
    dj = math(nt, "ADD", (x0 + 920, y0), dmin.outputs[0], jitter.outputs[0])
    soot = map_range(nt, dj.outputs[0], 0.06, 0.5, 0.78, 0.0, (x0 + 1100, y0), smooth=True)
    created.append(streak)
    col = mix_rgb(nt, soot.outputs[0], base_src, (0.016, 0.014, 0.012, 1.0), (x0 + 1300, y0))
    rgh = mix_float(nt, soot.outputs[0], rough_src, 0.88, (x0 + 1300, y0 - 260))
    nt.links.new(col.outputs["Result"], base_in)
    nt.links.new(rgh.outputs["Result"], rough_in)
    created += [dmin, noise, jitter, dj, soot, col, rgh]
    frame(nt, "FX exhaust soot", created)


# ---------------------------------------------------------------- turret number
def add_turret_number(mat, img):
    nt = mat.node_tree
    remove_by_label(nt, "FX turret number")
    # decal goes under the mud / grime / edge-wear layers: splice between Mix.002 and Mix.004
    mud_mix = nt.nodes["Mix.004"]
    under = mud_mix.inputs["A"].links[0].from_socket
    x0, y0 = -600, -2200
    tc = node(nt, "ShaderNodeTexCoord", (x0, y0))
    sep = node(nt, "ShaderNodeSeparateXYZ", (x0 + 200, y0))
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    # u runs toward the front on the right side (-y) and toward the rear on the left side (+y),
    # so the number reads left-to-right on both sides.
    sgn = math(nt, "SIGN", (x0 + 400, y0 + 120), sep.outputs["Y"])
    xc = math(nt, "SUBTRACT", (x0 + 400, y0), sep.outputs["X"], -0.45)
    xs = math(nt, "MULTIPLY", (x0 + 580, y0), xc.outputs[0], sgn.outputs[0])
    u = math(nt, "MULTIPLY_ADD", (x0 + 760, y0), xs.outputs[0], -1.0 / 1.024)
    u.inputs[2].default_value = 0.5
    v = math(nt, "MULTIPLY_ADD", (x0 + 760, y0 - 180), sep.outputs["Z"], 1.0 / 0.432)
    v.inputs[2].default_value = 0.5 - 0.40 / 0.432
    comb = node(nt, "ShaderNodeCombineXYZ", (x0 + 940, y0))
    nt.links.new(u.outputs[0], comb.inputs["X"])
    nt.links.new(v.outputs[0], comb.inputs["Y"])
    tex = node(nt, "ShaderNodeTexImage", (x0 + 1120, y0), _extension="CLIP", _interpolation="Cubic")
    tex.image = img
    nt.links.new(comb.outputs[0], tex.inputs["Vector"])
    # only on the (near-)vertical side walls
    nsep = node(nt, "ShaderNodeSeparateXYZ", (x0 + 200, y0 - 380))
    nt.links.new(tc.outputs["Normal"], nsep.inputs[0])
    nabs = math(nt, "ABSOLUTE", (x0 + 400, y0 - 380), nsep.outputs["Y"])
    side = map_range(nt, nabs.outputs[0], 0.62, 0.8, loc=(x0 + 580, y0 - 380))
    # hand-painted wear: patchy thinning + scratches
    wn = node(nt, "ShaderNodeTexNoise", (x0 + 580, y0 - 620), Scale=22.0, Detail=8.0, Roughness=0.7)
    nt.links.new(tc.outputs["Object"], wn.inputs["Vector"])
    wear = map_range(nt, wn.outputs["Fac"], 0.34, 0.46, loc=(x0 + 760, y0 - 620))
    a1 = math(nt, "MULTIPLY", (x0 + 1400, y0 - 200), tex.outputs["Alpha"], side.outputs[0])
    a2 = math(nt, "MULTIPLY", (x0 + 1580, y0 - 200), a1.outputs[0], wear.outputs[0])
    a3 = math(nt, "MULTIPLY", (x0 + 1760, y0 - 200), a2.outputs[0], 0.93)
    paint = mix_rgb(nt, a3.outputs[0], under, (0.52, 0.51, 0.45, 1.0), (x0 + 1960, y0 - 40))
    nt.links.new(paint.outputs["Result"], mud_mix.inputs["A"])
    frame(nt, "FX turret number", [tc, sep, sgn, xc, xs, u, v, comb, tex, nsep, nabs, side, wn, wear, a1, a2, a3, paint])


# ---------------------------------------------------------------- muzzle soot
def add_muzzle_soot(mat):
    nt = mat.node_tree
    remove_by_label(nt, "FX muzzle soot")
    bsdf, base_in, rough_in = out_sockets(nt)
    base_src, rough_src = reroute_input(nt, base_in), reroute_input(nt, rough_in)
    x0, y0 = 1900, -2400
    tc = node(nt, "ShaderNodeTexCoord", (x0, y0))
    sep = node(nt, "ShaderNodeSeparateXYZ", (x0 + 200, y0))
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    # barrel local +Z runs breech (0.09) -> muzzle (3.80)
    n1 = node(nt, "ShaderNodeTexNoise", (x0 + 200, y0 - 250), Scale=9.0, Detail=6.0, Roughness=0.62)
    nt.links.new(tc.outputs["Object"], n1.inputs["Vector"])
    jit = math(nt, "MULTIPLY_ADD", (x0 + 400, y0 - 250), n1.outputs["Fac"], 0.5)
    jit.inputs[2].default_value = -0.25
    zj = math(nt, "ADD", (x0 + 580, y0), sep.outputs["Z"], jit.outputs[0])
    soot = map_range(nt, zj.outputs[0], 3.05, 3.72, 0.0, 0.95, (x0 + 760, y0), smooth=True)
    # heat-burnt paint: brownish band behind the black muzzle
    burn = map_range(nt, zj.outputs[0], 2.6, 3.3, 0.0, 0.55, (x0 + 760, y0 - 260), smooth=True)
    c1 = mix_rgb(nt, burn.outputs[0], base_src, (0.055, 0.042, 0.028, 1.0), (x0 + 980, y0 - 100))
    c2 = mix_rgb(nt, soot.outputs[0], c1.outputs["Result"], (0.014, 0.012, 0.011, 1.0), (x0 + 1180, y0))
    r1 = mix_float(nt, soot.outputs[0], rough_src, 0.9, (x0 + 1180, y0 - 260))
    nt.links.new(c2.outputs["Result"], base_in)
    nt.links.new(r1.outputs["Result"], rough_in)
    frame(nt, "FX muzzle soot", [tc, sep, n1, jit, zj, soot, burn, c1, c2, r1])


def main():
    base = bpy.data.materials["paint_green"]

    img = bpy.data.images.get("turret_number_124.png")
    if img is None:
        img = bpy.data.images.load(NUM_PATH)
    img.filepath = "//textures/turret_number_124.png"
    img.alpha_mode = "STRAIGHT"
    img.pack()

    # derived materials are rebuilt from the base each run so the script is re-runnable
    for name in ("paint_green_turret", "paint_green_gun"):
        old = bpy.data.materials.get(name)
        if old:
            old.name = name + "_old"

    # copies are taken before the exhaust soot is spliced into the base (the soot is
    # world-space and only reaches the hull rear anyway)
    turret = base.copy(); turret.name = "paint_green_turret"
    gun = base.copy(); gun.name = "paint_green_gun"
    add_exhaust_soot(base)
    add_turret_number(turret, img)
    add_muzzle_soot(gun)

    def swap(obj_name, new):
        ob = bpy.data.objects[obj_name]
        for slot in ob.material_slots:
            if slot.material and slot.material.name.startswith(("paint_green", )) and slot.material.name != "paint_green_dark":
                slot.material = new

    swap("turret_body", turret)
    for n in ("gun_barrel", "gun_joint_band"):
        swap(n, gun)

    for name in ("paint_green_turret_old", "paint_green_gun_old"):
        old = bpy.data.materials.get(name)
        if old:
            bpy.data.materials.remove(old)
    print("textures done:", [m.name for m in bpy.data.materials if m.name.startswith("paint")])


main()
