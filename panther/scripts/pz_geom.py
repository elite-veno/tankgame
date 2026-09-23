"""Shared dimensions and mesh helpers for the Panther Ausf. G models.

Used by build_panther_detailed.py and build_panther_print.py (both run inside Blender).

Coordinate frame (metres, real scale):  +X forward, +Y left, +Z up, ground at Z = 0,
hull centred on X = 0 / Y = 0.  Turret parts use a local frame whose origin is the
turret-ring centre on top of the hull roof (see TURRET_ORIGIN).

Main reference figures (Pz.Kpfw. V Panther Ausf. G, 1944/45):
  length with gun 8.66 m, hull 6.87 m, width 3.27 m (3.42 m with skirts), height 2.99 m,
  ground clearance 0.56 m, track 660 mm wide / 153 mm pitch, 87 links per side,
  8 interleaved double road wheels of 860 mm per side, turret ring 1.65 m,
  armour: glacis 80 mm @ 55 deg, lower nose 50 mm @ 55 deg, hull side 50 mm @ 29 deg,
  lower side 40 mm, rear 40 mm @ 30 deg, roof 16-40 mm, floor 17-30 mm,
  turret front 110 mm @ 11 deg, turret side/rear 45 mm @ 25 deg, roof 16 mm.
"""
import math
from itertools import combinations

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, Euler

R = math.radians

# ----------------------------------------------------------------------------- hull
Z_BOTTOM = 0.54          # belly plate
Z_SPONSON = 1.12         # sponson floor / nose knuckle
Z_ROOF = 1.95            # hull roof (top surface)
X_NOSE = 3.42            # glacis / lower nose knuckle
X_LOWNOSE = 2.62         # lower nose meets belly
X_GLACIS_TOP = X_NOSE - (Z_ROOF - Z_SPONSON) * math.tan(R(55))   # ~2.23
X_REAR_TOP = -2.98       # rear plate meets roof
X_REAR_KNEE = -3.45      # rear plate lower knuckle
Z_REAR_KNEE = 0.80
X_REAR_BOTTOM = -3.25
W_LOWER = 0.93           # half width of the lower hull tub (between the tracks)
W_SPONSON = 1.635        # half width at sponson floor (hull outer width 3.27 m)
SIDE_SLOPE = R(29)       # upper side plates, from vertical
W_ROOF = W_SPONSON - (Z_ROOF - Z_SPONSON) * math.tan(SIDE_SLOPE)
X_BULKHEAD = -1.30       # firewall between fighting and engine compartment


def rear_x_at(z):
    """X of the rear plate outer face at height z (above the knee)."""
    t = (z - Z_REAR_KNEE) / (Z_ROOF - Z_REAR_KNEE)
    return X_REAR_KNEE + t * (X_REAR_TOP - X_REAR_KNEE)


X_REAR_SPONSON = rear_x_at(Z_SPONSON)

# ----------------------------------------------------------------------------- running gear
TRACK_W = 0.66
TRACK_PITCH = 0.153
TRACK_T = 0.10           # link height (inner face to ground face)
Y_TRACK_IN = 0.98
Y_TRACK_OUT = Y_TRACK_IN + TRACK_W          # 1.64
Y_TRACK_C = (Y_TRACK_IN + Y_TRACK_OUT) / 2  # 1.31  (gauge 2.62 m)
WHEEL_R = 0.43
WHEEL_Z = TRACK_T + WHEEL_R                 # 0.53
STATION_X = [1.78 - i * 0.505 for i in range(8)]   # front to rear; even index = outer row
SPROCKET = (2.80, 0.62)                     # x, z
SPROCKET_TEETH = 17
SPROCKET_RP = TRACK_PITCH / (2 * math.sin(math.pi / SPROCKET_TEETH))   # pitch radius ~0.416
IDLER = (-2.72, 0.62)
IDLER_R = 0.33
# lateral layout of the interleaved wheels (disc centre planes)
Y_OUTER_ROW = (Y_TRACK_C + 0.26, Y_TRACK_C - 0.26)
Y_INNER_ROW = (Y_TRACK_C + 0.115, Y_TRACK_C - 0.115)

