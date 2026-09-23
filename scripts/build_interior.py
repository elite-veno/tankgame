"""Builds the T-34-85 (1944, Plant No. 183 pattern) crew compartment interior.

Run headless on the tank file (re-runnable; it removes its previous output first):
    blender -b t34_85_preview.blend --python scripts/build_interior.py --python-expr "import bpy; bpy.ops.wm.save_mainfile()"
Needs the textures from scripts/make_interior_textures.py.

What it does
  * hull: replaces the solid filler block with a painted interior shell (openings for the
    turret ring, driver's hatch and bow MG ball); the engine bay stays sealed behind a bulkhead.
  * turret: hollows turret_body (and the base ring, roof plate, cupola) with Exact booleans
    against a cavity cutter parented to turret_root, including the cupola vision slits.
  * stations: driver, bow gunner / hull MG, fighting compartment floor, gunner, commander,
    loader, ZiS-S-53 breech & recoil guard, TSh-16 sight, coaxial DT, 9-RS radio, ammo racks.

Game-engine conventions
  * Materials are plain Principled BSDF (+ image textures on UVMap) -> clean glTF/FBX export.
    Textures: textures/interior_*.png (also packed into the .blend).
  * Static geometry is merged per rigid body: int_hull_static (no parent), int_turret_static
    (turret_root), int_gun_static (gun_cradle), int_driver_hatch_static (hull_driver_lid).
  * Every part a game would animate is its own object with the origin on its pivot and a
    `game_anim` custom property describing axis/range (exported as glTF extras).
  * `socket_*` empties mark seats and eye points; `cam_*` cameras are first-person views.
"""
import bpy, bmesh, math, os
from mathutils import Vector, Matrix, Euler

D = bpy.data
BLEND_DIR = os.path.dirname(D.filepath)
TEX_DIR = os.path.join(BLEND_DIR, "textures")
ROOT_DEFAULT = Vector((0.55, 0.0, 1.45))      # turret_root at 0 deg traverse
R = math.radians

# ------------------------------------------------------------------ materials
MATS = {
    "INT_paint": dict(tex="interior_paint_basecolor.png", rough=0.62),
    "INT_floor": dict(tex="interior_floor_basecolor.png", rough=0.75),
    "INT_instruments": dict(tex="interior_instruments.png", rough=0.3),
    "INT_metal_dark": dict(color=(0.03, 0.03, 0.028), metal=0.6, rough=0.45),
    "INT_steel": dict(color=(0.42, 0.42, 0.41), metal=1.0, rough=0.33),
    "INT_green": dict(color=(0.085, 0.10, 0.06), rough=0.6),
    "INT_radio": dict(color=(0.13, 0.15, 0.13), rough=0.55),
    "INT_white": dict(color=(0.75, 0.72, 0.62), rough=0.5),
    "INT_leather": dict(color=(0.09, 0.05, 0.028), rough=0.55),
    "INT_rubber": dict(color=(0.015, 0.015, 0.015), rough=0.9),
    "INT_brass": dict(color=(0.60, 0.42, 0.16), metal=1.0, rough=0.3),
    "INT_copper": dict(color=(0.55, 0.25, 0.12), metal=1.0, rough=0.35),
    "INT_shell": dict(color=(0.03, 0.03, 0.03), metal=0.3, rough=0.4),
    "INT_canvas": dict(color=(0.22, 0.20, 0.13), rough=0.95),
    "INT_red": dict(color=(0.38, 0.03, 0.02), rough=0.45),
    "INT_glass": dict(color=(0.02, 0.03, 0.03), rough=0.04),
    "INT_lamp": dict(color=(1.0, 0.86, 0.6), emit=4.0, rough=0.2),
}


def load_image(name):
    old = D.images.get(name)
    if old is not None:
        D.images.remove(old)
    img = D.images.load(os.path.join(TEX_DIR, name))
    img.pack()
    img.filepath = "//textures/" + name
    return img


def build_materials():
    out = {}
    for name, spec in MATS.items():
        m = D.materials.get(name) or D.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        o = nt.nodes.new("ShaderNodeOutputMaterial")
        o.location = (300, 0)
        nt.links.new(bsdf.outputs[0], o.inputs["Surface"])
        bsdf.inputs["Roughness"].default_value = spec.get("rough", 0.5)
        bsdf.inputs["Metallic"].default_value = spec.get("metal", 0.0)
        if "tex" in spec:
            t = nt.nodes.new("ShaderNodeTexImage")
            t.location = (-350, 0)
            t.image = load_image(spec["tex"])
            nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
        else:
            c = spec["color"]
            bsdf.inputs["Base Color"].default_value = (*c, 1)
        if "emit" in spec:
            bsdf.inputs["Emission Color"].default_value = (*spec["color"], 1)
            bsdf.inputs["Emission Strength"].default_value = spec["emit"]
        out[name] = m
    return out


# ------------------------------------------------------------------ geometry builder
def track(d, up=Vector((0, 0, 1))):
    """Rotation matrix taking +Z to direction d."""
    d = Vector(d).normalized()
    upv = Vector((0, 1, 0)) if abs(d.dot(up)) > 0.95 else up
    x = upv.cross(d).normalized()
    y = d.cross(x)
    return Matrix((x, y, d)).transposed()


def rot3(rot):
    if rot is None:
        return Matrix.Identity(3)
    if isinstance(rot, Matrix):
        return rot.to_3x3()
    return Euler(rot).to_matrix()


ATLAS = {i: ((0.25 + 0.5 * (i % 4)) / 2.0, 0.75 - 0.5 * (i // 4)) for i in range(8)}  # cell centre (u, v)
GAUGE_R_ATLAS = 0.245          # face radius inside a cell, in atlas units (atlas is 2 x 1)

REG = []  # (object, group, static)


class Part:
    def __init__(self, name, frame=None):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []
        self.frame = frame if frame is not None else Matrix.Identity(4)
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.lock = self.bm.faces.layers.int.new("uvlock")

    # -- bookkeeping
    def _mark(self, before, mat, lock=False):
        idx = self.mats.index(mat) if mat in self.mats else (self.mats.append(mat) or len(self.mats) - 1)
        new = [f for f in self.bm.faces if f not in before]
        for f in new:
            f.material_index = idx
            if lock:
                f[self.lock] = 1
        return new

    def M(self, c, rot=None, scale=(1, 1, 1)):
        return self.frame @ Matrix.Translation(Vector(c)) @ rot3(rot).to_4x4() @ Matrix.Diagonal((*scale, 1))

    # -- primitives (coordinates are in the part frame)
    def box(self, c, s, mat, rot=None, bevel=0.0, seg=1):
        before = set(self.bm.faces)
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=self.M(c, rot, s))
        if bevel:
            edges = list({e for v in r["verts"] for e in v.link_edges})
            bmesh.ops.bevel(self.bm, geom=edges, offset=bevel, segments=seg, affect="EDGES",
                            profile=0.5, clamp_overlap=True)
        return self._mark(before, mat)

    def cyl(self, p0, p1, r, mat, r2=None, seg=16, caps=True):
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        before = set(self.bm.faces)
        M = self.frame @ Matrix.Translation((p0 + p1) / 2) @ track(d).to_4x4()
        bmesh.ops.create_cone(self.bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r,
                              radius2=r if r2 is None else r2, depth=d.length, matrix=M)
        return self._mark(before, mat)

    def sphere(self, c, r, mat, seg=12, scale=(1, 1, 1), rot=None):
        before = set(self.bm.faces)
        bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=max(6, seg // 2), radius=r,
                                  matrix=self.M(c, rot, scale))
        return self._mark(before, mat)

    def torus(self, c, axis, Rm, rm, mat, seg=32, rseg=8):
        before = set(self.bm.faces)
        M = self.frame @ Matrix.Translation(Vector(c)) @ track(axis).to_4x4()
        vs = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            for j in range(rseg):
                b = 2 * math.pi * j / rseg
                p = Vector(((Rm + rm * math.cos(b)) * math.cos(a), (Rm + rm * math.cos(b)) * math.sin(a), rm * math.sin(b)))
                vs.append(self.bm.verts.new(M @ p))
        for i in range(seg):
            for j in range(rseg):
                a, b = i * rseg + j, i * rseg + (j + 1) % rseg
                c2, d2 = ((i + 1) % seg) * rseg + (j + 1) % rseg, ((i + 1) % seg) * rseg + j
                self.bm.faces.new((vs[a], vs[b], vs[c2], vs[d2]))
        return self._mark(before, mat)

    def ring(self, c, axis, r0, r1, h, mat, seg=48):
        """Flat annulus with thickness h (washer / race ring)."""
        before = set(self.bm.faces)
        M = self.frame @ Matrix.Translation(Vector(c)) @ track(axis).to_4x4()
        rows = []
        for (r, z) in ((r0, -h / 2), (r1, -h / 2), (r1, h / 2), (r0, h / 2)):
            rows.append([self.bm.verts.new(M @ Vector((r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), z))) for i in range(seg)])
        for k in range(4):
            A, B = rows[k], rows[(k + 1) % 4]
            for i in range(seg):
                j = (i + 1) % seg
                self.bm.faces.new((A[i], A[j], B[j], B[i]))
        return self._mark(before, mat)

    def path(self, pts, r, mat, seg=8):
        for a, b in zip(pts, pts[1:]):
            self.cyl(a, b, r, mat, seg=seg, caps=False)
        for p in pts:
            self.sphere(p, r, mat, seg=seg)

    def atlas_disc(self, c, rot, r, cell, seg=40):
        """Gauge face lying in the local XY plane of (c, rot), facing +Z, textured from the atlas."""
        before = set(self.bm.faces)
        M = self.M(c, rot)
        uc, vc = ATLAS[cell]
        centre = self.bm.verts.new(M @ Vector((0, 0, 0)))
        rim = [self.bm.verts.new(M @ Vector((r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), 0))) for i in range(seg)]
        faces = [self.bm.faces.new((centre, rim[i], rim[(i + 1) % seg])) for i in range(seg)]
        for f in faces:
            for l in f.loops:
                lp = M.inverted() @ l.vert.co
                l[self.uv].uv = (uc + lp.x / r * GAUGE_R_ATLAS / 2, vc + lp.y / r * GAUGE_R_ATLAS)
        return self._mark(before, "INT_instruments", lock=True)

    def atlas_quad(self, c, rot, w, h, cell, cw=0.46, ch=0.30):
        before = set(self.bm.faces)
        M = self.M(c, rot)
        uc, vc = ATLAS[cell]
        pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
        vs = [self.bm.verts.new(M @ Vector((x, y, 0))) for x, y in pts]
        f = self.bm.faces.new(vs)
        for l, (x, y) in zip(f.loops, pts):
            l[self.uv].uv = (uc + x / w * cw / 2, vc + y / h * ch)
        return self._mark(before, "INT_instruments", lock=True)

    # -- output
    def finish(self, coll, group, parent=None, origin=None, basis=None, static=True, props=None, name=None):
        bm = self.bm
        bm.normal_update()
        for f in bm.faces:
            if f[self.lock]:
                continue
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for l in f.loops:
                co = l.vert.co
                l[self.uv].uv = (co.y, co.z) if ax == 0 else (co.x, co.z) if ax == 1 else (co.x, co.y)
        if origin is not None:
            bmesh.ops.translate(bm, vec=-Vector(origin), verts=bm.verts)
        for f in bm.faces:
            f.smooth = True
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.calc_face_angle(0) > R(38):
                e.smooth = False
        bm.faces.layers.int.remove(self.lock)
        me = D.meshes.new(name or self.name)
        bm.to_mesh(me)
        bm.free()
        ob = D.objects.new(name or self.name, me)
        for m in self.mats:
            me.materials.append(D.materials[m])
        coll.objects.link(ob)
        if parent is not None:
            ob.parent = parent
            ob.matrix_parent_inverse = Matrix.Identity(4)
        if basis is not None:
            ob.matrix_basis = basis
        elif origin is not None:
            ob.location = origin
        for k, v in (props or {}).items():
            ob[k] = v
        REG.append((ob, group, static))
        return ob


