// Talents : chaque épreuve demande un talent, nommé selon le thème du parcours.
// L'équipe se répartit les talents ; l'app appelle à chaque épreuve le joueur qui a le bon talent.
// Aucun effet sur les points. Règles pures (testées), sans interface.

// Familles de talents. « orientation » sert au trajet, les autres aux épreuves sur place.
export const FAMILIES = ["orientation", "logique", "observation", "creativite", "force", "sangfroid", "voix"];
export const FAMILY_ICON = {
  orientation: "compass", logique: "bulb", observation: "eye", creativite: "camera", force: "bolt", sangfroid: "target", voix: "megaphone",
};
export const FAMILY_LABEL = {
  orientation: "Orientation", logique: "Logique", observation: "Observation", creativite: "Créativité", force: "Force", sangfroid: "Sang-froid", voix: "Voix",
};

// Noms et phrases d'appel par thème. {name} = prénom du joueur appelé.
const T = (name, call) => ({ name, call });
export const TALENTS = {
  explo: {
    orientation: T("Éclaireur", "ouvre la marche jusqu'à la prochaine balise"),
    logique: T("Érudit", "réfléchit pour toute l'expédition"),
    observation: T("Œil de lynx", "ne laisse échapper aucun détail"),
    creativite: T("Conteur", "met l'expédition en scène"),
    force: T("Bûcheron", "a les bras les plus solides"),
    sangfroid: T("Trappeur", "garde son calme sans bouger d'un poil"),
    voix: T("Chef de meute", "donne de la voix pour toute la meute"),
  },
  pirates: {
    orientation: T("Navigateur", "tient le cap jusqu'à la prochaine escale"),
    logique: T("Cartographe", "déchiffre les cartes mieux que personne"),
    observation: T("Vigie", "repère tout du haut du mât"),
    creativite: T("Barde", "fait le spectacle pour l'équipage"),
    force: T("Gabier", "hisse les voiles à la force des bras"),
    sangfroid: T("Timonier", "tient la barre sans trembler"),
    voix: T("Crieur de bord", "fait trembler les voiles"),
  },
  enquete: {
    orientation: T("Fileur", "suit la piste sans se faire repérer"),
    logique: T("Cerveau", "relie les indices entre eux"),
    observation: T("Limier", "flaire le moindre détail"),
    creativite: T("Portraitiste", "immortalise la scène"),
    force: T("Gros bras", "s'occupe des tâches musclées"),
    sangfroid: T("Démineur", "a des nerfs d'acier"),
    voix: T("Commissaire", "donne de la voix pour toute la brigade"),
  },
  espace: {
    orientation: T("Pilote", "guide l'équipage jusqu'à la prochaine planète"),
    logique: T("Ingénieur", "résout les problèmes de bord"),
    observation: T("Astronome", "scrute chaque recoin de l'horizon"),
    creativite: T("Reporter de bord", "raconte la mission en images"),
    force: T("Mécano", "remet les moteurs en marche à la force des bras"),
    sangfroid: T("Spécialiste de l'amarrage", "manœuvre sans trembler"),
    voix: T("Opérateur radio", "transmet le message jusqu'à la base"),
  },
};
export const talent = (themeId, family) => (TALENTS[themeId] || TALENTS.explo)[family] || TALENTS.explo.logique;

// Talent demandé par une épreuve : celui choisi par l'organisateur, sinon selon le type d'épreuve.
export function defaultTalent(step) {
  if (step.challenge === "enigme") return "logique";
  if (step.challenge === "photo" || step.challenge === "video") return "creativite";
  if (step.challenge === "jeu") return { secousse: "force", niveau: "sangfroid", cri: "voix" }[step.game?.kind] || "force";
  return "observation"; // balise : arrivée seule
}
export const stepTalent = (step) => (FAMILIES.includes(step.talent) && step.talent !== "orientation" ? step.talent : defaultTalent(step));

// Talents utiles pour un parcours : l'orientation (le trajet), puis ceux des épreuves, dans l'ordre des familles.
export function usedFamilies(steps) {
  const used = new Set(["orientation", ...steps.map(stepTalent)]);
  return FAMILIES.filter((f) => used.has(f));
}

// Répartition automatique : chaque joueur reçoit au moins un talent, chaque talent au moins un joueur.
// Renvoie { famille: [indices des joueurs] }.
export function autoAssign(count, families) {
  const out = Object.fromEntries(families.map((f) => [f, []]));
  if (!count || !families.length) return out;
  for (let i = 0; i < Math.max(count, families.length); i++) {
    const f = families[i % families.length];
    const m = i % count;
    if (!out[f].includes(m)) out[f].push(m);
  }
  return out;
}

// Joueur appelé pour une famille à l'étape stepId : les joueurs qui ont ce talent passent à tour de rôle,
// dans l'ordre des étapes de l'équipe. Renvoie le prénom, ou null si l'équipage n'est pas renseigné.
export function whoFor(crew, order, steps, stepId, family) {
  const ids = crew?.assign?.[family];
  if (!crew?.members?.length || !ids?.length) return null;
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const upTo = order.slice(0, order.indexOf(stepId) + 1);
  const k = family === "orientation" ? upTo.length - 1 : upTo.filter((id) => byId[id] && stepTalent(byId[id]) === family).length - 1;
  const m = ids[Math.max(0, k) % ids.length];
  return crew.members[m]?.trim() || null;
}

// Nettoie un équipage saisi : prénoms non vides, indices valides, au moins un joueur par talent.
export function normalizeCrew(members, assign, families) {
  const names = members.map((n) => String(n || "").trim().slice(0, 30));
  const keep = names.map((n, i) => (n ? i : -1)).filter((i) => i >= 0);
  const remap = Object.fromEntries(keep.map((old, i) => [old, i]));
  const clean = keep.map((i) => names[i]);
  const auto = autoAssign(clean.length, families);
  const out = {};
  for (const f of families) {
    const ids = (assign?.[f] || []).filter((i) => i in remap).map((i) => remap[i]);
    out[f] = ids.length ? [...new Set(ids)] : auto[f];
  }
  // Chacun son moment : un joueur sans talent rejoint le talent qui a le moins de joueurs.
  clean.forEach((_, m) => {
    if (!families.length || families.some((f) => out[f].includes(m))) return;
    const f = families.reduce((a, b) => (out[b].length < out[a].length ? b : a));
    out[f].push(m);
  });
  return { members: clean, assign: out };
}