# ----------------------------------------------------------------------------- turret
TURRET_X = 0.35
TURRET_ORIGIN = Vector((TURRET_X, 0.0, Z_ROOF + 0.005))
RING_R = 0.825           # turret ring (1.65 m)
T_ROOF_Z = 0.78          # turret roof height above ring plane
T_SIDE_SLOPE = R(25)
T_FRONT_X = 0.97         # front plate at the bottom (local)
T_FRONT_HW = 0.72        # half width of the front plate at the bottom
T_REAR_X = -1.40
T_REAR_HW = 1.18
T_FRONT_SLOPE = R(11)
T_REAR_SLOPE = R(25)
GUN_Z = 0.42             # gun axis above ring plane (local)
TRUNNION_X = 0.80
MANTLET_X = 1.02         # rear face of the mantlet (local)
MUZZLE_X = 4.86          # muzzle (local) -> world 5.21 m, length with gun 8.66 m
CUPOLA = Vector((-0.62, 0.40))   # centre on the roof (local x, y) -- left rear
CUPOLA_R = 0.39
CUPOLA_TOP = 0.215       # above turret roof


# ============================================================================= math helpers
def plane(point, normal):
    """Half space n.x <= d with outward normal."""
    n = np.array(normal, float)
    n /= np.linalg.norm(n)
    return (n, float(np.dot(n, np.array(point, float))))


def offset(planes, t):
    """Move planes inward by t (scalar or list)."""
    ts = t if isinstance(t, (list, tuple)) else [t] * len(planes)
    return [(n, d - ti) for (n, d), ti in zip(planes, ts)]


def convex_from_planes(planes, eps=1e-7):
    P = [(np.asarray(n, float), float(d)) for n, d in planes]
    verts = []
    for i, j, k in combinations(range(len(P)), 3):
        A = np.array([P[i][0], P[j][0], P[k][0]])
        if abs(np.linalg.det(A)) < 1e-10:
            continue
        x = np.linalg.solve(A, [P[i][1], P[j][1], P[k][1]])
        if all(np.dot(n, x) <= d + 1e-6 for n, d in P):
            if not any(np.linalg.norm(x - v) < 1e-6 for v in verts):
                verts.append(x)
    faces = []
    for n, d in P:
        idx = [i for i, v in enumerate(verts) if abs(np.dot(n, v) - d) < 1e-6]
        if len(idx) < 3:
            continue
        c = np.mean([verts[i] for i in idx], axis=0)
        u = np.cross(n, [0, 0, 1]) if abs(n[2]) < 0.9 else np.cross(n, [1, 0, 0])
        u /= np.linalg.norm(u)
        w = np.cross(n, u)
        idx.sort(key=lambda i: math.atan2(np.dot(verts[i] - c, w), np.dot(verts[i] - c, u)))
        area = 0.0
        for k in range(1, len(idx) - 1):
            area += np.linalg.norm(np.cross(verts[idx[k]] - verts[idx[0]], verts[idx[k + 1]] - verts[idx[0]]))
        if area < 1e-9 or sorted(idx) in [sorted(f) for f in faces]:
            continue                      # plane only touches an edge / vertex
        faces.append(idx)
    return [Vector(v) for v in verts], faces


def track_to(d, up=Vector((0, 0, 1))):
    """3x3 rotation taking +Z to direction d."""
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


