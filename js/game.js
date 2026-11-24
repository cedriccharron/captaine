// Règles du jeu (sans interface) : ordre des étapes, réponses, score.

export const HINT_COST = 20;
export const MAX_WRONG = 3;      // mauvaises réponses avant une pause
export const LOCK_MS = 30000;    // durée de la pause

export const CHALLENGES = {
  enigme: "Énigme",
  photo: "Défi photo",
  video: "Défi vidéo",
  jeu: "Mini-jeu",
  balise: "Balise",
};
export const CHALLENGE_LONG = { ...CHALLENGES, balise: "Balise (arrivée seule)" };
// Épreuves dont les points attendent la validation de l'organisateur.
export const needsJudge = (s) => s.challenge === "photo" || s.challenge === "video";
export const NAVS = {
  boussole: "Boussole",
  indice: "Indice seul",
  radar: "Radar",
};
export const LEVELS = { enfant: "Enfant", ado: "Ado / adulte" };

// Ordre circulaire : l'équipe n° k commence à l'étape k, puis enchaîne la boucle.
// Une étape marquée « finale » reste toujours la dernière, pour toutes les équipes.
export function teamOrder(steps, teamIndex = 0) {
  const loop = steps.filter((s) => !s.final);
  const finals = steps.filter((s) => s.final);
  const n = loop.length;
  const k = n ? ((teamIndex % n) + n) % n : 0;
  return [...loop.slice(k), ...loop.slice(0, k), ...finals].map((s) => s.id);
}

// Comparaison tolérante : majuscules, accents, espaces et ponctuation ignorés.
export function normalize(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/œ/g, "oe").replace(/æ/g, "ae")
    .replace(/[^a-z0-9]/g, "");
}

export function parseAnswers(text) {
  return String(text ?? "").split(/[\n;|]/).map((s) => s.trim()).filter(Boolean);
}

export function checkAnswer(step, given) {
  const g = normalize(given);
  if (!g) return false;
  return (step.answers || []).some((a) => normalize(a) === g);
}

// Points d'une étape réussie : valeur moins les indices, jamais négatif.
export function stepPoints(step, hintsUsed) {
  return Math.max(0, (Number(step.points) || 0) - HINT_COST * (hintsUsed || 0));
}

// ---------- Points selon la performance ------------------------------------------------
// Énigme : tous les points pendant FAST_MS, puis baisse régulière jusqu'à SLOW_SHARE des points
// au temps de référence de l'énigme (refMin, en minutes), et plus rien ne baisse ensuite.
export const FAST_MS = 60000;
export const SLOW_SHARE = 0.3;
export const REF_MINUTES = [2, 5, 10, 15];
export const DEFAULT_REF_MIN = 5;
export function speedShare(elapsedMs, refMin = DEFAULT_REF_MIN) {
  const ref = Math.max(FAST_MS + 1, (Number(refMin) || DEFAULT_REF_MIN) * 60000);
  const t = Math.max(0, Number(elapsedMs) || 0);
  if (t <= FAST_MS) return 1;
  if (t >= ref) return SLOW_SHARE;
  return 1 - (1 - SLOW_SHARE) * (t - FAST_MS) / (ref - FAST_MS);
}
// Points d'une énigme résolue en elapsedMs (null = chrono inconnu : tous les points), moins les indices.
export function enigmaPoints(step, hintsUsed, elapsedMs) {
  const base = Number(step.points) || 0;
  const share = elapsedMs == null ? 1 : speedShare(elapsedMs, step.refMin);
  return Math.max(0, Math.round(base * share) - HINT_COST * (hintsUsed || 0));
}
// Début du chrono d'une énigme : l'arrivée sur place, sinon le moment où l'étape est devenue
// la suivante à jouer (fin de l'étape précédente, ou début de la partie).
export function enigmaStart(play, stepId, startedAt) {
  const p = play.progress?.[stepId];
  if (p?.arrivedAt) return p.arrivedAt;
  const i = play.order.indexOf(stepId);
  const prev = play.order.slice(0, Math.max(0, i)).map((id) => play.progress?.[id]?.solvedAt || 0);
  const start = startedAt ? new Date(startedAt).getTime() : null;
  return Math.max(start || 0, ...prev) || null;
}

// Mini-jeu : points proportionnels au résultat (objectif atteint = tous les points). Le meilleur de 2 essais compte.
export const GAME_TRIES = 2;
export function gamePoints(step, value) {
  const target = Number(step.game?.target) || 1;
  return Math.round((Number(step.points) || 0) * Math.min(1, Math.max(0, Number(value) || 0) / target));
}
// Enregistre un essai de mini-jeu. Renvoie { done, points } : terminé si l'objectif est atteint ou les essais épuisés.
export function registerTry(progress, step, value, now = Date.now()) {
  progress.tries = (progress.tries || 0) + 1;
  progress.best = Math.max(progress.best || 0, Number(value) || 0);
  const points = gamePoints(step, progress.best);
  const done = progress.best >= (Number(step.game?.target) || 1) || progress.tries >= GAME_TRIES;
  if (done) Object.assign(progress, { status: "done", points, solvedAt: now });
  return { done, points, triesLeft: Math.max(0, GAME_TRIES - progress.tries) };
}

