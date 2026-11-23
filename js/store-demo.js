// Stockage du mode démo : tout reste dans ce navigateur, mais plusieurs « téléphones »
// peuvent être simulés (onglets, ou bascule organisateur / capitaine dans le même onglet).
// Même interface que store-supabase.js.
import { uuid, mediaUrl } from "./util.js";
import { offset } from "./geo.js";
import { makeCode } from "./game.js";

const KEY = "captaine-demo-v2";
const HOME = "captaine-demo-home";   // identité de l'organisateur (ce téléphone)
const ALIAS = "captaine-demo-as";    // identité simulée de cet onglet (capitaine)
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("captaine-demo") : null;

// Parcours d'exemple autour du Parc de Bruxelles (à jouer en mode simulation).
export function sampleCourse() {
  const c = { lat: 50.8448, lng: 4.3640 };
  const at = (d, b) => offset(c, d, b);
  const steps = [
    { title: "La grande fontaine", ...at(20, 0), nav: "boussole", challenge: "enigme",
      question: "Je jaillis sans jamais partir et l'on me jette des pièces pour un vœu. Combien de jets d'eau comptes-tu autour de moi ?",
      kidQuestion: "Compte les jets d'eau autour de la fontaine. Combien y en a-t-il ?",
      answers: ["8", "huit"], hint: "Fais le tour complet de la fontaine en comptant.", points: 50 },
    { title: "Le banc des amoureux", ...at(160, 70), nav: "indice", challenge: "photo",
      clue: "Quittez l'eau vers le soleil du matin et cherchez un banc à l'ombre d'un grand arbre.",
      question: "Faites une photo de toute l'équipe assise sur le banc, chacun imitant un animal différent.",
      points: 50 },
    { title: "Le vieux kiosque", ...at(230, 140), nav: "boussole", challenge: "video",
      question: "On y jouait de la musique le dimanche : filmez votre équipe qui chante un refrain sous le kiosque (15 secondes).",
      points: 50 },
    { title: "L'allée des statues", ...at(200, 230), nav: "radar", challenge: "jeu", game: { kind: "niveau", target: 8 },
      question: "Devenez des statues ! Le capitaine garde le téléphone parfaitement à plat pendant 8 secondes, sans trembler.", points: 50 },
    { title: "La porte du parc", ...at(260, 310), nav: "boussole", challenge: "enigme",
      question: "Combien de lettres compte le mot gravé au-dessus de la grille ?",
      answers: ["5", "cinq"], hint: "Le mot est en latin.", points: 50 },
    { title: "Le trésor", ...at(5, 180), nav: "radar", challenge: "enigme", final: true,
      question: "Dernière énigme : je suis ce que vous cherchez depuis le départ, souvent caché dans un coffre. Qui suis-je ?",
      answers: ["trésor", "tresor", "le trésor", "un trésor"], hint: "Regarde le titre de cette étape…", points: 100 },
  ];
  return {
    id: uuid(), name: "Balade au parc (exemple)", theme: "explo", created_at: new Date().toISOString(),
    defaults: { radius: 25, nav: "boussole" },
    steps: steps.map((s) => ({ id: uuid(), radius: 25, needOnSite: true, kidQuestion: "", hint: "", clue: "", answers: [], ...s })),
  };
}

const empty = () => ({ courses: [sampleCourse()], games: [], teams: [], relay: {}, messages: [] });
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* stockage illisible : on repart de zéro */ }
  const d = empty();
  write(d, false);
  return d;
}
const listeners = new Set();
function write(d, notify = true) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); }
  catch { throw new Error("Stockage du téléphone plein : supprime d'anciennes parties"); }
  if (notify) { channel?.postMessage("changed"); for (const fn of listeners) fn(); }
}
channel?.addEventListener("message", () => { for (const fn of listeners) fn(); });

function homeId() {
  let id = localStorage.getItem(HOME);
  if (!id) { id = `demo-${uuid()}`; localStorage.setItem(HOME, id); }
  return id;
}
const me = () => sessionStorage.getItem(ALIAS) || homeId();
const fail = (msg) => { throw new Error(msg); };
const now = () => new Date().toISOString();

// ---------- Photos (IndexedDB) -----------------------------------------------
let dbp;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("captaine-media", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("media");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("media", mode);
    const r = fn(tx.objectStore("media"));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
}

function fullGame(d, g) {
  return {
    ...structuredClone(g),
    teams: d.teams.filter((t) => t.game_id === g.id).sort((a, b) => a.idx - b.idx).map((t) => structuredClone(t)),
    messages: d.messages.filter((m) => m.game_id === g.id && (g.owner === me() || !m.team_id || d.teams.find((t) => t.id === m.team_id)?.captain === me())),
  };
}