def circle_hull(circles, n=96):
    """Convex hull (CCW, x/z plane) of circles [(x, z, r)] sampled with n points each."""
    pts = []
    for (cx, cz, r) in circles:
        for i in range(n):
            a = 2 * math.pi * i / n
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    pts = sorted(set(pts))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 1e-12:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 1e-12:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def resample_closed(poly, step=None, count=None):
    """Resample a closed polyline evenly; returns (points, tangents, total_length)."""
    P = [np.array(p, float) for p in poly]
    seg = [np.linalg.norm(P[(i + 1) % len(P)] - P[i]) for i in range(len(P))]
    L = sum(seg)
    if count is None:
        count = max(3, round(L / step))
    out, tan = [], []
    cum = np.concatenate([[0], np.cumsum(seg)])
    for k in range(count):
        s = L * k / count
        i = int(np.searchsorted(cum, s, side="right") - 1)
        i = min(i, len(P) - 1)
        t = (s - cum[i]) / seg[i] if seg[i] > 0 else 0
        a, b = P[i], P[(i + 1) % len(P)]
        out.append(a + (b - a) * t)
        d = b - a
        tan.append(d / (np.linalg.norm(d) + 1e-12))
    return out, tan, L


def track_centreline(step=0.01):
    """Track centreline loop in the x/z plane (CCW seen from the left side)."""
    circ = [(x, WHEEL_Z, WHEEL_R + TRACK_T / 2) for x in STATION_X]
    circ.append((SPROCKET[0], SPROCKET[1], SPROCKET_RP))
    circ.append((IDLER[0], IDLER[1], IDLER_R + TRACK_T / 2))
    return circle_hull(circ, n=240)


def track_outline(extra):
    """Outline of the track loop grown by `extra` from the wheel surfaces (for solids)."""
    circ = [(x, WHEEL_Z, WHEEL_R + extra) for x in STATION_X]
    circ.append((SPROCKET[0], SPROCKET[1], SPROCKET_RP - TRACK_T / 2 + extra))
    circ.append((IDLER[0], IDLER[1], IDLER_R + extra))
    return circle_hull(circ, n=180)


def gear_outline(teeth, r_root, r_tip, tooth_frac=0.42, n_per=8):
    """2D outline of a spur-like sprocket ring (list of (x, y), CCW)."""
    pts = []
    for k in range(teeth):
        a0 = 2 * math.pi * k / teeth
        da = 2 * math.pi / teeth
        half = da * tooth_frac / 2
        for i in range(n_per):  # root arc
            a = a0 + half + (da - 2 * half) * i / n_per
            pts.append((r_root * math.cos(a), r_root * math.sin(a)))
        a1 = a0 + da - half
        a2 = a0 + da + half
        tip_in = half * 0.45
        pts.append((r_tip * math.cos(a1 + tip_in), r_tip * math.sin(a1 + tip_in)))
        pts.append((r_tip * math.cos(a2 - tip_in), r_tip * math.sin(a2 - tip_in)))
    return pts


