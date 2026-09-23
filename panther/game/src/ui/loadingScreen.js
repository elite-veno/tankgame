// Laadscherm met voortgangsbalk, huidige stap en wisselende tips.
import { CONFIG } from '../config.js';

const TIPS = [
  'Rijd een veroveringspunt in om het in te nemen. Met meer tanks in het punt gaat het sneller.',
  'Staan beide teams in hetzelfde punt, dan ligt de verovering stil tot één team overblijft.',
  'Het team met minder punten verliest voortdurend tickets. Houd minstens twee van de drie punten vast!',
  `Elke vernietigde tank kost zijn team ${CONFIG.match.ticketsPerDestroyedTank} tickets.`,
  `Schiet op de zij- of achterkant: achterpantser neemt ${Math.round((CONFIG.tank.armorMultiplier.rear - 1) * 100)}% meer schade dan de zijkant.`,
  'De cirkel toont waar je loop écht op richt. Vuur pas als hij op je vizier staat.',
  'Houd de rechtermuisknop ingedrukt om in te zoomen voor precieze schoten op afstand.',
  'De loop compenseert zelf voor de valboog van de granaat: richt je vizier gewoon op het doel.',
  'Boomstammen en rotsen stoppen granaten. Gebruik ze als dekking.',
  `Na vernietiging keer je na ${CONFIG.match.respawnTime} seconden terug bij je teambasis.`,
  'Achteruitrijden gaat traag. Denk vooruit en keer op tijd om.',
  'Druk op TAB voor het scorebord en op ESC voor het menu.',
];

export class LoadingScreen {
  constructor(app) {
    this.el = document.createElement('div');
    this.el.className = 'screen loading hidden';
    this.el.innerHTML = `
      <div class="bg" style="background-image:url('./assets/loading_bg.jpg')"></div>
      <div class="shade"></div>
      <div class="content">
        <div class="mode-line">Verovering · Singleplayer</div>
        <div class="map-name">Dennenwoud</div>
        <div class="map-desc">Drie veroveringspunten verscholen tussen de grove dennen. Beheers het bos, breek hun tickets.</div>
        <div class="bar-wrap"><div class="bar"><i></i></div><div class="pct">0%</div></div>
        <div class="step">Voorbereiden</div>
        <div class="tip"><b>TIP</b><span></span></div>
        <button class="menu-btn primary error-btn hidden"></button>
      </div>`;
    app.uiRoot.appendChild(this.el);
    this.barEl = this.el.querySelector('.bar i');
    this.pctEl = this.el.querySelector('.pct');
    this.stepEl = this.el.querySelector('.step');
    this.tipEl = this.el.querySelector('.tip');
    this.tipText = this.el.querySelector('.tip span');
    this.errorBtn = this.el.querySelector('.error-btn');
    this.errorAction = null;
    this.failed = false;
    this.errorBtn.addEventListener('click', () => this.errorAction?.());
    this.tipIndex = Math.floor(Math.random() * TIPS.length);
    this.timer = null;
  }

  setHeading(modeLine, title, desc) {
    this.el.querySelector('.mode-line').textContent = modeLine;
    this.el.querySelector('.map-name').textContent = title;
    this.el.querySelector('.map-desc').textContent = desc;
  }

  show() {
    this.el.classList.remove('hidden');
    // achtergrondanimatie opnieuw starten
    const bg = this.el.querySelector('.bg');
    bg.style.animation = 'none';
    void bg.offsetWidth;
    bg.style.animation = '';
    this.failed = false;
    this.stepEl.classList.remove('error');
    this.errorBtn.classList.add('hidden');
    this.tipEl.classList.remove('hidden');
    this.setProgress(0, 'Voorbereiden');
    this.nextTip();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.nextTip(), 5200);
  }

  hide() {
    this.el.classList.add('hidden');
    clearInterval(this.timer);
  }

  // Laden mislukt: melding tonen met één knop om verder te kunnen (opnieuw proberen / terug).
  showError(message, buttonLabel, action) {
    this.failed = true;
    clearInterval(this.timer);
    this.stepEl.textContent = message;
    this.stepEl.classList.add('error');
    this.tipEl.classList.add('hidden');
    this.errorBtn.textContent = buttonLabel;
    this.errorBtn.classList.remove('hidden');
    this.errorAction = action;
  }

  nextTip() {
    this.tipIndex = (this.tipIndex + 1) % TIPS.length;
    this.tipEl.style.opacity = 0;
    setTimeout(() => {
      this.tipText.textContent = TIPS[this.tipIndex];
      this.tipEl.style.opacity = 1;
    }, 250);
  }

  setProgress(p, label) {
    // na een fout kunnen nog lopende laadtaken voortgang melden; de foutmelding blijft staan
    if (this.failed) return;
    const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
    this.barEl.style.width = `${pct}%`;
    this.pctEl.textContent = `${pct}%`;
    if (label) this.stepEl.textContent = label;
  }
}
