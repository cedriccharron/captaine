// Cap'taine — application principale (navigation, écrans, jeu).
import { CONFIG } from "./config.js";
import { createDemoStore } from "./store-demo.js";
import { icon } from "./icons.js";
import { esc, uuid, fmtNum, plural, fmtDistance, fmtDuration, fmtDateTime, initials, toast, confirmDialog, prepareMedia } from "./util.js";
import { GAMES, requestSensors, runGame } from "./minigames.js";
import {
  distance, bearing, offset, warmth, WARMTH_LABEL, cardinal,
  watchPosition, currentPosition, compassNeedsPermission, requestCompass, watchHeading, keepAwake,
} from "./geo.js";
import {
  CHALLENGES, CHALLENGE_LONG, needsJudge, NAVS, LEVELS, HINT_COST, parseAnswers, stepPoints, currentStepId,
  lockRemaining, registerAnswer, validateStep, teamPlay, teamScore, ranking, pendingCount,
} from "./game.js";
import { THEMES, theme, applyTheme, TEAM_COLORS } from "./themes.js";

const VERSION = "0.4.0 (jalon 3)";
const $ = (s, root = document) => root.querySelector(s);
const POS_EVERY_MS = 30000;      // envoi de la position du capitaine
const STALE_MS = 2 * 60000;      // au-delà : « hors réseau »

const S = {
  store: null,
  data: null,
  draft: null,      // brouillon d'étape en cours d'édition
  startForm: null,  // brouillon du formulaire de lancement
  flash: null,      // message de réussite affiché au-dessus de l'étape suivante
  media: null,      // photo ou vidéo prise, pas encore envoyée
  minigame: null,   // mini-jeu en cours {stepId, stop, failed}
  album: null,      // album ouvert {gameId, index}
  join: null,       // résultat de la recherche par code
  relay: null,      // code « Passer le relais » affiché
  live: { gameId: null, unsub: null },
  pendingRender: false,
  sense: { pos: null, heading: null, prevDist: null, warm: null, err: null, stopGeo: null, stopHead: null, wake: null, key: null, compassOn: false, lastPush: 0 },
};

// ---------- Accès aux données --------------------------------------------
const me = () => S.store.me();
const course = (id) => S.data.courses.find((c) => c.id === id);
const gameById = (id) => S.data.games.find((g) => g.id === id);
const stepOf = (g, id) => g.course.steps.find((s) => s.id === id);
const myTeam = (g) => g?.teams.find((t) => t.captain === me());
const isOwner = (g) => g?.owner === me();
const W = (themeId) => theme(themeId).words;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// Article défini devant un mot féminin des thèmes : « la balise », « l'escale ».
const la = (s) => (/^[aeiouyéèêh]/i.test(s) ? "l'" : "la ") + s;
// Dans un aperçu intégré (iframe), le navigateur bloque GPS, boussole et mode hors ligne.
const inFrame = () => { try { return window.self !== window.top; } catch { return true; } };
const joinUrl = (code, relay) => `${location.origin}${location.pathname}#/join/${code}${relay ? `?relay=${relay}` : ""}`;

async function persistCourse(c) { await S.store.saveCourse(c); }

function upsertGame(g) {
  const i = S.data.games.findIndex((x) => x.id === g.id);
  if (i >= 0) S.data.games[i] = g; else S.data.games.unshift(g);
  return g;
}
async function refreshGame(id) {
  try { return upsertGame(await S.store.getGame(id)); }
  catch (e) { toast(e.message, "error"); return gameById(id); }
}

// Redessine, sauf si l'utilisateur est en train d'écrire (on attend qu'il ait fini).
function softRender() {
  const a = document.activeElement;
  if (a && a.closest?.("#main") && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) { S.pendingRender = true; return; }
  render();
}
document.addEventListener("focusout", () => { if (S.pendingRender) setTimeout(() => { if (S.pendingRender) { S.pendingRender = false; softRender(); } }, 50); });

// ---------- Démarrage ------------------------------------------------------
async function boot() {
  const forceDemo = new URLSearchParams(location.search).has("demo");
  if (!forceDemo && CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && !inFrame()) {
    try {
      const { createSupabaseStore } = await import("./store-supabase.js");
      S.store = await createSupabaseStore();
      await S.store.init();
    } catch (e) {
      $("#main").innerHTML = `<div class="empty"><p>Impossible de joindre le serveur.</p><p class="muted small">${esc(e.message)}</p>
        <button class="btn primary" onclick="location.reload()">Réessayer</button></div>`;
      return;
    }
  } else {
    S.store = createDemoStore();
    await S.store.init();
  }
  document.body.classList.toggle("demo", S.store.mode === "demo");
  S.data = await S.store.loadAll();
  render();
}

// ---------- Navigation ---------------------------------------------------
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  return { parts: path.split("/").filter(Boolean), query: new URLSearchParams(qs || "") };
}
const go = (path) => { location.hash = path; };
window.addEventListener("hashchange", () => {
  S.pendingRender = false;
  if (S.minigame?.stop) { S.minigame.stop(); S.minigame = null; }
  render(); window.scrollTo(0, 0);
});

function render() {
  const main = $("#main");
  const nav = $("#nav");
  if (!S.data) return;
  const { parts, query } = route();
  const [a, b, c, d] = parts;
  let html;
  let tab = null;
  let playGame = null;
  let liveGame = null;
  try {
    if (!a) { html = viewCourses(); tab = "courses"; applyTheme("explo"); }
    else if (a === "games") { html = viewGames(); tab = "games"; applyTheme("explo"); }
    else if (a === "more") { html = viewMore(); tab = "more"; applyTheme("explo"); }
    else if (a === "join") { html = viewJoin(b, query); applyTheme(S.join?.theme || "explo"); }
    else if (a === "c" && !S.store.isAdmin()) html = adminOnly();
    else if (a === "c" && b && c === "theme") html = viewTheme(b);
    else if (a === "c" && b && c === "start") html = viewStart(b);
    else if (a === "c" && b && c === "s" && d) html = viewStepForm(b, d);
    else if (a === "c" && b) html = viewCourse(b);
    else if (a === "g" && b) {
      const g = gameById(b);
      if (!g) { html = `<div class="loading">Chargement de la partie…</div>`; refreshGame(b).then((x) => x && render()); }
      else {
        liveGame = g;
        const mode = c || defaultMode(g);
        if (mode === "end" || g.status === "finished") html = viewEnd(g);
        else if (mode === "relay") html = viewRelay(g);
        else if (mode === "play") { html = viewPlayOrWait(g); if (g.status === "running" && myTeam(g) && !myTeam(g).finished_at) playGame = g; }
        else if (mode === "live" && isOwner(g)) html = g.status === "lobby" ? viewLobby(g) : viewLive(g);
        else html = notFound();
      }
    }
    else html = notFound();
  } catch (e) {
    console.error(e);
    html = `<div class="empty"><p>Oups, cet écran a rencontré un problème.</p><p class="muted small">${esc(e.message)}</p><a class="btn primary" href="#/">Retour à l'accueil</a></div>`;
  }
  main.innerHTML = demoBar() + html;
  nav.hidden = !tab;
  for (const el of nav.querySelectorAll("a")) el.classList.toggle("active", el.dataset.tab === tab);
  const home = nav.querySelector('[data-tab="courses"] span');
  if (home) home.textContent = S.store.isAdmin() ? "Parcours" : "Accueil";
  syncLive(liveGame);
  syncSensors(playGame);
  if (playGame) updateLive();
  hydrateMedia();
  drawQr();
}

// Écran par défaut d'une partie : jouer si je suis capitaine (et pas organisateur d'une partie à plusieurs).
function defaultMode(g) {
  if (myTeam(g) && (!isOwner(g) || g.settings?.solo)) return "play";
  if (isOwner(g)) return "live";
  return "play";
}

function demoBar() {
  if (S.store.mode !== "demo" || !S.store.isAlias()) return "";
  return `<div class="alias-bar">${icon("walk", 16)} <span class="grow">Téléphone simulé d'un capitaine</span>
    <button class="btn small ghost" data-action="demo-home">Revenir à l'organisateur</button></div>`;
}

function adminOnly() {
  return `<div class="empty"><p>La création de parcours est réservée aux administrateurs.</p>
    <a class="btn primary" href="#/more">Connexion administrateur</a><a class="btn ghost" href="#/">Retour</a></div>`;
}

function notFound() {
  return `<div class="empty"><p>Cette page n'existe pas.</p><a class="btn primary" href="#/">Retour à l'accueil</a></div>`;
}

