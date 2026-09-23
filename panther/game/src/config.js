// Alle instelbare waarden van WOUDFRONT op één plek.
// Eenheden: meters, seconden, graden (tenzij anders vermeld). Snelheden in m/s (x 3.6 = km/h).

export const CONFIG = {
  game: {
    name: 'WOUDFRONT',
    subtitle: 'Tankslag in het dennenwoud',
    phase: 'Fase 1 · Singleplayer',
  },

  // Team 0 is altijd het team van de speler. skin = camouflage van de AI-tanks van dat team.
  teams: [
    { name: 'Blauw', color: '#4aa8ff', dark: '#173a5c', skin: 'hinterhalt' },
    { name: 'Rood', color: '#ff5a48', dark: '#5c1d16', skin: 'stahlgrau' },
  ],

  // Skins (camouflage) die je in de hangaar kiest. Kleuren in sRGB: base = grondverf,
  // a en b = camouflagekleuren, dust = stof en modder onderaan de romp. scale < 1 = grotere vlekken.
  // pattern: vlekken | stippen | effen | winter (a = afgesleten verf eronder) | strepen | splinter | digitaal
  skins: [
    { id: 'hinterhalt', name: 'Hinterhalt', info: 'Dunkelgelb met olijfgroen en roodbruin, 1944', pattern: 'vlekken', base: '#c4ab78', a: '#545c36', b: '#6d3c2a', dust: '#9f8d6b', scale: 1, seed: 0 },
    { id: 'lichtschaduw', name: 'Licht en schaduw', info: 'Vlekken met lichte stippen, zoals zon door de bomen', pattern: 'stippen', base: '#c2a974', a: '#4f5a33', b: '#683a29', dust: '#9f8d6b', scale: 1, seed: 41.7 },
    { id: 'stahlgrau', name: 'Stahlgrau', info: 'Donkergrijs met groene en bruine vlekken', pattern: 'vlekken', base: '#4c514f', a: '#3c472d', b: '#5a3a2b', dust: '#7b7565', scale: 1, seed: 17.3 },
    { id: 'dunkelgrau', name: 'Dunkelgrau', info: 'Effen donkergrijs, zoals aan het begin van de oorlog', pattern: 'effen', base: '#45494e', a: '#45494e', b: '#45494e', dust: '#7d7466', scale: 1, seed: 3.1 },
    { id: 'olivgruen', name: 'Olivgrün', info: 'Effen olijfgroen, rechtstreeks uit de fabriek', pattern: 'effen', base: '#4d5535', a: '#4d5535', b: '#4d5535', dust: '#86795f', scale: 1, seed: 8.8 },
    { id: 'winterwit', name: 'Winterwit', info: 'Witkalk over Dunkelgelb, deels afgesleten', pattern: 'winter', base: '#d8d6cd', a: '#b39c6c', b: '#56603a', dust: '#8a8274', scale: 1, seed: 25.2 },
    { id: 'afrika', name: 'Afrikakorps', info: 'Zandbruin met grote grijsgroene vlekken', pattern: 'vlekken', base: '#b99e69', a: '#6f735c', b: '#8a6f49', dust: '#a8916a', scale: 0.7, seed: 63.4 },
    { id: 'tijger', name: 'Tijgerstrepen', info: 'Schuine strepen in groen en bruin', pattern: 'strepen', base: '#c7ae78', a: '#4b5530', b: '#693925', dust: '#9f8d6b', scale: 1, seed: 11.9 },
    { id: 'splinter', name: 'Splinter', info: 'Hoekige scherven in drie kleuren', pattern: 'splinter', base: '#b6a676', a: '#4e5935', b: '#5f3d2b', dust: '#9a8a68', scale: 1, seed: 52.6 },
    { id: 'digitaal', name: 'Digitaal woud', info: 'Moderne pixelcamouflage in bosgroen', pattern: 'digitaal', base: '#8e8b66', a: '#4a5832', b: '#3a3225', dust: '#8a8068', scale: 1, seed: 71.2 },
  ],
  neutralColor: '#cfc8b4',

  sim: {
    tickRate: 60, // vaste simulatiestappen per seconde
    maxStepsPerFrame: 6, // voorkomt een inhaalspiraal na een haperend frame
  },

  match: {
    playersPerTeam: 4, // speler + 3 AI tegen 4 AI
    startTickets: 1000,
    ticketsPerDestroyedTank: 25,
    ticketBleedPerPoint: 1.0, // tickets per seconde per punt verschil in veroverde punten
    respawnTime: 5,
    startCountdown: 4, // seconden voor de start waarin je niet kunt rijden of schieten
    timeLimit: 20 * 60, // vangnet: daarna wint het team met de meeste tickets
    wreckLifetime: 45, // hoe lang een wrak blijft liggen (en in de weg ligt)
    friendlyFire: false,
    resultDelay: 3, // seconden tussen einde match en het resultaatscherm
  },

  capture: {
    radius: 17,
    captureTime: 14, // seconden voor 1 tank om een neutraal punt te veroveren (vijandig punt: 2x)
    extraTankBonus: 0.5, // elke extra tank in het punt: +50% snelheid
    maxRateMultiplier: 2.5,
    decayRate: 0.05, // voortgang/s terug naar de eigenaar als niemand in het punt staat
  },

  tank: {
    name: 'Panther Ausf. G',
    nation: 'Duitsland',
    role: 'Middelzware tank',
    maxHp: 1000,

    // rijden
    maxForwardSpeed: 12.5, // 45 km/h
    maxReverseSpeed: 4.7, // 17 km/h
    acceleration: 3.4,
    brakeDeceleration: 9,
    rollingResistance: 2.4,
    hullTurnRate: 42, // graden/s bij stilstand
    hullTurnRateAtSpeed: 28, // graden/s bij topsnelheid
    hullTurnAcceleration: 140, // graden/s²
    invertSteeringInReverse: true, // achteruit sturen zoals een auto
    slopeFactor: 0.55, // invloed van hellingen op de snelheid

    // toren en kanon
    turretTraverseSpeed: 30, // graden/s
    gunElevationSpeed: 13, // graden/s
    gunMinElevation: -8,
    gunMaxElevation: 18,
    reloadTime: 5.0,

    // granaat
    damage: 250,
    damageVariance: 0.1, // ±10%
    armorMultiplier: { front: 0.75, side: 1.0, rear: 1.4 },
    splashRadius: 4.5,
    splashDamage: 70,
    muzzleVelocity: 340,
    shellGravity: 4.0, // lichte zwaartekracht
    shellMaxLifetime: 4.5,
    dispersion: 0.12, // graden spreiding

    // afmetingen, afgeleid uit panther.glb (+X = voren, +Y = boven, +Z = rechts)
    hullHalfLength: 3.62,
    hullHalfWidth: 1.68,
    hullBox: { center: [0.05, 1.0, 0], half: [3.6, 0.98, 1.68] },
    turretBox: { center: [-0.2, 0.55, 0], half: [1.2, 0.55, 1.18] },
    turretPivot: [0.35, 1.955, 0], // torenring t.o.v. romp-oorsprong
    gunPivot: [0.8, 0.42, 0], // tappen van het kanon t.o.v. de toren
    muzzleLength: 4.06, // van de tappen tot de mondingsrem
    collisionCircles: { offsets: [-2.0, 0.05, 2.1], radius: 1.66 }, // tank tegen tank
  },

  ai: {
    viewDistance: 380,
    reactionTime: [0.45, 1.1], // seconden voor het eerste schot op een nieuw doel
    aimErrorStart: 2.4, // graden onnauwkeurigheid bij een nieuw doel
    aimErrorMin: 0.45, // graden na lang richten
    aimSettleTime: 3.2, // seconden om van start- naar minimale fout te gaan
    movingErrorFactor: 1.6, // extra fout als de AI zelf rijdt
    fireTolerance: 0.9, // graden tussen loop en gewenste richting om te vuren
    leadFactor: 0.85, // hoe goed de AI voor bewegende doelen voorhoudt
    decisionInterval: 2.5,
    targetScanInterval: 0.3,
    repathInterval: 7,
    stuckTime: 1.3,
    names: ['Wolf', 'Adelaar', 'Beer', 'Lynx', 'Havik', 'Vos', 'Das', 'Raaf', 'Eland', 'Marter', 'Buizerd'],
  },

  player: {
    name: 'Jij',
    skin: 'hinterhalt', // tot je in de hangaar een andere kiest (die keuze wordt onthouden)
  },

  camera: {
    fov: 62,
    zoomFov: 20,
    distance: 11,
    minDistance: 6,
    maxDistance: 22,
    targetHeight: 3.3, // kijkpunt boven de romp
    zoomTargetHeight: 4.3, // bij inzoomen net over de koepel kijken
    zoomDistance: 3.4,
    mouseSensitivity: 0.0022,
    zoomSensitivityFactor: 0.35,
    minPitch: -30,
    maxPitch: 55,
    maxAimDistance: 1200,
  },

  map: {
    seed: 20260923,
    size: 720, // speelbaar vierkant (m)
    worldSize: 1100, // terrein inclusief decoratieve rand
    heightResolution: 400, // rastercellen per zijde van het hoogteveld
    baseDistance: 300, // afstand van het midden tot elke teambasis
    pointSpread: 205, // afstand van punt A en C tot het midden
    pointClearingRadius: 34,
    baseClearingRadius: 52,
    roadWidth: 8,
    treeSpacingDense: 5.6,
    treeSpacingSparse: 11,
    treeSpacingBorder: 4.6,
    treeBorderDepth: 120, // bosrand buiten het speelveld
    meadowCount: 7,
    rockCount: 70,
    // soorten in trees_atlas.png: per soort 2 tegels (0° en 90°)
    treeSpecies: [
      { height: 20.4, trunkRadius: 0.3, weight: 1 },
      { height: 14.9, trunkRadius: 0.3, weight: 1 },
      { height: 17.5, trunkRadius: 0.3, weight: 1 },
      { height: 18.9, trunkRadius: 0.3, weight: 0.9 },
    ],
    treeScale: [0.85, 1.3],
  },

  graphics: {
    maxPixelRatio: 2,
    // pixelratio omlaag als er beelden gemist worden (t.o.v. de verversingsfrequentie van het scherm)
    // en weer omhoog als het een tijd vlekkeloos gaat; onder 1 alleen bij minder dan 50 fps
    adaptiveResolution: true,
    minPixelRatio: 0.75,
    shadows: true,
    shadowMapSize: 4096,
    shadowRange: 150, // meters rond de speler met schaduw
    fogDensity: 0.0028,
    plantCount: 26000,
    plantDrawDistance: 95,
  },

  audio: {
    masterVolume: 0.7,
  },
};

export const DEG = Math.PI / 180;
