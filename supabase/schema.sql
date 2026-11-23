-- Cap'taine — schéma Supabase (jalon 3)
-- À coller tel quel dans Supabase > SQL Editor > New query, puis « Run ».
-- Prérequis : Authentication > Sign In / Providers > « Allow anonymous sign-ins » activé.
-- Le script peut être relancé sans danger (il ne supprime aucune donnée).
--
-- Comptes administrateurs (seuls à pouvoir créer des parcours et lancer des parties) :
--   1. Authentication > Users > Add user > Create new user : e-mail + mot de passe, cocher « Auto Confirm User ».
--   2. SQL Editor : insert into public.admins (email) values ('adresse@exemple.be');
-- Les joueurs, eux, restent anonymes.

-- ---------- Tables ----------------------------------------------------------

create table if not exists public.courses (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  data        jsonb not null,                -- le parcours complet (nom, thème, étapes)
  updated_at  timestamptz not null default now()
);

create table if not exists public.games (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users on delete cascade,
  code         text not null unique,         -- code à saisir pour rejoindre (ex. K7RX42)
  course_id    uuid,
  course       jsonb not null,               -- copie figée du parcours au lancement
  settings     jsonb not null default '{}',  -- simulation, durée maximale…
  status       text not null default 'lobby' check (status in ('lobby', 'running', 'finished')),
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

create table if not exists public.teams (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references public.games on delete cascade,
  idx           int  not null,               -- position de départ dans la boucle
  name          text not null,
  color         text not null,
  level         text not null default 'ado',
  captain       uuid references auth.users on delete set null,
  captain_name  text,
  progress      jsonb not null default '{}', -- écrit par le capitaine
  judgments     jsonb not null default '{}', -- écrit par l'organisateur (validation des photos)
  last_pos      jsonb,                       -- {lat, lng, accuracy, at}
  finished_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (game_id, idx)
);

-- Code « Passer le relais » : table à part, lisible par le seul capitaine de l'équipe.
create table if not exists public.team_relay (
  team_id  uuid primary key references public.teams on delete cascade,
  token    text not null
);

create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games on delete cascade,
  team_id     uuid references public.teams on delete cascade,  -- null = toutes les équipes
  text        text not null check (length(text) between 1 and 500),
  created_at  timestamptz not null default now()
);

-- Adresses e-mail des administrateurs. Gérée à la main dans le SQL Editor (aucun accès depuis l'app).
create table if not exists public.admins (
  email     text primary key check (email = lower(email)),
  added_at  timestamptz not null default now()
);

create index if not exists teams_game_idx on public.teams (game_id);
create index if not exists messages_game_idx on public.messages (game_id);

-- ---------- Fonctions utilitaires ------------------------------------------------

create or replace function public.is_game_owner(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from games where id = g and owner = auth.uid());
$$;

create or replace function public.is_game_captain(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from teams where game_id = g and captain = auth.uid());
$$;

-- Administrateur = compte non anonyme, e-mail confirmé et présent dans public.admins.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from auth.users u join admins a on a.email = lower(u.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false));
$$;

-- ---------- Sécurité (Row Level Security) -------------------------------------------

alter table public.courses  enable row level security;
alter table public.games    enable row level security;
alter table public.teams    enable row level security;
alter table public.messages enable row level security;
alter table public.team_relay enable row level security;
alter table public.admins   enable row level security;  -- aucune politique : invisible depuis l'app

drop policy if exists relay_captain_read on public.team_relay;
create policy relay_captain_read on public.team_relay for select
  using (exists (select 1 from public.teams t where t.id = team_id and t.captain = auth.uid()));

drop policy if exists courses_owner on public.courses;
create policy courses_owner on public.courses for all
  using (owner = auth.uid()) with check (owner = auth.uid() and public.is_admin());

drop policy if exists games_owner on public.games;
create policy games_owner on public.games for all
  using (owner = auth.uid()) with check (owner = auth.uid() and public.is_admin());
drop policy if exists games_captain_read on public.games;
create policy games_captain_read on public.games for select
  using (public.is_game_captain(id));

drop policy if exists teams_owner on public.teams;
create policy teams_owner on public.teams for all
  using (public.is_game_owner(game_id)) with check (public.is_game_owner(game_id));
-- Les capitaines voient toutes les équipes de leur partie (classement).
drop policy if exists teams_captain_read on public.teams;
create policy teams_captain_read on public.teams for select
  using (public.is_game_captain(game_id));
-- Un capitaine ne modifie que sa propre équipe ; les colonnes sensibles sont protégées par le trigger ci-dessous.
drop policy if exists teams_captain_write on public.teams;
create policy teams_captain_write on public.teams for update
  using (captain = auth.uid()) with check (captain = auth.uid());