function top({ title, sub = "", back = null, actions = "" }) {
  return `<header class="top">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Retour">${icon("back", 22)}</a>` : ""}
    <div class="top-title"><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div>
    <div class="top-actions">${actions}</div></header>`;
}

// Abonnement temps réel à la partie affichée.
function syncLive(g) {
  const id = g?.id || null;
  if (S.live.gameId === id) return;
  S.live.unsub?.();
  S.live = { gameId: id, unsub: null };
  if (!id) return;
  S.live.unsub = S.store.subscribe(id, async () => {
    const before = signature(gameById(id));
    const fresh = await refreshGame(id);
    if (signature(fresh) !== before) softRender();
  });
}
const signature = (g) => g ? JSON.stringify([g.status, g.teams.map((t) => [t.captain, t.captain_name, t.judgments, t.progress, t.finished_at, isOwner(g) ? t.last_pos : null]), g.messages?.length]) : "";

// ---------- Parcours : liste ------------------------------------------------
function courseLength(c) {
  let m = 0;
  for (let i = 1; i < c.steps.length; i++) m += distance(c.steps[i - 1], c.steps[i]);
  return m;
}

function viewCourses() {
  const list = S.data.courses;
  if (!S.store.isAdmin()) return viewPlayerHome();
  return `${top({ title: "Mes parcours", sub: "Crée un jeu de piste, puis lance une partie", actions: `<a class="btn small primary" href="#/join">Rejoindre</a>` })}
    ${list.length ? list.map((c) => {
      const t = theme(c.theme);
      const ok = c.steps.length > 0 && c.steps.every((s) => !validateStep(s).length);
      return `<article class="card course">
        <a class="course-hero" href="#/c/${c.id}" style="background:${t.hero};color:${t.heroInk}">
          <span class="badge ${ok ? "ready" : ""}">${ok ? "Prêt à jouer" : "Brouillon"}</span>
          <strong>${esc(c.name)}</strong>
          <span class="small">${t.name} · ${plural(c.steps.length, W(c.theme).step, W(c.theme).steps)} · ${fmtDistance(courseLength(c))}</span>
        </a>
        <div class="card-actions">
          <a class="btn ghost" href="#/c/${c.id}">${icon("edit", 18)} Modifier</a>
          ${ok ? `<a class="btn primary" href="#/c/${c.id}/start">${icon("play", 18)} Jouer</a>` : `<span class="btn ghost disabled" aria-disabled="true">Pas encore jouable</span>`}
        </div></article>`;
    }).join("") : `<div class="empty"><p>Aucun parcours pour l'instant.</p></div>`}
    <button class="fab" data-action="new-course" aria-label="Créer un parcours">${icon("plus", 26)}</button>
    <p class="center small muted pad">Astuce : place tes étapes depuis chez toi avec « Sur la carte », ou sur le terrain avec « Ma position ».</p>`;
}

// Accueil des joueurs (pas administrateurs) : rejoindre une partie avec son code.
function viewPlayerHome() {
  return `${top({ title: "Cap'taine", sub: "Jeu de piste GPS en équipes" })}
    <section class="panel center">
      <h2>Rejoindre une partie</h2>
      <p class="small muted">Demande le code de la partie à l'organisateur, ou scanne son QR code.</p>
      <a class="btn primary big block" href="#/join">Entrer le code</a>
    </section>
    <p class="center small muted pad">Tu organises le jeu ? <a href="#/more">Connexion administrateur</a></p>`;
}

// ---------- Parcours : éditeur ---------------------------------------------
function viewCourse(id) {
  const c = course(id);
  if (!c) return notFound();
  applyTheme(c.theme);
  const t = theme(c.theme);
  const w = t.words;
  const errorsCount = c.steps.filter((s) => validateStep(s).length).length;
  return `${top({ title: c.name, sub: `${t.name} · ${plural(c.steps.length, w.step, w.steps)}`, back: "#/",
      actions: `<button class="icon-btn" data-action="delete-course" data-id="${c.id}" aria-label="Supprimer le parcours">${icon("trash")}</button>` })}
    <section class="panel">
      <label class="field"><span>Nom du parcours</span>
        <input value="${esc(c.name)}" maxlength="60" data-course-name="${c.id}"></label>
      <a class="row-link" href="#/c/${c.id}/theme"><span class="swatch" style="background:${t.hero}"></span>
        <span class="grow"><strong>Thème : ${t.name}</strong><br><span class="small muted">${esc(t.desc)}</span></span>${icon("palette")}</a>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>${cap(w.steps)}</h2><span class="small muted">${fmtDistance(courseLength(c))} à pied</span></div>
      ${c.steps.length ? `<ol class="steps">${c.steps.map((s, i) => {
        const errs = validateStep(s);
        return `<li class="step-row">
          <a class="step-main" href="#/c/${c.id}/s/${s.id}">
            <span class="num ${s.final ? "final" : ""}">${s.final ? icon("trophy", 16) : i + 1}</span>
            <span class="grow"><strong>${esc(s.title || "Sans nom")}</strong><br>
              <span class="small ${errs.length ? "warn" : "muted"}">${errs.length ? esc(errs[0]) : `${CHALLENGES[s.challenge]} · ${NAVS[s.nav]} · ${s.points} pts`}</span></span></a>
          <span class="reorder">
            <button class="icon-btn" data-action="step-up" data-c="${c.id}" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Monter">${icon("up", 18)}</button>
            <button class="icon-btn" data-action="step-down" data-c="${c.id}" data-i="${i}" ${i === c.steps.length - 1 ? "disabled" : ""} aria-label="Descendre">${icon("down", 18)}</button>
          </span></li>`;
      }).join("")}</ol>` : `<p class="muted">Aucune ${w.step} : ajoute la première.</p>`}
      <a class="btn ghost block" href="#/c/${c.id}/s/new">${icon("plus", 18)} Ajouter une ${w.step}</a>
      <p class="small muted foot">L'ordre compte : l'indice d'une ${w.step} doit mener à la suivante. Avec plusieurs équipes (jalon 2), chacune commencera à une ${w.step} différente et fera la boucle.</p>
    </section>
    <div class="form-actions sticky">
      ${errorsCount || !c.steps.length
        ? `<span class="btn primary disabled block" aria-disabled="true">${c.steps.length ? `${plural(errorsCount, `${w.step} à compléter`, `${w.steps} à compléter`)}` : `Ajoute une ${w.step} pour jouer`}</span>`
        : `<a class="btn primary block" href="#/c/${c.id}/start">${icon("play", 18)} Lancer une partie</a>`}
    </div>`;
}

// ---------- Thème -------------------------------------------------------------
function viewTheme(id) {
  const c = course(id);
  if (!c) return notFound();
  const t = theme(c.theme);
  applyTheme(c.theme);
  return `${top({ title: "Thème du parcours", back: `#/c/${c.id}` })}
    <section class="hero-card" style="background:${t.hero};color:${t.heroInk}">
      <span class="small">Aperçu côté joueurs</span>
      <strong class="hero-title">${esc(c.name)}</strong>
      <span>${esc(t.intro)}</span>
      <span class="chips-row"><span class="tchip">${t.words.teams}</span><span class="tchip">${cap(t.words.steps)}</span><span class="tchip">${cap(t.words.reward)}</span></span>
    </section>
    <div class="theme-grid">
      ${Object.entries(THEMES).map(([k, th]) => `<button class="theme-opt ${k === c.theme ? "on" : ""}" data-action="set-theme" data-c="${c.id}" data-v="${k}" aria-pressed="${k === c.theme}">
        <span class="swatch wide" style="background:${th.hero}"></span><strong>${th.name}</strong><span class="small muted">${th.desc}</span></button>`).join("")}
    </div>
    <p class="pad small muted">Le thème change les couleurs, le vocabulaire et les noms d'équipes proposés. Tes énigmes ne changent pas.</p>`;
}

// ---------- Étape : formulaire --------------------------------------------------
function newStep(c) {
  const d = c.defaults || {};
  return { id: uuid(), title: "", lat: null, lng: null, accuracy: null, radius: d.radius || 25, nav: d.nav || "boussole",
    clue: "", challenge: "enigme", question: "", kidQuestion: "", answers: [], hint: "", points: 50, needOnSite: true, final: false };
}