# ------------------------------------------------------------------ scene helpers
def get_coll(name, parent):
    c = D.collections.get(name)
    if c is None:
        c = D.collections.new(name)
        parent.children.link(c)
    return c


def purge_previous():
    top = D.collections.get("interior")
    if top:
        def rec(c):
            for ch in list(c.children):
                rec(ch)
            for o in list(c.objects):
                data = o.data
                D.objects.remove(o, do_unlink=True)
                if data is not None and data.users == 0:
                    if isinstance(data, bpy.types.Mesh):
                        D.meshes.remove(data)
                    elif isinstance(data, bpy.types.Light):
                        D.lights.remove(data)
                    elif isinstance(data, bpy.types.Camera):
                        D.cameras.remove(data)
            D.collections.remove(c)
        rec(top)
    for o in D.objects:
        for m in list(o.modifiers):
            if m.name.startswith("INT_"):
                o.modifiers.remove(m)
    for n in ("hull_driver_interior", "hull_bow_mg_interior", "cupola_opening"):
        o = D.objects.get(n)
        if o:
            D.objects.remove(o, do_unlink=True)


def temp_object(name, mesh, coll):
    ob = D.objects.new(name, mesh)
    coll.objects.link(ob)
    return ob


def bake_modifiers(ob):
    """Return a new mesh with ob's modifier stack applied (no bpy.ops)."""
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    return D.meshes.new_from_object(ob.evaluated_get(dg))


def box_uv(me):
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    bm.normal_update()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            co = l.vert.co
            l[uv].uv = (co.y, co.z) if ax == 0 else (co.x, co.z) if ax == 1 else (co.x, co.y)
    bm.to_mesh(me)
    bm.free()


def ensure_uv(ob):
    """Give an existing exterior mesh a box-projected UVMap so interior faces cut into it are textured."""
    if "UVMap" not in ob.data.uv_layers:
        ob.data.uv_layers.new(name="UVMap")
        box_uv(ob.data)


def add_bool(ob, cutter, name, before=None):
    m = ob.modifiers.new(name, "BOOLEAN")
    m.operation = "DIFFERENCE"
    m.solver = "EXACT"
    m.object = cutter
    m.material_mode = "TRANSFER"
    m.use_self = True           # cutters are unions of overlapping primitives
    names = [x.name for x in ob.modifiers]
    if before and before in names:
        ob.modifiers.move(names.index(name), names.index(before))
    return m


# ------------------------------------------------------------------ hull shell
HULL_Y = 0.921
PROFILE = [(-0.44, 0.424), (2.399, 0.424), (2.781, 0.710), (2.781, 0.948), (1.951, 1.426), (-0.44, 1.426)]  # 4-8 mm inside the armour


def build_hull_shell(coll, cut_coll):
    bm = bmesh.new()
    left = [bm.verts.new((x, HULL_Y, z)) for x, z in PROFILE]
    right = [bm.verts.new((x, -HULL_Y, z)) for x, z in PROFILE]
    bm.faces.new(left)
    bm.faces.new(list(reversed(right)))
    n = len(PROFILE)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((right[i], right[j], left[j], left[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = D.meshes.new("int_hull_shell_tmp")
    bm.to_mesh(me)
    bm.free()
    shell = temp_object("int_hull_shell_tmp", me, cut_coll)
    temps = []
    for src in ("cut_driver_hatch", "cut_bow_mg", "cut_turret_ring"):
        s = D.objects[src]
        t = temp_object(src + "_tmp", s.data.copy(), cut_coll)
        t.matrix_world = s.matrix_world.copy()
        temps.append(t)
        m = shell.modifiers.new(src, "BOOLEAN")
        m.operation, m.solver, m.object = "DIFFERENCE", "EXACT", t
    baked = bake_modifiers(shell)
    for t in temps:
        me_t = t.data
        D.objects.remove(t, do_unlink=True)
        D.meshes.remove(me_t)
    D.objects.remove(shell, do_unlink=True)
    D.meshes.remove(me)

    # keep only faces lying on the original shell planes -> the cutters leave clean holes
    planes = [(Vector((0, 1, 0)), HULL_Y), (Vector((0, -1, 0)), HULL_Y)]
    for i in range(n):
        (x0, z0), (x1, z1) = PROFILE[i], PROFILE[(i + 1) % n]
        nrm = Vector((z1 - z0, 0, -(x1 - x0))).normalized()
        planes.append((nrm, nrm.dot(Vector((x0, 0, z0)))))
    bm = bmesh.new()
    bm.from_mesh(baked)
    kill = []
    for f in bm.faces:
        if not any(all(abs(p.dot(v.co) - d) < 2e-3 for v in f.verts) for p, d in planes):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.reverse_faces(bm, faces=bm.faces)      # normals point into the crew compartment
    bm.to_mesh(baked)
    bm.free()
    part = Part("int_hull_shell")
    part.bm.from_mesh(baked)
    D.meshes.remove(baked)
    part.mats = ["INT_paint", "INT_floor"]
    part.bm.normal_update()
    for f in part.bm.faces:
        f.material_index = 1 if (f.normal.z > 0.9 and f.calc_center_median().z < 0.5) else 0
    return part.finish(coll, "hull")


def reshape_engine_core():
    core = D.objects["hull_inner_core"]
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(((-2.93 - 0.445) / 2, 0, 0.92)) @ Matrix.Diagonal((2.93 - 0.445, 1.84, 0.96, 1)))
    bm.to_mesh(core.data)
    bm.free()
    core.location = (0, 0, 0)
    core.rotation_euler = (0, 0, 0)
    core.scale = (1, 1, 1)


# ------------------------------------------------------------------ turret cavity
def build_turret_cutters(cut_coll, turret):
    body = D.objects["turret_body"]
    inv = turret.matrix_world.inverted()

    # decimated copy of the evaluated turret shell, in turret-local space
    tmp = temp_object("cav_src", body.data.copy(), cut_coll)
    tmp.matrix_world = inv @ body.matrix_world
    for m in body.modifiers:
        if m.type in ("SUBSURF",):
            mm = tmp.modifiers.new(m.name, m.type)
            mm.levels = 1
    dec = tmp.modifiers.new("dec", "DECIMATE")
    dec.ratio = 0.35
    me = bake_modifiers(tmp)
    src_me = tmp.data
    D.objects.remove(tmp, do_unlink=True)
    D.meshes.remove(src_me)
    me.transform(inv @ body.matrix_world)

    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    # armour: ~75 mm walls, ~25 mm roof, 45 mm floor overhang
    moves = []
    for v in bm.verts:
        n = v.normal
        t = 0.07 - 0.035 * max(0.0, n.z) - 0.025 * max(0.0, -n.z)
        moves.append((v, v.co - n * t))
    for v, co in moves:
        v.co = co
    bm.to_mesh(me)
    bm.free()
    cav = temp_object("INT_cut_turret_cavity", me, cut_coll)

    # turret ring opening (also cuts the solid base-ring disc)
    ring_me = D.meshes.new("INT_cut_ring")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=64, radius1=0.785, radius2=0.785, depth=0.7,
                          matrix=Matrix.Translation((0, 0, 0.1)))
    bm.to_mesh(ring_me)
    bm.free()
    ring = temp_object("INT_cut_ring", ring_me, cut_coll)
    u = cav.modifiers.new("ring", "BOOLEAN")
    u.operation, u.solver, u.object = "UNION", "EXACT", ring
    baked = bake_modifiers(cav)
    old = cav.data
    cav.modifiers.clear()
    cav.data = baked
    D.meshes.remove(old)
    D.objects.remove(ring, do_unlink=True)
    D.meshes.remove(ring_me)

    # cupola well + the five vision slits (turret-local)
    cup_c = inv @ D.objects["cupola_base"].matrix_world.translation
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=0.232, radius2=0.232, depth=0.85,
                          matrix=Matrix.Translation((cup_c.x, cup_c.y, 0.925)))
    for i in range(5):
        g = inv @ D.objects[f"cupola_vision_glass_{i}"].matrix_world.translation
        d = Vector((g.x - cup_c.x, g.y - cup_c.y, 0))
        ang = math.atan2(d.y, d.x)
        r_in, r_out = 0.18, d.length - 0.012
        M = (Matrix.Translation((cup_c.x + math.cos(ang) * (r_in + r_out) / 2, cup_c.y + math.sin(ang) * (r_in + r_out) / 2, g.z))
             @ Matrix.Rotation(ang, 4, "Z") @ Matrix.Diagonal((r_out - r_in, 0.11, 0.034, 1)))
        bmesh.ops.create_cube(bm, size=1.0, matrix=M)
    cme = D.meshes.new("INT_cut_cupola")
    bm.to_mesh(cme)
    bm.free()
    cup = temp_object("INT_cut_cupola", cme, cut_coll)

    for c in (cav, cup):
        c.parent = turret
        c.matrix_parent_inverse = Matrix.Identity(4)
        c.data.materials.clear()            # the cavity was copied from turret_body: drop its exterior paint
        c.data.materials.append(D.materials["INT_paint"])
        for poly in c.data.polygons:
            poly.material_index = 0
        box_uv(c.data)
        c.display_type = "WIRE"
        c.hide_render = True
        c.hide_viewport = True
    return cav, cup