drop policy if exists messages_owner on public.messages;
create policy messages_owner on public.messages for all
  using (public.is_game_owner(game_id)) with check (public.is_game_owner(game_id));
drop policy if exists messages_captain_read on public.messages;
create policy messages_captain_read on public.messages for select
  using (public.is_game_captain(game_id)
         and (team_id is null or exists (select 1 from teams t where t.id = team_id and t.captain = auth.uid())));

-- Un capitaine ne peut changer que sa progression, sa position et sa fin de partie.
create or replace function public.guard_team_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if public.is_game_owner(old.game_id) then
    return new;
  end if;
  if new.judgments is distinct from old.judgments or new.name is distinct from old.name
     or new.idx is distinct from old.idx or new.game_id is distinct from old.game_id
     or new.color is distinct from old.color or new.level is distinct from old.level then
    raise exception 'Modification réservée à l''organisateur';
  end if;
  return new;
end $$;
drop trigger if exists teams_guard on public.teams;
create trigger teams_guard before update on public.teams
  for each row execute function public.guard_team_update();

-- ---------- Fonctions appelées par l'app -----------------------------------------------

-- Trouver une partie par son code (avant d'avoir une équipe).
create or replace function public.find_game(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', g.id, 'code', g.code, 'status', g.status,
    'name', g.course->>'name', 'theme', g.course->>'theme',
    'teams', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'idx', t.idx, 'name', t.name, 'color', t.color,
        'taken', t.captain is not null, 'mine', t.captain = auth.uid(), 'captain_name', t.captain_name)
        order by t.idx) from teams t where t.game_id = g.id), '[]'::jsonb))
  from games g
  where g.code = upper(trim(p_code)) and g.status <> 'finished';
$$;

-- Prendre une équipe libre (le premier téléphone gagne).
create or replace function public.claim_team(p_team uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_game uuid;
begin
  update teams t set captain = auth.uid(), captain_name = left(trim(p_name), 30)
  where t.id = p_team and t.captain is null
    and exists (select 1 from games g where g.id = t.game_id and g.status <> 'finished')
  returning t.game_id into v_game;
  if v_game is null then
    raise exception 'Cette équipe est déjà prise';
  end if;
  insert into team_relay (team_id, token) values (p_team, upper(substr(md5(random()::text), 1, 6)))
    on conflict (team_id) do update set token = excluded.token;
  return v_game;
end $$;

-- Reprendre une équipe avec le code « Passer le relais ».
create or replace function public.take_over(p_code text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_team teams;
begin
  update teams t set captain = auth.uid()
  from games g, team_relay r
  where g.id = t.game_id and r.team_id = t.id and g.code = upper(trim(p_code)) and g.status <> 'finished'
    and r.token = upper(trim(p_token))
  returning t.* into v_team;
  if v_team.id is null then
    raise exception 'Code de relais incorrect';
  end if;
  update team_relay set token = upper(substr(md5(random()::text), 1, 6)) where team_id = v_team.id;
  return jsonb_build_object('game_id', v_team.game_id, 'team_id', v_team.id);
end $$;

-- À la première connexion d'un admin sur un téléphone : récupère les parcours et parties
-- créés avant, avec la session anonyme de ce téléphone.
create or replace function public.adopt_content(p_from uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int; m int;
begin
  if not public.is_admin() then
    raise exception 'Réservé aux administrateurs';
  end if;
  if p_from = auth.uid() or not exists (select 1 from auth.users where id = p_from and coalesce(is_anonymous, false)) then
    return 0;
  end if;
  update courses set owner = auth.uid() where owner = p_from;
  get diagnostics n = row_count;
  update games set owner = auth.uid() where owner = p_from;
  get diagnostics m = row_count;
  return n + m;
end $$;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.adopt_content(uuid) to authenticated;
grant execute on function public.find_game(text) to authenticated;
grant execute on function public.claim_team(uuid, text) to authenticated;
grant execute on function public.take_over(text, text) to authenticated;

-- ---------- Temps réel ---------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.games, public.teams, public.messages;
exception when duplicate_object then null; end $$;

-- ---------- Photos des défis ------------------------------------------------------------
-- Dossier : <id de la partie>/<id de l'équipe>/<id de la photo>.jpg
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;

drop policy if exists photos_read on storage.objects;
create policy photos_read on storage.objects for select
  using (bucket_id = 'photos' and (
    public.is_game_owner(((storage.foldername(objects.name))[1])::uuid)
    or public.is_game_captain(((storage.foldername(objects.name))[1])::uuid)));

drop policy if exists photos_write on storage.objects;
create policy photos_write on storage.objects for insert
  with check (bucket_id = 'photos' and exists (
    select 1 from public.teams t
    where t.id = ((storage.foldername(objects.name))[2])::uuid and t.captain = auth.uid()));