function viewStepForm(cid, sid) {
  const c = course(cid);
  if (!c) return notFound();
  applyTheme(c.theme);
  const w = W(c.theme);
  const key = `${cid}/${sid}`;
  if (S.draft?.key !== key) {
    const existing = c.steps.find((s) => s.id === sid);
    if (sid !== "new" && !existing) return notFound();
    S.draft = { key, isNew: sid === "new", step: existing ? structuredClone(existing) : newStep(c), answersText: (existing?.answers || []).join("\n"), errors: [] };
  }
  const s = S.draft.step;
  const seg = (field, opts, cls = "") => `<div class="seg ${cls}">${Object.entries(opts).map(([k, v]) =>
    `<button type="button" class="${s[field] === k ? "on" : ""}" data-action="draft-set" data-f="${field}" data-v="${k}" aria-pressed="${s[field] === k}">${v}</button>`).join("")}</div>`;
  const placed = Number.isFinite(s.lat);
  return `${top({ title: S.draft.isNew ? `Nouvelle ${w.step}` : (s.title || cap(w.step)), back: `#/c/${cid}`,
      actions: S.draft.isNew ? "" : `<button class="icon-btn" data-action="delete-step" aria-label="Supprimer">${icon("trash")}</button>` })}
    ${S.draft.errors.length ? `<div class="alert">${S.draft.errors.map(esc).join("<br>")}</div>` : ""}
    <section class="panel">
      <label class="field"><span>Nom</span><input data-f="title" value="${esc(s.title)}" maxlength="50" placeholder="Ex. La vieille fontaine"></label>
      <div class="place ${placed ? "ok" : ""}">
        <span class="grow">${placed
          ? `<strong>${icon("pin", 16)} Étape placée</strong><br><span class="small muted">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}${s.accuracy ? ` · précision ± ${Math.round(s.accuracy)} m` : ""}</span>`
          : `<strong>Pas encore placée</strong><br><span class="small muted">Choisis le lieu sur la carte, ou rends-toi sur place et appuie sur « Ma position ».</span>`}</span>
        <span class="place-btns">
          <button type="button" class="btn small primary" data-action="draft-map">${icon("pin", 16)} Sur la carte</button>
          <button type="button" class="btn small ghost" data-action="draft-locate">${icon("target", 16)} Ma position</button>
        </span>
      </div>
      <label class="field"><span>Zone d'arrivée</span>
        <select data-f="radius" data-num>${[10, 15, 25, 40, 60, 100].map((r) => `<option value="${r}" ${s.radius === r ? "selected" : ""}>rayon ${r} m</option>`).join("")}</select></label>
    </section>

    <section class="panel">
      <h2>Pour trouver ${la(w.step)}</h2>
      ${seg("nav", NAVS)}
      <p class="small muted">${s.nav === "boussole" ? "Une flèche et la distance guident l'équipe." : s.nav === "radar" ? "Un radar montre le point autour de l'équipe." : "Rien que ton indice : à l'équipe de deviner où aller."}</p>
      <label class="field"><span>Indice de navigation ${s.nav === "indice" ? "" : "(facultatif)"}</span>
        <textarea data-f="clue" rows="2" maxlength="300" placeholder="Ex. Cherchez l'eau qui ne s'arrête jamais de couler.">${esc(s.clue)}</textarea></label>
    </section>

    <section class="panel">
      <h2>Sur place</h2>
      ${seg("challenge", CHALLENGES, "wrap")}
      ${s.challenge === "enigme" ? `
        <label class="field"><span>Énigme</span><textarea data-f="question" rows="3" maxlength="500">${esc(s.question)}</textarea></label>
        <label class="field"><span>Version enfant (facultatif)</span><textarea data-f="kidQuestion" rows="2" maxlength="400" placeholder="Une version plus simple pour les plus jeunes">${esc(s.kidQuestion)}</textarea></label>
        <label class="field"><span>Réponses acceptées (une par ligne)</span><textarea data-f="answersText" rows="2" maxlength="300" placeholder="1874">${esc(S.draft.answersText)}</textarea>
          <span class="hint">Majuscules, accents et espaces sont ignorés.</span></label>
        <label class="field"><span>Indice d'énigme (coûte ${HINT_COST} pts)</span><input data-f="hint" value="${esc(s.hint)}" maxlength="200"></label>
        <label class="check"><input type="checkbox" data-f="needOnSite" ${s.needOnSite ? "checked" : ""}> Réponse acceptée seulement sur place</label>`
      : needsJudge(s) ? `
        <label class="field"><span>Consigne du défi ${s.challenge === "video" ? "vidéo" : "photo"}</span><textarea data-f="question" rows="3" maxlength="400" placeholder="${s.challenge === "video" ? "Ex. Chantez le refrain de votre chanson d'équipe devant la fontaine" : "Ex. Une pyramide humaine devant la roue du moulin"}">${esc(s.question)}</textarea></label>
        <p class="small muted">Les points restent « en attente » jusqu'à ta validation.${s.challenge === "video" ? " Vidéo courte conseillée (15 secondes) : au-delà de 48 Mo, elle est refusée." : ""}</p>`
      : s.challenge === "jeu" ? `
        <div class="seg wrap">${Object.entries(GAMES).map(([k, gm]) => `<button type="button" class="${s.game?.kind === k ? "on" : ""}" data-action="draft-game" data-v="${k}" aria-pressed="${s.game?.kind === k}">${gm.name}</button>`).join("")}</div>
        ${s.game?.kind ? `<p class="small muted">${esc(GAMES[s.game.kind].desc)}.</p>
          <label class="field"><span>Objectif</span><select data-game-target>${GAMES[s.game.kind].options.map((n) => `<option value="${n}" ${s.game.target === n ? "selected" : ""}>${n} ${GAMES[s.game.kind].unit}</option>`).join("")}</select></label>
          <label class="field"><span>Consigne (facultatif)</span><textarea data-f="question" rows="2" maxlength="300" placeholder="${esc(GAMES[s.game.kind].hint(s.game.target))}">${esc(s.question)}</textarea></label>
          ${s.game.kind === "cri" ? `<p class="small muted">Le capitaine devra autoriser le micro. Rien n'est enregistré : seul le volume est mesuré.</p>` : ""}` : `<p class="small muted">Choisis un mini-jeu.</p>`}`
      : `<label class="field"><span>Message à l'arrivée (facultatif)</span><textarea data-f="question" rows="2" maxlength="300">${esc(s.question)}</textarea></label>`}
      <label class="field"><span>Points</span><select data-f="points" data-num>${[20, 30, 50, 80, 100].map((p) => `<option value="${p}" ${s.points === p ? "selected" : ""}>${p} points</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" data-f="final" ${s.final ? "checked" : ""}> ${cap(w.step)} finale (toujours jouée en dernier)</label>
    </section>
    <div class="form-actions sticky"><a class="btn ghost" href="#/c/${cid}">Annuler</a><button class="btn primary" data-action="draft-save">Enregistrer</button></div>`;
}

// ---------- Lancement d'une partie -------------------------------------------------
const DURATIONS = { 0: "Sans limite", 60: "1 h", 90: "1 h 30", 120: "2 h", 150: "2 h 30", 180: "3 h" };

function viewStart(cid) {
  const c = course(cid);
  if (!c) return notFound();
  applyTheme(c.theme);
  const t = theme(c.theme);
  const framed = inFrame();
  if (S.startForm?.cid !== cid) {
    S.startForm = { cid, count: 1, solo: true, mode: framed ? "sim" : "real", maxMin: 0,
      teams: t.teamNames.map((name, i) => ({ name, level: "ado", color: TEAM_COLORS[i] })) };
  }
  const f = S.startForm;
  const loopSize = c.steps.filter((s) => !s.final).length;
  return `${top({ title: "Nouvelle partie", sub: esc(c.name), back: `#/c/${cid}` })}
    <section class="hero-card" style="background:${t.hero};color:${t.heroInk}">
      <strong class="hero-title">${esc(c.name)}</strong><span>${esc(t.intro)}</span>
      <span class="small">${plural(c.steps.length, t.words.step, t.words.steps)} · ${fmtDistance(courseLength(c))}</span>
    </section>
    <form id="start-form" data-c="${cid}">
      <section class="panel">
        <h2>${t.words.teams}</h2>
        <div class="seg">${[1, 2, 3, 4, 5, 6].map((n) => `<button type="button" class="${f.count === n ? "on" : ""}" data-action="start-count" data-v="${n}" aria-pressed="${f.count === n}">${n}</button>`).join("")}</div>
        ${f.teams.slice(0, f.count).map((tm, i) => `<div class="team-line">
          <span class="team-dot small-dot" style="background:${tm.color}">${esc(initials(tm.name))}</span>
          <input aria-label="Nom de l'équipe ${i + 1}" data-team-name="${i}" value="${esc(tm.name)}" maxlength="30">
          <select aria-label="Niveau de l'équipe ${i + 1}" data-team-level="${i}">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${tm.level === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        </div>`).join("")}
        ${f.count === 1
          ? `<label class="check"><input type="checkbox" data-start-solo ${f.solo ? "checked" : ""}> Je joue cette ${t.words.team.toLowerCase()} sur ce téléphone</label>`
          : `<p class="small muted">Chaque capitaine rejoindra avec le code de la partie, sur son propre téléphone.${f.count > loopSize ? ` Attention : plus d'équipes (${f.count}) que de ${t.words.steps} dans la boucle (${loopSize}), certaines partiront du même endroit.` : ""}</p>`}
      </section>
      <section class="panel">
        <fieldset class="field"><legend>Où jouez-vous ?</legend>
          <label class="radio-card ${framed ? "off" : ""}"><input type="radio" name="mode" value="real" ${framed ? "disabled" : f.mode === "real" ? "checked" : ""}><span><strong>Sur le terrain</strong><br><span class="small muted">${framed ? "Indisponible dans cet aperçu : le GPS y est bloqué. Ouvre l'app depuis son adresse GitHub Pages." : "GPS réel : l'écran des capitaines reste allumé."}</span></span></label>
          <label class="radio-card"><input type="radio" name="mode" value="sim" ${f.mode === "sim" ? "checked" : ""}><span><strong>Simulation</strong><br><span class="small muted">Pour tester chez soi : des boutons font avancer les équipes.</span></span></label>
        </fieldset>
        <label class="field"><span>Durée maximale</span><select data-start-max>${Object.entries(DURATIONS).map(([k, v]) => `<option value="${k}" ${f.maxMin === Number(k) ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      </section>
      <div class="form-actions sticky"><button class="btn primary block" type="submit">${icon("play", 18)} ${f.count === 1 && f.solo ? "C'est parti, cap'taine !" : "Ouvrir la salle d'attente"}</button></div>
    </form>`;
}

async function startGame(form) {
  const c = course(form.dataset.c);
  const f = S.startForm;
  f.mode = new FormData(form).get("mode") || f.mode;
  const teams = f.teams.slice(0, f.count).map((t) => ({ ...t, name: t.name.trim() || "Équipe" }));
  const solo = f.count === 1 && f.solo;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    let g = await S.store.createGame({ course: c, teams, settings: { sim: f.mode === "sim", maxMin: f.maxMin, solo } });
    if (solo) {
      await S.store.claimTeam(g.teams[0].id, "Organisateur");
      await S.store.setStatus(g.id, "running");
      g = await S.store.getGame(g.id);
      if (f.mode !== "sim") S.sense.wake = await keepAwake();
    }
    upsertGame(g);
    S.startForm = null;
    go(`/g/${g.id}`);
  } catch (e) { toast(e.message, "error"); btn.disabled = false; }
}

// ---------- Salle d'attente (organisateur) ---------------------------------------------
function viewLobby(g) {
  applyTheme(g.course.theme);
  const t = theme(g.course.theme);
  const taken = g.teams.filter((x) => x.captain).length;
  return `${top({ title: "Salle d'attente", sub: esc(g.course.name), back: "#/games" })}
    <section class="code-card" style="background:${t.hero};color:${t.heroInk}">
      <div class="qr" data-qr="${esc(joinUrl(g.code))}" role="img" aria-label="QR code pour rejoindre la partie"></div>
      <div class="code-side">
        <span class="small">Code de la partie</span>
        <strong class="code">${esc(g.code)}</strong>
        <button class="btn small light-btn" data-action="share-code" data-code="${esc(g.code)}">${icon("share", 16)} Envoyer le lien</button>
      </div>
    </section>
    <p class="pad small muted">Les capitaines scannent le QR code (ou ouvrent Cap'taine › Rejoindre et tapent le code), puis choisissent leur ${t.words.team.toLowerCase()}.</p>
    <section class="panel">
      <div class="panel-head"><h2>${t.words.teams}</h2><span class="small muted">${taken} / ${g.teams.length} prêtes</span></div>
      ${g.teams.map((x) => `<div class="team-row">
        <span class="team-dot" style="background:${x.color}">${esc(initials(x.name))}</span>
        <span class="grow"><strong>${esc(x.name)}</strong><br><span class="small muted">${x.captain ? `Capitaine : ${esc(x.captain_name || "?")}` : "En attente d'un capitaine…"}</span></span>
        ${x.captain ? `<button class="btn small ghost" data-action="release" data-t="${x.id}" data-g="${g.id}">Libérer</button>` : `<span class="small warn">Libre</span>`}
      </div>`).join("")}
      ${S.store.mode === "demo" ? `<button class="btn ghost block" data-action="demo-phone" data-code="${g.code}">${icon("walk", 18)} Simuler le téléphone d'un capitaine</button>` : ""}
    </section>
    <section class="panel">
      <div class="row-between small"><span>Mode</span><strong>${g.settings.sim ? "Simulation" : "Sur le terrain"}</strong></div>
      <div class="row-between small"><span>Ordre des ${t.words.steps}</span><strong>Décalé par ${t.words.team.toLowerCase()}</strong></div>
      <div class="row-between small"><span>Pénalité par indice</span><strong>−${HINT_COST} pts</strong></div>
      <div class="row-between small"><span>Durée maximale</span><strong>${DURATIONS[g.settings.maxMin || 0]}</strong></div>
    </section>
    <div class="form-actions sticky"><button class="btn primary block" data-action="start-now" data-g="${g.id}" ${taken ? "" : "disabled"}>${icon("flag", 18)} Donner le départ</button></div>
    <p class="center small muted pad">Les ${t.words.teams.toLowerCase()} sans capitaine pourront rejoindre en cours de partie.</p>`;
}

// QR codes : dessinés après l'affichage (bibliothèque chargée à la demande).
async function drawQr() {
  const els = document.querySelectorAll("[data-qr]:not([data-drawn])");
  if (!els.length) return;
  try {
    const { qrcode } = await import("./vendor/qrcode.mjs");
    for (const el of els) {
      const qr = qrcode(0, "M");
      qr.addData(el.dataset.qr);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      el.dataset.drawn = "1";
    }
  } catch { for (const el of els) el.hidden = true; }
}

// ---------- Rejoindre (capitaine) ---------------------------------------------------------
function viewJoin(code, query) {
  const relay = query.get("relay");
  if (!code) {
    return `${top({ title: "Rejoindre une partie", back: "#/" })}
      <form id="join-form" class="panel">
        <label class="field"><span>Code de la partie</span><input name="code" class="code-input" maxlength="8" autocapitalize="characters" autocomplete="off" required placeholder="K7RX42"></label>
        <button class="btn primary block" type="submit">Continuer</button>
      </form>
      <p class="pad small muted">Le code s'affiche sur le téléphone de l'organisateur, avec un QR code que tu peux aussi scanner avec l'appareil photo de l'iPhone.</p>`;
  }
  const key = `${code}|${relay || ""}`;
  if (S.join?.key !== key) {
    S.join = { key, loading: true };
    (async () => {
      try {
        if (relay) {
          const r = await S.store.takeOver(code, relay);
          S.data = await S.store.loadAll();
          toast("Tu reprends l'équipe : bon jeu !");
          go(`/g/${r.game_id}/play`);
          return;
        }
        const found = await S.store.findGame(code);
        S.join = { key, found, theme: found?.theme };
      } catch (e) { S.join = { key, error: e.message }; }
      render();
    })();
  }
  const j = S.join;
  if (j.loading) return `<div class="loading">Recherche de la partie…</div>`;
  if (j.error || !j.found) {
    return `${top({ title: "Rejoindre", back: "#/join" })}
      <div class="empty"><p>${esc(j.error || `Aucune partie en cours avec le code ${code.toUpperCase()}.`)}</p><a class="btn primary" href="#/join">Réessayer</a></div>`;
  }
  const f = j.found;
  const t = theme(f.theme);
  const mine = f.teams.find((x) => x.mine);
  if (mine) setTimeout(() => go(`/g/${f.id}/play`));
  return `${top({ title: esc(f.name), sub: `Code ${esc(f.code)}`, back: "#/join" })}
    <form id="claim-form" data-g="${f.id}">
      <section class="panel">
        <label class="field"><span>Ton prénom (capitaine)</span><input name="name" maxlength="30" required autocomplete="given-name"></label>
        <fieldset class="field"><legend>Choisis ton ${t.words.team.toLowerCase()}</legend>
          ${f.teams.map((x) => `<label class="radio-card ${x.taken ? "off" : ""}">
            <input type="radio" name="team" value="${x.id}" ${x.taken ? "disabled" : ""} required>
            <span class="team-dot small-dot" style="background:${x.color}">${esc(initials(x.name))}</span>
            <span class="grow"><strong>${esc(x.name)}</strong>${x.taken ? `<br><span class="small muted">déjà prise par ${esc(x.captain_name || "un capitaine")}</span>` : ""}</span></label>`).join("")}
        </fieldset>
      </section>
      <div class="form-actions"><button class="btn primary block" type="submit">Je suis le capitaine !</button></div>
    </form>
    <details class="pad small"><summary>Reprendre une équipe avec un code de relais</summary>
      <form id="relay-form" data-code="${esc(f.code)}" class="inline-form"><input name="token" maxlength="6" autocapitalize="characters" placeholder="Code de relais" required><button class="btn small primary" type="submit">Reprendre</button></form>
    </details>`;
}

// ---------- Jeu (capitaine) ------------------------------------------------------------------
function viewPlayOrWait(g) {
  applyTheme(g.course.theme);
  const team = myTeam(g);
  const t = theme(g.course.theme);
  if (!team) {
    return `${top({ title: esc(g.course.name), back: "#/games" })}<div class="empty"><p>Tu n'es plus capitaine d'une équipe dans cette partie.</p>
      ${isOwner(g) ? `<a class="btn primary" href="#/g/${g.id}/live">Suivre la partie</a>` : `<a class="btn primary" href="#/join/${g.code}">Rejoindre une équipe</a>`}</div>`;
  }
  if (g.status === "lobby") {
    const needCompass = compassNeedsPermission() && !S.sense.compassOn;
    return `<div class="play" style="--team:${team.color}">
      ${playHeader(g, team)}
      <div class="empty">
        <span class="big-icon">${icon("hourglass", 44)}</span>
        <h2 class="center-h">En attente du départ</h2>
        <p class="muted">L'organisateur donnera le départ dans un instant. Garde cet écran ouvert.</p>
        ${needCompass ? `<p><button class="btn primary" data-action="compass-on">${icon("compass", 18)} Activer la boussole maintenant</button></p>` : ""}
        <p class="small muted">${esc(t.intro)}</p>
      </div></div>`;
  }
  if (team.finished_at) {
    const rk = ranking(g);
    const pos = rk.findIndex((r) => r.team.id === team.id) + 1;
    return `<div class="play" style="--team:${team.color}">
      ${playHeader(g, team)}
      <div class="empty">
        <span class="big-icon trophy">${icon("trophy", 48)}</span>
        <h2 class="center-h">Bravo, ${esc(team.name)} !</h2>
        <p>Vous avez terminé le parcours. Classement provisoire : <strong>${pos}${pos === 1 ? "re" : "e"}</strong> sur ${g.teams.length}.</p>
        <p class="muted small">Rejoignez l'organisateur pour la remise du ${t.words.reward}.</p>
        <a class="btn primary" href="#/g/${g.id}/end">Voir le classement</a>
      </div></div>`;
  }
  return viewPlay(g, team);
}

function playHeader(g, team) {
  const t = theme(g.course.theme);
  const play = teamPlay(g, team);
  const sid = currentStepId(play);
  const idx = sid ? play.order.indexOf(sid) + 1 : play.order.length;
  const sc = teamScore(g, team);
  const left = timeLeft(g);
  return `<header class="play-top" style="background:${t.hero};color:${t.heroInk}">
      <a class="icon-btn light" href="#/games" aria-label="Quitter l'écran de jeu">${icon("back", 22)}</a>
      <span class="team-dot">${esc(initials(team.name))}</span>
      <span class="grow"><strong>${esc(team.name)}</strong><br><span class="small">${cap(t.words.step)} ${idx} / ${play.order.length}${left != null ? ` · ${left > 0 ? `reste ${fmtDuration(left)}` : "temps écoulé"}` : ""}</span></span>
      <span class="score"><strong>${fmtNum(sc.won)}</strong><span class="small">pts${sc.pending ? ` · +${sc.pending} en attente` : ""}</span></span>
    </header>
    ${messagesBanner(g, team)}`;
}

function timeLeft(g) {
  if (!g.settings?.maxMin || !g.started_at) return null;
  return new Date(g.started_at).getTime() + g.settings.maxMin * 60000 - Date.now();
}

// Messages de l'organisateur pas encore lus.
const seenKey = (g) => `captaine-seen-${g.id}`;
function messagesBanner(g, team) {
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(seenKey(g)) || "[]"); } catch { /* rien */ }
  const msgs = (g.messages || []).filter((m) => (!m.team_id || m.team_id === team.id) && !seen.includes(m.id));
  if (!msgs.length) return "";
  return `<div class="msg-banner">${icon("bulb", 18)}<span class="grow"><strong>Message de l'organisateur</strong>${msgs.map((m) => `<br>${esc(m.text)}`).join("")}</span>
    <button class="icon-btn" data-action="msg-seen" data-g="${g.id}" data-ids="${msgs.map((m) => m.id).join(",")}" aria-label="J'ai lu">${icon("check", 20)}</button></div>`;
}

function viewPlay(g, team) {
  const t = theme(g.course.theme);
  const w = t.words;
  const play = teamPlay(g, team);
  const sid = currentStepId(play);
  const s = stepOf(g, sid);
  const p = team.progress[sid] || {};
  const here = arrived(team, s) || (s.challenge === "enigme" && !s.needOnSite);
  const flash = S.flash; S.flash = null;
  const pending = S.store.pendingUploads();
  return `<div class="play" style="--team:${team.color}">
    ${playHeader(g, team)}
    ${g.settings.sim ? `<div class="simbar">${icon("walk", 16)} Simulation : la position est fictive.</div>` : `<div class="simbar warn" id="gps-status" hidden></div>`}
    ${pending ? `<div class="simbar">${icon("wifiOff", 16)} ${plural(pending, "envoi en attente de réseau", "envois en attente de réseau")}</div>` : ""}
    ${flash ? `<div class="flash">${icon("check", 18)} <span><strong>${esc(flash.text)}</strong>${flash.msg ? `<br><span class="small">${esc(flash.msg)}</span>` : ""}</span></div>` : ""}
    ${here ? "" : viewNavigator(g, s)}
    ${here ? viewChallenge(g, team, s, p) : ""}
    <p class="center small muted pad">${esc(g.course.name)} · ${plural(Object.values(team.progress).filter((x) => x.status === "done" || x.status === "pending").length, `${w.step} réussie`, `${w.steps} réussies`)}</p>
    <div class="row-gap small">
      <a class="btn small ghost" href="#/g/${g.id}/relay">${icon("share", 16)} Passer le relais</a>
      <button class="btn small ghost" data-action="skip-step" data-g="${g.id}">Passer cette ${w.step}</button>
    </div>
  </div>`;
}

function arrived(team, s) { return !!team.progress[s.id]?.arrivedAt; }
const levelQuestion = (team, s) => (team.level === "enfant" && s.kidQuestion?.trim()) ? s.kidQuestion : s.question;
const prog = (team, id) => (team.progress[id] ||= { status: "todo", hints: 0, wrong: 0 });

function viewNavigator(g, s) {
  const needCompass = compassNeedsPermission() && !S.sense.compassOn && s.nav !== "indice";
  return `<section class="navi">
    ${s.clue ? `<div class="clue">${icon("bulb", 18)}<span>${esc(s.clue)}</span></div>` : ""}
    ${s.nav === "boussole" ? `
      <div class="compass" aria-hidden="true"><span class="cn">N</span>
        <svg id="arrow" viewBox="0 0 120 120" width="150" height="150"><path d="M60 8 L84 74 L60 61 L36 74 Z" fill="var(--warm)"/><path d="M60 61 L84 74 L60 112 L36 74 Z" fill="currentColor" opacity=".18"/></svg></div>
      <div class="dist" id="dist">—</div>
      <div class="warm" id="warm" hidden></div>
      <p class="small muted center" id="dir-help"></p>`
    : s.nav === "radar" ? `
      <div class="radar"><svg viewBox="0 0 200 200" width="220" height="220" aria-hidden="true">
        <circle cx="100" cy="100" r="96" class="r-ring"/><circle cx="100" cy="100" r="64" class="r-ring"/><circle cx="100" cy="100" r="32" class="r-ring"/>
        <g id="radar-rot"><text x="100" y="16" text-anchor="middle" class="r-n">N</text><circle id="radar-dot" cx="100" cy="100" r="8" fill="var(--warm)"/></g>
        <circle cx="100" cy="100" r="6" fill="currentColor"/></svg>
        <p class="small muted center">Cercle extérieur : 300 m</p></div>
      <div class="dist" id="dist">—</div>
      <div class="warm" id="warm" hidden></div>`
    : `<p class="center muted pad">Pas de boussole pour cette ${W(g.course.theme).step} : suivez l'indice. Votre arrivée sera détectée automatiquement.</p>
      <div class="warm" id="warm" hidden></div>`}
    ${needCompass ? `<p class="center"><button class="btn primary" data-action="compass-on">${icon("compass", 18)} Activer la boussole</button></p>` : ""}
    ${g.settings.sim ? `<div class="sim-actions"><button class="btn ghost" data-action="sim-step" data-g="${g.id}">${icon("walk", 18)} Avancer</button><button class="btn ghost" data-action="sim-arrive" data-g="${g.id}">${icon("pin", 18)} Arriver</button></div>` : ""}
  </section>`;
}

function viewChallenge(g, team, s, p) {
  if (needsJudge(s)) {
    const video = s.challenge === "video";
    const m = S.media?.stepId === s.id ? S.media : null;
    const input = `<input type="file" accept="${video ? "video/*" : "image/*"}" capture="environment" data-media-input="${s.id}" hidden>`;
    return `<section class="panel challenge">
      <span class="kicker">Défi ${video ? "vidéo" : "photo"} · ${s.points} pts</span>
      <h2 class="q">${esc(levelQuestion(team, s))}</h2>
      ${m
        ? `${m.kind === "video" ? `<video class="photo-preview" src="${m.url}" controls playsinline></video>` : `<img class="photo-preview" src="${m.url}" alt="Photo prise pour le défi">`}
           <div class="row-actions"><label class="btn ghost">${icon(video ? "video" : "camera", 18)} Refaire${input}</label>
           <button class="btn primary" data-action="media-send" data-g="${g.id}">Envoyer</button></div>`
        : `<label class="btn primary block big">${icon(video ? "video" : "camera", 20)} ${video ? "Filmer" : "Prendre la photo"}${input}</label>`}
      <p class="small muted">L'organisateur validera ${video ? "la vidéo" : "la photo"}. Vous pouvez continuer sans attendre.${video ? " Restez court : 15 secondes environ." : ""}</p>
    </section>`;
  }
  if (s.challenge === "jeu") {
    const gm = GAMES[s.game.kind];
    const run = S.minigame?.stepId === s.id ? S.minigame : null;
    return `<section class="panel challenge">
      <span class="kicker">Mini-jeu · ${gm.name} · ${s.points} pts</span>
      <h2 class="q">${esc(s.question?.trim() || gm.hint(s.game.target))}</h2>
      ${s.game.kind === "niveau" ? `<div class="bubble-level" aria-hidden="true"><span class="bl-ring"></span><span class="bl-bubble" id="mg-bubble"></span></div>` : ""}
      <div class="mg-meter" role="progressbar" aria-label="Progression" aria-valuemin="0" aria-valuemax="100" id="mg-meter"><span id="mg-bar"></span></div>
      <p class="center mg-val" id="mg-val">${run?.failed ? "Raté ! On réessaie ?" : run ? "C'est parti !" : `Objectif : ${s.game.target} ${gm.unit}`}</p>
      ${run && !run.failed
        ? `<button class="btn ghost block" data-action="game-stop">Arrêter</button>`
        : `<button class="btn primary block big" data-action="game-start" data-g="${g.id}" data-s="${s.id}">${icon("play", 20)} ${run?.failed ? "Réessayer" : "Commencer"}</button>`}
      ${g.settings.sim ? `<button class="btn ghost block" data-action="game-sim" data-g="${g.id}" data-s="${s.id}">Réussir (simulation)</button>` : ""}
    </section>`;
  }
  const lock = lockRemaining(p);
  return `<section class="panel challenge">
    <span class="kicker">Énigme · ${stepPoints(s, p.hints)} pts${team.level === "enfant" && s.kidQuestion ? " · version enfant" : ""}</span>
    <h2 class="q">${esc(levelQuestion(team, s))}</h2>
    ${p.hints ? `<div class="clue">${icon("bulb", 18)}<span>${esc(s.hint)}</span></div>` : ""}
    <form id="answer-form" data-g="${g.id}" data-s="${s.id}" autocomplete="off">
      <label class="field"><span>Votre réponse</span><input name="answer" ${lock ? "disabled" : ""} autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"></label>
      ${lock ? `<p class="alert" id="lock" data-until="${p.lockUntil}">${icon("hourglass", 16)} Trop d'essais : pause de ${Math.ceil(lock / 1000)} s</p>` : ""}
      <div class="row-actions">
        ${s.hint && !p.hints ? `<button type="button" class="btn ghost" data-action="hint" data-g="${g.id}" data-s="${s.id}">${icon("bulb", 18)} Indice (−${HINT_COST} pts)</button>` : ""}
        <button class="btn primary" type="submit" ${lock ? "disabled" : ""}>Valider</button>
      </div>
    </form>
    ${!arrived(team, s) && s.needOnSite === false ? `<p class="small muted">Cette ${W(g.course.theme).step} peut se résoudre à distance.</p>` : ""}
  </section>`;
}

// ---------- Capteurs ------------------------------------------------------------------------
function resetSense(releaseWake = true) {
  S.sense.stopGeo?.(); S.sense.stopHead?.();
  const wake = S.sense.wake;
  if (releaseWake) wake?.release?.().catch?.(() => {});
  Object.assign(S.sense, { pos: null, heading: null, prevDist: null, warm: null, err: null, stopGeo: null, stopHead: null, wake: releaseWake ? null : wake, key: null, compassOn: S.sense.compassOn && !releaseWake, lastPush: 0 });
}

// Démarre ou arrête les capteurs selon l'écran affiché (seulement pendant le jeu du capitaine).
function syncSensors(g) {
  const team = g && myTeam(g);
  if (!team) { if (S.sense.key) resetSense(); return; }
  const key = `${g.id}/${team.id}`;
  if (S.sense.key === key) return;
  resetSense(false);
  S.sense.key = key;
  if (g.settings.sim) {
    const s = stepOf(g, currentStepId(teamPlay(g, team)));
    S.sense.pos = team.last_pos?.sim ? { ...team.last_pos } : { ...offset(s, 350, 200), accuracy: 5, sim: true };
  } else {
    S.sense.stopGeo = watchPosition(
      (p) => { S.sense.pos = p; S.sense.err = null; onPosition(); },
      (e) => { S.sense.err = e.message; updateLive(); },
    );
    if (!S.sense.wake) keepAwake().then((w) => { S.sense.wake = w; });
  }
  if (!compassNeedsPermission()) startCompass();
}

function startCompass() {
  if (S.sense.stopHead) return;
  S.sense.compassOn = true;
  S.sense.stopHead = watchHeading((h) => { S.sense.heading = h; updateArrow(); });
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (S.sense.key && !S.sense.wake) S.sense.wake = await keepAwake();
  if (S.live.gameId) { await refreshGame(S.live.gameId); softRender(); }
});

function sensedGameTeam() {
  if (!S.sense.key) return [];
  const [gid] = S.sense.key.split("/");
  const g = gameById(gid);
  return [g, myTeam(g)];
}

async function pushTeam(g, team, extra = {}) {
  await S.store.pushTeam(team.id, { progress: team.progress, finished_at: team.finished_at || null, ...extra })
    .catch((e) => toast(e.message, "error"));
}

// Nouvelle position : distance, détection d'arrivée, envoi périodique à l'organisateur.
async function onPosition() {
  const [g, team] = sensedGameTeam();
  if (!g || !team || team.finished_at) return;
  const play = teamPlay(g, team);
  const s = stepOf(g, currentStepId(play));
  if (!s || !S.sense.pos) return;
  const d = distance(S.sense.pos, s);
  const w = warmth(S.sense.prevDist, d);
  if (w) S.sense.warm = w;
  if (S.sense.prevDist == null || Math.abs(d - S.sense.prevDist) >= 3) S.sense.prevDist = d;
  const pos = { lat: S.sense.pos.lat, lng: S.sense.pos.lng, accuracy: S.sense.pos.accuracy, at: new Date().toISOString(), ...(g.settings.sim ? { sim: true } : {}) };
  team.last_pos = pos;
  const slack = Math.min(S.sense.pos.accuracy || 0, 30) / 2;
  if (!arrived(team, s) && d - slack <= s.radius) {
    const p = prog(team, s.id);
    p.arrivedAt = Date.now();
    navigator.vibrate?.([120, 60, 120]);
    if (s.challenge === "balise") {
      p.status = "done"; p.points = stepPoints(s, 0); p.solvedAt = Date.now();
      S.flash = { text: `${cap(W(g.course.theme).step)} trouvée ! +${p.points} pts`, msg: s.question };
    }
    await afterProgress(g, team, { last_pos: pos });
    return;
  }
  if (Date.now() - S.sense.lastPush > POS_EVERY_MS || g.settings.sim) {
    S.sense.lastPush = Date.now();
    S.store.pushTeam(team.id, { last_pos: pos }).catch(() => {});
  }
  updateLive();
}

async function afterProgress(g, team, extra = {}) {
  const play = teamPlay(g, team);
  if (!currentStepId(play) && !team.finished_at) team.finished_at = new Date().toISOString();
  S.sense.prevDist = null; S.sense.warm = null;
  await pushTeam(g, team, extra);
  if (team.finished_at) {
    resetSense();
    // Partie solo : l'organisateur joue lui-même, on passe directement aux résultats.
    if (g.settings?.solo && isOwner(g)) {
      await S.store.setStatus(g.id, "finished").catch(() => {});
      await refreshGame(g.id);
      go(`/g/${g.id}/end`);
      return;
    }
  }
  render();
}

// Mise à jour légère (sans tout redessiner) : distance, chaud/froid, GPS, temps restant.
function updateLive() {
  const [g, team] = sensedGameTeam();
  if (!g || !team) return;
  const s = stepOf(g, currentStepId(teamPlay(g, team)));
  const pos = S.sense.pos;
  const st = $("#gps-status");
  if (st) {
    const msg = S.sense.err || (!pos ? "Recherche de la position GPS…" : pos.accuracy > 50 ? `GPS imprécis (± ${Math.round(pos.accuracy)} m) : restez à découvert` : "");
    st.hidden = !msg;
    st.innerHTML = msg ? `${icon("wifiOff", 16)} ${esc(msg)}` : "";
  }
  if (!s || !pos) return;
  const distEl = $("#dist");
  if (distEl) distEl.textContent = fmtDistance(distance(pos, s));
  const wEl = $("#warm");
  if (wEl) { wEl.hidden = !S.sense.warm; wEl.textContent = S.sense.warm ? WARMTH_LABEL[S.sense.warm] : ""; wEl.dataset.w = S.sense.warm || ""; }
  updateArrow();
}

function updateArrow() {
  const [g, team] = sensedGameTeam();
  if (!g || !team || !S.sense.pos) return;
  const s = stepOf(g, currentStepId(teamPlay(g, team)));
  if (!s) return;
  const b = bearing(S.sense.pos, s);
  const h = S.sense.heading;
  const arrow = $("#arrow");
  if (arrow) arrow.style.transform = `rotate(${(b - (h ?? 0) + 360) % 360}deg)`;
  const help = $("#dir-help");
  if (help) help.textContent = h == null ? `Sans boussole : le haut de l'écran = le nord. Direction : ${cardinal(b)}.` : "Tenez le téléphone à plat devant vous.";
  const rot = $("#radar-rot");
  const dot = $("#radar-dot");
  if (rot && dot) {
    const r = (Math.min(distance(S.sense.pos, s), 300) / 300) * 92;
    dot.setAttribute("cx", 100 + r * Math.sin((b * Math.PI) / 180));
    dot.setAttribute("cy", 100 - r * Math.cos((b * Math.PI) / 180));
    rot.setAttribute("transform", `rotate(${-(h ?? 0)} 100 100)`);
  }
}

// Chaque seconde : compte à rebours de la pause, fin du temps imparti.
setInterval(() => {
  const el = $("#lock");
  if (el) {
    const left = Number(el.dataset.until) - Date.now();
    if (left <= 0) render();
    else el.lastChild.textContent = ` Trop d'essais : pause de ${Math.ceil(left / 1000)} s`;
  }
  const [g, team] = sensedGameTeam();
  if (g && team && !team.finished_at && timeLeft(g) != null && timeLeft(g) <= 0) {
    team.finished_at = new Date().toISOString();
    toast("Temps écoulé : la partie est terminée pour votre équipe");
    afterProgress(g, team);
  }
}, 1000);

// ---------- Relais ----------------------------------------------------------------------------
function viewRelay(g) {
  applyTheme(g.course.theme);
  const team = myTeam(g);
  if (!team) return notFound();
  if (!S.relay || S.relay.teamId !== team.id) {
    S.relay = { teamId: team.id, token: null };
    S.store.relayToken(team.id).then((tok) => { S.relay.token = tok; render(); }).catch((e) => toast(e.message, "error"));
  }
  const tok = S.relay.token;
  return `${top({ title: "Passer le relais", sub: esc(team.name), back: `#/g/${g.id}/play` })}
    <section class="panel center">
      <p>Le nouveau capitaine scanne ce QR code avec son iPhone. Il reprend la partie exactement où vous en êtes, et ce téléphone-ci ne pourra plus jouer.</p>
      ${tok ? `<div class="qr big-qr" data-qr="${esc(joinUrl(g.code, tok))}" role="img" aria-label="QR code de relais"></div>
        <p class="small muted">Ou, dans Cap'taine › Rejoindre : code <strong>${esc(g.code)}</strong>, puis code de relais <strong class="code-inline">${esc(tok)}</strong></p>` : `<p class="muted">Préparation du code…</p>`}
      ${S.store.pendingUploads() ? `<p class="alert">Des envois attendent encore le réseau : attends qu'ils partent avant de passer le relais, sinon ils seront perdus.</p>` : ""}
    </section>`;
}

// ---------- Carte live (organisateur) ------------------------------------------------------------
function viewLive(g) {
  applyTheme(g.course.theme);
  const t = theme(g.course.theme);
  const rk = ranking(g);
  const pendings = g.teams.reduce((n, x) => n + pendingCount(x), 0);
  const left = timeLeft(g);
  const elapsed = g.started_at ? Date.now() - new Date(g.started_at).getTime() : 0;
  return `${top({ title: esc(g.course.name), sub: `En cours · ${fmtDuration(elapsed)}${left != null ? ` · reste ${fmtDuration(Math.max(0, left))}` : ""} · code ${esc(g.code)}`, back: "#/games",
      actions: `<button class="icon-btn" data-action="show-code" data-g="${g.id}" aria-label="Afficher le code">${icon("share")}</button>` })}
    ${liveMap(g)}
    ${pendings ? `<section class="panel attention"><div class="panel-head"><h2>${icon("camera", 18)} À valider</h2><span class="small muted">${pendings}</span></div>
      ${g.teams.flatMap((x) => Object.entries(x.progress).filter(([id, p]) => p.status === "pending" && !x.judgments?.[id]).map(([id, p]) => {
        const s = stepOf(g, id);
        return `<div class="validate">
          ${mediaTag(g, x, p, "thumb big", `Défi ${s.title}`)}
          <p><span class="team-chip" style="background:${x.color}">${esc(x.name)}</span> <strong>${esc(s.title)}</strong><br><span class="small muted">${esc(s.question)}</span></p>
          <div class="row-actions"><button class="btn ghost" data-action="judge" data-v="refused" data-t="${x.id}" data-s="${id}">Refuser</button>
          <button class="btn primary" data-action="judge" data-v="done" data-t="${x.id}" data-s="${id}">Valider +${p.points} pts</button></div></div>`;
      })).join("")}</section>` : ""}
    <section class="panel">
      <h2>${t.words.teams}</h2>
      ${rk.map((r) => {
        const x = r.team;
        const last = x.last_pos?.at ? Date.now() - new Date(x.last_pos.at).getTime() : null;
        const stale = !x.finished_at && x.captain && (last == null || last > STALE_MS);
        const play = teamPlay(g, x);
        const cur = currentStepId(play);
        return `<div class="team-row ${stale ? "stale" : ""}">
          <span class="team-dot" style="background:${x.color}">${esc(initials(x.name))}</span>
          <span class="grow"><span class="row-between"><strong>${esc(x.name)}</strong><strong>${fmtNum(r.won)} pts</strong></span>
            <span class="bar"><span style="width:${Math.round((r.done / r.total) * 100)}%;background:${x.color}"></span></span>
            <span class="small ${stale ? "warn" : "muted"}">${!x.captain ? "Pas de capitaine" : x.finished_at ? "Terminé" : stale ? `Hors réseau ${last == null ? "" : `depuis ${fmtDuration(last)}`} · dernière position connue` : `${cap(t.words.step)} ${r.done + 1}/${r.total} : ${esc(stepOf(g, cur)?.title || "")}`}${r.pending ? ` · ${r.pending} pts en attente` : ""}</span></span>
        </div>`;
      }).join("")}
    </section>
    <form id="msg-form" class="panel" data-g="${g.id}">
      <h2>${icon("bulb", 18)} Indice ou message</h2>
      <select name="team" aria-label="Destinataire"><option value="">Toutes les ${t.words.teams.toLowerCase()}</option>${g.teams.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>
      <div class="inline-form"><input name="text" maxlength="300" placeholder="Ex. Cherchez du côté du moulin !" required><button class="btn primary" type="submit">Envoyer</button></div>
    </form>
    <div class="pad row-gap"><button class="btn ghost" data-action="finish-game" data-g="${g.id}">${icon("flag", 18)} Terminer la partie</button></div>`;
}

// Carte sans fond (fonctionne hors ligne) : étapes numérotées et positions des équipes.
function liveMap(g) {
  const pts = [...g.course.steps.map((s) => ({ lat: s.lat, lng: s.lng })), ...g.teams.filter((x) => x.last_pos).map((x) => x.last_pos)];
  if (!pts.length) return "";
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k), ys = pts.map((p) => p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 0.0005);
  const W0 = 340, H0 = 240, pad = 24;
  const sc = Math.min((W0 - 2 * pad) / span, (H0 - 2 * pad) / span);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const P = (p) => [W0 / 2 + (p.lng * k - cx) * sc, H0 / 2 - (p.lat - cy) * sc];
  const steps = g.course.steps;
  const path = steps.map((s, i) => `${i ? "L" : "M"}${P(s).map((v) => v.toFixed(1)).join(" ")}`).join(" ");
  return `<section class="map-card"><svg viewBox="0 0 ${W0} ${H0}" role="img" aria-label="Carte des étapes et des équipes">
    <path d="${path}" class="m-path"/>
    ${steps.map((s, i) => { const [x, y] = P(s); return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" class="m-step ${s.final ? "final" : ""}"/><text x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="middle" class="m-num">${s.final ? "★" : i + 1}</text></g>`; }).join("")}
    ${g.teams.filter((x) => x.last_pos).map((x) => {
      const [x0, y0] = P(x.last_pos);
      const stale = !x.finished_at && Date.now() - new Date(x.last_pos.at).getTime() > STALE_MS;
      return `<g class="${stale ? "m-stale" : ""}"><circle cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="11" fill="${x.color}" class="m-team"/><text x="${x0.toFixed(1)}" y="${(y0 + 4).toFixed(1)}" text-anchor="middle" class="m-ini">${esc(initials(x.name))}</text></g>`;
    }).join("")}
  </svg><p class="small muted">Pointillés : position non mise à jour depuis plus de 2 min.</p></section>`;
}

// ---------- Fin de partie ---------------------------------------------------------------------------
function viewEnd(g) {
  applyTheme(g.course.theme);
  const t = theme(g.course.theme);
  const rk = ranking(g);
  const owner = isOwner(g);
  const pendings = g.teams.reduce((n, x) => n + pendingCount(x), 0);
  const final = g.status === "finished" && !pendings;
  const mine = myTeam(g);
  const solo = g.teams.length === 1;
  const head = solo ? `${esc(rk[0].team.name)} : ${fmtNum(rk[0].won)} pts` : final ? `${esc(rk[0].team.name)} gagne !` : "Classement provisoire";
  const dur = (g.finished_at ? new Date(g.finished_at) : Date.now()) - new Date(g.started_at || g.created_at);
  return `<header class="end-hero" style="background:${t.hero};color:${t.heroInk}">
      <a class="icon-btn light" href="#/games" aria-label="Retour aux parties">${icon("back", 22)}</a>
      <span class="trophy">${icon("trophy", 44)}</span>
      <span class="small">${esc(g.course.name)} · ${g.status === "finished" ? "terminé" : "en cours"}</span>
      <h1>${head}</h1>
      <span class="small">${fmtDuration(dur)} · ${plural(g.teams.length, t.words.team.toLowerCase(), t.words.teams.toLowerCase())}${pendings ? ` · ${plural(pendings, "défi à valider", "défis à valider")}` : ""}</span>
    </header>
    ${owner && pendings ? `<section class="panel attention">
      <h2>À valider avant le classement final</h2>
      ${g.teams.flatMap((x) => Object.entries(x.progress).filter(([id, p]) => p.status === "pending" && !x.judgments?.[id]).map(([id, p]) => {
        const s = stepOf(g, id);
        return `<div class="validate">
          ${mediaTag(g, x, p, "thumb big", `Défi ${s.title}`)}
          <p><span class="team-chip" style="background:${x.color}">${esc(x.name)}</span> <strong>${esc(s.title)}</strong><br><span class="small muted">${esc(s.question)}</span></p>
          <div class="row-actions"><button class="btn ghost" data-action="judge" data-v="refused" data-t="${x.id}" data-s="${id}">Refuser</button>
          <button class="btn primary" data-action="judge" data-v="done" data-t="${x.id}" data-s="${id}">Valider +${p.points} pts</button></div></div>`;
      })).join("")}
    </section>` : ""}
    ${solo ? "" : `<section class="panel"><h2>Classement</h2>
      <ol class="ranking">${rk.map((r, i) => `<li class="${mine?.id === r.team.id ? "me" : ""}">
        <span class="rank">${i + 1}</span><span class="team-dot small-dot" style="background:${r.team.color}">${esc(initials(r.team.name))}</span>
        <span class="grow"><strong>${esc(r.team.name)}</strong><br><span class="small muted">${r.done}/${r.total} ${t.words.steps}${r.team.finished_at ? " · terminé" : ""}${r.pending ? ` · ${r.pending} pts en attente` : ""}</span></span>
        <span class="pts">${fmtNum(r.won)} pts</span></li>`).join("")}</ol></section>`}
    ${viewAlbum(g)}
    ${(mine ? [mine] : owner ? g.teams : []).map((x) => { const play = teamPlay(g, x); return `<section class="panel">
      <h2>${solo ? "Le parcours" : `Parcours : ${esc(x.name)}`}</h2>
      <ol class="recap">${play.order.map((id) => { const s = stepOf(g, id); const p = play.progress[id] || {}; return `<li>
        <span class="grow">${esc(s.title)}<br><span class="small muted">${CHALLENGES[s.challenge]}${p.hints ? " · indice" : ""}</span></span>
        ${p.media && p.status !== "pending" ? mediaTag(g, x, p, "thumb", "") : ""}
        <span class="pts ${p.status || "todo"}">${p.status === "done" ? `+${p.points}` : p.status === "pending" ? "en attente" : p.status === "refused" ? "refusée" : p.status === "skipped" ? "passée" : "—"}</span></li>`; }).join("")}</ol>
    </section>`; }).join("")}
    <div class="pad row-gap">${owner ? `<a class="btn ghost" href="#/c/${g.course_id}/start">${icon("play", 18)} Rejouer</a>` : ""}
      ${owner && g.status !== "finished" ? `<a class="btn ghost" href="#/g/${g.id}/live">Retour à la carte</a>` : ""}<a class="btn primary" href="#/">Accueil</a></div>`;
}

function mediaTag(g, team, p, cls, alt) {
  const attrs = `data-media="${p.media}" data-gid="${g.id}" data-tid="${team.id}" data-ext="${p.ext || "jpg"}"`;
  return p.mediaType === "video"
    ? `<video ${attrs} class="${cls}" controls playsinline preload="metadata"></video>`
    : `<img ${attrs} class="${cls}" alt="${esc(alt)}">`;
}

// Charge les photos et vidéos (stockées à part) dans les balises <img|video data-media>.
async function hydrateMedia(root = document) {
  for (const el of root.querySelectorAll("[data-media]")) {
    const id = el.dataset.media;
    if (!id || el.getAttribute("src")) continue;
    try {
      const v = await S.store.getMedia(id, { gameId: el.dataset.gid, teamId: el.dataset.tid, ext: el.dataset.ext });
      if (v) el.src = v;
    } catch { /* média absent */ }
  }
}

// ---------- Album souvenir ------------------------------------------------------------
function albumItems(g) {
  return g.teams.flatMap((t) => Object.entries(teamPlay(g, t).progress)
    .filter(([, p]) => p.media && p.status !== "refused")
    .map(([sid, p]) => ({ team: t, step: stepOf(g, sid), p })))
    .sort((a, b) => (a.p.solvedAt || 0) - (b.p.solvedAt || 0));
}

function viewAlbum(g) {
  const items = albumItems(g);
  if (!items.length) return "";
  return `<section class="panel">
    <div class="panel-head"><h2>${icon("camera", 18)} Album souvenir</h2><span class="small muted">${plural(items.length, "souvenir", "souvenirs")}</span></div>
    <div class="album">${items.map((it, i) => `<button class="album-item" data-action="album-open" data-g="${g.id}" data-i="${i}" aria-label="Ouvrir : ${esc(it.step.title)}, ${esc(it.team.name)}">
      ${it.p.mediaType === "video" ? `<video data-media="${it.p.media}" data-gid="${g.id}" data-tid="${it.team.id}" data-ext="${it.p.ext || "mp4"}" muted playsinline preload="metadata"></video><span class="play-badge">${icon("play", 16)}</span>`
        : `<img data-media="${it.p.media}" data-gid="${g.id}" data-tid="${it.team.id}" data-ext="${it.p.ext || "jpg"}" alt="">`}
      <span class="album-team" style="background:${it.team.color}">${esc(initials(it.team.name))}</span></button>`).join("")}</div>
    <button class="btn ghost block" data-action="album-share-all" data-g="${g.id}">${icon("share", 18)} Partager tout l'album</button>
  </section>`;
}

function openAlbum(g, i) {
  const items = albumItems(g);
  const n = items.length;
  const it = items[((i % n) + n) % n];
  S.album = { gameId: g.id, index: ((i % n) + n) % n };
  const dlg = document.getElementById("dialog");
  dlg.className = "lightbox";
  dlg.innerHTML = `<div class="lb">
    <div class="lb-media">${it.p.mediaType === "video"
      ? `<video data-media="${it.p.media}" data-gid="${g.id}" data-tid="${it.team.id}" data-ext="${it.p.ext || "mp4"}" controls playsinline autoplay></video>`
      : `<img data-media="${it.p.media}" data-gid="${g.id}" data-tid="${it.team.id}" data-ext="${it.p.ext || "jpg"}" alt="${esc(it.step.title)}">`}</div>
    <p class="lb-cap"><span class="team-chip" style="background:${it.team.color}">${esc(it.team.name)}</span> ${esc(it.step.title)}<br><span class="small">${esc(it.step.question || "")}</span></p>
    <div class="lb-actions">
      <button class="btn ghost" data-action="album-nav" data-d="-1" aria-label="Précédent">${icon("back", 20)}</button>
      <button class="btn primary" data-action="album-share-one">${icon("share", 18)} Enregistrer</button>
      <button class="btn ghost" data-action="album-nav" data-d="1" aria-label="Suivant"><span class="flip">${icon("back", 20)}</span></button>
      <button class="btn ghost" data-action="album-close">Fermer</button>
    </div></div>`;
  if (!dlg.open) dlg.showModal();
  hydrateMedia(dlg);
}

async function shareMedia(g, items) {
  const files = [];
  for (const it of items) {
    const blob = await S.store.getMediaBlob(it.p.media, { gameId: g.id, teamId: it.team.id, ext: it.p.ext });
    const name = `${g.course.name}-${it.team.name}-${it.step.title}.${it.p.ext || "jpg"}`.replace(/[^\p{L}\p{N}.-]+/gu, "_");
    files.push(new File([blob], name, { type: blob.type || (it.p.mediaType === "video" ? "video/mp4" : "image/jpeg") }));
  }
  if (navigator.canShare?.({ files })) {
    await navigator.share({ files, title: g.course.name }).catch(() => {});
    return;
  }
  // Repli : téléchargement fichier par fichier.
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  toast(files.length > 1 ? "Fichiers téléchargés" : "Fichier téléchargé");
}

// ---------- Parties -------------------------------------------------------------------
function viewGames() {
  const list = S.data.games;
  const status = { lobby: "salle d'attente", running: "en cours", finished: "terminée" };
  return `${top({ title: "Parties", sub: "Organisées ou jouées sur ce téléphone", actions: `<a class="btn small primary" href="#/join">Rejoindre</a>` })}
    ${list.length ? `<div class="list">${list.map((g) => {
      const t = theme(g.course.theme);
      const team = myTeam(g);
      const role = isOwner(g) ? (g.settings?.solo ? "Partie solo" : "Organisateur") : `Capitaine · ${esc(team?.name || "")}`;
      const best = ranking(g)[0];
      return `<a class="card game-row" href="#/g/${g.id}">
        <span class="team-dot" style="background:${t.hero};color:${t.heroInk}">${esc(initials(g.course.name))}</span>
        <span class="grow"><strong>${esc(g.course.name)}</strong><br>
        <span class="small muted">${role} · ${fmtDateTime(g.created_at)} · ${status[g.status]}${g.settings?.sim ? " · simulation" : ""}</span></span>
        ${best ? `<span class="pts">${fmtNum((team ? teamScore(g, team) : best).won)} pts</span>` : ""}</a>`;
    }).join("")}</div>` : `<div class="empty"><p>Aucune partie pour l'instant.</p>${S.store.isAdmin() ? `<a class="btn primary" href="#/">Choisir un parcours</a>` : `<a class="btn primary" href="#/join">Rejoindre une partie</a>`}</div>`}`;
}

// ---------- Plus ---------------------------------------------------------------------
function viewMore() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  return `${top({ title: "Plus" })}
    ${standalone ? "" : `<section class="panel"><h2>${icon("download", 18)} Installer sur l'iPhone</h2>
      <ol class="small"><li>Ouvre cette page dans Safari.</li><li>Touche le bouton Partager ${icon("share", 16)}.</li><li>Choisis « Sur l'écran d'accueil ».</li></ol>
      <p class="small muted">Installée, l'app fonctionne sans réseau et garde tes données plus longtemps.</p></section>`}
    <section class="panel"><h2>Pendant une partie</h2>
      <ul class="small"><li>Autorise la localisation et la boussole quand l'iPhone le demande.</li>
      <li>Garde l'app ouverte à l'écran : sur iPhone, le GPS d'une app web s'arrête écran éteint.</li>
      <li>Pense à charger le téléphone du capitaine avant de partir.</li></ul></section>
    ${S.store.mode === "cloud" ? viewAccount() : ""}
    ${S.store.mode === "demo" ? `<section class="panel"><h2>Mode démo</h2>
      <p class="small muted">Tout est enregistré dans ce navigateur. Pour essayer à plusieurs équipes : lance une partie à 2 équipes ou plus, puis « Simuler le téléphone d'un capitaine » dans la salle d'attente.</p>
      <p class="center"><button class="btn small ghost" data-action="demo-reset">Réinitialiser les données de démo</button></p></section>` : ""}
    <p class="center small muted">Cap'taine ${VERSION} · ${S.store.mode === "cloud" ? "en ligne" : "démo"}</p>`;
}

