// Règles du jeu (sans interface) : ordre des étapes, réponses, score.

export const HINT_COST = 20;
export const MAX_WRONG = 3;      // mauvaises réponses avant une pause
export const LOCK_MS = 30000;    // durée de la pause

export const CHALLENGES = {
  enigme: "Énigme",
  photo: "Défi photo",
  balise: "Balise (arrivée seule)",
};
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

// Enregistre une réponse. Renvoie { ok, locked }.
export function registerAnswer(progress, step, given, now = Date.now()) {
  if (lockRemaining(progress, now)) return { ok: false, locked: true };
  if (checkAnswer(step, given)) {
    progress.status = "done";
    progress.points = stepPoints(step, progress.hints);
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
  if (step.challenge === "photo" && !step.question?.trim()) errors.push("Décris le défi photo");
  if (step.nav === "indice" && !step.clue?.trim()) errors.push("Écris l'indice qui mène à l'étape");
  return errors;
}

// ---------- Plusieurs équipes (jalon 2) ------------------------------------------

// Progression vue par tous : celle du capitaine, corrigée par les validations de l'organisateur.
export function mergedProgress(team) {
  const out = {};
  for (const [id, p] of Object.entries(team.progress || {})) {
    const verdict = team.judgments?.[id];
    out[id] = p.status === "pending" && verdict
      ? { ...p, status: verdict, points: verdict === "refused" ? 0 : p.points }
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
