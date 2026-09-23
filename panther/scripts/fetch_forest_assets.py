"""Download the CC0 Poly Haven assets used by render_forest.py into panther/forest_assets/.

    python panther/scripts/fetch_forest_assets.py

Everything comes from https://polyhaven.com (CC0, no attribution required).
Already-downloaded files are skipped, so the script is safe to re-run.
"""
import json
import os
import sys
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "forest_assets"))
HDRI = ("forest_slope", "8k")
MODELS = ["pine_tree_01", "fir_tree_01", "fir_sapling", "fir_sapling_medium", "pine_sapling_medium", "fern_02",
          "grass_medium_01", "grass_medium_02", "tree_stump_01", "dead_tree_trunk", "rock_moss_set_01",
          "root_cluster_01", "dry_branches_medium_01", "nettle_plant", "moss_01"]
MODEL_RES = "2k"
TEXTURES = [("forest_ground_04", "4k"), ("brown_mud_leaves_01", "4k"), ("forest_leaves_02", "4k")]
UA = {"User-Agent": "panther-forest-scene/1.0"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def save(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = get(url)
    with open(path + ".part", "wb") as f:
        f.write(data)
    os.replace(path + ".part", path)
    print(f"  {os.path.relpath(path, ROOT)}  {len(data) / 1e6:.1f} MB", flush=True)


def files(asset):
    return json.loads(get(f"https://api.polyhaven.com/files/{asset}"))


def main():
    os.makedirs(ROOT, exist_ok=True)
    name, res = HDRI
    print("hdri", name)
    f = files(name)["hdri"][res]["hdr"]
    save(f["url"], os.path.join(ROOT, "hdri", f"{name}_{res}.hdr"))
    for m in MODELS:
        print("model", m)
        f = files(m)["blend"][MODEL_RES]["blend"]
        base = os.path.join(ROOT, "models", m)
        save(f["url"], os.path.join(base, os.path.basename(f["url"].split("?")[0])))
        for rel, inc in f.get("include", {}).items():
            save(inc["url"], os.path.join(base, rel))
    for t, res in TEXTURES:
        print("texture", t)
        f = files(t)
        maps = {"Diffuse": "diff", "nor_gl": "nor_gl", "Rough": "rough", "AO": "ao", "Displacement": "disp"}
        for key, short in maps.items():
            if key in f and res in f[key]:
                fmt = "png" if key in ("nor_gl", "Displacement") and "png" in f[key][res] else "jpg"
                if fmt not in f[key][res]:
                    fmt = list(f[key][res])[0]
                save(f[key][res][fmt]["url"], os.path.join(ROOT, "textures", t, f"{t}_{short}_{res}.{fmt}"))
    print("done ->", ROOT)


if __name__ == "__main__":
    sys.exit(main())
