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
