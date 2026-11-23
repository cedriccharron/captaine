import assert from "node:assert/strict";
import { distance, bearing, offset, warmth } from "../js/geo.js";
import { teamOrder, normalize, checkAnswer, stepPoints, score, currentStepId, isFinished, registerAnswer, lockRemaining, validateStep, parseAnswers } from "../js/game.js";

const p = { lat: 50.8448, lng: 4.364 };
const q = offset(p, 250, 70);
assert.ok(Math.abs(distance(p, q) - 250) < 0.5, "offset/distance");
assert.ok(Math.abs(bearing(p, q) - 70) < 0.5, "bearing");
assert.equal(warmth(100, 80), "chaud"); assert.equal(warmth(50, 40), "brulant"); assert.equal(warmth(80, 100), "froid"); assert.equal(warmth(80, 81), null);

const steps = ["a","b","c","d"].map((id) => ({ id })); steps.push({ id: "f", final: true });
assert.deepEqual(teamOrder(steps, 0), ["a","b","c","d","f"]);
assert.deepEqual(teamOrder(steps, 1), ["b","c","d","a","f"]);
assert.deepEqual(teamOrder(steps, 5), ["b","c","d","a","f"]);

assert.equal(normalize("  Le Trésor! "), "letresor");
const st = { answers: parseAnswers("1874\nmille huit cent soixante-quatorze"), points: 50 };
assert.ok(checkAnswer(st, " 1874 ")); assert.ok(checkAnswer(st, "Mille-huit-cent soixante quatorze")); assert.ok(!checkAnswer(st, "1875")); assert.ok(!checkAnswer(st, ""));
assert.equal(stepPoints(st, 1), 30); assert.equal(stepPoints({ points: 30 }, 2), 0);

const prog = { hints: 1, wrong: 0 }; const t0 = 1_000_000;
assert.deepEqual(registerAnswer(prog, st, "x", t0), { ok: false, locked: false });
registerAnswer(prog, st, "y", t0);
assert.equal(registerAnswer(prog, st, "z", t0).locked, true);
assert.equal(registerAnswer(prog, st, "1874", t0 + 1000).locked, true, "locked blocks even right answer");
assert.ok(lockRemaining(prog, t0 + 1000) > 0);
assert.equal(registerAnswer(prog, st, "1874", t0 + 31000).ok, true);
assert.equal(prog.points, 30);

const g = { order: ["a","b","c"], progress: { a: { status: "done", points: 50 }, b: { status: "pending", points: 50 } } };
assert.deepEqual(score(g), { won: 50, pending: 50 });
assert.equal(currentStepId(g), "c"); assert.ok(!isFinished(g));
g.progress.c = { status: "skipped" }; assert.ok(isFinished(g));

assert.ok(validateStep({ title: "", challenge: "enigme", nav: "boussole" }).length >= 3);
assert.deepEqual(validateStep({ title: "x", lat: 1, lng: 2, challenge: "balise", nav: "boussole" }), []);
console.log("Tous les tests de logique passent");

