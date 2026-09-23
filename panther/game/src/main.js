// Opstart en schermwissels: hangaar (lobby) -> laadscherm -> match -> resultaten -> hangaar.
import './ui/styles.css';
import { CONFIG } from './config.js';
import { createRenderer } from './render/renderer.js';
import { AssetStore } from './render/assets.js';
import { TankModelFactory } from './render/tankModel.js';
import { SoundEngine } from './audio/audio.js';
import { Lobby } from './ui/lobby.js';
import { LoadingScreen } from './ui/loadingScreen.js';
import { ResultsScreen } from './ui/endScreen.js';
import { loadProfile } from './ui/profile.js';

const app = {
  canvas: document.getElementById('scene'),
  uiRoot: document.getElementById('ui'),
  state: 'boot',
  profile: loadProfile(),
  renderer: null,
  assets: null,
  audio: new SoundEngine(CONFIG.audio.masterVolume),
  tankFactory: null,
  lobby: null,
  loading: null,
  results: null,
  match: null,
};

let last = -1;

// time = tijdstempel van het beeld (requestAnimationFrame), niet het moment waarop deze functie toevallig
// draait: zo beweegt alles per beeld precies zo ver als de tijd tussen twee beelden op het scherm.
function frame(time) {
  const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, time - last) / 1000);
  last = time;
  if (app.state === 'lobby') {
    app.lobby.update(dt);
    app.lobby.render();
  } else if (app.state === 'match' && app.match) {
    app.match.frame(dt);
  }
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  app.renderer.setSize(w, h, false);
  app.lobby?.resize(w, h);
  app.match?.resize(w, h);
}

async function startMatch() {
  if (app.state !== 'lobby') return;
  app.state = 'loading';
  app.audio.ensure();
  app.lobby.hide();
  app.loading.setHeading('Verovering · Singleplayer', 'Dennenwoud', 'Drie veroveringspunten verscholen tussen de grove dennen. Beheers het bos, breek hun tickets.');
  app.loading.show();
  let match = null;
  try {
    const { Match } = await import('./game/match.js');
    match = new Match(app);
    await match.load((p, label) => app.loading.setProgress(p, label));
    match.onFinished = (summary) => {
      app.state = 'results';
      match.dispose();
      app.match = null;
      app.results.show(summary);
    };
    match.onQuit = () => {
      match.dispose();
      app.match = null;
      backToLobby();
    };
    app.match = match;
    app.loading.hide();
    app.state = 'match';
    match.start();
  } catch (err) {
    console.error(err);
    app.loading.showError(`Fout bij laden van de match: ${err.message}`, 'Terug naar de hangaar', () => {
      match?.dispose();
      app.loading.hide();
      backToLobby();
    });
  }
}

function backToLobby() {
  app.results.hide();
  app.lobby.show();
  app.state = 'lobby';
}

async function boot() {
  app.renderer = createRenderer(app.canvas);
  window.addEventListener('resize', onResize);
  app.assets = new AssetStore(app.renderer);
  app.loading = new LoadingScreen(app);
  app.loading.setHeading(CONFIG.game.phase, CONFIG.game.name, 'Hangaar wordt ingericht…');
  app.loading.show();
  try {
    const gltfs = await app.assets.loadTank((p) => app.loading.setProgress(p * 0.9, 'Tankmodellen laden'));
    app.tankFactory = new TankModelFactory(gltfs);
    app.loading.setProgress(0.95, 'Hangaar opbouwen');
    app.lobby = new Lobby(app);
    app.lobby.onStart = startMatch;
    app.results = new ResultsScreen(app);
    app.results.onBack = backToLobby;
    app.lobby.ensureHangar();
    // shaders vooraf compileren zodat het eerste beeld niet hapert (de lobby blijft zolang verborgen)
    await app.renderer.compileAsync(app.lobby.hangar.scene, app.lobby.hangar.camera);
    app.loading.setProgress(1, 'Klaar');
    app.loading.hide();
    app.lobby.show();
    app.state = 'lobby';
    app.renderer.setAnimationLoop(frame);
  } catch (err) {
    console.error(err);
    app.loading.showError(`Fout bij laden: ${err.message}`, 'Opnieuw proberen', () => window.location.reload());
  }
}

// voor testen en debuggen vanuit de console
window.__woudfront = app;

boot();