function viewAccount() {
  const acc = S.store.account();
  if (acc.admin) return `<section class="panel"><h2>Compte administrateur</h2>
    <p class="small">Connecté : <strong>${esc(acc.email || "")}</strong></p>
    <p class="small muted">Tes parcours et tes parties te suivent sur tous les téléphones où tu te connectes.</p>
    <button class="btn ghost block" data-action="sign-out">Se déconnecter</button></section>`;
  return `<section class="panel"><h2>Espace administrateur</h2>
    <p class="small muted">Pour créer des parcours et lancer des parties. Les joueurs n'ont pas besoin de compte.</p>
    <form id="login-form">
      <label class="field"><span>E-mail</span><input name="email" type="email" required autocomplete="username" inputmode="email" autocapitalize="none"></label>
      <label class="field"><span>Mot de passe</span><input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn primary block" type="submit">Se connecter</button>
    </form>
    <p class="small muted">Évite de te connecter sur le téléphone d'un capitaine pendant une partie.</p></section>`;
}

// ---------- Actions (clics) -------------------------------------------------------------
const actions = {
  async "new-course"() {
    if (!S.store.isAdmin()) { go("/more"); return; }
    const c = { id: uuid(), name: "Nouveau parcours", theme: "explo", created_at: new Date().toISOString(), defaults: { radius: 25, nav: "boussole" }, steps: [] };
    await persistCourse(c);
    S.data = await S.store.loadAll();
    go(`/c/${c.id}`);
  },
  async "sign-out"() {
    if (!(await confirmDialog("Se déconnecter du compte administrateur sur ce téléphone ?", "Se déconnecter"))) return;
    await S.store.signOut();
    S.data = await S.store.loadAll();
    toast("Déconnecté");
    go("/");
  },
  async "delete-course"(el) {
    const c = course(el.dataset.id);
    if (!(await confirmDialog(`Supprimer « ${c.name} » ? Les parties déjà jouées restent dans l'historique.`, "Supprimer"))) return;
    await S.store.deleteCourse(c.id);
    S.data = await S.store.loadAll();
    go("/");
  },
  async "set-theme"(el) {
    const c = course(el.dataset.c);
    c.theme = el.dataset.v;
    S.startForm = null;
    await persistCourse(c);
    render();
  },
  async "step-up"(el) { await moveStep(el.dataset.c, Number(el.dataset.i), -1); },
  async "step-down"(el) { await moveStep(el.dataset.c, Number(el.dataset.i), 1); },

  "draft-set"(el) {
    S.draft.step[el.dataset.f] = el.dataset.v;
    render();
  },
  async "draft-map"(el) {
    const [cid] = S.draft.key.split("/");
    const c = course(cid);
    const s = S.draft.step;
    const others = c.steps
      .map((x, i) => ({ lat: x.lat, lng: x.lng, label: x.final ? "★" : String(i + 1), id: x.id }))
      .filter((x) => x.id !== s.id && Number.isFinite(x.lat));
    el.disabled = true;
    let p;
    try {
      const { pickLocation } = await import("./mappick.js");
      p = await pickLocation({ start: Number.isFinite(s.lat) ? { lat: s.lat, lng: s.lng } : null, others, radius: s.radius,
        title: "Choisir le lieu" });
    } finally { el.disabled = false; }
    if (!p || !S.draft || S.draft.step !== s) return;
    Object.assign(s, { lat: p.lat, lng: p.lng, accuracy: null });
    toast(`${cap(W(c.theme).step)} placée sur la carte`);
    render();
  },
  async "draft-locate"(el) {
    if (inFrame()) {
      // Aperçu : pas de GPS. On place l'étape près de la précédente pour pouvoir tester.
      const [cid] = S.draft.key.split("/");
      const prev = course(cid).steps.filter((x) => x.id !== S.draft.step.id).at(-1);
      const base = prev ? offset(prev, 120, Math.random() * 360) : { lat: 50.8448, lng: 4.364 };
      Object.assign(S.draft.step, { lat: base.lat, lng: base.lng, accuracy: null });
      toast("Aperçu sans GPS : position fictive à 120 m de l'étape précédente");
      render();
      return;
    }
    el.disabled = true;
    el.innerHTML = "Localisation…";
    try {
      const p = await currentPosition();
      Object.assign(S.draft.step, { lat: p.lat, lng: p.lng, accuracy: p.accuracy });
      if (p.accuracy > 30) toast(`Précision ± ${Math.round(p.accuracy)} m : élargis la zone d'arrivée si besoin`);
      else toast("Étape placée ici");
    } catch (e) { toast(e.message, "error"); }
    render();
  },
  async "draft-save"() {
    const [cid] = S.draft.key.split("/");
    const c = course(cid);
    const s = S.draft.step;
    s.answers = parseAnswers(S.draft.answersText);
    s.title = s.title.trim();
    const errs = validateStep(s);
    if (errs.length) { S.draft.errors = errs; render(); window.scrollTo(0, 0); return; }
    const i = c.steps.findIndex((x) => x.id === s.id);
    if (i >= 0) c.steps[i] = s; else c.steps.push(s);
    // Une seule étape finale, placée en dernier.
    if (s.final) { c.steps.forEach((x) => { if (x.id !== s.id) x.final = false; }); c.steps = [...c.steps.filter((x) => !x.final), s]; }
    await persistCourse(c);
    S.draft = null;
    toast("Étape enregistrée");
    go(`/c/${cid}`);
  },
  async "delete-step"() {
    const [cid] = S.draft.key.split("/");
    if (!(await confirmDialog("Supprimer cette étape ?", "Supprimer"))) return;
    const c = course(cid);
    c.steps = c.steps.filter((x) => x.id !== S.draft.step.id);
    await persistCourse(c);
    S.draft = null;
    go(`/c/${cid}`);
  },

  "start-count"(el) { S.startForm.count = Number(el.dataset.v); render(); },
  async "start-now"(el) {
    const g = gameById(el.dataset.g);
    const free = g.teams.filter((x) => !x.captain).length;
    if (free && !(await confirmDialog(`${plural(free, "équipe n'a", "équipes n'ont")} pas encore de capitaine. Donner quand même le départ ?`, "Donner le départ", false))) return;
    await S.store.setStatus(g.id, "running");
    await refreshGame(g.id);
    render();
  },
  async release(el) {
    if (!(await confirmDialog("Libérer cette équipe ? Son capitaine actuel ne pourra plus jouer, un autre téléphone pourra la prendre.", "Libérer"))) return;
    await S.store.releaseTeam(el.dataset.t);
    await refreshGame(el.dataset.g);
    render();
  },
  async "share-code"(el) {
    const url = joinUrl(el.dataset.code);
    const text = `Rejoins notre jeu de piste Cap'taine : code ${el.dataset.code}`;
    try {
      if (navigator.share) await navigator.share({ title: "Cap'taine", text, url });
      else { await navigator.clipboard.writeText(`${text}\n${url}`); toast("Lien copié"); }
    } catch { /* partage annulé */ }
  },
  "show-code"(el) {
    const g = gameById(el.dataset.g);
    const dlg = document.getElementById("dialog");
    dlg.className = "";
    dlg.innerHTML = `<form method="dialog" class="dlg center"><p>Code de la partie</p><div class="qr" data-qr="${esc(joinUrl(g.code))}"></div>
      <p class="code dark">${esc(g.code)}</p><div class="dlg-actions"><button value="ok" class="btn primary">Fermer</button></div></form>`;
    dlg.showModal();
    drawQr();
  },
  async judge(el) {
    const [g] = S.data.games.filter((x) => x.teams.some((t) => t.id === el.dataset.t));
    await S.store.judge(el.dataset.t, el.dataset.s, el.dataset.v);
    toast(el.dataset.v === "done" ? "Défi validé" : "Défi refusé");
    await refreshGame(g.id);
    render();
  },
  async "finish-game"(el) {
    if (!(await confirmDialog("Terminer la partie pour toutes les équipes ?", "Terminer"))) return;
    await S.store.setStatus(el.dataset.g, "finished");
    await refreshGame(el.dataset.g);
    go(`/g/${el.dataset.g}/end`);
  },

  async "compass-on"() {
    if (await requestCompass()) { startCompass(); render(); }
    else toast("Boussole refusée : le haut de l'écran indiquera le nord", "error");
  },
  async "sim-step"() { await simMove(false); },
  async "sim-arrive"() { await simMove(true); },
  async hint(el) {
    const g = gameById(el.dataset.g);
    const team = myTeam(g);
    const s = stepOf(g, el.dataset.s);
    if (!(await confirmDialog(`Utiliser l'indice ? L'énigme rapportera ${stepPoints(s, 1)} pts au lieu de ${stepPoints(s, 0)}.`, "Voir l'indice", false))) return;
    prog(team, s.id).hints = 1;
    await pushTeam(g, team);
    render();
  },
  async "media-send"(el) {
    const g = gameById(el.dataset.g);
    const team = myTeam(g);
    const m = S.media;
    const s0 = stepOf(g, m.stepId);
    const mediaId = uuid();
    el.disabled = true;
    try { await S.store.putMedia(mediaId, m.blob, { gameId: g.id, teamId: team.id, ext: m.ext }); }
    catch { toast("Média non enregistré : stockage du téléphone plein", "error"); el.disabled = false; return; }
    const p = prog(team, s0.id);
    Object.assign(p, { status: "pending", points: stepPoints(s0, 0), media: mediaId, mediaType: m.kind, ext: m.ext, solvedAt: Date.now() });
    S.media = null;
    S.flash = { text: `${m.kind === "video" ? "Vidéo" : "Photo"} envoyée : +${p.points} pts en attente de validation` };
    await afterProgress(g, team);
  },
  async "game-start"(el) {
    const g = gameById(el.dataset.g);
    const s0 = stepOf(g, el.dataset.s);
    let stream = null;
    try { stream = await requestSensors(s0.game.kind); }
    catch (e) { toast(e.message, "error"); return; }
    S.minigame?.stop?.();
    S.minigame = { stepId: s0.id, failed: false, stop: null };
    render();
    const target = s0.game.target;
    S.minigame.stop = runGame(s0.game.kind, target, {
      stream,
      onTick: ({ value, progress, extra }) => {
        const bar = $("#mg-bar"); if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
        const meter = $("#mg-meter"); if (meter) { meter.setAttribute("aria-valuenow", Math.round(progress * 100)); meter.dataset.loud = extra?.loud ? "1" : ""; }
        const val = $("#mg-val");
        if (val) val.textContent = s0.game.kind === "secousse" ? `${value} / ${target} secousses` : `${fmtNum(value, 1)} / ${target} s`;
        const bub = $("#mg-bubble");
        if (bub && extra) bub.style.transform = `translate(${Math.max(-50, Math.min(50, extra.gamma * 3))}px, ${Math.max(-50, Math.min(50, extra.beta * 3))}px)`;
      },
      onDone: (ok) => minigameDone(g.id, s0.id, ok),
    });
  },
  "album-open"(el) { openAlbum(gameById(el.dataset.g), Number(el.dataset.i)); },
  "album-nav"(el) { openAlbum(gameById(S.album.gameId), S.album.index + Number(el.dataset.d)); },
  "album-close"() { const d = document.getElementById("dialog"); d.close(); d.className = ""; },
  async "album-share-one"() {
    const g = gameById(S.album.gameId);
    await shareMedia(g, [albumItems(g)[S.album.index]]);
  },
  async "album-share-all"(el) {
    const g = gameById(el.dataset.g);
    const items = albumItems(g);
    toast(`Préparation de ${plural(items.length, "fichier", "fichiers")}…`);
    await shareMedia(g, items);
  },
  "game-stop"() { S.minigame?.stop?.(); S.minigame = null; render(); },
  async "game-sim"(el) { await minigameDone(el.dataset.g, el.dataset.s, true); },
  "draft-game"(el) {
    const kind = el.dataset.v;
    S.draft.step.game = { kind, target: GAMES[kind].def };
    render();
  },
  async "skip-step"(el) {
    const g = gameById(el.dataset.g);
    const team = myTeam(g);
    const w = W(g.course.theme);
    if (!(await confirmDialog(`Passer cette ${w.step} ? Elle ne rapportera aucun point.`, "Passer"))) return;
    prog(team, currentStepId(teamPlay(g, team))).status = "skipped";
    await afterProgress(g, team);
  },
  "msg-seen"(el) {
    const key = `captaine-seen-${el.dataset.g}`;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(key) || "[]"); } catch { /* rien */ }
    localStorage.setItem(key, JSON.stringify([...seen, ...el.dataset.ids.split(",")]));
    render();
  },

  async "demo-phone"(el) {
    S.store.becomeNewPhone();
    resetSense();
    S.data = await S.store.loadAll();
    S.join = null;
    go(`/join/${el.dataset.code}`);
  },
  async "demo-home"() {
    S.store.backHome();
    resetSense();
    S.data = await S.store.loadAll();
    go("/games");
    render();
  },
  async "demo-reset"() {
    if (!(await confirmDialog("Effacer tous les parcours et parties de ce navigateur et remettre l'exemple ?", "Réinitialiser"))) return;
    await S.store.reset();
    S.data = await S.store.loadAll();
    go("/");
  },
};