// Jalon 2
import { mergedProgress, teamPlay, teamScore, ranking, makeCode, pendingCount } from "../js/game.js";
{
  const course = { steps: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  const t1 = { idx: 0, progress: { a: { status: "done", points: 50 }, b: { status: "pending", points: 50 } }, judgments: { b: "done" }, finished_at: null };
  const t2 = { idx: 1, progress: { b: { status: "done", points: 50 }, c: { status: "pending", points: 50 } }, judgments: { c: "refused" } };
  const game = { course, teams: [t2, t1] };
  assert.equal(mergedProgress(t1).b.status, "done");
  assert.equal(mergedProgress(t2).c.points, 0);
  assert.deepEqual(teamPlay(game, t2).order, ["b", "c", "a"]);
  assert.deepEqual(teamScore(game, t1), { won: 100, pending: 0 });
  assert.equal(ranking(game)[0].team, t1);
  assert.equal(pendingCount({ progress: { x: { status: "pending" }, y: { status: "pending" } }, judgments: { x: "done" } }), 1);
  assert.match(makeCode(), /^[A-HJ-KM-NP-Z2-9]{6}$/);
}
console.log("Tests jalon 2 OK");

// Jalon 3 : mini-jeux
import { createShakeDetector, createLevelDetector, createShoutDetector, rms } from "../js/minigames.js";
{
  const sh = createShakeDetector({ threshold: 14, minGapMs: 180 });
  let t = 0;
  for (let i = 0; i < 10; i++) { sh.push(20, t); sh.push(25, t + 20); sh.push(2, t + 60); t += 250; } // 10 secousses nettes
  assert.equal(sh.count, 10);
  const sh2 = createShakeDetector({ threshold: 14, minGapMs: 180 });
  sh2.push(20, 0); sh2.push(3, 50); sh2.push(20, 100); // trop rapproché
  assert.equal(sh2.count, 1);
  const lv = createLevelDetector({ maxTilt: 6, holdMs: 1000 });
  assert.equal(lv.push(1, 1, 0).done, false);
  assert.equal(lv.push(2, -2, 600).held, 600);
  assert.equal(lv.push(10, 0, 700).held, 0, "trop penché : remise à zéro");
  lv.push(0, 0, 800); assert.equal(lv.push(0, 0, 1900).done, true);
  const cr = createShoutDetector({ threshold: 0.2, holdMs: 500 });
  let r; for (let i = 0; i <= 10; i++) r = cr.push(i % 2 ? 0.5 : 0.3, i * 60);
  assert.ok(r.done);
  assert.ok(Math.abs(rms([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9);
}
import { validateStep as vs3, needsJudge } from "../js/game.js";
assert.ok(needsJudge({ challenge: "video" }));
assert.deepEqual(vs3({ title: "x", lat: 1, lng: 1, nav: "boussole", challenge: "jeu", game: { kind: "secousse", target: 30 } }), []);
assert.equal(vs3({ title: "x", lat: 1, lng: 1, nav: "boussole", challenge: "jeu" }).length, 1);
console.log("Tests jalon 3 OK");

// Lieu saisi à la main (liens et coordonnées Google Maps)
{
  const { parseLocation } = await import("../js/geo.js");
  const near = (r, lat, lng) => r && Math.abs(r.lat - lat) < 1e-4 && Math.abs(r.lng - lng) < 1e-4;
  assert.ok(near(parseLocation("50.8448, 4.364"), 50.8448, 4.364), "décimal");
  assert.ok(near(parseLocation(" -33.8568 151.2153 "), -33.8568, 151.2153), "décimal négatif");
  assert.ok(near(parseLocation(`50°50'41.3"N 4°21'50.4"E`), 50.844806, 4.364), "DMS");
  assert.ok(near(parseLocation(`33°51'24.5"S 151°12'55.1"E`), -33.856806, 151.215306), "DMS sud");
  assert.ok(near(parseLocation("https://www.google.com/maps/place/Grand-Place/@50.8467,4.3499,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d50.846777!4d4.352360"), 50.846777, 4.35236), "épingle !3d!4d prioritaire");
  assert.ok(near(parseLocation("https://www.google.com/maps/@50.8467,4.3499,17z"), 50.8467, 4.3499), "centre @");
  assert.ok(near(parseLocation("https://maps.google.com/?q=50.8448,4.364"), 50.8448, 4.364), "q=");
  assert.ok(near(parseLocation("https://www.google.com/maps/search/?api=1&query=50.8448%2C4.364"), 50.8448, 4.364), "query= encodé");
  assert.equal(parseLocation("https://maps.app.goo.gl/AbCdEf123"), null, "lien court");
  assert.equal(parseLocation("Grand-Place Bruxelles"), null, "adresse");
  assert.equal(parseLocation("95, 4"), null, "hors limites");
  assert.equal(parseLocation(""), null);
  console.log("Tests lieu saisi OK");
}