def hollow_turret(cav, cup):
    body = D.objects["turret_body"]
    for ob in [body] + [D.objects[n] for n in ("turret_base_ring", "turret_roof_plate", "cupola_base", "cupola_ring")] + \
              [D.objects[f"cupola_vision_frame_{i}"] for i in range(5)]:
        ensure_uv(ob)
        wn = next((m.name for m in ob.modifiers if m.type == "WEIGHTED_NORMAL"), None)
        if ob is body or ob.name == "turret_base_ring":
            add_bool(ob, cav, "INT_cavity", before=wn)
        if ob is not D.objects["turret_base_ring"]:
            add_bool(ob, cup, "INT_cupola", before=wn)


# ------------------------------------------------------------------ exterior parts that now show inside
def offset_profile(P, d):
    """Offset the convex XZ profile outward by d."""
    n = len(P)
    lines = []
    for i in range(n):
        (x0, z0), (x1, z1) = P[i], P[(i + 1) % n]
        nx, nz = (z1 - z0), -(x1 - x0)
        L = math.hypot(nx, nz)
        nx, nz = -nx / L, -nz / L                     # outward for a CCW profile
        lines.append(((x0 + nx * d, z0 + nz * d), (x1 - x0, z1 - z0)))
    out = []
    for i in range(n):
        (p, r), (q, s_) = lines[i - 1], lines[i]
        den = r[0] * s_[1] - r[1] * s_[0]
        t = ((q[0] - p[0]) * s_[1] - (q[1] - p[1]) * s_[0]) / den
        out.append((p[0] + t * r[0], p[1] + t * r[1]))
    return out


def inside_hull(w, m=0.01):
    if abs(w.y) > HULL_Y - m or w.z < PROFILE[0][1] + m or w.z > PROFILE[-1][1] - m or w.x < PROFILE[0][0] + m:
        return False
    n = len(PROFILE)
    for i in range(n):
        (x0, z0), (x1, z1) = PROFILE[i], PROFILE[(i + 1) % n]
        if (x1 - x0) * (w.z - z0) - (z1 - z0) * (w.x - x0) < m * math.hypot(x1 - x0, z1 - z0):
            return False
    return True


HULL_KEEP = {"hd_bow_mg_ball", "turret_base_ring"}               # intentionally visible inside
TURRET_KEEP = {"turret_body", "turret_mantlet", "turret_gun_sleeve", "turret_base_ring"}