async function minigameDone(gid, sid, ok) {
  const g = gameById(gid);
  const team = myTeam(g);
  if (!ok) { S.minigame = { stepId: sid, failed: true }; navigator.vibrate?.([60, 40, 60]); render(); return; }
  S.minigame = null;
  const s0 = stepOf(g, sid);
  const p = prog(team, sid);
  Object.assign(p, { status: "done", points: stepPoints(s0, 0), solvedAt: Date.now() });
  navigator.vibrate?.(200);
  S.flash = { text: `Mini-jeu réussi ! +${p.points} pts` };
  await afterProgress(g, team);
}

async function moveStep(cid, i, dir) {
  const c = course(cid);
  const j = i + dir;
  if (j < 0 || j >= c.steps.length) return;
  [c.steps[i], c.steps[j]] = [c.steps[j], c.steps[i]];
  c.steps = [...c.steps.filter((x) => !x.final), ...c.steps.filter((x) => x.final)];
  await persistCourse(c);
  render();
}

async function simMove(arrive) {
  const [g, team] = sensedGameTeam();
  if (!g) return;
  const s = stepOf(g, currentStepId(teamPlay(g, team)));
  const pos = S.sense.pos;
  const d = distance(pos, s);
  const next = arrive || d < 40 ? { lat: s.lat, lng: s.lng } : offset(pos, Math.max(25, d * 0.4), bearing(pos, s));
  S.sense.pos = { ...next, accuracy: 5, sim: true };
  await onPosition();
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action] && !el.disabled) {
    e.preventDefault();
    Promise.resolve(actions[el.dataset.action](el, e)).catch((err) => toast(err.message, "error"));
  }
});

