// Voorkeuren van de speler die tussen sessies bewaard blijven (nu: de gekozen skin).
// In fase 2 gaat de skin mee in de spelerslijst naar de server, zodat anderen hem ook zien.
import { CONFIG } from '../config.js';

const SKIN_KEY = 'woudfront.skin';

export function loadProfile() {
  let skin = CONFIG.player.skin;
  try {
    const saved = localStorage.getItem(SKIN_KEY);
    if (saved && CONFIG.skins.some((s) => s.id === saved)) skin = saved;
  } catch {
    // opslag niet beschikbaar: standaardskin
  }
  return { skin };
}

export function saveSkin(profile, skinId) {
  profile.skin = skinId;
  try {
    localStorage.setItem(SKIN_KEY, skinId);
  } catch {
    // opslag niet beschikbaar: alleen voor deze sessie
  }
}
