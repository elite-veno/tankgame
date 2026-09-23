"""Panther Ausf. G -- 3D-print kit (default 1:35) with a simplified exterior + interior.

Run headless (from the repository root):
    blender -b --factory-startup --python panther/scripts/build_panther_print.py -- [--scale 35]

Output
    panther/print_1-35/*.stl          one file per part, already in print orientation (mm)
    panther/panther_print_1-35.blend  assembled + exploded reference scene

Parts (see panther/README.md for print settings and assembly)
    hull_lower          tub with driver / radio operator stations, gearbox, ammo racks,
                        firewall and engine bay; pegs for the running gear
    hull_upper          superstructure (roof down on the bed); lifts off to show the interior
    running_gear_left/right   tracks, interleaved road wheels, sprocket, idler (inner face down)
    turret_body         walls, chin mantlet, open top, ring plate
    turret_roof         roof plate with the commander's cupola (glued onto the body)
    turret_basket       turret floor + gun breech, deflector guard, gunner / commander / loader
                        seats; drops through the hull roof and makes the turret rotate
    hatch               the working cupola hatch -- lifts out of its seat and swings on a pin
    hatch_pin           optional printed pin (or use a 6 mm piece of 1.75 mm filament)
    gun_barrel          KwK 42 L/70 barrel with muzzle brake (print muzzle down)
    exhaust (x2)        exhaust pipes, plug into the sockets on the rear plate
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

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SCALE = 35
if "--scale" in argv:
    SCALE = float(argv[argv.index("--scale") + 1])

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
TAG = f"1-{SCALE:g}"
OUT_DIR = os.path.join(ROOT, f"print_{TAG}")

MM = SCALE / 1000.0            # real metres per printed millimetre

# printed dimensions in millimetres, converted to real metres
WALL = 1.6 * MM                # hull / turret walls
FLOOR_T = 1.6 * MM
ROOF_T = 1.4 * MM              # hull roof
ROOF_P = 2.0 * MM              # turret roof plate
BOT_T = 1.4 * MM               # turret bottom ring plate
LIP_T = 0.8 * MM
LIP_H = 1.6 * MM
LIP_H2 = 0.8 * MM              # turret roof locating lip
CLR = 0.20 * MM                # sliding / plug-in fit
ROT_CLR = 0.30 * MM            # turret rotation gap
ENG_D = 0.45 * MM              # engraving depth
ENG_W = 0.5 * MM               # engraving width
PEG_R = 1.25 * MM
PEG_L = 1.8 * MM
PIN_R = 0.875 * MM             # 1.75 mm filament
KEY_W = 2.0 * MM



def P(name="p", frame=None):
    return Part(name, frame)


def box(c, s, rot=None, frame=None):
    p = P(frame=frame)
    p.box(c, s, rot=rot)
    return p


def boxr(x0, x1, y0, y1, z0, z1, frame=None):
    return box(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)), frame=frame)


def cyl(p0, p1, r, r2=None, seg=32, frame=None):
    p = P(frame=frame)
    p.cyl(p0, p1, r, r2=r2, seg=seg)
    return p


def convex(planes, frame=None):
    p = P(frame=frame)
    p.convex(planes)
    return p


def ring_cut(c, r, w, z0, z1, frame=None, seg=64):
    """Annular groove cutter (engraving) with axis Z."""
    return annulus(c, r - w / 2, r + w / 2, z0, z1, frame=frame, seg=seg)


def annulus(c, r0, r1, z0, z1, frame=None, seg=64, M=None):
    p = P(frame=frame)
    p.ring_prism([(c[0] + r1 * math.cos(2 * math.pi * i / seg), c[1] + r1 * math.sin(2 * math.pi * i / seg)) for i in range(seg)],
                 [(c[0] + r0 * math.cos(2 * math.pi * i / seg), c[1] + r0 * math.sin(2 * math.pi * i / seg)) for i in range(seg)],
                 z0, z1, M=M)
    return p


def rect_groove(cx, cy, lx, ly, z0, z1, w=ENG_W, frame=None):
    out = []
    for (x, y, sx, sy) in ((cx, cy + ly / 2, lx + w, w), (cx, cy - ly / 2, lx + w, w),
                           (cx + lx / 2, cy, w, ly + w), (cx - lx / 2, cy, w, ly + w)):
        out.append(box((x, y, (z0 + z1) / 2), (sx, sy, z1 - z0), frame=frame))
    return out


def chamfer_block(x0, x1, y0, y1, z0, z1, ch, frame=None):
    """Box whose two lower long edges (along X) are chamfered 45 deg by ch -- prints without support."""
    s2 = math.sqrt(0.5)
    pl = [plane((0, 0, z0), (0, 0, -1)), plane((0, 0, z1), (0, 0, 1)),
          plane((x0, 0, 0), (-1, 0, 0)), plane((x1, 0, 0), (1, 0, 0)),
          plane((0, y0, 0), (0, -1, 0)), plane((0, y1, 0), (0, 1, 0)),
          plane((0, y1 - ch, z0), (0, s2, -s2)), plane((0, y0 + ch, z0), (0, -s2, -s2))]
    return convex(pl, frame=frame)


# ============================================================================= lower hull
LIP_X = (X_REAR_SPONSON + 0.45, X_NOSE - 0.90)
PEG_POS = [(0.95, 0.84), (-1.55, 0.84)]


def build_hull_lower(coll):
    W = WALL
    base = convex(hull_lower_planes(top=Z_SPONSON))
    cav = convex(offset(hull_lower_planes(top=Z_SPONSON + 0.5), [FLOOR_T, 0, W, W, W, W, W]))
    zf = Z_BOTTOM + FLOOR_T
    wi = W_LOWER - W                       # inner face of the side walls
    det = []
    # locating lips on top of the side walls
    for s in (1, -1):
        y0, y1 = s * wi, s * (wi + LIP_T)
        det.append(boxr(LIP_X[0], LIP_X[1], y0, y1, Z_SPONSON - 0.01, Z_SPONSON + LIP_H))
    # firewall
    det.append(boxr(X_BULKHEAD - 0.6 * MM, X_BULKHEAD + 0.6 * MM, -W_LOWER + 0.01, W_LOWER - 0.01, Z_BOTTOM + 0.01, Z_SPONSON))
    # --- driver (left, +Y) and radio operator (right) stations
    for s in (1, -1):
        det.append(boxr(1.72, 2.12, s * 0.33, s * 0.71, zf - 0.01, zf + 0.36))          # seat cushion block
        det.append(boxr(1.62, 1.72, s * 0.35, s * 0.69, zf - 0.01, zf + 0.80))          # backrest
    for dy in (0.40, 0.64):                                                              # steering levers
        det.append(cyl((2.36, dy, zf - 0.01), (2.36, dy, zf + 0.62), 0.7 * MM, seg=12))
        det.append(cyl((2.36, dy, zf + 0.62), (2.26, dy, zf + 0.70), 0.7 * MM, seg=12))
    det.append(boxr(2.20, 2.55, 0.70, wi + 0.01, zf - 0.01, zf + 0.52))                 # instrument console
    det.append(boxr(2.46, 2.52, 0.40, 0.66, zf - 0.01, zf + 0.12))                       # pedals block
    # gearbox (AK 7-200) + steering unit + final drive housings
    det.append(boxr(1.95, 2.72, -0.26, 0.26, zf - 0.01, zf + 0.42))
    det.append(cyl((2.45, -wi - 0.01, zf + 0.20), (2.45, wi + 0.01, zf + 0.20), 0.20, seg=40))       # final drives,
    det.append(boxr(2.25, 2.65, -wi - 0.01, wi + 0.01, zf - 0.01, zf + 0.20))                          # D-shaped (no overhang)
    det.append(cyl((2.25, 0, zf + 0.42), (2.25, 0, zf + 0.52), 0.14, seg=24))           # gearbox cover dome
    # hull MG ammo bag rack and radio sets (right side)
    det.append(boxr(1.18, 1.62, -wi - 0.01, -0.62, zf - 0.01, zf + 0.46))
    det.append(boxr(1.22, 1.58, -wi - 0.01, -0.66, zf + 0.46, zf + 0.50))
    # propeller shaft (half buried in the floor)
    det.append(cyl((X_BULKHEAD - 0.40, 0, zf + 0.02), (1.96, 0, zf + 0.02), 0.075, seg=24))
    # ammunition racks along the side walls of the fighting compartment (shell noses up)
    for s in (1, -1):
        det.append(boxr(-1.15, 0.95, s * (wi + 0.01), s * (wi - 0.22), zf - 0.01, zf + 0.34))
        for row, yy in enumerate((wi - 0.06, wi - 0.16)):
            n = 20
            for i in range(n):
                x = -1.10 + i * 2.0 / (n - 1)
                p = P()
                p.lathe([(0, zf + 0.30), (0.045, zf + 0.30), (0.045, zf + 0.44), (0.030, zf + 0.50),
                         (0.012, zf + 0.55), (0, zf + 0.55)], seg=16, M=Matrix.Translation((x, s * yy, 0)))
                det.append(p)
    # engine bay: Maybach HL 230 P30 (V12), radiators/fans, fuel tanks
    ex = -2.30
    vee = [(0.30, zf - 0.01), (0.30, zf + 0.26), (0.45, zf + 0.54), (0.27, zf + 0.64), (0.07, zf + 0.42),
           (-0.07, zf + 0.42), (-0.27, zf + 0.64), (-0.45, zf + 0.54), (-0.30, zf + 0.26), (-0.30, zf - 0.01)]
    eng = P()   # V12 block: crankcase + both cylinder banks as one section, valley between the banks
    eng.prism([(y, z) for y, z in vee], ex - 0.62, ex + 0.62,
              M=Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    det.append(eng)
    for s in (1, -1):
        det.append(cyl((ex + 0.52, s * 0.26, zf + 0.35), (ex + 0.52, s * 0.26, zf + 0.62), 0.11, seg=24))   # air cleaners
        det.append(boxr(-2.95, -1.55, s * (wi + 0.01), s * 0.60, zf - 0.01, zf + 0.47))                  # radiators
        det.append(cyl((-1.95, s * 0.74, zf + 0.47), (-1.95, s * 0.74, zf + 0.52), 0.12, seg=32))        # fan hubs
    # pegs for the running gear
    for s in (1, -1):
        for (x, z) in PEG_POS:
            det.append(cyl((x, s * (W_LOWER - 0.01), z), (x, s * (W_LOWER + PEG_L), z), PEG_R, seg=24))
    # rear: towing coupling
    det.append(boxr(X_REAR_BOTTOM - 0.12, X_REAR_BOTTOM + 0.05, -0.12, 0.12, Z_BOTTOM + 0.10, Z_BOTTOM + 0.22))
    cuts = []
    # floor escape hatch engraving (underneath) is skipped -- belly is the print bed
    return csg("hull_lower", coll, base, [("DIFFERENCE", [cav]), ("UNION", det), ("DIFFERENCE", cuts)])


# ============================================================================= upper hull
EXHAUST_Y = 0.42
EXHAUST_X = rear_x_at(1.80) - 0.11
EXHAUST_R = 0.085
SOCKET_R = 0.8 * MM + CLR / 2
SOCKET_D = 2.2 * MM


def build_hull_upper(coll):
    up = hull_upper_planes()   # bottom, roof, glacis, rear, side+, side-
    base = convex(up)
    wi = W_LOWER - WALL
    cav = convex([plane((0, 0, Z_SPONSON - 0.3), (0, 0, -1)),
                  (up[1][0], up[1][1] - ROOF_T),
                  (up[2][0], up[2][1] - WALL),
                  (up[3][0], up[3][1] - WALL),
                  plane((0, wi, 0), (0, 1, 0)), plane((0, -wi, 0), (0, -1, 0))])
    grooves = []
    for s in (1, -1):
        y0, y1 = s * (wi - 0.5 * MM), s * (wi + LIP_T + CLR)
        grooves.append(boxr(LIP_X[0] - CLR, LIP_X[1] + CLR, y0, y1, Z_SPONSON - 0.05, Z_SPONSON + LIP_H + CLR))
    ring = cyl((TURRET_X, 0, Z_SPONSON), (TURRET_X, 0, Z_ROOF + 0.05), RING_R, seg=128)

    det = []
    gl_n = Vector(up[2][0])

    def on_glacis(x, y):
        z = Z_SPONSON + (X_NOSE - x) / math.tan(math.radians(55))
        return Vector((x, y, z))
    # hull MG ball mount (right) + MG 34 barrel jacket
    c = on_glacis(2.95, -0.55) - gl_n * 0.04
    p = P(); p.sphere(c, 0.13, seg=32); det.append(p)
    det.append(cyl(c, c + Vector((0.34, 0, 0)), 0.035, seg=16))
    # headlight (left)
    c = on_glacis(2.62, 0.98)
    det.append(cyl(c - gl_n * 0.02, c + Vector((0.10, 0, 0.06)), 0.045, seg=16))
    det.append(cyl(c + Vector((0.06, 0, 0.06)), c + Vector((0.18, 0, 0.06)), 0.085, seg=24))
    # exhaust collars (armoured) with stubs, and the two stowage bins on the rear plate
    rn, rd = Vector(up[3][0]), up[3][1]
    for s in (1, -1):
        det.append(convex([plane((0, 0, 1.55), (0, 0, -1)), plane((0, 0, Z_ROOF), (0, 0, 1)),
                           plane((EXHAUST_X - EXHAUST_R - 0.03, 0, 0), (-1, 0, 0)),
                           (-rn, -rd + 0.03),
                           plane((0, s * EXHAUST_Y + 0.14, 0), (0, 1, 0)), plane((0, s * EXHAUST_Y - 0.14, 0), (0, -1, 0))]))
        det.append(cyl((EXHAUST_X, s * EXHAUST_Y, 1.50), (EXHAUST_X, s * EXHAUST_Y, Z_ROOF), EXHAUST_R + 0.02, seg=32))
        det.append(convex([plane((0, 0, 1.52), (0, 0, -1)), plane((0, 0, Z_ROOF), (0, 0, 1)),
                           plane((-3.36, 0, 0), (-1, 0, 0)), (-rn, -rd + 0.03),
                           plane((0, s * 1.08, 0), (0, s, 0)), plane((0, s * 0.64, 0), (0, -s, 0))]))
    # tools on the sponson sides: cleaning-rod tube (left), tow cable (right)
    def side_pt(x, z, s, out):
        y = W_SPONSON - (z - Z_SPONSON) * math.tan(SIDE_SLOPE)
        n = Vector((0, math.cos(SIDE_SLOPE), math.sin(SIDE_SLOPE)))
        return Vector((x, s * y, z)) + Vector((0, s * n.y, n.z)) * out
    # (side tools are left to the detailed model -- they would need supports on the sloped sides)

    cuts = []
    z0, z1 = Z_ROOF - ENG_D, Z_ROOF + 0.05
    for s in (1, -1):
        cuts.append(ring_cut((1.60, s * 0.60), 0.27, ENG_W, z0, z1))          # driver / radio op hatches
        cuts.append(ring_cut((1.60, s * 0.60), 0.07, ENG_W, z0, z1))          # hatch hinge boss
        cuts += rect_groove(2.04, s * 0.60, 0.10, 0.24, z0, z1)               # periscopes
        cuts.append(ring_cut((-1.72, s * 0.78), 0.23, ENG_W, z0, z1))         # fan grilles
        cuts.append(ring_cut((-1.72, s * 0.78), 0.15, ENG_W, z0, z1))
        cuts += rect_groove(-2.52, s * 0.80, 0.70, 0.46, z0, z1)              # radiator grilles
        for k in range(5):
            cuts.append(boxr(-2.85, -2.19, s * (0.62 + 0.09 * k) - ENG_W / 2, s * (0.62 + 0.09 * k) + ENG_W / 2, z0, z1))
        cuts.append(cyl((-2.72, s * 0.28, z0), (-2.72, s * 0.28, z1), 0.06, seg=16))  # filler caps
        # exhaust sockets (in the stubs, open at the roof plane)
        cuts.append(cyl((EXHAUST_X, s * EXHAUST_Y, Z_ROOF - SOCKET_D), (EXHAUST_X, s * EXHAUST_Y, Z_ROOF + 0.05), SOCKET_R, seg=24))
    cuts += rect_groove(-2.05, 0.0, 0.90, 0.80, z0, z1)                        # engine access hatch
    cuts.append(boxr(X_BULKHEAD - ENG_W / 2, X_BULKHEAD + ENG_W / 2, -W_ROOF, W_ROOF, z0, z1))
    return csg("hull_upper", coll, base, [("DIFFERENCE", [cav] + grooves + [ring]), ("UNION", det), ("DIFFERENCE", cuts)])


# ============================================================================= running gear
def build_running_gear(coll, side):
    s = 1 if side == "left" else -1
    frame = Matrix.Diagonal((1, s, 1, 1))
    Y0 = W_LOWER                         # inner face (print bed)
    YS = 1.06                            # slab / wheel base plane
    # track loop: full solid, then the inside is cleared down to the slab
    outer = track_outline(TRACK_T)
    inner = track_outline(0.0)
    M_xz = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))    # (x, y, z) <- (x, z, y)
    base = P(frame=frame)
    base.prism(outer, Y0, Y_TRACK_OUT, M=M_xz)
    clear = P(frame=frame)
    clear.prism(inner, YS, Y_TRACK_OUT + 0.1, M=M_xz)

    det = []
    # grousers (tread bars) every pitch on the ground face
    pts, tans, L = resample_closed(track_centreline(), count=87)
    grous = P(frame=frame)
    for p, t in zip(pts, tans):
        nrm = Vector((t[1], 0, -t[0]))           # outward (loop is CCW in x/z)
        ang = math.atan2(t[1], t[0])
        c = Vector((p[0], (Y_TRACK_IN + Y_TRACK_OUT) / 2, p[1])) + nrm * (TRACK_T / 2 + 0.008)
        grous.box(c, (0.05, TRACK_W - 0.06, 0.03), rot=(0, -ang, 0))
    det.append(grous)
    # road wheels (even index = outer row); inner row is finished before the outer row goes on
    rows = {0: [], 1: []}
    for i, x in enumerate(STATION_X):
        yf = 1.62 if i % 2 == 0 else 1.49
        r = rows[i % 2]
        r.append(cyl((x, YS - 0.01, WHEEL_Z), (x, yf, WHEEL_Z), WHEEL_R + 0.006, seg=64, frame=frame))
        r.append(cyl((x, yf - 0.01, WHEEL_Z), (x, yf + 0.03, WHEEL_Z), 0.13, seg=32, frame=frame))     # hub
        r.append(cyl((x, yf + 0.02, WHEEL_Z), (x, yf + 0.06, WHEEL_Z), 0.075, r2=0.06, seg=24, frame=frame))
    wcuts = {0: [], 1: []}
    for i, x in enumerate(STATION_X):   # tyre line + wheel nuts
        yf = 1.62 if i % 2 == 0 else 1.49
        wcuts[i % 2].append(annulus((x, WHEEL_Z), 0.355, 0.355 + ENG_W, yf - ENG_D, yf + 0.02, frame=frame, M=M_xz))
        for k in range(8):
            a = 2 * math.pi * k / 8
            wcuts[i % 2].append(cyl((x + 0.20 * math.cos(a), yf - ENG_D, WHEEL_Z + 0.20 * math.sin(a)),
                                    (x + 0.20 * math.cos(a), yf + 0.02, WHEEL_Z + 0.20 * math.sin(a)), 0.022, seg=10, frame=frame))
    det += rows[1]
    # sprocket: two toothed rings + drum + hub
    gx, gz = SPROCKET
    g = gear_outline(SPROCKET_TEETH, SPROCKET_RP - 0.045, SPROCKET_RP + 0.035)
    Mg = Matrix.Translation((gx, 0, gz)) @ M_xz
    p = P(frame=frame)
    p.prism(g, YS - 0.01, 1.58, M=Mg)
    det.append(p)
    det.append(cyl((gx, YS - 0.01, gz), (gx, 1.58, gz), 0.27, seg=48, frame=frame))
    det.append(cyl((gx, 1.57, gz), (gx, 1.63, gz), 0.19, seg=40, frame=frame))
    det.append(cyl((gx, 1.62, gz), (gx, 1.67, gz), 0.10, seg=32, frame=frame))
    # idler
    ix, iz = IDLER
    det.append(cyl((ix, YS - 0.01, iz), (ix, 1.58, iz), IDLER_R + 0.006, seg=64, frame=frame))
    det.append(cyl((ix, 1.57, iz), (ix, 1.62, iz), 0.12, seg=32, frame=frame))
    # return roller behind the sprocket
    det.append(cyl((2.22, YS - 0.01, 0.86), (2.22, 1.40, 0.86), 0.10, seg=32, frame=frame))

    cuts = list(wcuts[0])
    for k in range(6):  # idler spokes openings (shallow)
        a = 2 * math.pi * k / 6
        cuts.append(cyl((ix + 0.21 * math.cos(a), 1.58 - 1.0 * MM, iz + 0.21 * math.sin(a)),
                        (ix + 0.21 * math.cos(a), 1.62, iz + 0.21 * math.sin(a)), 0.065, seg=20, frame=frame))
    for (x, z) in PEG_POS:   # peg holes in the inner face
        cuts.append(cyl((x, Y0 - 0.05, z), (x, Y0 + PEG_L + 0.4 * MM, z), PEG_R + CLR / 2 + 0.05 * MM, seg=24, frame=frame))
    return csg(f"running_gear_{side}", coll, base, [("DIFFERENCE", [clear]), ("UNION", det), ("DIFFERENCE", wcuts[1]),
                                                     ("UNION", rows[0]), ("DIFFERENCE", cuts)])


# ============================================================================= turret
TF = Matrix.Translation(TURRET_ORIGIN)          # turret local frame
TUBE_R = RING_R - ROT_CLR                        # basket tube outer radius (runs in the hull roof ring)
TUBE_IN = TUBE_R - 1.2 * MM                      # basket tube inner radius
SPIGOT_R = TUBE_IN + 0.6 * MM                    # thin spigot that locates in the turret ring plate
HOLE_R = SPIGOT_R + 0.10 * MM                    # hole in the turret ring plate (basket goes in from below)
ROOF_Z0 = T_ROOF_Z - ROOF_P                      # joint between body and roof plate
BARREL_PEG_R = 0.055
BARREL_PEG_L = 0.30
HATCH_R = 0.30          # cupola hatch (real metres)
HATCH_OPEN_R = 0.25
RECESS_D = 1.0 * MM
PIVOT_ANG = math.radians(-135)
PIVOT_D = CUPOLA_R + 0.055
CUPOLA_BOSS_R = 0.075


def mantlet_poly():
    x0, rr, cz = MANTLET_X + 0.05, 0.36, GUN_Z
    pts = [(x0 + rr * math.cos(math.radians(a)), cz + rr * math.sin(math.radians(a))) for a in range(90, -1, -6)]
    pts += [(x0 + rr, cz - 0.12), (x0 + rr - 0.07, 0.0)]
    pts += [(0.92, 0.0), (0.92 - 0.70 * math.tan(T_FRONT_SLOPE), 0.70), (0.86, cz + rr)]
    return pts


def mantlet_part(grow=0.0):
    M = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    p = P(frame=TF)
    poly = mantlet_poly()
    if grow:
        cx = sum(q[0] for q in poly) / len(poly)
        cz = sum(q[1] for q in poly) / len(poly)
        poly = [(cx + (q[0] - cx) * (1 + grow), cz + (q[1] - cz) * (1 + grow)) for q in poly]
    p.prism(poly, -0.64 - grow, 0.64 + grow, M=M)
    return p


def build_turret_body(coll):
    tp = turret_planes(roof=ROOF_Z0)
    base = convex(tp, frame=TF)
    cav = convex(offset(turret_planes(roof=T_ROOF_Z + 0.5), [BOT_T, 0, WALL * 1.3, WALL, WALL, WALL]), frame=TF)
    hole = cyl((0, 0, -0.1), (0, 0, BOT_T + 0.01), HOLE_R, seg=128, frame=TF)
    notch = boxr(-HOLE_R - 1.0 * MM, -HOLE_R + 0.3 * MM, -KEY_W / 2 - CLR, KEY_W / 2 + CLR, -0.1, BOT_T + 0.01, frame=TF)
    det = [mantlet_part()]
    # locating lip on top of the walls (roof plate has the matching groove)
    lip_o = convex([plane((0, 0, ROOF_Z0 - 0.3 * MM), (0, 0, -1)), plane((0, 0, ROOF_Z0 + LIP_H2), (0, 0, 1))] +
                   offset(turret_planes()[2:], WALL - LIP_T), frame=TF)
    lip_i = convex([plane((0, 0, ROOF_Z0 - 0.1), (0, 0, -1)), plane((0, 0, ROOF_Z0 + 0.1), (0, 0, 1))] +
                   offset(turret_planes()[2:], WALL), frame=TF)
    lip = csg_part_diff(lip_o, lip_i)
    # rear escape hatch disc, 3 crane sockets on the side walls, spare-link hooks
    rn = Vector((-math.cos(T_REAR_SLOPE), 0, math.sin(T_REAR_SLOPE)))
    c = Vector((T_REAR_X + 0.40 * math.tan(T_REAR_SLOPE), 0, 0.40))
    det.append(cyl(c - rn * 0.01, c + rn * 0.03, 0.25, seg=64, frame=TF))
    det.append(cyl(c + rn * 0.02, c + rn * 0.06, 0.05, seg=16, frame=TF))
    cuts = [
        cyl((1.50, 0, GUN_Z), (1.50 - BARREL_PEG_L - 0.02, 0, GUN_Z), BARREL_PEG_R + CLR / 2, seg=32, frame=TF),
        cyl((1.50, -0.30, GUN_Z + 0.02), (1.25, -0.30, GUN_Z + 0.02), 0.035, seg=16, frame=TF),   # coax MG
        cyl((1.50, 0.29, GUN_Z + 0.06), (1.25, 0.29, GUN_Z + 0.06), 0.03, seg=16, frame=TF),      # TZF 12a sight
    ]
    return csg("turret_body", coll, base, [("DIFFERENCE", [cav, hole, notch]), ("UNION", det + [lip]),
                                            ("DIFFERENCE", cuts)])


def cupola_c():
    return Vector((CUPOLA.x, CUPOLA.y, 0))


def pivot_xy():
    return (CUPOLA.x + PIVOT_D * math.cos(PIVOT_ANG), CUPOLA.y + PIVOT_D * math.sin(PIVOT_ANG))


def build_turret_roof(coll):
    tp = turret_planes()
    base = convex([plane((0, 0, ROOF_Z0), (0, 0, -1)), plane((0, 0, T_ROOF_Z), (0, 0, 1))] + tp[2:], frame=TF)
    cz = T_ROOF_Z + CUPOLA_TOP
    # cast cupola: base, periscope band, armoured top ring
    prof = [(0, ROOF_Z0), (CUPOLA_R, ROOF_Z0), (CUPOLA_R, T_ROOF_Z + 0.05), (CUPOLA_R - 0.03, T_ROOF_Z + 0.07),
            (CUPOLA_R - 0.03, T_ROOF_Z + 0.13), (CUPOLA_R, T_ROOF_Z + 0.16), (CUPOLA_R, cz), (0, cz)]
    cup = P(frame=TF)
    cup.lathe(prof, seg=96, M=Matrix.Translation(cupola_c()))
    px, py = pivot_xy()
    det = [cup, cyl((px, py, ROOF_Z0), (px, py, cz), CUPOLA_BOSS_R, seg=32, frame=TF)]
    # periscope armour hoods (7) on the band
    for k in range(7):
        a = math.radians(0 + k * 360 / 7)
        c = cupola_c() + Vector((math.cos(a), math.sin(a), 0)) * (CUPOLA_R - 0.02)
        det.append(box((c.x, c.y, T_ROOF_Z + 0.10), (0.06, 0.13, 0.07), rot=(0, 0, a), frame=TF))
    # loader periscope, ventilator, close-defence weapon, crane sockets ("Pilze")
    det.append(boxr(0.18, 0.40, -0.58, -0.36, T_ROOF_Z - 0.01, T_ROOF_Z + 0.07, frame=TF))
    det.append(cyl((0.30, 0.0, T_ROOF_Z - 0.01), (0.30, 0.0, T_ROOF_Z + 0.05), 0.11, seg=32, frame=TF))
    det.append(cyl((-0.62, -0.38, T_ROOF_Z - 0.01), (-0.62, -0.38, T_ROOF_Z + 0.07), 0.10, seg=32, frame=TF))
    for (x, y) in ((0.45, 0.42), (0.45, -0.20), (-1.00, -0.25)):
        det.append(cyl((x, y, T_ROOF_Z - 0.01), (x, y, T_ROOF_Z + 0.07), 0.05, r2=0.035, seg=16, frame=TF))
    # groove for the wall lip (underside) + clearances
    grv_o = convex([plane((0, 0, ROOF_Z0 - 0.05), (0, 0, -1)), plane((0, 0, ROOF_Z0 + LIP_H2 + CLR), (0, 0, 1))] +
                   offset(tp[2:], WALL - LIP_T - CLR), frame=TF)
    grv_i = convex([plane((0, 0, ROOF_Z0 - 0.1), (0, 0, -1)), plane((0, 0, ROOF_Z0 + 0.1), (0, 0, 1))] +
                   offset(tp[2:], WALL + CLR), frame=TF)
    groove = csg_part_diff(grv_o, grv_i)
    cuts = [cyl(cupola_c() + Vector((0, 0, ROOF_Z0 - 0.1)), cupola_c() + Vector((0, 0, cz + 0.1)), HATCH_OPEN_R, seg=96, frame=TF),
            cyl(cupola_c() + Vector((0, 0, cz - RECESS_D)), cupola_c() + Vector((0, 0, cz + 0.1)), HATCH_R + CLR, seg=96, frame=TF),
            cyl((px, py, cz - 3.0 * MM), (px, py, cz + 0.1), PIN_R + 0.05 * MM, seg=24, frame=TF),
            mantlet_part(grow=CLR * 3)]
    return csg("turret_roof", coll, base, [("UNION", det), ("DIFFERENCE", [groove] + cuts)])


def csg_part_diff(a, b):
    """Return a Part holding (a - b) evaluated immediately (used for ring-shaped cutters)."""
    tmpc = get_coll("_tmp_parts")
    o = csg("_diff", tmpc, a, [("DIFFERENCE", [b])])
    p = P()
    p.bm.from_mesh(o.data)
    bpy.data.objects.remove(o, do_unlink=True)
    return p


def build_hatch(coll):
    """Cupola hatch in assembled (closed) position, turret frame."""
    cz = T_ROOF_Z + CUPOLA_TOP
    px, py = pivot_xy()
    c = cupola_c()
    plug_h = RECESS_D - 0.2 * MM
    base = cyl(c + Vector((0, 0, cz - plug_h)), c + Vector((0, 0, cz + 0.02)), HATCH_R - CLR / 2, seg=96, frame=TF)
    cap_t = 1.0 * MM
    det = [cyl(c + Vector((0, 0, cz)), c + Vector((0, 0, cz + cap_t)), CUPOLA_R - 0.03, seg=96, frame=TF)]
    # arm to the pivot
    d = Vector((px, py, 0)) - c
    ang = math.atan2(d.y, d.x)
    L = d.length
    det.append(box(c + d / 2 + Vector((0, 0, cz + cap_t / 2)), (L, 0.10, cap_t), rot=(0, 0, ang), frame=TF))
    det.append(cyl((px, py, cz), (px, py, cz + cap_t), CUPOLA_BOSS_R, seg=32, frame=TF))
    # hand grip ridge and hinge-lever detail on the underside plug are skipped; top gets a small grip bar
    cuts = [cyl((px, py, cz - 0.1), (px, py, cz + 0.1), PIN_R + 0.20 * MM, seg=24, frame=TF)]
    for k in (-1, 1):
        cuts.append(box(c + Vector((0, k * 0.12, cz + cap_t)), (0.24, ENG_W, 2 * ENG_D), frame=TF))
    return csg("hatch", coll, base, [("UNION", det), ("DIFFERENCE", cuts)])


def build_hatch_pin(coll):
    px, py = pivot_xy()
    cz = T_ROOF_Z + CUPOLA_TOP
    base = cyl((px, py, cz - 3.0 * MM), (px, py, cz + 3.4 * MM), PIN_R - 0.05 * MM, seg=24, frame=TF)
    head = cyl((px, py, cz + 3.3 * MM), (px, py, cz + 4.0 * MM), PIN_R + 0.8 * MM, seg=24, frame=TF)
    return csg("hatch_pin", coll, base, [("UNION", [head])])


def build_basket(coll):
    z_floor = (1.35 - TURRET_ORIGIN.z)
    zf = z_floor + FLOOR_T
    # tube (runs in the hull roof ring) -> shoulder glued under the turret ring plate -> spigot + key in the hole
    base = annulus((0, 0), TUBE_IN, TUBE_R, z_floor, 0.0, frame=TF, seg=128)
    det = [cyl((0, 0, z_floor), (0, 0, zf), TUBE_R - 0.6 * MM, seg=128, frame=TF),   # floor sits inside the tube wall
           annulus((0, 0), TUBE_IN, SPIGOT_R, -0.01, BOT_T - 0.1 * MM, frame=TF, seg=128),
           boxr(-HOLE_R - 0.7 * MM, -SPIGOT_R + 0.3 * MM, -KEY_W / 2, KEY_W / 2, 0.0, BOT_T - 0.1 * MM, frame=TF)]
    F = TF
    # rotary joint + hydraulic traverse unit
    det.append(cyl((0, 0, zf - 0.01), (0, 0, zf + 0.20), 0.12, seg=32, frame=F))
    det.append(boxr(0.23, 0.48, -0.48, -0.23, zf - 0.01, zf + 0.30, frame=F))
    # gun cradle on a pedestal with a 45 deg gusset, breech ring, recoil cylinders
    det.append(chamfer_block(-0.40, 0.72, -0.16, 0.16, GUN_Z - 0.14, GUN_Z + 0.14, 0.075, frame=F))
    det.append(boxr(-0.62, 0.30, -0.09, 0.09, zf - 0.01, GUN_Z - 0.13, frame=F))
    det.append(convex([plane((0.29, 0, 0), (-1, 0, 0)), plane((0.72, 0, 0), (1, 0, 0)),
                       plane((0, 0, GUN_Z - 0.13), (0, 0, 1)), plane((0, 0.09, 0), (0, 1, 0)), plane((0, -0.09, 0), (0, -1, 0)),
                       plane((0.29, 0, zf - 0.01), (math.sqrt(.5), 0, -math.sqrt(.5)))], frame=F))
    det.append(chamfer_block(-0.62, -0.30, -0.22, 0.22, GUN_Z - 0.20, GUN_Z + 0.20, 0.13, frame=F))
    det.append(boxr(-0.66, -0.60, -0.05, 0.05, GUN_Z + 0.02, GUN_Z + 0.12, frame=F))               # breech handle
    for y in (-0.09, 0.09):
        det.append(cyl((-0.30, y, GUN_Z + 0.19), (0.66, y, GUN_Z + 0.19), 0.06, seg=24, frame=F))
    # deflector guard (shortened to stay on the basket floor)
    for y in (-0.24, 0.24):
        det.append(boxr(-0.70, -0.40, y - 0.0175, y + 0.0175, zf - 0.01, GUN_Z + 0.10, frame=F))
    det.append(boxr(-0.72, -0.68, -0.26, 0.26, zf - 0.01, GUN_Z + 0.10, frame=F))
    # gunner: seat, TZF 12a sight, elevation + traverse handwheels
    det.append(boxr(-0.03, 0.27, 0.37, 0.67, zf - 0.01, -0.20, frame=F))
    det.append(boxr(-0.10, -0.03, 0.39, 0.65, zf - 0.01, 0.12, frame=F))
    det.append(cyl((-0.12, 0.20, GUN_Z + 0.06), (0.70, 0.20, GUN_Z + 0.06), 0.045, seg=20, frame=F))
    det.append(boxr(-0.22, -0.10, 0.15, 0.27, GUN_Z + 0.01, GUN_Z + 0.12, frame=F))
    det.append(cyl((0.05, 0.15, GUN_Z - 0.10), (0.05, 0.27, GUN_Z - 0.10), 0.03, seg=12, frame=F))
    det.append(cyl((0.05, 0.26, GUN_Z - 0.10), (0.05, 0.30, GUN_Z - 0.10), 0.10, seg=32, frame=F))
    det.append(cyl((0.42, 0.42, zf - 0.01), (0.42, 0.42, 0.10), 0.05, seg=16, frame=F))
    det.append(cyl((0.34, 0.42, 0.10), (0.44, 0.42, 0.10), 0.10, seg=32, frame=F))
    # commander: raised seat + backrest under the cupola
    det.append(boxr(-0.50, -0.25, 0.27, 0.52, zf - 0.01, 0.05, frame=F))
    det.append(boxr(-0.54, -0.50, 0.28, 0.51, zf - 0.01, 0.35, frame=F))
    # loader: seat + spent-case bin
    det.append(boxr(-0.18, 0.08, -0.63, -0.37, zf - 0.01, -0.25, frame=F))
    det.append(boxr(-0.55, -0.35, -0.52, -0.28, zf - 0.01, -0.22, frame=F))
    return csg("turret_basket", coll, base, [("UNION", det)])


def build_barrel(coll):
    F = TF
    gz = GUN_Z
    prof = [(0, 1.50 - BARREL_PEG_L), (BARREL_PEG_R, 1.50 - BARREL_PEG_L), (BARREL_PEG_R, 1.44),
            (0.110, 1.44), (0.110, 1.78), (0.086, 1.80), (0.068, MUZZLE_X - 0.47),
            (0.100, MUZZLE_X - 0.45), (0.120, MUZZLE_X - 0.43), (0.120, MUZZLE_X - 0.27),
            (0.080, MUZZLE_X - 0.25), (0.080, MUZZLE_X - 0.21), (0.120, MUZZLE_X - 0.17),
            (0.120, MUZZLE_X - 0.03), (0.105, MUZZLE_X), (0.045, MUZZLE_X), (0.045, MUZZLE_X - 0.05), (0, MUZZLE_X - 0.05)]
    p = P(frame=F)
    p.lathe(prof, seg=48, M=Matrix.Translation((0, 0, gz)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
    # lathe profile z is along the local X after rotation; need z -> x: Rotation(+90 about Y) maps z to +x
    return csg("gun_barrel", coll, p, [])


def build_exhaust(coll, s):
    x, y = EXHAUST_X, s * EXHAUST_Y
    base = cyl((x, y, Z_ROOF + 0.005), (x, y, 2.30), EXHAUST_R, seg=40)
    det = [cyl((x, y, 2.26), (x, y, 2.34), EXHAUST_R + 0.02, seg=40),
           cyl((x, y, Z_ROOF - SOCKET_D + 0.3 * MM), (x, y, Z_ROOF + 0.01), SOCKET_R - CLR / 2 - 0.05 * MM, seg=24)]
    cuts = [cyl((x, y, 2.20), (x, y, 2.40), EXHAUST_R - 0.03, seg=32)]
    return csg(f"exhaust_{'left' if s > 0 else 'right'}", coll, base, [("UNION", det), ("DIFFERENCE", cuts)])


# ============================================================================= checks / export
def check(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    nm = sum(1 for e in bm.edges if not e.is_manifold)
    vol = bm.calc_volume(signed=True)
    shells = len(bmesh_islands(bm))
    bm.free()
    return nm, vol, shells


def bmesh_islands(bm):
    seen, islands = set(), []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, isl = [v], []
        seen.add(v.index)
        while stack:
            a = stack.pop()
            isl.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index)
                    stack.append(b)
        islands.append(isl)
    return islands


PRINT_ROT = {
    "hull_lower": Matrix.Identity(4),
    "hull_upper": Matrix.Rotation(math.pi, 4, "X"),
    "running_gear_left": Matrix.Rotation(math.pi / 2, 4, "X"),
    "running_gear_right": Matrix.Rotation(-math.pi / 2, 4, "X"),
    "turret_body": Matrix.Identity(4),
    "turret_roof": Matrix.Identity(4),
    "turret_basket": Matrix.Identity(4),
    "hatch": Matrix.Rotation(math.pi, 4, "X"),
    "hatch_pin": Matrix.Rotation(math.pi, 4, "X"),
    "gun_barrel": Matrix.Rotation(math.pi / 2, 4, "Y"),
    "exhaust_left": Matrix.Rotation(math.pi, 4, "X"),
    "exhaust_right": Matrix.Rotation(math.pi, 4, "X"),
}


def export_stl(obj, path):
    me = obj.data.copy()
    me.transform(PRINT_ROT[obj.name])
    xs = [v.co for v in me.vertices]
    mn = Vector((min(v.x for v in xs), min(v.y for v in xs), min(v.z for v in xs)))
    mx = Vector((max(v.x for v in xs), max(v.y for v in xs), max(v.z for v in xs)))
    me.transform(Matrix.Translation(Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))))
    me.transform(Matrix.Scale(1000.0 / SCALE, 4))
    me.update()
    overhang = 0.0
    for poly in me.polygons:   # support check: faces facing down steeper than 45 deg, not on the bed
        if poly.normal.z < -0.7072 and max(me.vertices[i].co.z for i in poly.vertices) > 0.2:
            overhang += poly.area
    tmp = bpy.data.objects.new(obj.name + "_print", me)
    bpy.context.scene.collection.objects.link(tmp)
    for o in bpy.context.scene.objects:
        if o is not None and o != tmp:
            o.select_set(False)
    tmp.select_set(True)
    bpy.context.view_layer.objects.active = tmp
    bpy.ops.wm.stl_export(filepath=path, export_selected_objects=True, ascii_format=False,
                          apply_modifiers=True, global_scale=1.0, use_scene_unit=False)
    size = (mx - mn) * (1000.0 / SCALE)
    size = Vector(sorted([abs(size.x), abs(size.y), abs(size.z)]))
    dims = tmp.dimensions.copy()
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.meshes.remove(me)
    return dims, overhang


def main():
    clear_scene()
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    coll = get_coll("print_parts_assembled")
    builders = [
        ("hull_lower", lambda: build_hull_lower(coll)),
        ("hull_upper", lambda: build_hull_upper(coll)),
        ("running_gear_left", lambda: build_running_gear(coll, "left")),
        ("running_gear_right", lambda: build_running_gear(coll, "right")),
        ("turret_body", lambda: build_turret_body(coll)),
        ("turret_roof", lambda: build_turret_roof(coll)),
        ("turret_basket", lambda: build_basket(coll)),
        ("hatch", lambda: build_hatch(coll)),
        ("hatch_pin", lambda: build_hatch_pin(coll)),
        ("gun_barrel", lambda: build_barrel(coll)),
        ("exhaust_left", lambda: build_exhaust(coll, 1)),
        ("exhaust_right", lambda: build_exhaust(coll, -1)),
    ]
    only = None
    if "--only" in argv:
        only = argv[argv.index("--only") + 1].split(",")
    os.makedirs(OUT_DIR, exist_ok=True)
    report = []
    for name, fn in builders:
        if only and name not in only:
            continue
        obj = fn()
        nm, vol, shells = check(obj)
        dims, ovh = export_stl(obj, os.path.join(OUT_DIR, f"panther_{TAG}_{name}.stl"))
        report.append((name, nm, vol * (1000 / SCALE) ** 3 / 1000.0, shells, dims, ovh))
        print(f"PART {name:20s} nonmanifold={nm:4d} shells={shells} vol={vol * (1000 / SCALE) ** 3 / 1000:8.2f} cm3 "
              f"size={dims.x:6.1f} x {dims.y:6.1f} x {dims.z:6.1f} mm  overhang>45deg={ovh:7.1f} mm2", flush=True)
    # materials for the reference scene
    cols = {"hull": (0.55, 0.50, 0.33), "running": (0.22, 0.22, 0.2), "turret": (0.60, 0.55, 0.37),
            "hatch": (0.75, 0.25, 0.15), "gun": (0.45, 0.42, 0.30), "exhaust": (0.35, 0.18, 0.1)}
    for o in coll.objects:
        key = next(k for k in cols if o.name.startswith(k))
        m = bpy.data.materials.get("PR_" + key) or bpy.data.materials.new("PR_" + key)
        m.diffuse_color = (*cols[key], 1)
        try:
            bsdf = m.node_tree.nodes.get("Principled BSDF")
            bsdf.inputs["Base Color"].default_value = (*cols[key], 1)
            bsdf.inputs["Roughness"].default_value = 0.6
        except Exception:
            pass
        o.data.materials.clear()
        o.data.materials.append(m)
        o.data.shade_smooth()
        o.data.set_sharp_from_angle(angle=math.radians(30))
    with open(os.path.join(OUT_DIR, "build_report.txt"), "w") as f:
        f.write(f"Panther Ausf. G print kit, scale 1:{SCALE:g}\n")
        f.write("part                  non-manifold-edges  shells  volume_cm3   bbox_mm (print orientation)   overhang>45deg_mm2\n")
        for name, nm, vol, shells, d, ovh in report:
            f.write(f"{name:22s}{nm:10d}{shells:10d}{vol:12.2f}   {d.x:6.1f} x {d.y:6.1f} x {d.z:6.1f}   {ovh:10.1f}\n")
    if not only:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, f"panther_print_{TAG}.blend"))


main()