def trim_intruders(cut_coll, cav):
    """Exterior details that used to be buried in solid geometry get cut back to the armour."""
    from mathutils.bvhtree import BVHTree
    P = offset_profile(PROFILE, 0.006)
    Y = HULL_Y + 0.006
    bm = bmesh.new()
    left = [bm.verts.new((x, Y, z)) for x, z in P]
    right = [bm.verts.new((x, -Y, z)) for x, z in P]
    bm.faces.new(left)
    bm.faces.new(list(reversed(right)))
    for i in range(len(P)):
        j = (i + 1) % len(P)
        bm.faces.new((right[i], right[j], left[j], left[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = D.meshes.new("INT_cut_hull_interior")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(D.materials["INT_paint"])
    hull_cut = temp_object("INT_cut_hull_interior", me, cut_coll)
    hull_cut.display_type = "WIRE"
    hull_cut.hide_render = True
    hull_cut.hide_viewport = True

    dg = bpy.context.evaluated_depsgraph_get()
    ce = cav.evaluated_get(dg)
    bvh = BVHTree.FromPolygons([cav.matrix_world @ v.co for v in ce.data.vertices], [p.vertices[:] for p in ce.data.polygons])
    trimmed = []
    for cname, keep in (("hull", HULL_KEEP), ("hull_details", HULL_KEEP), ("turret", TURRET_KEEP)):
        for ob in D.collections[cname].objects:
            if ob.type != "MESH" or ob.hide_render or ob.name in keep or ob.name.startswith("cut_"):
                continue
            ev = ob.evaluated_get(dg)
            ws = [ob.matrix_world @ v.co for v in ev.data.vertices]
            if cname != "turret":
                if any(inside_hull(w) for w in ws):
                    add_bool(ob, hull_cut, "INT_hull_trim")
                    trimmed.append(ob.name)
            else:
                deep = 0.0
                for w in ws:
                    hit, n, i, d = bvh.find_nearest(w)
                    if hit is not None and (w - hit).dot(n) < 0:
                        deep = max(deep, d)
                if deep > 0.01:
                    ensure_uv(ob)
                    add_bool(ob, cav, "INT_cavity")
                    trimmed.append(ob.name)
    print("trimmed exterior parts:", trimmed)


# ------------------------------------------------------------------ small reusable assemblies
def seat(p, c, w=0.36, d=0.36, back_h=0.34, back_tilt=-0.2, post=True):
    """Crew seat: cushion top centred at c, backrest behind (-x)."""
    x, y, z = c
    p.box((x, y, z - 0.035), (d, w, 0.07), "INT_leather", bevel=0.02, seg=2)
    p.box((x, y, z - 0.078), (d - 0.02, w - 0.02, 0.016), "INT_metal_dark", bevel=0.004)
    bx = x - d / 2 - 0.02
    p.box((bx, y, z + back_h / 2 + 0.03), (0.06, w - 0.02, back_h), "INT_leather", rot=(0, back_tilt, 0), bevel=0.02, seg=2)
    for sy in (-1, 1):
        yy = y + sy * (w / 2 - 0.03)
        p.path([(x - d / 2 + 0.03, yy, z - 0.08), (bx + 0.035, yy, z - 0.06),
                (bx + 0.035 + math.sin(back_tilt) * back_h * 0.8, yy, z + back_h * 0.8)], 0.011, "INT_metal_dark")
    if post:
        p.cyl((x, y, 0.43), (x, y, z - 0.085), 0.03, "INT_metal_dark", seg=12)
        p.box((x, y, 0.432), (0.2, 0.16, 0.016), "INT_metal_dark", bevel=0.004)
        p.box((x + 0.12, y, 0.47), (0.02, 0.1, 0.06), "INT_steel")   # height-adjust latch


def round_85(p, base, direction, lying_mat="INT_brass"):
    """85 mm UBR-365 round: brass case 0.63 m + black AP projectile, base at `base`."""
    b = Vector(base)
    d = Vector(direction).normalized()
    p.cyl(b - d * 0.004, b + d * 0.008, 0.059, lying_mat, seg=20)
    p.cyl(b + d * 0.008, b + d * 0.55, 0.052, lying_mat, r2=0.05, seg=20)
    p.cyl(b + d * 0.55, b + d * 0.60, 0.05, lying_mat, r2=0.045, seg=20)
    p.cyl(b + d * 0.60, b + d * 0.64, 0.045, lying_mat, seg=20, caps=False)
    p.cyl(b + d * 0.62, b + d * 0.66, 0.0445, "INT_copper", seg=20)
    p.cyl(b + d * 0.66, b + d * 0.80, 0.0425, "INT_shell", seg=20)
    p.cyl(b + d * 0.80, b + d * 0.95, 0.0425, "INT_shell", r2=0.008, seg=20)
    p.sphere(b - d * 0.004, 0.012, "INT_copper", seg=8, scale=(1, 1, 0.3), rot=track(d))


def handwheel(name, coll, group, parent, centre_parent_space, axis, radius, frame, props):
    """Separate animatable handwheel. Built around the origin, rotated so local Z = axis."""
    p = Part(name)
    p.torus((0, 0, 0), (0, 0, 1), radius, 0.011, "INT_metal_dark", seg=36, rseg=8)
    p.cyl((0, 0, -0.03), (0, 0, 0.02), 0.022, "INT_metal_dark", seg=16)
    for k in range(3):
        a = 2 * math.pi * k / 3
        p.cyl((0, 0, 0), (math.cos(a) * radius, math.sin(a) * radius, 0), 0.007, "INT_metal_dark", seg=8)
    a = R(60)
    hx, hy = math.cos(a) * radius, math.sin(a) * radius
    p.cyl((hx, hy, 0), (hx, hy, 0.09), 0.012, "INT_rubber", seg=12)
    basis = Matrix.Translation(centre_parent_space) @ track(axis).to_4x4()
    return p.finish(coll, group, parent=parent, basis=basis, static=False, props=props)


# ------------------------------------------------------------------ stations
def build_driver(coll, cols):
    p = Part("drv")
    seat(p, (1.80, 0.33, 0.56))
    # steering levers: pivot brackets on the floor
    for y in (0.10, 0.56):
        p.box((2.04, y, 0.455), (0.09, 0.05, 0.06), "INT_metal_dark", bevel=0.006)
        p.cyl((2.04, y - 0.03, 0.47), (2.04, y + 0.03, 0.47), 0.012, "INT_steel", seg=10)
    # pedal bracket
    p.box((2.10, 0.33, 0.445), (0.10, 0.44, 0.04), "INT_metal_dark", bevel=0.006)
    p.cyl((2.10, 0.10, 0.47), (2.10, 0.56, 0.47), 0.012, "INT_steel", seg=10)
    # gearbox selector gate
    p.box((1.95, -0.03, 0.47), (0.18, 0.13, 0.09), "INT_metal_dark", bevel=0.008)
    p.box((1.95, -0.03, 0.518), (0.15, 0.10, 0.008), "INT_steel")
    for k, gx in enumerate((1.90, 1.95, 2.00)):
        p.box((gx, -0.03, 0.523), (0.012, 0.07, 0.004), "INT_rubber")
    # hand throttle on left wall
    p.box((1.72, 0.90, 0.86), (0.08, 0.03, 0.10), "INT_metal_dark", bevel=0.005)
    p.path([(1.72, 0.885, 0.86), (1.76, 0.86, 0.93), (1.79, 0.86, 0.97)], 0.008, "INT_steel")
    p.sphere((1.79, 0.86, 0.975), 0.016, "INT_rubber", seg=10)
    # compressed-air starting bottles (2 x 10 l) with straps and valves
    for z in (0.51, 0.675):
        p.cyl((1.62, 0.815, z), (2.14, 0.815, z), 0.075, "INT_green", seg=24)
        p.sphere((1.62, 0.815, z), 0.075, "INT_green", seg=16, scale=(0.4, 1, 1), rot=(0, R(90), 0))
        p.cyl((2.14, 0.815, z), (2.19, 0.815, z), 0.022, "INT_brass", seg=12)
        p.cyl((2.18, 0.79, z), (2.18, 0.84, z), 0.016, "INT_brass", seg=10)
        for sx in (1.72, 2.04):
            p.ring((sx, 0.815, z), (1, 0, 0), 0.076, 0.082, 0.025, "INT_metal_dark", seg=24)
    p.box((1.88, 0.905, 0.60), (0.5, 0.03, 0.28), "INT_metal_dark", bevel=0.005)
    p.path([(2.19, 0.815, 0.51), (2.24, 0.815, 0.60), (2.19, 0.815, 0.675)], 0.007, "INT_copper")
    p.path([(2.24, 0.815, 0.60), (2.26, 0.86, 0.80), (2.10, 0.90, 1.00)], 0.007, "INT_copper")
    # fire extinguisher (tetrachloride) on bracket
    p.cyl((1.45, 0.85, 0.62), (1.45, 0.85, 0.92), 0.045, "INT_red", seg=18)
    p.cyl((1.45, 0.85, 0.92), (1.45, 0.85, 0.97), 0.02, "INT_brass", seg=12)
    p.path([(1.45, 0.85, 0.97), (1.47, 0.83, 0.99), (1.50, 0.83, 0.98)], 0.006, "INT_brass")
    for z in (0.68, 0.86):
        p.ring((1.45, 0.85, z), (0, 0, 1), 0.046, 0.052, 0.02, "INT_metal_dark", seg=18)
    p.box((1.45, 0.905, 0.77), (0.06, 0.02, 0.28), "INT_metal_dark")
    # driver's electrical switchboard
    p.box((1.72, 0.885, 1.17), (0.18, 0.06, 0.15), "INT_radio", bevel=0.006)
    for k in range(3):
        p.cyl((1.66 + 0.06 * k, 0.855, 1.20), (1.66 + 0.06 * k, 0.83, 1.215), 0.004, "INT_steel", seg=8)
        p.cyl((1.66 + 0.06 * k, 0.855, 1.20), (1.66 + 0.06 * k, 0.852, 1.20), 0.012, "INT_metal_dark", seg=12)
    p.cyl((1.72, 0.855, 1.13), (1.72, 0.84, 1.13), 0.016, "INT_red", seg=14)       # starter button
    p.cyl((1.78, 0.855, 1.13), (1.78, 0.845, 1.13), 0.012, "INT_lamp", seg=12)     # pilot lamp
    # tank-intercom TPU box + headset hanging on a hook
    p.box((1.50, 0.89, 1.07), (0.12, 0.05, 0.12), "INT_radio", bevel=0.006)
    p.cyl((1.50, 0.865, 1.09), (1.50, 0.85, 1.09), 0.018, "INT_metal_dark", seg=14)
    p.path([(1.50, 0.87, 1.03), (1.52, 0.83, 0.95), (1.58, 0.80, 0.90)], 0.006, "INT_rubber")
    p.sphere((1.58, 0.80, 0.88), 0.045, "INT_leather", seg=12, scale=(1, 0.7, 1))
    # data plate on the left wall
    p.atlas_quad((1.30, 0.919, 1.22), Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0))).transposed(), 0.14, 0.09, 7)
    # dome lamp
    p.cyl((1.70, 0.62, 1.426), (1.70, 0.62, 1.40), 0.05, "INT_metal_dark", seg=16)
    p.sphere((1.70, 0.62, 1.40), 0.035, "INT_lamp", seg=12, scale=(1, 1, 0.6))
    p.finish(cols["hull"], "hull")

    # instrument panel (own frame so the needles can rotate about their local Z)
    C = Vector((2.00, 0.835, 1.10))
    E = Vector((1.84, 0.33, 1.26))
    z = (E - C).normalized()
    x = (C - E).cross(Vector((0, 0, 1))).normalized()
    y = z.cross(x)
    F = Matrix.Translation(C) @ Matrix((x, y, z)).transposed().to_4x4()
    panel = D.objects.new("driver_instrument_panel", None)
    panel.empty_display_type = "PLAIN_AXES"
    panel.empty_display_size = 0.05
    panel.matrix_world = F
    cols["hull"].objects.link(panel)
    pp = Part("drv_panel")
    pp.box((0, 0, -0.012), (0.37, 0.25, 0.024), "INT_radio", bevel=0.008, seg=2)
    for sx in (-1, 1):   # mounting struts back to the wall
        pp.cyl((sx * 0.15, 0.0, -0.024), (sx * 0.15, 0.02, -0.09), 0.01, "INT_metal_dark", seg=8)
    gauges = [  # name, cell, x, y, r, lo, hi
        ("speedometer", 0, -0.095, 0.035, 0.058, 0, 60),
        ("tachometer", 1, 0.06, 0.035, 0.058, 0, 2500),
        ("oil_pressure", 2, -0.135, -0.08, 0.032, 0, 15),
        ("oil_temp", 3, -0.055, -0.08, 0.032, 0, 125),
        ("water_temp", 4, 0.025, -0.08, 0.032, 0, 125),
        ("ammeter", 5, 0.105, -0.08, 0.032, -30, 30),
    ]
    for gname, cell, gx, gy, gr, lo, hi in gauges:
        pp.atlas_disc((gx, gy, 0.003), None, gr, cell)
        pp.ring((gx, gy, 0.006), (0, 0, 1), gr, gr + 0.008, 0.01, "INT_metal_dark", seg=40)
        n = Part("needle_" + gname)
        L = gr * 0.82
        vs = [(-0.18 * gr, -0.0035), (L, -0.0012), (L, 0.0012), (-0.18 * gr, 0.0035)]
        bm = n.bm
        ca = math.cos(R(225)), math.sin(R(225))
        verts = [bm.verts.new((px * ca[0] - py * ca[1], px * ca[1] + py * ca[0], 0.0)) for px, py in vs]
        bm.faces.new(verts)
        n._mark(set(), "INT_white")
        n.cyl((0, 0, -0.001), (0, 0, 0.004), 0.006, "INT_metal_dark", seg=10)
        n.finish(cols["hull"], "anim", parent=panel, origin=None, basis=Matrix.Translation((gx, gy, 0.007)), static=False,
                 props={"game_anim": "rotate local Z; angle_deg = -270 * (value - min) / (max - min)",
                        "gauge_min": lo, "gauge_max": hi, "gauge_sweep_deg": 270.0})
    for k in range(4):   # warning lamps + toggles along the right edge
        pp.cyl((0.155, 0.09 - 0.045 * k, 0.0), (0.155, 0.09 - 0.045 * k, 0.012), 0.009, "INT_lamp" if k == 0 else "INT_metal_dark", seg=12)
    pp.finish(cols["hull"], "hull", parent=panel)

    # --- animatable controls (origin on pivot)
    for side, y in (("L", 0.56), ("R", 0.10)):
        lv = Part(f"lever_steer_{side}")
        lv.path([(2.04, y, 0.47), (2.02, y, 0.62), (1.97, y, 0.93)], 0.013, "INT_steel")
        lv.cyl((1.972, y, 0.91), (1.955, y, 1.05), 0.021, "INT_rubber", seg=14)
        lv.sphere((1.955, y, 1.05), 0.021, "INT_rubber", seg=12)
        lv.finish(cols["hull"], "anim", origin=(2.04, y, 0.47), static=False,
                  props={"game_anim": "rotate local Y, pull = negative, range_deg = [-22, 0]"})
    for pname, y, top in (("clutch", 0.47, 0.62), ("brake", 0.27, 0.60), ("throttle", 0.17, 0.57)):
        pd = Part("pedal_" + pname)
        pd.path([(2.10, y, 0.47), (2.22, y, 0.52), (2.29, y, top)], 0.011, "INT_steel")
        pad = (0.03, 0.09, 0.12) if pname != "throttle" else (0.03, 0.07, 0.16)
        pd.box((2.30, y, top + 0.02), pad, "INT_metal_dark", rot=(0, R(-28), 0), bevel=0.005)
        for k in range(4):
            pd.box((2.286 - 0.0 * k, y, top - 0.02 + k * 0.03), (0.006, pad[1] - 0.01, 0.006), "INT_steel", rot=(0, R(-28), 0))
        pd.finish(cols["hull"], "anim", origin=(2.10, y, 0.47), static=False,
                  props={"game_anim": "rotate local Y, press = positive, range_deg = [0, 18]"})
    gl = Part("lever_gear")
    gl.path([(1.95, -0.03, 0.52), (1.94, -0.03, 0.70), (1.90, -0.03, 0.87)], 0.011, "INT_steel")
    gl.sphere((1.90, -0.03, 0.885), 0.028, "INT_rubber", seg=14)
    gl.finish(cols["hull"], "anim", origin=(1.95, -0.03, 0.52), static=False,
              props={"game_anim": "5-speed gate: rotate local Y (fore/aft +/-14 deg) and local X (+/-10 deg per plane)"})

    # periscopes + handle on the open driver's hatch (parented to the lid so it can be animated)
    lid = D.objects["hull_driver_lid"]
    lp = Part("drv_lid", frame=lid.matrix_world.inverted())
    c = Vector((2.474, 0.33, 1.607))
    n = Vector((0.788, 0, -0.615))
    u = Vector((0.615, 0, 0.788))
    rot = Matrix((u, Vector((0, 1, 0)), n)).transposed()
    for sy in (-0.12, 0.12):
        o = c - u * 0.08 + Vector((0, sy, 0))
        lp.box(o + n * 0.045, (0.15, 0.085, 0.09), "INT_metal_dark", rot=rot, bevel=0.008)
        lp.box(o + n * 0.093, (0.10, 0.065, 0.008), "INT_glass", rot=rot)
        lp.box(o + n * 0.06 + u * 0.085, (0.03, 0.09, 0.05), "INT_rubber", rot=rot, bevel=0.01)
    lp.path([c + u * 0.13 + Vector((0, -0.07, 0)), c + u * 0.13 + n * 0.04 + Vector((0, -0.05, 0)),
             c + u * 0.13 + n * 0.04 + Vector((0, 0.05, 0)), c + u * 0.13 + Vector((0, 0.07, 0))], 0.009, "INT_steel")
    lp.finish(cols["hull"], "lid", parent=lid)


