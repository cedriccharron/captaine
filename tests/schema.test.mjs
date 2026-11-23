// Test du schéma Supabase dans un Postgres en mémoire : npm i @electric-sql/pglite puis node tests/schema.test.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
const db = new PGlite();
const q = (s) => db.exec(s);
await q(`
create role authenticated; create role anon;
create schema auth; create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean not null default true);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
create schema storage; create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id serial primary key, bucket_id text, name text); alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
create publication supabase_realtime;
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000000b'),('00000000-0000-0000-0000-00000000000c'),('00000000-0000-0000-0000-00000000000d'),('00000000-0000-0000-0000-000000000009');
insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a', 'Admin@Test.be', now(), false),      -- admin
  ('00000000-0000-0000-0000-00000000000e', 'autre@test.be', now(), false),      -- compte non admin
  ('00000000-0000-0000-0000-00000000000f', 'pasconfirme@test.be', null, false); -- admin pas encore confirmé
`);
const schema = fs.readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
await q(schema); await q(schema); // relançable
await q(`insert into public.admins (email) values ('admin@test.be'), ('pasconfirme@test.be') on conflict do nothing`);
await q(`grant usage on schema public, storage to authenticated; grant all on all tables in schema public, storage to authenticated; grant usage on all sequences in schema storage to authenticated;`);
const as = async (u, sql) => { await q(`reset role; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000${u}'; set role authenticated;`); return db.query(sql); };
const expectFail = async (u, sql, label) => { try { await as(u, sql); console.log("FAIL (should be refused):", label); } catch (e) { console.log("ok refused:", label, "-", e.message.split("\n")[0]); } };
// a = organisateur, b et c = capitaines, d = intrus
let r = await as("a", `insert into games (code, course) values ('K7RX42', '{"name":"Test","theme":"explo","steps":[]}') returning id`);
const g = r.rows[0].id;
await as("a", `insert into teams (game_id, idx, name, color) values ('${g}',0,'Renards','#B5541C'),('${g}',1,'Ecureuils','#2F5FB8')`);
r = await as("b", `select find_game('k7rx42') as f`); const f = r.rows[0].f; console.log("find:", f.name, f.teams.length, "teams");
const t0 = f.teams[0].id, t1 = f.teams[1].id;
await as("b", `select claim_team('${t0}', 'Tom')`); console.log("b claimed team 0");
await expectFail("c", `select claim_team('${t0}', 'Léa')`, "claim already taken");
await as("c", `select claim_team('${t1}', 'Léa')`);
r = await as("b", `select count(*) from teams`); console.log("b sees teams:", r.rows[0].count);
r = await as("d", `select count(*) from teams`); console.log("intrus sees teams:", r.rows[0].count);
r = await as("d", `select count(*) from games`); console.log("intrus sees games:", r.rows[0].count);
r = await as("b", `update teams set progress = '{"x":{"status":"done"}}', last_pos='{"lat":1}' where id='${t0}' returning id`); console.log("b updates own progress:", r.rows.length);
r = await as("b", `update teams set progress = '{}' where id='${t1}' returning id`); console.log("b updates other team rows:", r.rows.length);
await expectFail("b", `update teams set judgments = '{"x":"done"}' where id='${t0}'`, "captain writes judgments");
r = await as("a", `update teams set judgments = '{"x":"done"}' where id='${t0}' returning id`); console.log("owner judges:", r.rows.length);
r = await as("b", `select token from team_relay`); console.log("b relay tokens visible:", r.rows.length); const tok = r.rows[0].token;
r = await as("c", `select token from team_relay`); console.log("c relay tokens visible:", r.rows.length);
r = await as("d", `select take_over('K7RX42', '${tok}') as t`); console.log("d took over:", r.rows[0].t.team_id === t0);
r = await as("b", `update teams set progress='{}' where id='${t0}' returning id`); console.log("old captain b can still write:", r.rows.length);
await expectFail("d", `select take_over('K7RX42', '${tok}')`, "reuse relay token");
await as("a", `insert into messages (game_id, team_id, text) values ('${g}', null, 'A tous'), ('${g}', '${t1}', 'Pour Ecureuils')`);
r = await as("d", `select text from messages order by text`); console.log("d (Renards) messages:", r.rows.map(x=>x.text));
r = await as("c", `select text from messages order by text`); console.log("c (Ecureuils) messages:", r.rows.map(x=>x.text));
await as("d", `insert into storage.objects (bucket_id, name) values ('photos', '${g}/${t0}/p1.jpg')`); console.log("d uploads photo ok");
await expectFail("c", `insert into storage.objects (bucket_id, name) values ('photos', '${g}/${t0}/p2.jpg')`, "upload into other team");
r = await as("a", `select count(*) from storage.objects`); console.log("owner sees photos:", r.rows[0].count);

// ---------- Comptes administrateurs ----------
const course = `'{"name":"P","theme":"explo","steps":[]}'`;
r = await as("a", `select is_admin() as v`); console.log("admin is_admin:", r.rows[0].v);
r = await as("d", `select is_admin() as v`); console.log("anonyme is_admin:", r.rows[0].v);
await as("a", `insert into courses (data) values (${course})`); console.log("admin creates course ok");
await expectFail("d", `insert into courses (data) values (${course})`, "anonymous creates course");
await expectFail("d", `insert into games (code, course) values ('ZZZZ01', ${course})`, "anonymous creates game");
await expectFail("e", `insert into courses (data) values (${course})`, "account not in admins list");
await expectFail("f", `insert into courses (data) values (${course})`, "admin email not confirmed");
r = await as("d", `select count(*) from admins`); console.log("anonymous sees admins rows (none expected):", r.rows[0].count);
r = await as("a", `select count(*) from admins`); console.log("admin sees admins rows (none expected):", r.rows[0].count);
// Parcours créés avant la restriction par la session anonyme 9, récupérés par l'admin.
await q(`reset role; insert into courses (owner, data) values ('00000000-0000-0000-0000-000000000009', ${course})`);
await expectFail("9", `update courses set data = ${course}`, "legacy anonymous owner edits course");
await expectFail("e", `select adopt_content('00000000-0000-0000-0000-000000000009')`, "non-admin adopts");
r = await as("a", `select adopt_content('00000000-0000-0000-0000-00000000000e') as n`); console.log("adopt from non-anonymous account:", r.rows[0].n);
r = await as("a", `select adopt_content('00000000-0000-0000-0000-000000000009') as n`); console.log("admin adopts legacy rows:", r.rows[0].n);
r = await as("a", `select count(*) from courses`); console.log("admin courses:", r.rows[0].count);
