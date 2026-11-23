// Thèmes : couleurs et vocabulaire. Les énigmes ne changent pas.
export const THEMES = {
  explo: {
    name: "Exploration", desc: "Nature, forêt, boussole",
    hero: "#1F4D3A", heroInk: "#FFFDF7", accent: "#B5541C",
    words: { team: "Expédition", teams: "Expéditions", step: "balise", steps: "balises", reward: "trésor" },
    teamNames: ["Les Renards", "Les Écureuils", "Les Hiboux", "Les Blaireaux", "Les Cerfs", "Les Lynx"],
    intro: "Suivez la boussole, lisez le paysage, trouvez le trésor.",
  },
  pirates: {
    name: "Pirates", desc: "Îles, cartes, coffres",
    hero: "#0E3A5C", heroInk: "#FFF7E6", accent: "#B23A2B",
    words: { team: "Équipage", teams: "Équipages", step: "escale", steps: "escales", reward: "butin" },
    teamNames: ["Les Requins", "Les Mouettes", "Les Pieuvres", "Les Corsaires", "Les Flibustiers", "Les Boucaniers"],
    intro: "Hissez les voiles, moussaillons : le coffre vous attend.",
  },
  enquete: {
    name: "Enquête", desc: "Indices, suspects, mystère",
    hero: "#2B2B33", heroInk: "#F5F2EA", accent: "#8A5A00",
    words: { team: "Brigade", teams: "Brigades", step: "piste", steps: "pistes", reward: "coupable" },
    teamNames: ["Brigade Loupe", "Brigade Pipe", "Brigade Chapeau", "Brigade Empreinte", "Brigade Carnet", "Brigade Lanterne"],
    intro: "Un objet a disparu. Suivez les pistes, démasquez le coupable.",
  },
  espace: {
    name: "Espace", desc: "Planètes, missions, signaux",
    hero: "#1E1A4D", heroInk: "#F2F0FF", accent: "#3D6FD1",
    words: { team: "Équipage", teams: "Équipages", step: "planète", steps: "planètes", reward: "signal" },
    teamNames: ["Apollo", "Orion", "Vega", "Andromède", "Pégase", "Cassiopée"],
    intro: "Un signal a été capté. Rejoignez chaque planète avant l'aube.",
  },
};

export const theme = (id) => THEMES[id] || THEMES.explo;

export function applyTheme(id) {
  const t = theme(id);
  const r = document.documentElement.style;
  r.setProperty("--hero", t.hero);
  r.setProperty("--hero-ink", t.heroInk);
  r.setProperty("--accent", t.accent);
}

// Couleurs d'équipes : clartés différentes, lisibles par les daltoniens.
export const TEAM_COLORS = ["#B5541C", "#2F5FB8", "#6B3FA8", "#1B7A4B", "#A0306A", "#7A5A00"];
