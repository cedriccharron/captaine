// Stockage en ligne : Supabase (sessions anonymes, base de données, temps réel, photos).
// Le téléphone du capitaine reste la référence : ses envois partent d'une file d'attente
// qui se vide dès que le réseau revient. Même interface que store-demo.js.
import { CONFIG } from "./config.js";
import { uuid } from "./util.js";

const OUTBOX = "captaine-outbox";   // {teams: {teamId: patch}, media: [{id, gameId, teamId}]}
const CACHE = "captaine-cache";     // dernières parties connues, pour jouer hors ligne

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Bibliothèque Supabase introuvable"));
    document.head.appendChild(s);
  });
}

const readJSON = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage plein */ } };
const isNetworkError = (e) => !navigator.onLine || /fetch|network|Failed to|Load failed/i.test(String(e?.message || e));

// ---------- Photos en attente (IndexedDB) ----------------------------------------
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
const dataUrlToBlob = async (dataUrl) => (await fetch(dataUrl)).blob();

export async function createSupabaseStore() {
  if (!window.supabase) await loadScript("js/vendor/supabase.js");
  const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  let userId = null;

  const must = ({ data, error }) => {
    if (error) throw new Error(translate(error.message));
    return data;
  };

  // ---------- File d'envoi -----------------------------------------------------
  const outbox = () => readJSON(OUTBOX, { teams: {}, media: [] });
  let flushing = false;
  async function flush() {
    if (flushing || !navigator.onLine) return;
    flushing = true;
    try {
      const box = outbox();
      for (const [teamId, patch] of Object.entries(box.teams)) {
        try {
          must(await sb.from("teams").update(patch).eq("id", teamId));
          const b = outbox();
          if (JSON.stringify(b.teams[teamId]) === JSON.stringify(patch)) delete b.teams[teamId]; // rien de plus récent entre-temps
          writeJSON(OUTBOX, b);
        } catch (e) {
          if (!isNetworkError(e)) { const b = outbox(); delete b.teams[teamId]; writeJSON(OUTBOX, b); }
        }
      }
      for (const m of [...box.media]) {
        try {
          const data = await idb("readonly", (s) => s.get(m.id));
          if (data) {
            const { error } = await sb.storage.from("photos").upload(`${m.gameId}/${m.teamId}/${m.id}.jpg`, await dataUrlToBlob(data), { contentType: "image/jpeg", upsert: true });
            if (error && !/exists/i.test(error.message)) throw error;
          }
          const b = outbox(); b.media = b.media.filter((x) => x.id !== m.id); writeJSON(OUTBOX, b);
        } catch { /* on réessaiera */ }
      }
    } finally { flushing = false; }
  }
  window.addEventListener("online", flush);
  setInterval(flush, 20000);

  // ---------- Lecture --------------------------------------------------------------
  const cache = () => readJSON(CACHE, {});
  function withOutbox(game) {
    const box = outbox();
    return { ...game, teams: game.teams.map((t) => (box.teams[t.id] ? { ...t, ...box.teams[t.id] } : t)) };
  }
  async function fetchGame(id) {
    const g = must(await sb.from("games").select("*, teams(*), messages(*)").eq("id", id).maybeSingle());
    if (!g) throw new Error("Partie introuvable");
    g.teams.sort((a, b) => a.idx - b.idx);
    g.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const c = cache(); c[id] = g; writeJSON(CACHE, c);
    return g;
  }

  return {
    mode: "cloud",
    me: () => userId,

    async init() {
      let { data: { session } } = await sb.auth.getSession();
      if (!session) {
        try { session = must(await sb.auth.signInAnonymously()).session; }
        catch (e) { if (!isNetworkError(e)) throw e; }
      }
      userId = session?.user?.id || readJSON("captaine-user", null);
      if (userId) writeJSON("captaine-user", userId);
      if (!userId) throw new Error("Première ouverture : connecte-toi à internet");
      flush();
      return { user: { id: userId } };
    },

    async loadAll() {
      try {
        const [courses, games] = await Promise.all([
          sb.from("courses").select("*").order("updated_at", { ascending: false }).then(must),
          sb.from("games").select("*, teams(*), messages(*)").order("created_at", { ascending: false }).limit(50).then(must),
        ]);
        for (const g of games) { g.teams.sort((a, b) => a.idx - b.idx); g.messages.sort((a, b) => a.created_at.localeCompare(b.created_at)); }
        const data = { courses: courses.map((r) => ({ ...r.data, id: r.id })), games };
        writeJSON("captaine-all", data);
        const c = cache(); for (const g of games) c[g.id] = g; writeJSON(CACHE, c);
        return { ...data, games: data.games.map(withOutbox) };
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        const data = readJSON("captaine-all", { courses: [], games: [] });
        const c = cache();
        return { courses: data.courses, games: data.games.map((g) => withOutbox(c[g.id] || g)), offline: true };
      }
    },

    async saveCourse(course) {
      const { id, ...data } = course;
      must(await sb.from("courses").upsert({ id, data: { ...data, id }, updated_at: new Date().toISOString() }));
      return course;
    },
    async deleteCourse(id) { must(await sb.from("courses").delete().eq("id", id)); },

    async createGame({ course, teams, settings }) {
      const { makeCode } = await import("./game.js");
      let game;
      for (let i = 0; i < 5 && !game; i++) {
        const { data, error } = await sb.from("games").insert({ code: makeCode(), course_id: course.id, course, settings }).select().single();
        if (!error) game = data;
        else if (!/duplicate|unique/i.test(error.message)) throw new Error(translate(error.message));
      }
      if (!game) throw new Error("Impossible de créer la partie, réessaie");
      must(await sb.from("teams").insert(teams.map((t, idx) => ({ game_id: game.id, idx, name: t.name, color: t.color, level: t.level || "ado" }))));
      return fetchGame(game.id);
    },
    async deleteGame(id) { must(await sb.from("games").delete().eq("id", id)); },

    async getGame(id) {
      try { return withOutbox(await fetchGame(id)); }
      catch (e) {
        if (!isNetworkError(e)) throw e;
        const g = cache()[id];
        if (!g) throw new Error("Pas de réseau, et cette partie n'est pas encore sur ce téléphone");
        return { ...withOutbox(g), offline: true };
      }
    },

    async findGame(code) { return must(await sb.rpc("find_game", { p_code: code })); },
    async claimTeam(teamId, name) { return must(await sb.rpc("claim_team", { p_team: teamId, p_name: name })); },
    async takeOver(code, token) { return must(await sb.rpc("take_over", { p_code: code, p_token: token })); },
    async relayToken(teamId) {
      const row = must(await sb.from("team_relay").select("token").eq("team_id", teamId).maybeSingle());
      if (!row) throw new Error("Seul le capitaine peut passer le relais");
      return row.token;
    },
    async releaseTeam(teamId) { must(await sb.from("teams").update({ captain: null, captain_name: null }).eq("id", teamId)); },
    async setStatus(gameId, status) {
      const patch = { status };
      if (status === "running") patch.started_at = new Date().toISOString();
      if (status === "finished") patch.finished_at = new Date().toISOString();
      must(await sb.from("games").update(patch).eq("id", gameId));
    },

    // Envoi de la progression du capitaine : file d'attente si pas de réseau.
    async pushTeam(teamId, patch) {
      const box = outbox();
      box.teams[teamId] = { ...(box.teams[teamId] || {}), ...patch };
      writeJSON(OUTBOX, box);
      const c = cache();
      for (const g of Object.values(c)) for (const t of g.teams || []) if (t.id === teamId) Object.assign(t, patch);
      writeJSON(CACHE, c);
      await flush();
    },
    async judge(teamId, stepId, verdict) {
      const t = must(await sb.from("teams").select("judgments").eq("id", teamId).single());
      must(await sb.from("teams").update({ judgments: { ...t.judgments, [stepId]: verdict } }).eq("id", teamId));
    },
    async sendMessage(gameId, teamId, text) {
      must(await sb.from("messages").insert({ game_id: gameId, team_id: teamId || null, text }));
    },

    subscribe(gameId, cb) {
      let timer;
      const ping = () => { clearTimeout(timer); timer = setTimeout(cb, 250); };
      const ch = sb.channel(`game-${gameId}-${uuid().slice(0, 6)}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "teams", filter: `game_id=eq.${gameId}` }, ping)
        .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: `id=eq.${gameId}` }, ping)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `game_id=eq.${gameId}` }, ping)
        .subscribe();
      const onOnline = () => ping();
      window.addEventListener("online", onOnline);
      return () => { sb.removeChannel(ch); window.removeEventListener("online", onOnline); clearTimeout(timer); };
    },
    pendingUploads: () => { const b = outbox(); return b.media.length + Object.keys(b.teams).length; },

    // Photos : gardées sur le téléphone, envoyées dès que possible.
    async putMedia(id, dataUrl, { gameId, teamId } = {}) {
      await idb("readwrite", (s) => s.put(dataUrl, id));
      const box = outbox(); box.media.push({ id, gameId, teamId }); writeJSON(OUTBOX, box);
      flush();
    },
    async getMedia(id, { gameId, teamId } = {}) {
      const local = await idb("readonly", (s) => s.get(id)).catch(() => null);
      if (local) return local;
      if (!gameId || !teamId) return null;
      const { data } = await sb.storage.from("photos").createSignedUrl(`${gameId}/${teamId}/${id}.jpg`, 3600);
      return data?.signedUrl || null;
    },

    // « Sécuriser mes parcours » : rattache un e-mail à la session anonyme.
    async linkEmail(email) {
      must(await sb.auth.updateUser({ email }));
    },
  };
}

function translate(msg) {
  const map = {
    "Anonymous sign-ins are disabled": "Active « Allow anonymous sign-ins » dans Supabase (Authentication)",
    "JWT expired": "Session expirée, recharge l'app",
  };
  return map[msg] || msg;
}