# ============================================================================= mesh builder
class Part:
    """Accumulates primitives into one bmesh with per-primitive material slots."""

    def __init__(self, name, frame=None):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []
        self.frame = frame if frame is not None else Matrix.Identity(4)

    def _mark(self, before, mat):
        if mat is None:
            mat = "_default"
        if mat not in self.mats:
            self.mats.append(mat)
        idx = self.mats.index(mat)
        new = [f for f in self.bm.faces if f not in before]
        for f in new:
            f.material_index = idx
        return new

    def M(self, c=(0, 0, 0), rot=None, scale=(1, 1, 1)):
        return self.frame @ Matrix.Translation(Vector(c)) @ rot3(rot).to_4x4() @ Matrix.Diagonal((*scale, 1))

    # ---------------------------------------------------------------- primitives
    def box(self, c, s, mat=None, rot=None, bevel=0.0, seg=1):
        before = set(self.bm.faces)
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=self.M(c, rot, s))
        if bevel:
            edges = list({e for v in r["verts"] for e in v.link_edges})
            bmesh.ops.bevel(self.bm, geom=edges, offset=bevel, segments=seg, affect="EDGES",
                            profile=0.5, clamp_overlap=True)
        return self._mark(before, mat)

    def cyl(self, p0, p1, r, mat=None, r2=None, seg=24, caps=True):
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        before = set(self.bm.faces)
        M = self.frame @ Matrix.Translation((p0 + p1) / 2) @ track_to(d).to_4x4()
        bmesh.ops.create_cone(self.bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r,
                              radius2=r if r2 is None else r2, depth=d.length, matrix=M)
        return self._mark(before, mat)

    def sphere(self, c, r, mat=None, seg=16, scale=(1, 1, 1), rot=None):
        before = set(self.bm.faces)
        bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=max(6, seg // 2), radius=r,
                                  matrix=self.M(c, rot, scale))
        return self._mark(before, mat)

    def convex(self, planes, mat=None):
        verts, faces = convex_from_planes(planes)
        before = set(self.bm.faces)
        bv = [self.bm.verts.new(self.frame @ v) for v in verts]
        for f in faces:
            self.bm.faces.new([bv[i] for i in f])
        return self._mark(before, mat)

    def prism(self, poly, z0, z1, mat=None, M=None):
        """Extrude a 2D polygon (x, y) from z0 to z1 in frame M (4x4)."""
        M = self.frame @ (M if M is not None else Matrix.Identity(4))
        before = set(self.bm.faces)
        area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                   for i in range(len(poly)))
        if area < 0:
            poly = list(reversed(poly))
        bot = [self.bm.verts.new(M @ Vector((x, y, z0))) for x, y in poly]
        top = [self.bm.verts.new(M @ Vector((x, y, z1))) for x, y in poly]
        n = len(poly)
        self.bm.faces.new(list(reversed(bot)))
        self.bm.faces.new(top)
        for i in range(n):
            j = (i + 1) % n
            self.bm.faces.new((bot[i], bot[j], top[j], top[i]))
        return self._mark(before, mat)

    def ring_prism(self, outer, inner, z0, z1, mat=None, M=None):
        """Extrude the region between two closed polygons with equal vertex count."""
        M = self.frame @ (M if M is not None else Matrix.Identity(4))
        before = set(self.bm.faces)

        def ccw(p):
            a = sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))
            return p if a > 0 else list(reversed(p))
        outer, inner = ccw(outer), ccw(inner)
        n = len(outer)
        assert len(inner) == n
        ob = [self.bm.verts.new(M @ Vector((x, y, z0))) for x, y in outer]
        ot = [self.bm.verts.new(M @ Vector((x, y, z1))) for x, y in outer]
        ib = [self.bm.verts.new(M @ Vector((x, y, z0))) for x, y in inner]
        it = [self.bm.verts.new(M @ Vector((x, y, z1))) for x, y in inner]
        for i in range(n):
            j = (i + 1) % n
            self.bm.faces.new((ob[i], ob[j], ot[j], ot[i]))
            self.bm.faces.new((it[i], it[j], ib[j], ib[i]))
            self.bm.faces.new((ot[i], ot[j], it[j], it[i]))
            self.bm.faces.new((ib[i], ib[j], ob[j], ob[i]))
        return self._mark(before, mat)

    def lathe(self, profile, seg=48, mat=None, M=None, a0=0.0, a1=2 * math.pi, closed=False):
        """Revolve a (r, z) profile around the frame Z axis; r == 0 points become poles.
        Profile runs bottom -> top along the outside of the solid.  closed=True joins the
        last profile point back to the first (ring-shaped sections that never touch the axis)."""
        M = self.frame @ (M if M is not None else Matrix.Identity(4))
        full = abs(a1 - a0 - 2 * math.pi) < 1e-9
        before = set(self.bm.faces)
        ns = seg if full else seg + 1
        rows = []
        for r, z in profile:
            if r < 1e-9:
                rows.append([self.bm.verts.new(M @ Vector((0, 0, z)))])
            else:
                rows.append([self.bm.verts.new(M @ Vector((r * math.cos(a0 + (a1 - a0) * i / seg),
                                                           r * math.sin(a0 + (a1 - a0) * i / seg), z)))
                             for i in range(ns)])
        pairs = list(zip(rows, rows[1:]))
        if closed:
            pairs.append((rows[-1], rows[0]))
        for A, B in pairs:
            rng = range(seg)
            for i in rng:
                j = (i + 1) % ns if full else i + 1
                if len(A) == 1 and len(B) == 1:
                    continue
                if len(A) == 1:
                    self.bm.faces.new((A[0], B[i], B[j]))
                elif len(B) == 1:
                    self.bm.faces.new((A[i], A[j], B[0]))
                else:
                    self.bm.faces.new((A[i], A[j], B[j], B[i]))
        if not full:  # close the sector with the profile polygon on both ends
            for k in (0, ns - 1):
                vs = [row[0] if len(row) == 1 else row[k] for row in rows]
                vs = [v for i, v in enumerate(vs) if i == 0 or v is not vs[i - 1]]
                if len(vs) >= 3:
                    try:
                        self.bm.faces.new(vs if k == 0 else list(reversed(vs)))
                    except ValueError:
                        pass
        return self._mark(before, mat)

    def torus(self, c, axis, Rm, rm, mat=None, seg=32, rseg=8):
        before = set(self.bm.faces)
        M = self.frame @ Matrix.Translation(Vector(c)) @ track_to(axis).to_4x4()
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

    def ring(self, c, axis, r0, r1, h, mat=None, seg=48):
        """Flat annulus of thickness h centred on c."""
        M = Matrix.Translation(Vector(c)) @ track_to(axis).to_4x4()
        prof = [(r0, -h / 2), (r1, -h / 2), (r1, h / 2), (r0, h / 2)]
        before = set(self.bm.faces)
        MM = self.frame @ M
        rows = [[self.bm.verts.new(MM @ Vector((r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), z)))
                 for i in range(seg)] for r, z in prof]
        for k in range(4):
            A, B = rows[k], rows[(k + 1) % 4]
            for i in range(seg):
                j = (i + 1) % seg
                self.bm.faces.new((A[i], A[j], B[j], B[i]))
        return self._mark(before, mat)

    def tube(self, pts, r, mat=None, seg=12, caps=True):
        """Sweep a circle along a polyline (mitred joints)."""
        pts = [Vector(p) for p in pts]
        before = set(self.bm.faces)
        rings = []
        n = len(pts)
        for i, p in enumerate(pts):
            if i == 0:
                t = (pts[1] - p).normalized()
            elif i == n - 1:
                t = (p - pts[-2]).normalized()
            else:
                t = ((p - pts[i - 1]).normalized() + (pts[i + 1] - p).normalized()).normalized()
            if i == 0:
                R3 = track_to(t)
            else:  # parallel transport of the previous frame
                prev_t = rings[-1][1]
                q = prev_t.rotation_difference(t)
                R3 = q.to_matrix() @ rings[-1][2]
            scale = 1.0
            if 0 < i < n - 1:
                a = (p - pts[i - 1]).normalized()
                cosh = max(0.3, abs(a.dot(t)))
                scale = 1.0 / cosh
            ring = []
            for k in range(seg):
                ang = 2 * math.pi * k / seg
                local = Vector((r * math.cos(ang), r * math.sin(ang), 0))
                v = R3 @ local
                # stretch along the mitre direction
                if scale != 1.0:
                    a = (p - pts[i - 1]).normalized()
                    bdir = (a - t * a.dot(t))
                    if bdir.length > 1e-6:
                        bdir.normalize()
                        v = v + bdir * v.dot(bdir) * (scale - 1)
                ring.append(self.bm.verts.new(self.frame @ (p + v)))
            rings.append((ring, t, R3))
        for (A, _, _), (B, _, _) in zip(rings, rings[1:]):
            for k in range(seg):
                j = (k + 1) % seg
                self.bm.faces.new((A[k], A[j], B[j], B[k]))
        if caps:
            self.bm.faces.new(list(reversed(rings[0][0])))
            self.bm.faces.new(rings[-1][0])
        return self._mark(before, mat)

    def mesh(self, verts, faces, mat=None, M=None):
        M = self.frame @ (M if M is not None else Matrix.Identity(4))
        before = set(self.bm.faces)
        bv = [self.bm.verts.new(M @ Vector(v)) for v in verts]
        for f in faces:
            self.bm.faces.new([bv[i] for i in f])
        return self._mark(before, mat)

    # ---------------------------------------------------------------- output
    def build(self, coll, materials=None, parent=None, smooth=None, fix_normals=True):
        if fix_normals:
            bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        obj = bpy.data.objects.new(self.name, me)
        coll.objects.link(obj)
        for m in self.mats:
            if materials is not None and m in materials:
                me.materials.append(materials[m])
            else:
                me.materials.append(None)
        if smooth is not None:
            me.shade_smooth()
            me.set_sharp_from_angle(angle=smooth)
        if parent is not None:
            obj.parent = parent
        return obj


