// Mini-jeux avec les capteurs du téléphone.
// La détection est écrite en fonctions pures (testées), le branchement aux capteurs est à part.

export const GAMES = {
  secousse: { name: "Secousse", desc: "Secouer le téléphone le plus vite possible", unit: "secousses", options: [20, 30, 50], def: 30,
    hint: (n) => `Secouez le téléphone ${n} fois en moins de 20 secondes ! Tenez-le bien.` },
  niveau: { name: "Niveau à bulle", desc: "Garder le téléphone parfaitement à plat", unit: "secondes", options: [5, 8, 12], def: 8,
    hint: (n) => `Posez le téléphone à plat sur la main et gardez la bulle au centre pendant ${n} secondes. Le moindre tremblement remet le compteur à zéro !` },
  cri: { name: "Cri d'équipe", desc: "Crier assez fort, assez longtemps (micro)", unit: "secondes", options: [1, 2, 3], def: 2,
    hint: (n) => `Poussez votre cri d'équipe le plus fort possible : la jauge doit rester dans le vert pendant ${n} seconde${n > 1 ? "s" : ""} au total.` },
};
export const TIME_LIMIT_MS = 20000;

// Secousses : un pic d'accélération au-dessus du seuil, séparé du précédent d'au moins minGapMs.
export function createShakeDetector({ threshold = 14, minGapMs = 180 } = {}) {
  let count = 0, last = -Infinity, armed = true;
  return {
    push(mag, t) {
      // mag : norme de l'accélération sans la gravité (m/s²)
      if (armed && mag >= threshold && t - last >= minGapMs) { count++; last = t; armed = false; }
      else if (mag < threshold * 0.5) armed = true; // il faut redescendre avant le pic suivant
      return count;
    },
    get count() { return count; },
  };
}

// Niveau à bulle : inclinaison (avant/arrière et gauche/droite) sous maxTilt pendant holdMs d'affilée.
export function createLevelDetector({ maxTilt = 6, holdMs = 8000 } = {}) {
  let since = null, best = 0;
  return {
    push(beta, gamma, t) {
      const tilt = Math.hypot(beta || 0, gamma || 0);
      if (tilt <= maxTilt) { since ??= t; } else since = null;
      const held = since == null ? 0 : t - since;
      best = Math.max(best, held);
      return { tilt, held, progress: Math.min(1, held / holdMs), done: held >= holdMs };
    },
    get best() { return best; },
  };
}

// Cri : volume (RMS 0–1) au-dessus du seuil, cumulé jusqu'à holdMs.
export function createShoutDetector({ threshold = 0.2, holdMs = 2000 } = {}) {
  let total = 0, lastT = null;
  return {
    push(rms, t) {
      if (lastT != null && rms >= threshold) total += Math.min(t - lastT, 200);
      lastT = t;
      return { loud: rms >= threshold, total, progress: Math.min(1, total / holdMs), done: total >= holdMs };
    },
  };
}

// Volume RMS d'un échantillon audio (valeurs -1…1).
export function rms(samples) {
  let s = 0;
  for (const v of samples) s += v * v;
  return samples.length ? Math.sqrt(s / samples.length) : 0;
}

// ---------- Branchement aux capteurs ------------------------------------------------
export async function requestSensors(kind) {
  if (kind === "cri") {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Micro indisponible sur cet appareil");
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .catch(() => { throw new Error("Autorise le micro pour jouer à ce mini-jeu"); });
  }
  const Ev = kind === "secousse" ? globalThis.DeviceMotionEvent : globalThis.DeviceOrientationEvent;
  if (!Ev) throw new Error("Capteur indisponible sur cet appareil");
  if (typeof Ev.requestPermission === "function") {
    const r = await Ev.requestPermission().catch(() => "denied");
    if (r !== "granted") throw new Error("Autorise les capteurs de mouvement pour jouer");
  }
  return null;
}

// Lance un essai de mini-jeu. onTick({value, progress, extra}) à chaque mesure.
// L'essai s'arrête à l'objectif atteint, au temps limite ou par .end() sur la fonction renvoyée ;
// onDone({ ok, score }) reçoit alors le résultat (secousses, ou secondes tenues).
export function runGame(kind, target, { stream, onTick, onDone }) {
  let stopped = false, score = 0;
  const finish = (ok) => { if (!stopped) { stop(); onDone({ ok, score: Math.min(score, target) }); } };
  let stop = () => {};

  if (kind === "secousse") {
    const det = createShakeDetector();
    const h = (e) => {
      const a = e.acceleration && e.acceleration.x != null ? e.acceleration : null;
      let mag;
      if (a) mag = Math.hypot(a.x, a.y, a.z);
      else { const g = e.accelerationIncludingGravity || {}; mag = Math.abs(Math.hypot(g.x || 0, g.y || 0, g.z || 0) - 9.81); }
      const n = det.push(mag, e.timeStamp || performance.now());
      score = n;
      onTick({ value: n, progress: Math.min(1, n / target) });
      if (n >= target) finish(true);
    };
    window.addEventListener("devicemotion", h);
    stop = () => { stopped = true; window.removeEventListener("devicemotion", h); clearTimeout(timer); };
  } else if (kind === "niveau") {
    const det = createLevelDetector({ holdMs: target * 1000 });
    const h = (e) => {
      const r = det.push(e.beta, e.gamma, performance.now());
      score = det.best / 1000;
      onTick({ value: r.held / 1000, progress: r.progress, extra: { beta: e.beta || 0, gamma: e.gamma || 0 } });
      if (r.done) finish(true);
    };
    window.addEventListener("deviceorientation", h);
    stop = () => { stopped = true; window.removeEventListener("deviceorientation", h); clearTimeout(timer); };
  } else if (kind === "cri") {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const det = createShoutDetector({ holdMs: target * 1000 });
    let raf;
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      const level = rms(buf);
      const r = det.push(level, performance.now());
      score = r.total / 1000;
      onTick({ value: r.total / 1000, progress: r.progress, extra: { level, loud: r.loud } });
      if (r.done) finish(true); else raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    stop = () => { stopped = true; cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); clearTimeout(timer); };
  }
  // Le niveau à bulle laisse plus de temps : il faut surtout réussir à tenir.
  const timer = setTimeout(() => finish(false), kind === "niveau" ? 60000 : TIME_LIMIT_MS);
  // Appel simple : annule sans résultat (on quitte l'écran). .end() : termine l'essai et le compte.
  const cancel = () => stop();
  cancel.end = () => finish(false);
  return cancel;
}
