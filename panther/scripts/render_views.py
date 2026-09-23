"""Preview renderer used while building the models.

    blender -b <file.blend> --python panther/scripts/render_views.py -- <preset> [out_dir]

Presets: print (print kit: assembled, exploded, interior, parts), detailed (detailed model views).
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PRESET = argv[0] if argv else "print"
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = argv[1] if len(argv) > 1 else os.path.join(ROOT, "renders")
os.makedirs(OUT, exist_ok=True)

sc = bpy.context.scene


def setup(engine="CYCLES", samples=48, res=(1600, 1000)):
    sc.render.engine = engine
    if engine == "CYCLES":
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for t in ("OPTIX", "CUDA"):
                try:
                    prefs.compute_device_type = t
                    prefs.get_devices()
                    if any(d.type == t for d in prefs.devices):
                        for d in prefs.devices:
                            d.use = d.type == t
                        sc.cycles.device = "GPU"
                        break
                except Exception:
                    continue
        except Exception:
            pass
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "AgX"
    w = sc.world or bpy.data.worlds.new("World")
    sc.world = w
    nt = w.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.62, 0.66, 0.72, 1)
        bg.inputs["Strength"].default_value = 0.7


def light_rig():
    for name, rot, energy in (("_key", (math.radians(50), 0, math.radians(35)), 4.0),
                              ("_fill", (math.radians(65), 0, math.radians(-120)), 1.2)):
        ld = bpy.data.lights.get(name) or bpy.data.lights.new(name, "SUN")
        ld.energy = energy
        ld.angle = math.radians(4)
        o = bpy.data.objects.get(name) or bpy.data.objects.new(name, ld)
        if o.name not in sc.collection.objects:
            sc.collection.objects.link(o)
        o.rotation_euler = rot


def ground(z=0.0, size=60):
    me = bpy.data.meshes.get("_ground")
    if me is None:
        me = bpy.data.meshes.new("_ground")
        s = size
        me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
        m = bpy.data.materials.new("_ground")
        m.diffuse_color = (0.35, 0.34, 0.31, 1)
        try:
            m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.33, 0.32, 0.29, 1)
            m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
        except Exception:
            pass
        me.materials.append(m)
    o = bpy.data.objects.get("_ground") or bpy.data.objects.new("_ground", me)
    if o.name not in sc.collection.objects:
        sc.collection.objects.link(o)
    o.location.z = z
    return o


def camera(loc, target, lens=50, ortho=None):
    cd = bpy.data.cameras.get("_cam") or bpy.data.cameras.new("_cam")
    cd.lens = lens
    cd.clip_start, cd.clip_end = 0.01, 500
    if ortho:
        cd.type, cd.ortho_scale = "ORTHO", ortho
    else:
        cd.type = "PERSP"
    o = bpy.data.objects.get("_cam") or bpy.data.objects.new("_cam", cd)
    if o.name not in sc.collection.objects:
        sc.collection.objects.link(o)
    o.location = loc
    d = Vector(target) - Vector(loc)
    o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc.camera = o


def shot(name):
    sc.render.filepath = os.path.join(OUT, name + ".png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", sc.render.filepath, flush=True)


def show(names=None, hide=()):
    for o in sc.objects:
        if o.type != "MESH" or o.name.startswith("_"):
            continue
        vis = (names is None or any(o.name.startswith(n) for n in names)) and not any(o.name.startswith(h) for h in hide)
        o.hide_render = not vis


def orbit(target, dist, az, el):
    t = Vector(target)
    return t + Vector((math.cos(math.radians(el)) * math.cos(math.radians(az)),
                       math.cos(math.radians(el)) * math.sin(math.radians(az)),
                       math.sin(math.radians(el)))) * dist


def print_preset():
    setup(samples=32)
    light_rig()
    ground()
    objs = {o.name: o for o in sc.objects}
    base = {n: o.location.copy() for n, o in objs.items()}
    tgt = (0.3, 0, 1.2)
    show()
    camera(orbit(tgt, 13, 215, 22), tgt, lens=45)
    shot("print_assembled_rear")
    camera(orbit(tgt, 13, 35, 28), tgt, lens=45)
    shot("print_assembled_front")
    # exploded
    off = {"hull_upper": (0, 0, 1.3), "turret_basket": (0, 0, 2.2), "turret_body": (0, 0, 3.4), "turret_roof": (0, 0, 4.4),
           "hatch": (0, 0, 5.1), "hatch_pin": (0, 0, 5.6), "gun_barrel": (1.2, 0, 3.4), "exhaust": (0, 0, 2.1),
           "running_gear_left": (0, 1.5, 0), "running_gear_right": (0, -1.5, 0)}
    for n, o in objs.items():
        for k, v in off.items():
            if n.startswith(k):
                o.location = base[n] + Vector(v)
    camera(orbit((0.3, 0, 2.6), 17, 225, 22), (0.3, 0, 2.6), lens=40)
    shot("print_exploded")
    for n, o in objs.items():
        o.location = base[n]
    # interior: upper hull and turret removed
    show(hide=("hull_upper", "turret_body", "turret_roof", "hatch", "gun_barrel", "exhaust"))
    camera(orbit((0.0, 0, 1.0), 9.5, 200, 48), (0.0, 0, 0.9), lens=40)
    shot("print_interior_hull")
    show(["turret_basket"])
    camera(orbit((0.35, 0, 1.9), 4.0, 210, 35), (0.35, 0, 1.9), lens=45)
    shot("print_interior_basket")
    show()
    # the working hatch: lifted 1.2 mm and swung 110 deg about the pin
    import mathutils
    h, pin, roof = objs.get("hatch"), objs.get("hatch_pin"), objs.get("turret_roof")
    if h is not None:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import pz_geom as g
        ang = math.radians(-135)
        pv = g.TURRET_ORIGIN + mathutils.Vector((g.CUPOLA.x + (g.CUPOLA_R + 0.055) * math.cos(ang),
                                                 g.CUPOLA.y + (g.CUPOLA_R + 0.055) * math.sin(ang), 0))
        M = (mathutils.Matrix.Translation(pv) @ mathutils.Matrix.Rotation(math.radians(-110), 4, "Z") @
             mathutils.Matrix.Translation(-pv) @ mathutils.Matrix.Translation((0, 0, 1.2 * 0.035)))
        h.matrix_world = M
        cam_t = g.TURRET_ORIGIN + mathutils.Vector((g.CUPOLA.x, g.CUPOLA.y, 0.9))
        camera(orbit(cam_t, 2.6, 200, 42), cam_t, lens=45)
        shot("print_hatch_open")
        h.matrix_world = mathutils.Matrix.Identity(4)


def ctrl_set(**kw):
    c = bpy.data.objects.get("Panther_Controls")
    for k, v in kw.items():
        c[k] = v
    c.update_tag()
    bpy.context.view_layer.update()


def detailed_preset(which):
    setup(samples=int(os.environ.get("PZ_SAMPLES", "64")))
    light_rig()
    ground()
    for o in sc.objects:          # the build's own sun is replaced by the preview rig
        if o.type == "LIGHT" and not o.name.startswith("_"):
            o.hide_render = True
    ctrl_set(turret_traverse=0.0, gun_elevation=0.0, cupola_hatch=0.0, driver_hatch=0.0, radio_hatch=0.0,
             turret_rear_hatch=0.0, cutaway=0, skirts=0)
    tgt = (0.2, 0, 1.3)
    views = {
        "front34": lambda: (camera(orbit(tgt, 12.5, -35, 18), tgt, 40), "det_front34"),
        "rear34": lambda: (camera(orbit(tgt, 12.5, 145, 25), tgt, 40), "det_rear34"),
        "side": lambda: (camera(orbit((0.4, 0, 1.2), 14, 90, 3), (0.4, 0, 1.2), 50), "det_side"),
        "top": lambda: (camera(orbit((0.4, 0, 1.2), 14, -90, 88), (0.4, 0, 1.2), 50), "det_top"),
        "wheels": lambda: (camera(orbit((0.9, 1.4, 0.6), 4.2, 70, 12), (0.9, 1.4, 0.6), 40), "det_wheels"),
        "turret": lambda: (camera(orbit((0.2, 0, 2.5), 4.8, -140, 35), (0.2, 0.1, 2.4), 40), "det_turret"),
        "rside": lambda: (camera(orbit((-0.3, -1.4, 1.5), 5.5, -80, 20), (-0.3, -1.4, 1.5), 35), "det_rside"),
        "rearplate": lambda: (camera(orbit((-3.2, 0, 1.4), 5.0, 180, 20), (-3.2, 0, 1.4), 40), "det_rearplate"),
    }
    names = which.split(",") if which else list(views)
    for v in names:
        if v in views:
            _, name = views[v]()
            shot(name)
    if "open" in names or not which:
        ctrl_set(cupola_hatch=1.0, driver_hatch=1.0, radio_hatch=1.0, turret_rear_hatch=1.0, turret_traverse=35.0,
                 gun_elevation=8.0)
        camera(orbit(tgt, 11, -30, 38), tgt, 40)
        shot("det_hatches_open")
    if "cut" in names or not which:
        ctrl_set(cutaway=1, cupola_hatch=0.0, driver_hatch=0.0, radio_hatch=0.0, turret_rear_hatch=0.0,
                 turret_traverse=0.0, gun_elevation=0.0)
        camera(orbit((0.0, 0.2, 1.3), 10.5, 72, 30), (0.0, 0.2, 1.2), 38)
        shot("det_cutaway")
        camera(orbit((1.2, 0.3, 1.5), 4.6, 60, 30), (1.4, 0.0, 1.3), 35)
        shot("det_cutaway_crew")
        camera(orbit((-2.2, 0.3, 1.3), 4.2, 70, 38), (-2.2, 0.0, 1.2), 35)
        shot("det_cutaway_engine")


if PRESET == "print":
    print_preset()
elif PRESET == "detailed":
    detailed_preset(argv[2] if len(argv) > 2 else "")