def get_coll(name, parent=None):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(c)
    return c


def empty(name, coll, loc=(0, 0, 0), parent=None, size=0.2, kind="PLAIN_AXES"):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = kind
    e.empty_display_size = size
    coll.objects.link(e)
    if parent is not None:
        e.parent = parent
    e.location = loc
    return e


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.cameras,
                  bpy.data.lights, bpy.data.images, bpy.data.node_groups):
        for b in list(block):
            block.remove(b)


# ============================================================================= CSG (Manifold booleans)
def csg(name, coll, base, stages):
    """base: Part; stages: list of (op, [Part]) applied in order with the Manifold solver."""
    tmp = get_coll("_tmp_" + name)
    b = base.build(tmp)
    for i, (op, parts) in enumerate(stages):
        parts = [p for p in parts if p is not None and len(p.bm.faces)]
        if not parts:
            continue
        c = bpy.data.collections.new(f"_{name}_{i}")
        tmp.children.link(c)
        for p in parts:
            p.build(c)
        m = b.modifiers.new(f"s{i}", "BOOLEAN")
        m.operation, m.solver, m.operand_type, m.collection = op, "MANIFOLD", "COLLECTION", c
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(b.evaluated_get(dg))
    me.name = name
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    # clean up the operands
    def kill(c):
        for ch in list(c.children):
            kill(ch)
        for o in list(c.objects):
            m = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if m is not None and m.users == 0:
                bpy.data.meshes.remove(m)
        bpy.data.collections.remove(c)
    kill(tmp)
    return obj