def build_bow_gunner(coll, cols):
    p = Part("bow")
    seat(p, (1.80, -0.47, 0.56))
    # DT drum rack (6 x 63-round pans) on the right wall
    p.box((1.585, -0.905, 1.03), (0.50, 0.02, 0.72), "INT_metal_dark", bevel=0.005)
    for cx in (1.47, 1.70):
        for cz in (0.80, 1.03, 1.26):
            p.cyl((cx, -0.895, cz), (cx, -0.855, cz), 0.108, "INT_green", seg=28)
            p.cyl((cx, -0.855, cz), (cx, -0.848, cz), 0.03, "INT_metal_dark", seg=12)
            p.box((cx, -0.87, cz + 0.105), (0.05, 0.05, 0.012), "INT_steel")          # clip
    # intercom
    p.box((2.02, -0.89, 1.10), (0.12, 0.05, 0.12), "INT_radio", bevel=0.006)
    p.cyl((2.02, -0.865, 1.12), (2.02, -0.85, 1.12), 0.018, "INT_metal_dark", seg=14)
    p.finish(cols["hull"], "hull")

    # hull DT in the ball mount - own object, origin at the ball centre, local +X = bore axis
    mg = Part("bow_mg_dt")
    mg.sphere((0, 0, 0), 0.135, "INT_metal_dark", seg=20, scale=(0.35, 1, 1))
    mg.ring((-0.05, 0, 0), (1, 0, 0), 0.10, 0.145, 0.02, "INT_metal_dark", seg=32)
    mg.box((-0.26, 0, 0.0), (0.34, 0.06, 0.08), "INT_metal_dark", bevel=0.006)
    mg.cyl((-0.08, 0, 0.0), (0.05, 0, 0.0), 0.028, "INT_metal_dark", seg=14)
    mg.cyl((-0.22, 0, 0.045), (-0.22, 0, 0.085), 0.118, "INT_green", seg=32)           # pan magazine
    mg.cyl((-0.22, 0, 0.085), (-0.22, 0, 0.095), 0.03, "INT_metal_dark", seg=14)
    mg.box((-0.37, 0, -0.07), (0.03, 0.028, 0.09), "INT_leather", rot=(0, R(-15), 0), bevel=0.008)   # pistol grip
    mg.path([(-0.33, 0, -0.04), (-0.33, 0, -0.07), (-0.30, 0, -0.07), (-0.30, 0, -0.04)], 0.004, "INT_steel")
    mg.cyl((-0.43, 0.018, 0.0), (-0.64, 0.018, -0.01), 0.009, "INT_steel", seg=8)   # telescopic stock rods
    mg.cyl((-0.43, -0.018, 0.0), (-0.64, -0.018, -0.01), 0.009, "INT_steel", seg=8)
    mg.box((-0.65, 0, -0.01), (0.03, 0.06, 0.12), "INT_rubber", bevel=0.01)
    mg.cyl((-0.14, 0.055, 0.03), (-0.34, 0.055, 0.03), 0.02, "INT_metal_dark", seg=12)   # PPU-8T sight tube
    mg.cyl((-0.34, 0.055, 0.03), (-0.38, 0.055, 0.03), 0.026, "INT_rubber", seg=12)
    basis = Matrix.Translation((2.53, -0.47, 1.15)) @ Matrix.Rotation(R(-30), 4, "Y")
    mg.finish(cols["hull"], "anim", basis=basis, static=False,
              props={"game_anim": "ball mount: rotate local Z (traverse +/-12 deg) and local Y (elevation -6..+16 deg about the modelled pose)"})