// ---------- Saisies -----------------------------------------------------------------------
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.f && S.draft) {
    if (el.type === "checkbox") return;
    if (el.dataset.f === "answersText") S.draft.answersText = el.value;
    else S.draft.step[el.dataset.f] = el.hasAttribute("data-num") ? Number(el.value) : el.value;
  }
  if (el.dataset.teamName && S.startForm) S.startForm.teams[Number(el.dataset.teamName)].name = el.value;
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.f && S.draft) {
    if (el.type === "checkbox") S.draft.step[el.dataset.f] = el.checked;
    else if (el.hasAttribute("data-num")) S.draft.step[el.dataset.f] = Number(el.value);
    return;
  }
  if (S.startForm) {
    if (el.dataset.teamLevel) { S.startForm.teams[Number(el.dataset.teamLevel)].level = el.value; return; }
    if (el.hasAttribute("data-start-solo")) { S.startForm.solo = el.checked; render(); return; }
    if (el.hasAttribute("data-start-max")) { S.startForm.maxMin = Number(el.value); return; }
    if (el.name === "mode" && el.closest("#start-form")) { S.startForm.mode = el.value; return; }
  }
  if (el.dataset.courseName) {
    const c = course(el.dataset.courseName);
    c.name = el.value.trim() || "Parcours sans nom";
    await persistCourse(c);
    toast("Nom enregistré");
    return;
  }
  if (el.dataset.mediaInput && el.files?.[0]) {
    try {
      const m = await prepareMedia(el.files[0]);
      S.media = { stepId: el.dataset.mediaInput, ...m };
      render();
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  if (el.hasAttribute("data-game-target") && S.draft?.step.game) { S.draft.step.game.target = Number(el.value); render(); }
});

