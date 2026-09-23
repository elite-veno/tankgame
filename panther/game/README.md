# WOUDFRONT — tankslag in het dennenwoud

Singleplayer tankgame in Three.js (fase 1): een lobby in War Thunder-stijl met 3D-hangar, en een
Verovering-match (Domination) met punten A, B en C, tickets en AI-tanks in een procedureel bos.

## Starten

Vereist: Node.js 18 of nieuwer (getest met Node 22).

```
cd panther/game
npm install
npm run dev
```

Open daarna **http://localhost:5173** in Chrome, Edge of Firefox. In de hangaar klik je op
**TEN STRIJDE**; na het laadscherm klik je op **Beginnen** (de muis wordt dan vergrendeld).

Een productieversie bouwen: `npm run build` (uitvoer in `dist/`), bekijken met `npm run preview`.

## Besturing

| Toets | Actie |
|---|---|
| W / S | vooruit / achteruit (met acceleratie) |
| A / D | romp draaien (achteruit sturen werkt zoals bij een auto) |
| Muis | camera en toren richten |
| Linkermuisknop | vuren |
| Rechtermuisknop (vasthouden) | inzoomen |
| Scrollwiel | cameraafstand |
| Tab (vasthouden) | scorebord |
| Esc | pauze / menu (match verlaten) |

Het vizier (midden) is waar je wilt raken. De kleine cirkel laat zien waar de loop op dat moment
écht op richt, inclusief de valboog van de granaat. Hij wordt groen als de loop op het vizier staat.

## Camouflage (skins)

Rechts in de hangaar kies je een van de 10 skins voor je tank: Hinterhalt, Licht en schaduw, Stahlgrau,
Dunkelgrau, Olivgrün, Winterwit, Afrikakorps, Tijgerstrepen, Splinter en Digitaal woud. De tank in de
hangaar wisselt meteen mee, en je keuze wordt onthouden (in de browser). De AI-tanks rijden in de
camouflage van hun team. De skins staan in `CONFIG.skins` in `src/config.js` (kleuren, patroon, schaal);
een nieuwe skin toevoegen is één regel.

## Spelregels

- Twee teams van vier: jij + 3 AI (Blauw) tegen 4 AI (Rood).
- Sta in een veroveringspunt om het in te nemen. Meer tanks in het punt = sneller. Staan beide teams
  erin, dan ligt de verovering stil (betwist). Een vijandelijk punt wordt eerst geneutraliseerd.
- Elk team start met 1000 tickets. Het team met minder punten verliest continu tickets (per punt
  verschil), en elke vernietigde tank kost zijn team 25 tickets.
- Vernietigd? Na 5 seconden kom je terug bij je teambasis. Het wrak blijft een tijd liggen.
- Schade hangt af van de hoek: voorpantser neemt minder schade, zij- en achterkant meer.
- De match eindigt als een team op 0 tickets staat (of na de tijdslimiet: meeste tickets wint).

Alle waarden (snelheid, schade, herlaadtijd, tickets, verovertijd, AI-precisie, kaartgrootte, …)
staan in **`src/config.js`**.

## Projectstructuur

```
src/
  config.js            alle instellingen
  main.js              opstart en schermwissels (hangaar -> laden -> match -> resultaten)
  core/                seed-random, noise, wiskundehulp
  sim/                 spellogica, zonder browser/rendering
    mapGen.js          procedurele bosmap (terrein, paden, punten, bases, bomen, rotsen)
    terrain.js         hoogteveld
    obstacles.js       ruimtelijk raster voor stammen/rotsen
    tank.js            rijden, terrein volgen, botsen, toren/loop richten
    projectiles.js     granaten, treffers, schade
    capturePoints.js   veroveren en tickets
    world.js           spelstatus + vaste simulatiestap, events, respawn, wrakken, einde
  ai/
    navGrid.js         navigatieraster + A*
    ai.js              AI-tanks: doelkeuze, padvolgen, loskomen, richten en vuren
  input/playerInput.js toetsenbord/muis -> commando
  render/              Three.js-weergave (terrein, bos, tanks, effecten, camera, hangaar)
    runningGear.js     meedraaiende rupsbanden en wielen (vertexshader)
  ui/                  lobby (met skinkeuze), laadscherm, HUD, minimap, resultaten, CSS
    profile.js         bewaarde voorkeuren van de speler (gekozen skin)
  audio/audio.js       gesynthetiseerde geluiden (Web Audio)
  game/match.js        koppelt simulatie, AI, invoer, weergave, HUD en geluid
tools/
  headless-match.mjs   volledige AI-match in Node (npm run sim)
  build-lods.mjs       vereenvoudigde tankmodellen voor afstand (npm run lods)
public/assets/         modellen en textures
```

### Voorbereid op multiplayer (fase 2)

- `src/sim` en `src/ai` gebruiken geen DOM of rendering (alleen Three.js-wiskunde) en draaien dus ook
  in Node: `npm run sim` speelt een complete match zonder browser.
- Invoer en logica zijn gescheiden: de speler én de AI leveren elke simulatiestap een commando
  (`{ throttle, steer, aimX/Y/Z, fire }`). Online kan dat commando over het netwerk naar de server.
- De wereld verandert alleen in `GameWorld.step()` (vaste 60 Hz). De weergave leest de status en
  reageert op events (`shotFired`, `shellImpact`, `tankDestroyed`, `pointCaptured`, …); de HUD bevat
  geen spelstatus.
- De kaart wordt deterministisch gegenereerd uit de seed in `config.js`, zodat server en clients
  dezelfde kaart bouwen.
- De spelerslijst (`roster`: team, naam, skin) is de enige informatie per speler die de weergave nodig
  heeft; online stuurt de server die lijst rond, zodat iedereen elkaars camouflage ziet.

## Assets

- `panther.glb`: het bestaande Panther-model (romp, toren en loop als aparte nodes).
  `panther_lod1..3.glb` zijn vereenvoudigde versies (55k / 12k / 4k driehoeken) voor AI-tanks op
  afstand, gemaakt met `npm run lods`.
- `trees_atlas.png/.json`, `plants_atlas.png`, `ground_*.jpg`, `sky.hdr`, `bark.jpg`: gemaakt met
  `panther/scripts/export_game_assets.py` uit de Poly Haven-assets (CC0).
- `loading_bg.jpg`: verkleinde versie van `panther/renders/forest_hero.png`.
- Hangaar, rotsen, effecten en geluiden worden in code gegenereerd.
- Rupsen en wielen: de 87 schakels per kant en de wielen zitten in de romp-mesh van `panther.glb`.
  Bij het laden krijgt elke vertex een schakel- of wielnummer (maten uit `panther/scripts/pz_geom.py`),
  waarna een vertexshader de schakels langs de band schuift en de wielen laat draaien.
  Bij bochten lopen de linker- en rechterband met verschillende snelheid.