# ============================================================================= shared solids
def hull_upper_planes():
    """Superstructure (sponsons, glacis, roof, upper rear) as outward half spaces."""
    gl_n = (math.cos(R(55)), 0, math.sin(R(55)))        # glacis normal (55 deg from vertical)
    side_n = (0, math.cos(SIDE_SLOPE), math.sin(SIDE_SLOPE))
    rear_dir = Vector((X_REAR_TOP - X_REAR_KNEE, 0, Z_ROOF - Z_REAR_KNEE)).normalized()
    rear_n = Vector((-rear_dir.z, 0, rear_dir.x))        # points backwards/up
    return [
        plane((0, 0, Z_SPONSON), (0, 0, -1)),
        plane((0, 0, Z_ROOF), (0, 0, 1)),
        plane((X_NOSE, 0, Z_SPONSON), gl_n),
        plane((X_REAR_KNEE, 0, Z_REAR_KNEE), rear_n),
        plane((0, W_SPONSON, Z_SPONSON), side_n),
        plane((0, -W_SPONSON, Z_SPONSON), (0, -side_n[1], side_n[2])),
    ]


def hull_lower_planes(top=Z_SPONSON):
    nose_n = Vector((Z_SPONSON - Z_BOTTOM, 0, -(X_NOSE - X_LOWNOSE))).normalized()   # forward/down
    rear_low_n = Vector((-(Z_REAR_KNEE - Z_BOTTOM), 0, -(X_REAR_KNEE - X_REAR_BOTTOM) * -1)).normalized()
    rear_dir = Vector((X_REAR_TOP - X_REAR_KNEE, 0, Z_ROOF - Z_REAR_KNEE)).normalized()
    rear_n = Vector((-rear_dir.z, 0, rear_dir.x))
    # lower rear plate from (X_REAR_BOTTOM, Z_BOTTOM) to (X_REAR_KNEE, Z_REAR_KNEE)
    d = Vector((X_REAR_KNEE - X_REAR_BOTTOM, 0, Z_REAR_KNEE - Z_BOTTOM)).normalized()
    rear_low_n = Vector((d.z, 0, -d.x))
    if rear_low_n.x > 0:
        rear_low_n = -rear_low_n
    return [
        plane((0, 0, Z_BOTTOM), (0, 0, -1)),
        plane((0, 0, top), (0, 0, 1)),
        plane((X_LOWNOSE, 0, Z_BOTTOM), nose_n),
        plane((X_REAR_KNEE, 0, Z_REAR_KNEE), rear_n),
        plane((X_REAR_BOTTOM, 0, Z_BOTTOM), rear_low_n),
        plane((0, W_LOWER, 0), (0, 1, 0)),
        plane((0, -W_LOWER, 0), (0, -1, 0)),
    ]