def build_fighting_compartment(coll, cols):
    p = Part("fc")
    # floor ammunition bins (rubber-matted lids the loader stands on)
    for x0, x1 in ((-0.10, 0.64), (0.66, 1.40)):
        for y0, y1 in ((-0.74, -0.25), (-0.245, 0.245), (0.25, 0.74)):
            cx, cy, L, W = (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0
            p.box((cx, cy, 0.505), (L, W, 0.16), "INT_paint", bevel=0.008)
            p.box((cx, cy, 0.589), (L - 0.03, W - 0.03, 0.01), "INT_rubber", bevel=0.003)
            for sx in (-1, 1):
                p.path([(cx + sx * (L / 2 + 0.004), cy - 0.05, 0.54), (cx + sx * (L / 2 + 0.025), cy - 0.04, 0.54),
                        (cx + sx * (L / 2 + 0.025), cy + 0.04, 0.54), (cx + sx * (L / 2 + 0.004), cy + 0.05, 0.54)], 0.006, "INT_steel", seg=6)
            p.box((cx, cy - W / 2 - 0.004, 0.56), (0.05, 0.012, 0.04), "INT_steel")   # latch
    # batteries (4 x 6-STE-128) in two boxes against the bulkhead
    for sy in (-1, 1):
        cy = sy * 0.50
        p.box((-0.28, cy, 0.56), (0.30, 0.42, 0.27), "INT_green", bevel=0.01)
        for k in (-1, 1):
            for t in (-1, 1):
                p.cyl((-0.28 + t * 0.08, cy + k * 0.12, 0.695), (-0.28 + t * 0.08, cy + k * 0.12, 0.72), 0.014, "INT_brass", seg=10)
        p.path([(-0.20, cy - 0.12, 0.72), (-0.20, cy - 0.12, 0.78), (-0.36, cy + 0.12, 0.78), (-0.36, cy + 0.12, 0.72)], 0.008, "INT_rubber")
    p.path([(-0.20, -0.38, 0.72), (-0.35, -0.2, 0.9), (-0.43, 0.0, 1.0)], 0.01, "INT_rubber")
    # engine bulkhead: access panel, bolts, handles, fuel cocks
    p.box((-0.432, 0, 1.05), (0.012, 0.92, 0.56), "INT_paint", bevel=0.004)
    for k in range(12):
        for yy, zz in ((-0.44 + 0.08 * k, 0.79), (-0.44 + 0.08 * k, 1.31)):
            p.cyl((-0.43, yy, zz), (-0.422, yy, zz), 0.011, "INT_metal_dark", seg=6)
    for zz in (0.87, 0.95, 1.03, 1.11, 1.19, 1.27):
        for yy in (-0.44, 0.44):
            p.cyl((-0.43, yy, zz), (-0.422, yy, zz), 0.011, "INT_metal_dark", seg=6)
    for yy in (-0.25, 0.25):
        p.path([(-0.428, yy - 0.06, 1.05), (-0.39, yy - 0.05, 1.05), (-0.39, yy + 0.05, 1.05), (-0.428, yy + 0.06, 1.05)], 0.01, "INT_steel")
    for k, yy in enumerate((-0.75, -0.62, 0.62)):
        p.cyl((-0.44, yy, 1.2), (-0.38, yy, 1.2), 0.02, "INT_brass", seg=12)
        p.box((-0.37, yy, 1.2), (0.012, 0.09, 0.02), "INT_red" if k == 0 else "INT_metal_dark")
    p.path([(-0.43, -0.75, 1.2), (-0.40, -0.70, 1.395), (1.95, -0.70, 1.395), (2.02, -0.70, 1.33)], 0.012, "INT_copper")
    # cable conduits under the roof edges
    p.path([(-0.42, 0.70, 1.405), (1.30, 0.70, 1.405), (1.60, 0.80, 1.33), (1.72, 0.86, 1.25)], 0.012, "INT_metal_dark")
    p.path([(-0.42, -0.66, 1.405), (1.50, -0.66, 1.405), (1.95, -0.80, 1.22), (2.02, -0.86, 1.16)], 0.012, "INT_metal_dark")
    # Christie spring housings: front pair near-vertical, mid pairs inclined (wheels 1-3)
    for sy in (-1, 1):
        p.cyl((2.40, sy * 0.835, 0.424), (2.20, sy * 0.835, 1.426), 0.09, "INT_paint", seg=20, caps=False)
        for wx in (1.07, 0.10):
            p.cyl((wx + 0.16, sy * 0.838, 0.424), (wx - 0.16, sy * 0.838, 1.426), 0.085, "INT_paint", seg=20, caps=False)
            for t in (0.25, 0.75):
                zc = 0.424 + t * 1.002
                xc = wx + 0.16 - t * 0.32
                p.ring((xc, sy * 0.838, zc), (-0.32, 0, 1.0), 0.085, 0.095, 0.03, "INT_paint", seg=20)
    # turret-ring gear (fixed to the hull), 120 internal teeth
    p.ring((0.55, 0, 1.40), (0, 0, 1), 0.80, 0.86, 0.05, "INT_metal_dark", seg=96)
    for k in range(120):
        a = 2 * math.pi * k / 120
        p.box((0.55 + math.cos(a) * 0.792, math.sin(a) * 0.792, 1.40), (0.018, 0.022, 0.045), "INT_metal_dark", rot=(0, 0, a))
    p.finish(cols["hull"], "hull")


def build_turret(coll, cols, turret):
    T = Matrix.Translation(-ROOT_DEFAULT)           # parts below are written in world coords
    p = Part("tur", frame=T)
    # rotating race ring
    p.ring((0.55, 0, 1.475), (0, 0, 1), 0.745, 0.785, 0.05, "INT_steel", seg=96)
    # gunner's seat, hung from the race ring
    seat(p, (0.30, 0.46, 1.34), w=0.28, d=0.28, back_h=0.18, back_tilt=-0.1, post=False)
    p.path([(0.30, 0.46, 1.25), (0.33, 0.60, 1.30), (0.36, 0.72, 1.46)], 0.016, "INT_metal_dark")
    p.path([(0.18, 0.46, 1.25), (0.20, 0.64, 1.35), (0.22, 0.70, 1.46)], 0.014, "INT_metal_dark")
    # commander's seat on wall brackets, below the cupola
    seat(p, (-0.13, 0.43, 1.70), w=0.30, d=0.28, back_h=0.20, back_tilt=-0.08, post=False)
    p.path([(-0.13, 0.43, 1.62), (-0.13, 0.70, 1.66), (-0.13, 0.86, 1.76)], 0.016, "INT_metal_dark")
    p.path([(-0.24, 0.43, 1.62), (-0.24, 0.70, 1.66), (-0.24, 0.85, 1.78)], 0.016, "INT_metal_dark")
    p.box((-0.18, 0.88, 1.78), (0.18, 0.02, 0.08), "INT_metal_dark", bevel=0.004)
    # loader's folding seat with straps (right wall)
    p.box((0.25, -0.70, 1.52), (0.26, 0.22, 0.05), "INT_leather", bevel=0.015, seg=2)
    p.box((0.25, -0.86, 1.53), (0.24, 0.03, 0.05), "INT_metal_dark", bevel=0.004)
    for sx in (-0.10, 0.10):
        p.box((0.25 + sx, -0.74, 1.73), (0.03, 0.006, 0.40), "INT_canvas", rot=(R(-12), 0, 0))
    # elevation gearbox (turret-fixed) - handwheel is a separate object
    p.box((0.76, 0.22, 1.74), (0.14, 0.12, 0.15), "INT_metal_dark", bevel=0.01)
    p.cyl((0.76, 0.28, 1.74), (0.76, 0.33, 1.74), 0.016, "INT_steel", seg=12)
    p.path([(0.76, 0.22, 1.66), (0.80, 0.22, 1.55), (0.84, 0.30, 1.47)], 0.012, "INT_metal_dark")
    # traverse mechanism MPB + MB-20V electric motor + controller
    p.box((0.93, 0.62, 1.56), (0.18, 0.16, 0.20), "INT_metal_dark", bevel=0.012)
    p.cyl((0.84, 0.62, 1.70), (1.06, 0.62, 1.70), 0.07, "INT_green", seg=20)
    p.cyl((0.82, 0.62, 1.70), (0.84, 0.62, 1.70), 0.05, "INT_metal_dark", seg=16)
    p.box((0.80, 0.74, 1.72), (0.08, 0.07, 0.09), "INT_green", bevel=0.006)
    p.path([(0.80, 0.74, 1.765), (0.77, 0.74, 1.82)], 0.008, "INT_steel")
    p.sphere((0.77, 0.74, 1.825), 0.016, "INT_rubber", seg=10)
    p.cyl((0.84, 0.62, 1.60), (0.83, 0.62, 1.60), 0.02, "INT_steel", seg=12)
    # 9-RS radio: transmitter + receiver stack on the left rear wall
    for zc, h in ((1.66, 0.19), (1.88, 0.23)):
        p.box((-0.52, 0.765, zc), (0.40, 0.17, h), "INT_radio", bevel=0.008)
        for sx in (-0.19, 0.19):
            p.path([(-0.52 + sx, 0.70, zc + h / 2 - 0.02), (-0.52 + sx, 0.66, zc + h / 2 - 0.02)], 0.006, "INT_steel")
    p.atlas_quad((-0.52, 0.679, 1.915), Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0))).transposed(), 0.15, 0.095, 6)
    for k, kx in enumerate((-0.66, -0.38, -0.66, -0.38, -0.52)):
        kz = (1.84, 1.84, 1.67, 1.67, 1.62)[k]
        p.cyl((kx, 0.68, kz), (kx, 0.655, kz), 0.018 if k < 4 else 0.012, "INT_metal_dark", seg=16)
    p.cyl((-0.45, 0.68, 1.70), (-0.45, 0.668, 1.70), 0.022, "INT_glass", seg=16)      # antenna current meter
    p.path([(-0.52, 0.85, 2.00), (-0.60, 0.85, 2.20), (-0.78, 0.85, 2.25)], 0.01, "INT_copper")   # feed to the antenna mount
    p.box((-0.20, 0.87, 1.98), (0.12, 0.05, 0.12), "INT_radio", bevel=0.006)              # commander's intercom
    p.path([(-0.20, 0.85, 1.93), (-0.22, 0.80, 1.86), (-0.28, 0.78, 1.83)], 0.006, "INT_rubber")
    p.sphere((-0.30, 0.77, 1.82), 0.045, "INT_leather", seg=12, scale=(0.7, 1, 1))
    p.box((0.30, -0.87, 1.90), (0.12, 0.05, 0.12), "INT_radio", bevel=0.006)              # loader's intercom
    # bustle ready rack: 6 rounds lying across the turret, straps + end frames
    for rx in (-0.81, -0.93):
        for rz in (1.80, 1.92, 2.04):
            round_85(p, (rx, 0.47, rz), (0, -1, 0))
    for yy in (-0.32, 0.30):
        p.box((-0.87, yy, 1.92), (0.26, 0.012, 0.40), "INT_metal_dark", bevel=0.004)
    for rz in (1.86, 1.98):
        p.box((-0.87, -0.05, rz), (0.26, 0.04, 0.006), "INT_leather")
    p.box((-0.87, 0.0, 1.73), (0.28, 0.80, 0.015), "INT_metal_dark", bevel=0.004)
    # roof ventilator fans under the two domes
    for vn in ("vent_base_0", "vent_base_1"):
        v = D.objects[vn].matrix_world.translation
        p.cyl((v.x, v.y, 2.19), (v.x, v.y, 2.31), 0.115, "INT_paint", seg=24, caps=False)
        p.ring((v.x, v.y, 2.19), (0, 0, 1), 0.07, 0.12, 0.01, "INT_metal_dark", seg=24)
        for k in range(6):
            a = math.pi * k / 6
            p.box((v.x, v.y, 2.19), (0.23, 0.008, 0.006), "INT_metal_dark", rot=(0, 0, a))
        p.cyl((v.x, v.y, 2.20), (v.x, v.y, 2.26), 0.04, "INT_green", seg=16)
    # cupola: inner race + grab handles; loader's hatch lock handle; periscope eyepieces
    cc = D.objects["cupola_base"].matrix_world.translation
    p.ring((cc.x, cc.y, 2.29), (0, 0, 1), 0.232, 0.26, 0.03, "INT_steel", seg=48)
    for a in (R(40), R(220)):
        q = Vector((cc.x + math.cos(a) * 0.228, cc.y + math.sin(a) * 0.228, 2.40))
        t = Vector((-math.sin(a), math.cos(a), 0)) * 0.05
        p.path([q - t, q - t - Vector((math.cos(a), math.sin(a), 0)) * 0.03, q + t - Vector((math.cos(a), math.sin(a), 0)) * 0.03, q + t], 0.008, "INT_steel")
    lh = D.objects["loader_hatch_ring"].matrix_world.translation
    p.path([(lh.x - 0.08, lh.y, 2.30), (lh.x - 0.08, lh.y, 2.25), (lh.x + 0.08, lh.y, 2.25), (lh.x + 0.08, lh.y, 2.30)], 0.01, "INT_steel")
    p.box((lh.x, lh.y + 0.2, 2.29), (0.12, 0.03, 0.02), "INT_metal_dark")
    for pn in ("gunner_mk4", "loader_mk4"):
        e = D.objects[pn].matrix_world.translation
        p.box((e.x, e.y, 2.22), (0.075, 0.16, 0.16), "INT_metal_dark", bevel=0.008)
        p.box((e.x - 0.04, e.y, 2.20), (0.008, 0.12, 0.05), "INT_glass")
        p.box((e.x - 0.05, e.y, 2.25), (0.03, 0.13, 0.03), "INT_rubber", bevel=0.01)
    # dome lamp
    p.cyl((0.20, -0.35, 2.31), (0.20, -0.35, 2.28), 0.05, "INT_metal_dark", seg=16)
    p.sphere((0.20, -0.35, 2.28), 0.035, "INT_lamp", seg=12, scale=(1, 1, 0.6))
    p.finish(cols["turret"], "turret", parent=turret)

    handwheel("wheel_elevation", cols["turret"], "anim", turret, Vector((0.76, 0.35, 1.74)) - ROOT_DEFAULT, (0, 1, 0), 0.09, None,
              {"game_anim": "rotate local Z; drives tank_controls.gun_elevation (approx. 1 turn = 2.5 deg)"})
    handwheel("wheel_traverse", cols["turret"], "anim", turret, Vector((0.76, 0.62, 1.62)) - ROOT_DEFAULT, (-1, -0.3, 0.25), 0.10, None,
              {"game_anim": "rotate local Z; drives tank_controls.turret_traverse (approx. 1 turn = 1.3 deg)"})


