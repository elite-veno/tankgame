"""Cannon finishing pass for t34_85_preview.blend.

Everything that physically elevates with the ZiS-S-53 (cast mantlet, recoil sleeve, the
TSh-16 sight port and the coaxial DT) is moved under gun_cradle, and a `tank_controls`
empty exposes gun elevation / turret traverse in degrees, wired to the cradle and turret
with drivers. Defaults reproduce the current pose exactly.
"""
import bpy, math

ELEVATING = [
    "turret_mantlet", "turret_gun_sleeve", "turret_sleeve_bore",
    "turret_sleeve_bolt_src", *[f"turret_sleeve_bolt_{i}" for i in range(7)],
    "turret_coax_boss", "turret_coax_hole", "gun_coax_dt_barrel", "gun_coax_sight",
    "turret_sight_boss", "turret_sight_aperture",
]

cradle = bpy.data.objects["gun_cradle"]
turret = bpy.data.objects["turret_root"]

# current pose -> control defaults (cradle pitches about local Y; negative = muzzle up)
elev0 = -math.degrees(cradle.rotation_euler[1])
trav0 = math.degrees(turret.rotation_euler[2])

for n in ELEVATING:
    ob = bpy.data.objects[n]
    if ob.parent is cradle:
        continue
    mw = ob.matrix_world.copy()
    ob.parent = cradle
    ob.matrix_parent_inverse = cradle.matrix_world.inverted()
    ob.matrix_world = mw

ctl = bpy.data.objects.get("tank_controls")
if ctl is None:
    ctl = bpy.data.objects.new("tank_controls", None)
    bpy.data.collections["turret"].objects.link(ctl)
ctl.empty_display_type = "SINGLE_ARROW"
ctl.empty_display_size = 0.6
ctl.location = (turret.matrix_world.translation.x, 0.0, 3.2)
ctl.hide_render = True

for key, val, lo, hi, desc in (
    ("gun_elevation", elev0, -5.0, 22.0, "ZiS-S-53 elevation in degrees (+ = muzzle up)"),
    ("turret_traverse", trav0, -180.0, 180.0, "Turret traverse in degrees (+ = counter-clockwise from above)"),
):
    ctl[key] = round(val, 4)
    ui = ctl.id_properties_ui(key)
    ui.update(min=lo, max=hi, soft_min=lo, soft_max=hi, default=round(val, 4), description=desc, step=100)


def drive(ob, index, prop, expr):
    ob.driver_remove("rotation_euler", index)
    fc = ob.driver_add("rotation_euler", index)
    d = fc.driver
    d.type = "SCRIPTED"
    v = d.variables.new()
    v.name = "a"
    v.type = "SINGLE_PROP"
    v.targets[0].id_type = "OBJECT"
    v.targets[0].id = ctl
    v.targets[0].data_path = f'["{prop}"]'
    d.expression = expr


drive(cradle, 1, "gun_elevation", "-a*0.017453292519943295")
drive(turret, 2, "turret_traverse", "a*0.017453292519943295")
print(f"cannon rig done: elevation {elev0:.3f} deg, traverse {trav0:.3f} deg")