export function createDemoStore() {
  return {
    mode: "demo",
    me,
    async init() { homeId(); return { user: { id: me() } }; },

    // Bascule « téléphone simulé » (démo uniquement).
    isAlias: () => !!sessionStorage.getItem(ALIAS),
    becomeNewPhone() { sessionStorage.setItem(ALIAS, `demo-phone-${uuid().slice(0, 8)}`); },
    backHome() { sessionStorage.removeItem(ALIAS); },

    async loadAll() {
      const d = read();
      const mine = d.games.filter((g) => g.owner === me() || d.teams.some((t) => t.game_id === g.id && t.captain === me()));
      return {
        courses: structuredClone(d.courses),
        games: mine.map((g) => fullGame(d, g)).sort((a, b) => b.created_at.localeCompare(a.created_at)),
      };
    },

    async saveCourse(course) {
      const d = read();
      const i = d.courses.findIndex((c) => c.id === course.id);
      if (i >= 0) d.courses[i] = course; else d.courses.unshift(course);
      write(d);
      return course;
    },
    async deleteCourse(id) {
      const d = read();
      d.courses = d.courses.filter((c) => c.id !== id);
      write(d);
    },

    async createGame({ course, teams, settings }) {
      const d = read();
      let code;
      do code = makeCode(); while (d.games.some((g) => g.code === code && g.status !== "finished"));
      const g = { id: uuid(), owner: me(), code, course_id: course.id, course: structuredClone(course), settings,
        status: "lobby", created_at: now(), started_at: null, finished_at: null };
      d.games.push(g);
      teams.forEach((t, idx) => d.teams.push({ id: uuid(), game_id: g.id, idx, name: t.name, color: t.color, level: t.level || "ado",
        captain: null, captain_name: null, progress: {}, judgments: {}, last_pos: null, finished_at: null, updated_at: now() }));
      write(d);
      return fullGame(d, g);
    },
    async deleteGame(id) {
      const d = read();
      d.games = d.games.filter((g) => g.id !== id);
      d.teams = d.teams.filter((t) => t.game_id !== id);
      d.messages = d.messages.filter((m) => m.game_id !== id);
      write(d);
    },
    async getGame(id) {
      const d = read();
      const g = d.games.find((x) => x.id === id);
      if (!g) fail("Partie introuvable");
      if (g.owner !== me() && !d.teams.some((t) => t.game_id === id && t.captain === me())) fail("Cette partie n'est pas sur ce téléphone");
      return fullGame(d, g);
    },

    async findGame(code) {
      const d = read();
      const g = d.games.find((x) => x.code === String(code).trim().toUpperCase() && x.status !== "finished");
      if (!g) return null;
      return { id: g.id, code: g.code, status: g.status, name: g.course.name, theme: g.course.theme,
        teams: d.teams.filter((t) => t.game_id === g.id).sort((a, b) => a.idx - b.idx)
          .map((t) => ({ id: t.id, idx: t.idx, name: t.name, color: t.color, taken: !!t.captain, mine: t.captain === me(), captain_name: t.captain_name })) };
    },
    async claimTeam(teamId, name) {
      const d = read();
      const t = d.teams.find((x) => x.id === teamId);
      const g = t && d.games.find((x) => x.id === t.game_id);
      if (!t || !g || g.status === "finished" || t.captain) fail("Cette équipe est déjà prise");
      t.captain = me(); t.captain_name = String(name).trim().slice(0, 30); t.updated_at = now();
      d.relay[t.id] = makeCode().slice(0, 6);
      write(d);
      return g.id;
    },
    async relayToken(teamId) {
      const d = read();
      const t = d.teams.find((x) => x.id === teamId);
      if (t?.captain !== me()) fail("Seul le capitaine peut passer le relais");
      return d.relay[teamId];
    },
    async takeOver(code, token) {
      const d = read();
      const g = d.games.find((x) => x.code === String(code).trim().toUpperCase() && x.status !== "finished");
      const t = g && d.teams.find((x) => x.game_id === g.id && d.relay[x.id] === String(token).trim().toUpperCase());
      if (!t) fail("Code de relais incorrect");
      t.captain = me(); t.updated_at = now();
      d.relay[t.id] = makeCode();
      write(d);
      return { game_id: g.id, team_id: t.id };
    },
    async releaseTeam(teamId) {
      const d = read();
      const t = d.teams.find((x) => x.id === teamId);
      const g = t && d.games.find((x) => x.id === t.game_id);
      if (g?.owner !== me()) fail("Réservé à l'organisateur");
      t.captain = null; t.captain_name = null; t.updated_at = now();
      write(d);
    },
    async setStatus(gameId, status) {
      const d = read();
      const g = d.games.find((x) => x.id === gameId);
      if (g?.owner !== me()) fail("Réservé à l'organisateur");
      g.status = status;
      if (status === "running" && !g.started_at) g.started_at = now();
      if (status === "finished") g.finished_at = now();
      write(d);
    },
    async pushTeam(teamId, patch) {
      const d = read();
      const t = d.teams.find((x) => x.id === teamId);
      if (!t || t.captain !== me()) fail("Tu n'es plus le capitaine de cette équipe");
      for (const k of ["progress", "last_pos", "finished_at"]) if (k in patch) t[k] = patch[k];
      t.updated_at = now();
      write(d);
    },
    async judge(teamId, stepId, verdict) {
      const d = read();
      const t = d.teams.find((x) => x.id === teamId);
      const g = t && d.games.find((x) => x.id === t.game_id);
      if (g?.owner !== me()) fail("Réservé à l'organisateur");
      t.judgments = { ...t.judgments, [stepId]: verdict };
      t.updated_at = now();
      write(d);
    },
    async sendMessage(gameId, teamId, text) {
      const d = read();
      d.messages.push({ id: uuid(), game_id: gameId, team_id: teamId || null, text: String(text).slice(0, 500), created_at: now() });
      write(d);
    },
    subscribe(_gameId, cb) {
      const fn = () => cb();
      listeners.add(fn);
      const onStorage = (e) => { if (e.key === KEY) cb(); };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(fn); window.removeEventListener("storage", onStorage); };
    },
    pendingUploads: () => 0,

    putMedia: (id, blob) => idb("readwrite", (s) => s.put(blob, id)),
    async getMedia(id) { return mediaUrl(id, await idb("readonly", (s) => s.get(id))); },
    async getMediaBlob(id) { const v = await idb("readonly", (s) => s.get(id)); return typeof v === "string" ? (await import("./util.js")).dataUrlToBlob(v) : v; },

    async reset() {
      localStorage.removeItem(KEY);
      sessionStorage.removeItem(ALIAS);
      await idb("readwrite", (s) => s.clear()).catch(() => {});
      write(empty());
    },
  };
}