def build_gun(coll, cols, cradle):
    """ZiS-S-53 breech end. Coordinates are gun_cradle-local: +X = bore axis, origin = trunnions."""
    p = Part("gun")
    x_m = -0.27                                       # rear face of the mantlet casting
    p.box((-0.48, 0, -0.01), (0.44, 0.24, 0.27), "INT_metal_dark", bevel=0.015, seg=2)   # cradle
    p.cyl((x_m, 0, 0), (-0.72, 0, 0), 0.098, "INT_metal_dark", seg=28)                   # barrel tube
    for sy in (-0.075, 0.075):                                                             # recoil buffer / recuperator
        p.cyl((x_m, sy, 0.175), (-0.86, sy, 0.175), 0.052, "INT_metal_dark", seg=20)
        p.cyl((-0.86, sy, 0.175), (-0.89, sy, 0.175), 0.038, "INT_steel", seg=16)
        p.box((-0.80, sy, 0.10), (0.05, 0.05, 0.12), "INT_metal_dark")
    p.box((-0.845, 0, -0.005), (0.25, 0.33, 0.31), "INT_steel", bevel=0.012, seg=2)     # breech ring
    p.box((-0.73, 0, -0.005), (0.02, 0.35, 0.33), "INT_metal_dark", bevel=0.004)
    # breech operating handle (right side) and firing-mechanism housing
    p.path([(-0.80, -0.17, 0.02), (-0.80, -0.24, 0.02), (-0.95, -0.26, -0.08), (-1.02, -0.26, -0.10)], 0.013, "INT_steel")
    p.cyl((-1.02, -0.24, -0.10), (-1.02, -0.29, -0.10), 0.022, "INT_rubber", seg=12)
    p.box((-0.84, 0.18, -0.08), (0.10, 0.04, 0.08), "INT_metal_dark", bevel=0.006)
    # recoil guard: tubular frame + gunner-side shield plate, spent-case bag
    for sy in (-0.20, 0.20):
        p.path([(-0.93, sy, 0.10), (-1.55, sy, 0.10), (-1.55, sy, -0.13), (-0.93, sy, -0.13)], 0.014, "INT_metal_dark")
        p.cyl((-1.22, sy, 0.10), (-1.22, sy, -0.13), 0.012, "INT_metal_dark", seg=8)
    p.path([(-1.55, -0.20, -0.13), (-1.55, 0.20, -0.13)], 0.014, "INT_metal_dark")
    p.box((-1.24, 0.205, -0.015), (0.60, 0.006, 0.22), "INT_paint", bevel=0.003)
    p.box((-1.36, 0, -0.30), (0.34, 0.30, 0.30), "INT_canvas", bevel=0.06, seg=3)
    p.path([(-1.20, -0.15, -0.13), (-1.20, -0.15, -0.16)], 0.006, "INT_steel")
    # elevation arc (sector) on the left of the cradle
    seg = 10
    for k in range(seg):
        a0, a1 = R(188 + 3 * k), R(188 + 3 * (k + 1))
        am = (a0 + a1) / 2
        p.box((0.53 * math.cos(am), 0.16, 0.53 * math.sin(am)), (0.028, 0.02, 0.07), "INT_metal_dark", rot=(0, -am, 0))
        p.box((0.572 * math.cos(am), 0.16, 0.572 * math.sin(am)), (0.012, 0.018, 0.018), "INT_steel", rot=(0, -am, 0))
    p.path([(-0.30, 0.15, -0.05), (-0.45, 0.16, -0.12)], 0.012, "INT_metal_dark")
    # TSh-16 telescopic sight on the left of the gun
    sy, sz = 0.26, 0.12
    p.cyl((x_m, sy, sz), (-0.80, sy, sz), 0.042, "INT_metal_dark", seg=20)
    p.cyl((-0.80, sy, sz), (-0.90, sy, sz), 0.055, "INT_metal_dark", seg=20)
    p.cyl((-0.90, sy, sz), (-0.95, sy, sz), 0.042, "INT_rubber", r2=0.05, seg=20)
    p.cyl((-0.945, sy, sz), (-0.95, sy, sz), 0.02, "INT_glass", seg=12)
    p.box((-0.93, sy, sz + 0.06), (0.05, 0.10, 0.05), "INT_rubber", bevel=0.015)          # brow pad
    for xx in (-0.40, -0.70):
        p.box((xx, 0.20, sz - 0.02), (0.05, 0.11, 0.03), "INT_metal_dark", bevel=0.004)
    p.cyl((-0.62, sy, sz + 0.042), (-0.62, sy, sz + 0.07), 0.016, "INT_steel", seg=10)    # range drum
    # coaxial DT on the right of the gun
    cy, cz = -0.22, 0.02
    p.box((-0.44, cy, cz), (0.34, 0.06, 0.085), "INT_metal_dark", bevel=0.006)
    p.cyl((x_m, cy, cz), (-0.27 - 0.001, cy, cz), 0.025, "INT_metal_dark", seg=12)
    p.cyl((-0.40, cy - 0.005, cz + 0.045), (-0.40, cy - 0.005, cz + 0.087), 0.10, "INT_green", seg=32)
    p.cyl((-0.40, cy, cz + 0.087), (-0.40, cy, cz + 0.097), 0.03, "INT_metal_dark", seg=14)
    p.box((-0.58, cy, cz - 0.08), (0.03, 0.028, 0.09), "INT_leather", rot=(0, R(-15), 0), bevel=0.008)
    p.box((-0.66, cy, cz - 0.01), (0.03, 0.05, 0.10), "INT_rubber", bevel=0.01)
    p.box((-0.40, -0.16, cz - 0.02), (0.20, 0.06, 0.03), "INT_metal_dark")
    # spent-case deflector plate between the gun and the coax
    p.box((-0.80, -0.19, 0.10), (0.20, 0.004, 0.10), "INT_metal_dark")
    p.finish(cols["gun"], "gun", parent=cradle)

    bb = Part("gun_breech_block")
    bb.box((-0.975, 0, -0.005), (0.012, 0.23, 0.25), "INT_steel", bevel=0.004)
    bb.cyl((-0.98, 0, 0.0), (-0.995, 0, 0.0), 0.03, "INT_metal_dark", seg=16)
    bb.cyl((-0.98, 0.07, -0.08), (-0.99, 0.07, -0.08), 0.012, "INT_metal_dark", seg=10)
    bb.finish(cols["gun"], "anim", parent=cradle, origin=(-0.975, 0, 0), static=False,
              props={"game_anim": "vertical sliding wedge: translate local Z, open = -0.13 m"})