// Défi photo / vidéo : le juge classe les envois d'un même défi. Part des points selon la place.
export const RANK_SHARES = [1, 0.8, 0.6, 0.5];
export const rankShare = (rank) => RANK_SHARES[Math.min(Math.max(1, rank), RANK_SHARES.length) - 1];
// Une décision du juge : "refused", "done" (ancien format : tous les points) ou { verdict: "done", rank }.
export const verdictOf = (j) => (j && typeof j === "object" ? j.verdict : j) || null;
export function judgedPoints(points, judgment) {
  const v = verdictOf(judgment);
  if (v === "refused") return 0;
  if (v === "done" && typeof judgment === "object" && judgment.rank) return Math.round((points || 0) * rankShare(judgment.rank));
  return points || 0;
}

// Score d'une partie : points acquis et points en attente de validation.
export function score(game) {
  let won = 0;
  let pending = 0;
  for (const p of Object.values(game.progress || {})) {
    if (p.status === "done") won += p.points || 0;
    if (p.status === "pending") pending += p.points || 0;
  }
  return { won, pending };
}

// L'étape suivante à jouer, ou null si la partie est finie.
export function currentStepId(game) {
  return game.order.find((id) => {
    const st = game.progress?.[id]?.status;
    return st !== "done" && st !== "pending" && st !== "skipped";
  }) ?? null;
}

export function isFinished(game) {
  return currentStepId(game) == null;
}

// Pause après trop de mauvaises réponses : renvoie le nombre de ms restantes.
export function lockRemaining(progress, now = Date.now()) {
  return progress?.lockUntil && progress.lockUntil > now ? progress.lockUntil - now : 0;
}

// Enregistre une réponse. Renvoie { ok, locked }. startedAt : début du chrono (voir enigmaStart).
export function registerAnswer(progress, step, given, now = Date.now(), startedAt = null) {
  if (lockRemaining(progress, now)) return { ok: false, locked: true };
  if (checkAnswer(step, given)) {
    progress.status = "done";
    progress.points = enigmaPoints(step, progress.hints, startedAt == null ? null : now - startedAt);
    progress.solvedAt = now;
    return { ok: true, locked: false };
  }
  progress.wrong = (progress.wrong || 0) + 1;
  if (progress.wrong % MAX_WRONG === 0) progress.lockUntil = now + LOCK_MS;
  return { ok: false, locked: !!progress.lockUntil && progress.lockUntil > now };
}

export function validateStep(step) {
  const errors = [];
  if (!step.title?.trim()) errors.push("Donne un nom à l'étape");
  if (!Number.isFinite(step.lat) || !Number.isFinite(step.lng)) errors.push("Place l'étape (bouton « Ma position »)");
  if (step.challenge === "enigme") {
    if (!step.question?.trim()) errors.push("Écris l'énigme");
    if (!step.answers?.length) errors.push("Indique au moins une réponse acceptée");
  }
  if (needsJudge(step) && !step.question?.trim()) errors.push(`Décris le défi ${step.challenge === "video" ? "vidéo" : "photo"}`);
  if (step.challenge === "jeu" && !step.game?.kind) errors.push("Choisis le mini-jeu");
  if (step.nav === "indice" && !step.clue?.trim()) errors.push("Écris l'indice qui mène à l'étape");
  return errors;
}

// ---------- Plusieurs équipes (jalon 2) ------------------------------------------

// Progression vue par tous : celle du capitaine, corrigée par les validations de l'organisateur.
export function mergedProgress(team) {
  const out = {};
  for (const [id, p] of Object.entries(team.progress || {})) {
    const j = team.judgments?.[id];
    const verdict = verdictOf(j);
    out[id] = p.status === "pending" && verdict
      ? { ...p, status: verdict, points: judgedPoints(p.points, j), rank: j?.rank || null }
      : { ...p };
  }
  return out;
}

// Vue « jeu » d'une équipe : ordre de ses étapes + progression fusionnée.
export function teamPlay(game, team) {
  return { order: teamOrder(game.course.steps, team.idx), progress: mergedProgress(team) };
}

export function teamScore(game, team) {
  return score(teamPlay(game, team));
}

// Classement : points acquis, puis l'équipe qui a fini la première.
export function ranking(game) {
  return [...(game.teams || [])]
    .map((t) => {
      const play = teamPlay(game, t);
      const done = play.order.filter((id) => ["done", "pending", "refused", "skipped"].includes(play.progress[id]?.status)).length;
      return { team: t, ...score(play), done, total: play.order.length };
    })
    .sort((a, b) => b.won - a.won
      || (a.team.finished_at ? new Date(a.team.finished_at) : Infinity) - (b.team.finished_at ? new Date(b.team.finished_at) : Infinity)
      || b.done - a.done);
}

// Code de partie lisible : 6 caractères sans 0/O ni 1/I/L.
export function makeCode(rand = Math.random) {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => A[Math.floor(rand() * A.length)]).join("");
}

export const pendingCount = (team) =>
  Object.entries(team.progress || {}).filter(([id, p]) => p.status === "pending" && !team.judgments?.[id]).length;