def turret_planes(roof=T_ROOF_Z):
    """Turret body (without mantlet / cupola) in the turret local frame."""
    def side(p0, p1, slope, left):
        d = Vector((p1[0] - p0[0], p1[1] - p0[1], 0)).normalized()
        nh = Vector((d.y, -d.x, 0)) if left else Vector((-d.y, d.x, 0))
        n = nh * math.cos(slope) + Vector((0, 0, math.sin(slope)))
        return plane((p0[0], p0[1], 0), n)
    fl, rl = (T_FRONT_X, T_FRONT_HW), (T_REAR_X, T_REAR_HW)
    return [
        plane((0, 0, 0), (0, 0, -1)),
        plane((0, 0, roof), (0, 0, 1)),
        plane((T_FRONT_X, 0, 0), (math.cos(T_FRONT_SLOPE), 0, math.sin(T_FRONT_SLOPE))),
        plane((T_REAR_X, 0, 0), (-math.cos(T_REAR_SLOPE), 0, math.sin(T_REAR_SLOPE))),
        side((fl[0], fl[1]), (rl[0], rl[1]), T_SIDE_SLOPE, True),
        side((fl[0], -fl[1]), (rl[0], -rl[1]), T_SIDE_SLOPE, False),
    ]


def turret_halfwidth(x, z):
    """Half width of the turret body at local (x, z) (for placing parts on the sides)."""
    t = (x - T_FRONT_X) / (T_REAR_X - T_FRONT_X)
    return T_FRONT_HW + t * (T_REAR_HW - T_FRONT_HW) - z * math.tan(T_SIDE_SLOPE)


def mantlet_profile(chin=True):
    """Side profile (x forward, z up) of the late 'chin' mantlet, local turret frame, closed polygon."""
    cz = GUN_Z
    rr = 0.34
    x0 = MANTLET_X - 0.03    # axis of the rounded face (close to the trunnion)
    pts = [(x0 + rr * math.cos(R(a)), cz + rr * math.sin(R(a))) for a in range(90, -1, -5)]
    if chin:
        pts += [(x0 + rr, cz - 0.12), (x0 + rr - 0.07, 0.06)]
    else:
        pts += [(x0 + rr * math.cos(R(-a)), cz + rr * math.sin(R(-a))) for a in range(5, 91, 5)]
    tf = math.tan(T_FRONT_SLOPE)           # rear face follows the sloped turret front plate
    pts.append((T_FRONT_X - 0.04 - pts[-1][1] * tf, pts[-1][1]))
    pts.append((T_FRONT_X - 0.04 - (cz + rr) * tf, cz + rr))
    return pts


def mantlet_front_profile():
    """Front view (y, z) of the mantlet: full width low down, rounded shoulders at the top."""
    half = [(0.62, 0.0), (0.62, 0.46), (0.605, 0.56), (0.57, 0.64), (0.51, 0.71), (0.43, 0.76), (0.34, 0.80)]
    return [(y, z) for y, z in half] + [(-y, z) for y, z in reversed(half)]
