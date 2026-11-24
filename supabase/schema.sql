-- NHL Time : comptes, abonnements VIP et contenu réservé.
-- À coller UNE fois dans Supabase → SQL Editor → New query → Run.

-- 1. Profils (créés automatiquement à l'inscription)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

drop policy if exists "profil : lecture" on public.profiles;
create policy "profil : lecture" on public.profiles for select using (id = auth.uid() or public.is_admin());

-- 2. Abonnements (l'abonné demande, l'admin valide après avoir reçu le paiement)
create table if not exists public.subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  categories text[] not null,
  prix numeric not null default 0,
  methode text not null check (methode in ('paypal', 'revolut', 'crypto')),
  reference text,
  statut text not null default 'en_attente' check (statut in ('en_attente', 'actif', 'refuse', 'expire')),
  debut timestamptz,
  fin timestamptz,
  created_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;

-- prix calculé par la base (impossible de le modifier depuis le navigateur) :
-- 15 € la première catégorie, +5 € par catégorie en plus, +10 € pour le foot en plus.
create or replace function public.prix_formule(cats text[]) returns numeric language sql immutable as $$
  select case when coalesce(array_length(cats, 1), 0) = 0 then 0
    when cats = array['foot'] then 15
    else 15 + (select coalesce(sum(case when c = 'foot' then 10 else 5 end), 0) from unnest(cats) c) - 5
  end
$$;
create or replace function public.sub_before_insert() returns trigger language plpgsql as $$
begin
  if not (new.categories <@ array['nhl', 'nba', 'foot', 'tennis', 'paris_du_jour']) or coalesce(array_length(new.categories, 1), 0) = 0 then
    raise exception 'catégories invalides';
  end if;
  new.prix := public.prix_formule(new.categories);
  if not public.is_admin() then new.statut := 'en_attente'; new.debut := null; new.fin := null; end if;
  return new;
end $$;
drop trigger if exists sub_bi on public.subscriptions;
create trigger sub_bi before insert on public.subscriptions for each row execute function public.sub_before_insert();

drop policy if exists "abonnement : lecture" on public.subscriptions;
create policy "abonnement : lecture" on public.subscriptions for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "abonnement : demande" on public.subscriptions;
create policy "abonnement : demande" on public.subscriptions for insert with check (user_id = auth.uid() or public.is_admin());
drop policy if exists "abonnement : validation admin" on public.subscriptions;
create policy "abonnement : validation admin" on public.subscriptions for update using (public.is_admin()) with check (public.is_admin());

-- 3. Contenu VIP (écrit par l'analyse automatique avec la clé de service, lu seulement par les abonnés actifs)
create table if not exists public.vip_content (
  categorie text not null,
  cle text not null,
  contenu jsonb,
  maj timestamptz not null default now(),
  primary key (categorie, cle)
);
alter table public.vip_content enable row level security;
drop policy if exists "vip : abonnés actifs" on public.vip_content;
create policy "vip : abonnés actifs" on public.vip_content for select using (
  public.is_admin() or exists (
    select 1 from public.subscriptions s
    where s.user_id = auth.uid() and s.statut = 'actif' and now() between s.debut and s.fin and vip_content.categorie = any (s.categories)
  )
);

-- 4. Stockage privé des données d'analyse (historique, apprentissage)
insert into storage.buckets (id, name, public) values ('data', 'data', false) on conflict (id) do nothing;

-- 5. Toi = admin : remplace l'adresse par celle de TON compte (après t'être inscrit sur le site), puis exécute :
-- update public.profiles set is_admin = true where email = 'ton.adresse@exemple.com';
