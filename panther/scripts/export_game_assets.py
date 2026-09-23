"""Export browser-game assets for the Three.js tank game (panther/game/public/assets).

    blender -b --factory-startup --python panther/scripts/export_game_assets.py

Needs panther/panther_ausf_g_detailed.blend and panther/forest_assets (fetch_forest_assets.py).

Writes
    panther.glb            exterior-only Panther, merged into three parts with game pivots:
                             Panther > hull (mesh)
                                     > turret (node at the turret ring)  > turret_mesh
                                                                         > gun (node at the trunnion) > gun_mesh
                           +X forward, +Y up (glTF), metres.
    trees_atlas.png        4 tree impostors (3 Scots pines + 1 fir) rendered from the Poly Haven models,
                           each from two sides (0 and 90 degrees), soft-sky lit + alpha, 8 columns x 1 row
    trees_atlas.json       per tile: world size, tree height, base offset and trunk diameter
    bark.jpg               bark texture for the 3D trunks
    plants_atlas.png       grass clump | fern, albedo + alpha
    ground_*.jpg           forest floor / leaves / mud textures (1k)
    sky.hdr                2k equirectangular HDRI (forest_slope) for sky + reflections
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
ASSETS = os.path.join(ROOT, "forest_assets")
OUT = os.path.join(ROOT, "game", "public", "assets")
os.makedirs(OUT, exist_ok=True)
D = bpy.data


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


# ============================================================================= tank
def export_tank():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(ROOT, "panther_ausf_g_detailed.blend"))
    sc = bpy.context.scene
    ctrl = D.objects["Panther_Controls"]
    for k in ("turret_traverse", "gun_elevation", "cupola_hatch", "driver_hatch", "radio_hatch", "turret_rear_hatch",
              "cutaway", "skirts"):
        ctrl[k] = 0
    bpy.context.view_layer.update()
    turret = D.objects["turret_root"]
    gun = D.objects["gun_pivot"]
    t_pos = turret.matrix_world.translation.copy()
    g_pos = gun.matrix_world.translation.copy()

    def descends(o, anc):
        p = o.parent
        while p is not None:
            if p == anc:
                return True
            p = p.parent
        return False

    keep_colls = {"Exterior", "Running_gear", "Turret", "Markings"}
    groups = {"hull": [], "turret": [], "gun": []}
    for o in sc.objects:
        if o.type != "MESH" or not any(c.name in keep_colls for c in o.users_collection):
            continue
        if o.name.startswith(("cutaway", "_")):
            continue
        g = "gun" if (o.parent == gun or descends(o, gun)) else ("turret" if descends(o, turret) else "hull")
        groups[g].append(o)
    dg = bpy.context.evaluated_depsgraph_get()
    new_objs = {}
    for g, objs in groups.items():
        bm = bmesh.new()
        mats = []
        for o in objs:
            # cutaway booleans stay off; everything else (bevels) is applied
            ev = o.evaluated_get(dg)
            me = D.meshes.new_from_object(ev)
            me.transform(o.matrix_world)
            idx_map = []
            for m in me.materials:
                if m not in mats:
                    mats.append(m)
                idx_map.append(mats.index(m))
            for p in me.polygons:
                p.material_index = idx_map[p.material_index] if idx_map else 0
            bm.from_mesh(me)
            D.meshes.remove(me)
        off = {"hull": Vector((0, 0, 0)), "turret": t_pos, "gun": g_pos}[g]
        bmesh.ops.translate(bm, verts=bm.verts, vec=-off)
        me = D.meshes.new(f"{g}_mesh")
        bm.to_mesh(me)
        bm.free()
        for m in mats:
            me.materials.append(m)
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(35))
        new_objs[g] = me
        print(f"TANK {g}: {len(objs)} objects, {len(me.vertices)} verts, {len(me.polygons)} faces, {len(mats)} materials",
              flush=True)
    # simple, exporter-friendly copies of the materials (the game builds its own camo shader from the names)
    simple = {}
    for me in new_objs.values():
        for i, m in enumerate(me.materials):
            if m is None:
                continue
            if m.name not in simple:
                col, rough, metal = m.diffuse_color, 0.6, 0.0
                bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if m.node_tree else None
                if bsdf is not None:
                    if not bsdf.inputs["Base Color"].is_linked:
                        col = bsdf.inputs["Base Color"].default_value
                    rough = 0.65 if bsdf.inputs["Roughness"].is_linked else bsdf.inputs["Roughness"].default_value
                    metal = bsdf.inputs["Metallic"].default_value
                g = D.materials.new(m.name.replace("PZ_", "G_"))
                nt = g.node_tree
                b_ = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
                b_.inputs["Base Color"].default_value = (col[0], col[1], col[2], 1)
                b_.inputs["Roughness"].default_value = rough
                b_.inputs["Metallic"].default_value = metal
                simple[m.name] = g
            me.materials[i] = simple[m.name]
    tmp = os.path.join(ROOT, "game", "_tank_parts.blend")
    D.libraries.write(tmp, set(new_objs.values()), fake_user=True)
    # fresh session: build the game hierarchy and export
    reset()
    with D.libraries.load(tmp, link=False) as (src, dst):
        dst.meshes = [f"{g}_mesh" for g in ("hull", "turret", "gun")]
    meshes = {m.name.split("_")[0]: m for m in dst.meshes}
    col = bpy.context.scene.collection

    def obj(name, data, parent=None, loc=(0, 0, 0)):
        o = D.objects.new(name, data)
        col.objects.link(o)
        o.parent = parent
        o.location = loc
        return o
    root = obj("Panther", None)
    obj("hull", meshes["hull"], root)
    tnode = obj("turret", None, root, t_pos)
    obj("turret_mesh", meshes["turret"], tnode)
    gnode = obj("gun", None, tnode, g_pos - t_pos)
    obj("gun_mesh", meshes["gun"], gnode)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "panther.glb"), export_format="GLB",
                              use_selection=False, export_apply=False, export_yup=True,
                              export_extras=True, export_cameras=False, export_lights=False)
    os.remove(tmp)
    print("TANK exported", os.path.getsize(os.path.join(OUT, "panther.glb")) / 1e6, "MB", flush=True)


# ============================================================================= impostors
def albedo_override(mat, lit=False):
    """Turn a Poly Haven material into albedo + alpha (for impostor rendering).

    lit=False: unlit albedo (emission).
    lit=True:  diffuse albedo lit by the soft sky of impostor_world(), so the impostor carries
               baked self-occlusion (darker inner branches) that does not depend on the view angle.
    """
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if out is None:
        return
    imgs = [n for n in nt.nodes if n.type == "TEX_IMAGE" and n.image is not None]
    alp = next((n for n in imgs if "_alpha" in n.image.name), None)
    if bsdf is not None:
        col_src = bsdf.inputs["Base Color"].links[0].from_socket if bsdf.inputs["Base Color"].is_linked else None
        alpha_src = bsdf.inputs["Alpha"].links[0].from_socket if bsdf.inputs["Alpha"].is_linked else None
        if alpha_src is None and alp is not None:
            # Poly Haven twig materials mix in a Transparent BSDF with the alpha texture instead of
            # using the Principled alpha input; without this the leaf cards render as solid quads.
            alpha_src = alp.outputs["Color"]
    else:   # node-group materials: take the diffuse / alpha image textures directly
        diff = next((n for n in imgs if "_diff" in n.image.name and "dry" not in n.image.name), None)
        col_src = diff.outputs["Color"] if diff else None
        alpha_src = alp.outputs["Color"] if alp else None
    em = nt.nodes.new("ShaderNodeBsdfDiffuse" if lit else "ShaderNodeEmission")
    if col_src is not None:
        nt.links.new(col_src, em.inputs["Color"])
    elif bsdf is not None:
        em.inputs["Color"].default_value = bsdf.inputs["Base Color"].default_value
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    if alpha_src is not None:
        # hard cut-out so the atlas has crisp alpha
        mr = nt.nodes.new("ShaderNodeMath")
        mr.operation = "GREATER_THAN"
        mr.inputs[1].default_value = 0.5
        nt.links.new(alpha_src, mr.inputs[0])
        nt.links.new(mr.outputs[0], mix.inputs[0])
    else:
        mix.inputs[0].default_value = 1.0
    for l in list(out.inputs["Surface"].links):
        nt.links.remove(l)
    nt.links.new(mix.outputs[0], out.inputs["Surface"])


def impostor_world(w):
    """Soft overcast sky: bright zenith, darker horizon, dim ground bounce, plus a sun at the zenith.
    Everything is rotation-symmetric around the vertical axis, so a camera-facing impostor looks
    right from every direction."""
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.22, 0.22, 0.2, 1)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
    mid = ramp.color_ramp.elements.new(0.5)
    mid.color = (0.62, 0.64, 0.66, 1)
    remap = nt.nodes.new("ShaderNodeMapRange")
    remap.inputs["From Min"].default_value = -1.0
    remap.inputs["From Max"].default_value = 1.0
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.85
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], remap.inputs["Value"])
    nt.links.new(remap.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    sun_d = D.lights.new("zenith", "SUN")
    sun_d.energy = 1.1
    sun_d.angle = math.radians(25)
    sun = D.objects.new("zenith", sun_d)
    bpy.context.scene.collection.objects.link(sun)


def render_sprites(specs, path, tile_w, tile_h, angles=(0,), lit=False):
    """specs: list of (asset, object_name). Renders each object from the side (once per angle in
    `angles`, degrees around Z) into one row atlas. With lit=True the materials are lit by
    impostor_world() instead of being rendered as flat albedo."""
    reset()
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 128 if lit else 24
    sc.cycles.use_denoising = lit
    sc.cycles.transparent_max_bounces = 256
    sc.cycles.max_bounces = 6
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.view_settings.view_transform = "Standard"
    sc.render.resolution_x, sc.render.resolution_y = tile_w, tile_h
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == "OPTIX"
        sc.cycles.device = "GPU"
    except Exception:
        pass
    w = D.worlds.new("w")
    sc.world = w
    if lit:
        impostor_world(w)
    tiles = []
    for asset, name in specs:
        folder = os.path.join(ASSETS, "models", asset)
        blend = next(os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".blend"))
        with D.libraries.load(blend, link=False) as (src, dst):
            dst.objects = [n for n in src.objects if n == name]
        o = dst.objects[0]
        sc.collection.objects.link(o)
        o.parent = None
        for m in o.data.materials:
            if m is not None:
                albedo_override(m, lit)
        for angle in angles:
            o.rotation_euler = (0, 0, math.radians(angle))
            bpy.context.view_layer.update()
            bb = [o.matrix_world @ Vector(v) for v in o.bound_box]
            mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
            mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
            size = mx - mn
            centre = (mn + mx) / 2
            # keep the trunk (object origin) centred horizontally, so the game can pivot on it
            origin = o.matrix_world.translation
            half_w = max(mx.x - origin.x, origin.x - mn.x)
            cam_d = D.cameras.new("c")
            cam_d.type = "ORTHO"
            cam_d.ortho_scale = max(size.z, 2 * half_w * tile_h / tile_w) * 1.02
            cam = D.objects.new("c", cam_d)
            sc.collection.objects.link(cam)
            cam.location = (origin.x, centre.y - 60, mn.z + cam_d.ortho_scale / 2 - size.z * 0.01)
            cam.rotation_euler = (math.radians(90), 0, 0)
            sc.camera = cam
            tp = os.path.join(bpy.app.tempdir, f"tile_{len(tiles)}.png")
            sc.render.filepath = tp
            bpy.ops.render.render(write_still=True)
            tiles.append((tp, cam_d.ortho_scale, size, name, angle, (mn.z - origin.z) + size.z * 0.01))
            print(f"SPRITE {name} @{angle}: size {size.x:.2f} x {size.y:.2f} x {size.z:.2f} m, "
                  f"ortho {cam_d.ortho_scale:.2f}", flush=True)
            D.objects.remove(cam, do_unlink=True)
        D.objects.remove(o, do_unlink=True)
    # assemble the atlas (one row)
    import json
    import numpy as np
    atlas = np.zeros((tile_h, tile_w * len(tiles), 4), dtype=np.float32)
    meta = []
    for i, (tp, ortho, size, name, angle, base) in enumerate(tiles):
        img = D.images.load(tp)
        px = np.empty(tile_w * tile_h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        tile = px.reshape(tile_h, tile_w, 4)     # Blender pixel rows start at the bottom
        atlas[:, i * tile_w:(i + 1) * tile_w, :] = tile
        m_per_px = ortho / tile_h
        # trunk width: opaque pixels in the rows between 0.4 m and 1.6 m above the base
        r0 = int((base + 0.4) / m_per_px)
        r1 = max(r0 + 1, int((base + 1.6) / m_per_px))
        widths = [(tile[r, :, 3] > 0.5).sum() for r in range(max(0, r0), min(tile_h, r1))]
        trunk = float(np.median(widths)) * m_per_px if widths else 0.5
        meta.append({"name": name, "angle": angle, "tileHeight": round(ortho, 4),
                     "tileWidth": round(ortho * tile_w / tile_h, 4), "treeHeight": round(size.z, 3),
                     "baseOffset": round(base, 4), "trunkDiameter": round(trunk, 3)})
    with open(os.path.splitext(path)[0] + ".json", "w") as f:
        json.dump({"tiles": meta, "tileWidthPx": tile_w, "tileHeightPx": tile_h}, f, indent=1)
    # bleed colour into transparent pixels so mip-mapping does not produce dark fringes
    rgb, a = atlas[..., :3], atlas[..., 3:4]
    filled = rgb * (a > 0.5)
    mask = (a[..., 0] > 0.5).astype(np.float32)
    for _ in range(12):
        acc = np.zeros_like(filled)
        cnt = np.zeros_like(mask)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            acc += np.roll(np.roll(filled, dy, 0), dx, 1)
            cnt += np.roll(np.roll(mask, dy, 0), dx, 1)
        grow = (mask == 0) & (cnt > 0)
        filled[grow] = acc[grow] / cnt[grow][:, None]
        mask = np.maximum(mask, grow.astype(np.float32))
    atlas[..., :3] = filled
    out = D.images.new("atlas", tile_w * len(tiles), tile_h, alpha=True)
    out.pixels.foreach_set(atlas.ravel())
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    print("ATLAS", path, flush=True)
    return tiles


def save_scaled(src, dst, size, fmt="JPEG"):
    img = D.images.load(src)
    img.scale(size, size)
    img.filepath_raw = dst
    img.file_format = fmt
    img.save()
    D.images.remove(img)


def export_textures():
    reset()
    tex = os.path.join(ASSETS, "textures")
    pairs = [("forest_ground_04", "ground_forest"), ("forest_leaves_02", "ground_leaves"), ("brown_mud_leaves_01", "ground_mud")]
    for name, out in pairs:
        save_scaled(os.path.join(tex, name, f"{name}_diff_4k.jpg"), os.path.join(OUT, f"{out}_diff.jpg"), 1024)
        save_scaled(os.path.join(tex, name, f"{name}_nor_gl_4k.png"), os.path.join(OUT, f"{out}_nor.jpg"), 1024)
    save_scaled(os.path.join(ASSETS, "models", "pine_tree_01", "textures", "pine_tree_01_bark_diff_2k.png"),
                os.path.join(OUT, "bark.jpg"), 512)
    img = D.images.load(os.path.join(ASSETS, "hdri", "forest_slope_8k.hdr"))
    img.scale(2048, 1024)
    img.filepath_raw = os.path.join(OUT, "sky.hdr")
    img.file_format = "HDR"
    img.save()
    print("TEXTURES done", flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parts = argv or ["tank", "trees", "plants", "textures"]
    if "tank" in parts:
        export_tank()
    if "trees" in parts:
        # every tree from two sides (0 and 90 degrees), lit by a soft sky for baked self-occlusion
        render_sprites([("pine_tree_01", "pine_tree_01_a_LOD0"), ("pine_tree_01", "pine_tree_01_b_LOD0"),
                        ("pine_tree_01", "pine_tree_01_c_LOD0"), ("fir_tree_01", "fir_tree_01_a_LOD0")],
                       os.path.join(OUT, "trees_atlas.png"), 512, 1024, angles=(0, 90), lit=True)
    if "plants" in parts:
        render_sprites([("grass_medium_02", "grass_medium_02_e"), ("fern_02", "fern_02_b")],
                       os.path.join(OUT, "plants_atlas.png"), 512, 512)
    if "textures" in parts:
        export_textures()


main()
