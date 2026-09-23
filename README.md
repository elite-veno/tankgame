# Tankgame

| Map | Inhoud |
|---|---|
| [`panther/game`](panther/game/README.md) | **WOUDFRONT**: tankgame in Three.js (hangaar-lobby, Verovering met punten A/B/C, AI-tanks, 10 skins) |
| [`panther`](panther/README.md) | Panther Ausf. G: gedetailleerd Blender-model, 3D-printkit (1:35), renders en de scripts die alles bouwen |
| `scripts`, `textures`, `t34_85_preview.blend` | T-34/85-model met interieur (Blender) |

## De game starten

Vereist: Node.js 18 of nieuwer.

```
cd panther/game
npm install
npm run dev
```

Open daarna http://localhost:5173. Besturing en spelregels staan in [`panther/game/README.md`](panther/game/README.md).

## Niet in de repository

Deze bestanden zijn te groot voor GitHub (meer dan 100 MB) en worden met scripts opnieuw gemaakt:

- `panther/forest_assets/` (Poly Haven, CC0): `python panther/scripts/fetch_forest_assets.py`
- `panther/panther_forest_scene.blend`:
  `blender -b panther/panther_ausf_g_detailed.blend --python panther/scripts/render_forest.py -- --no-render`