document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.method === "dialog") return; // laisse les boîtes de confirmation se fermer
  e.preventDefault();
  const fd = new FormData(form);
  try {
    if (form.id === "start-form") { await startGame(form); return; }
    if (form.id === "join-form") { S.join = null; go(`/join/${String(fd.get("code")).trim().toUpperCase()}`); return; }
    if (form.id === "claim-form") {
      const btn = form.querySelector("button[type=submit]"); btn.disabled = true;
      try {
        const gid = await S.store.claimTeam(fd.get("team"), fd.get("name"));
        S.join = null;
        S.data = await S.store.loadAll();
        go(`/g/${gid}/play`);
      } catch (err) { toast(err.message, "error"); S.join = null; render(); }
      return;
    }
    if (form.id === "relay-form") { S.join = null; go(`/join/${form.dataset.code}?relay=${String(fd.get("token")).trim().toUpperCase()}`); return; }
    if (form.id === "msg-form") {
      await S.store.sendMessage(form.dataset.g, fd.get("team") || null, String(fd.get("text")).trim());
      form.reset();
      toast("Message envoyé");
      return;
    }
    if (form.id === "login-form") {
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const n = await S.store.signIn(String(fd.get("email")).trim().toLowerCase(), String(fd.get("password")));
        S.data = await S.store.loadAll();
        toast(n ? `Connecté · ${plural(n, "élément récupéré", "éléments récupérés")} de ce téléphone` : "Connecté");
        go("/");
      } finally { btn.disabled = false; }
      return;
    }
    if (form.id === "answer-form") {
      const g = gameById(form.dataset.g);
      const team = myTeam(g);
      const s = stepOf(g, form.dataset.s);
      const p = prog(team, s.id);
      const given = fd.get("answer");
      if (!String(given).trim()) return;
      const res = registerAnswer(p, s, given);
      if (res.ok) {
        navigator.vibrate?.(150);
        S.flash = { text: `Bonne réponse ! +${p.points} pts` };
        await afterProgress(g, team);
      } else {
        await pushTeam(g, team);
        navigator.vibrate?.([60, 40, 60]);
        toast(res.locked ? "Trop d'essais : petite pause" : "Ce n'est pas ça…", "error");
        if (res.locked) render();
        else { form.answer.value = ""; form.answer.focus(); }
      }
    }
  } catch (err) { toast(err.message, "error"); }
});

// L'organisateur voit les durées « hors réseau » se mettre à jour.
setInterval(() => {
  const { parts } = route();
  if (parts[0] === "g" && S.live.gameId && isOwner(gameById(S.live.gameId)) && gameById(S.live.gameId)?.status === "running") softRender();
}, 30000);

// ---------- PWA -----------------------------------------------------------------------------
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