def build_sockets(cols, turret, cradle):
    def empty(name, coll, loc_world, parent=None, props=None):
        e = D.objects.new(name, None)
        e.empty_display_type = "SPHERE"
        e.empty_display_size = 0.04
        coll.objects.link(e)
        if parent is not None:
            e.parent = parent
            e.matrix_parent_inverse = Matrix.Identity(4)
            e.location = Vector(loc_world) - (ROOT_DEFAULT if parent is turret else Vector())
        else:
            e.location = loc_world
        for k, v in (props or {}).items():
            e[k] = v
        return e

    s = cols["sockets"]
    empty("socket_seat_driver", s, (1.80, 0.33, 0.56))
    empty("socket_eye_driver", s, (1.84, 0.33, 1.26))
    empty("socket_seat_bow_gunner", s, (1.80, -0.47, 0.56))
    empty("socket_eye_bow_gunner", s, (1.84, -0.47, 1.26))
    empty("socket_seat_gunner", s, (0.30, 0.46, 1.34), turret)
    empty("socket_eye_gunner", s, (0.34, 0.27, 2.07), turret)
    empty("socket_seat_commander", s, (-0.13, 0.43, 1.70), turret)
    empty("socket_eye_commander", s, (-0.09, 0.43, 2.44), turret)
    empty("socket_seat_loader", s, (0.25, -0.70, 1.52), turret)
    empty("socket_eye_loader", s, (0.25, -0.45, 2.02), turret)

    def cam(name, loc, look, parent=None, lens=16):
        c = D.objects.new(name, D.cameras.new(name))
        c.data.lens = lens
        c.data.clip_start = 0.02
        s.objects.link(c)
        M = Matrix.Translation(loc) @ Vector(look).to_track_quat("-Z", "Y").to_matrix().to_4x4()
        if parent is not None:
            c.parent = parent
            c.matrix_parent_inverse = Matrix.Identity(4)
            c.matrix_basis = parent.matrix_world.inverted() @ M
        else:
            c.matrix_world = M
        return c

    cam("cam_driver", (1.84, 0.33, 1.26), (1, 0.12, -0.55), lens=12)
    cam("cam_bow_gunner", (1.84, -0.47, 1.26), (1, -0.1, -0.5), lens=12)
    cam("cam_commander", (-0.09, 0.43, 2.44), (1, -0.15, -0.05), turret)
    # TSh-16 view: sits on the sight's objective in the mantlet (4x, ~16 deg field) - overlay a reticle in-game
    cam("cam_gunner_sight", cradle.matrix_world @ Vector((0.40, 0.26, 0.12)), cradle.matrix_world.to_3x3() @ Vector((1, 0, 0)), cradle, lens=125)
    cam("cam_loader", (0.25, -0.45, 2.02), (0.2, 0.9, -0.6), turret, lens=14)


def build_lights(cols, turret):
    for name, loc, parent, energy in (("INT_light_driver", (1.70, 0.62, 1.37), None, 18.0),
                                      ("INT_light_fighting", (0.9, -0.3, 1.30), None, 14.0),
                                      ("INT_light_turret", (0.20, -0.35, 2.24), turret, 18.0)):
        L = D.lights.new(name, "POINT")
        L.energy = energy
        L.color = (1.0, 0.85, 0.62)
        L.shadow_soft_size = 0.04
        ob = D.objects.new(name, L)
        (cols["turret"] if parent else cols["hull"]).objects.link(ob)
        if parent:
            ob.parent = parent
            ob.matrix_parent_inverse = Matrix.Identity(4)
            ob.location = Vector(loc) - ROOT_DEFAULT
        else:
            ob.location = loc


# ------------------------------------------------------------------ merge static parts
def merge(objs, name, coll, parent):
    bm = bmesh.new()
    mats = []
    tgt = parent.matrix_world.inverted() if parent else Matrix.Identity(4)
    for o in objs:
        me = o.data.copy()
        me.transform(tgt @ o.matrix_world)
        remap = []
        for m in me.materials:
            if m.name not in mats:
                mats.append(m.name)
            remap.append(mats.index(m.name))
        for poly in me.polygons:
            poly.material_index = remap[poly.material_index]
        bm.from_mesh(me)
        D.meshes.remove(me)
    out = D.meshes.new(name)
    bm.to_mesh(out)
    bm.free()
    for m in mats:
        out.materials.append(D.materials[m])
    ob = D.objects.new(name, out)
    coll.objects.link(ob)
    if parent:
        ob.parent = parent
        ob.matrix_parent_inverse = Matrix.Identity(4)
    for o in objs:
        me = o.data
        D.objects.remove(o, do_unlink=True)
        D.meshes.remove(me)
    return ob


# ------------------------------------------------------------------ main
def main():
    scn = bpy.context.scene
    ctl = D.objects.get("tank_controls")
    saved = None
    if ctl:  # build at the default pose
        saved = (ctl["gun_elevation"], ctl["turret_traverse"])
        ctl["gun_elevation"], ctl["turret_traverse"] = 0.6, 0.0
    bpy.context.view_layer.update()

    purge_previous()
    build_materials()
    top = get_coll("interior", scn.collection)
    cols = {k: get_coll(f"interior_{k}", top) for k in ("hull", "turret", "gun", "sockets", "cutters")}
    turret = D.objects["turret_root"]
    cradle = D.objects["gun_cradle"]

    reshape_engine_core()
    build_hull_shell(cols["hull"], cols["cutters"])
    cav, cup = build_turret_cutters(cols["cutters"], turret)
    hollow_turret(cav, cup)
    trim_intruders(cols["cutters"], cav)

    build_driver(top, cols)
    build_bow_gunner(top, cols)
    build_fighting_compartment(top, cols)
    build_turret(top, cols, turret)
    build_gun(top, cols, cradle)
    build_sockets(cols, turret, cradle)
    build_lights(cols, turret)
    bpy.context.view_layer.update()

    groups = {"hull": (cols["hull"], None, "int_hull_static"),
              "turret": (cols["turret"], turret, "int_turret_static"),
              "gun": (cols["gun"], cradle, "int_gun_static"),
              "lid": (cols["hull"], D.objects["hull_driver_lid"], "int_driver_hatch_static")}
    for g, (coll, parent, name) in groups.items():
        objs = [o for o, gg, s in REG if gg == g and s and o.name in D.objects]
        if objs:
            merge(objs, name, coll, parent)

    if ctl and saved:
        ctl["gun_elevation"], ctl["turret_traverse"] = saved
    bpy.context.view_layer.update()
    n_obj = sum(1 for o in top.all_objects)
    n_tri = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in top.all_objects if o.type == "MESH" and not o.name.startswith("INT_cut"))
    print(f"interior built: {n_obj} objects, {n_tri} triangles")


main()
