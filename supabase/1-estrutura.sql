-- Rode este arquivo primeiro, em Supabase > SQL Editor.
-- Cria as tabelas, as regras de acesso e a atualização ao vivo.

create table if not exists public.entregas (
  id text primary key,
  projeto text not null default '',
  campanha text not null default '',
  fase text not null default '',
  entrega text not null default '',
  status text not null default 'A fazer',
  prazo date not null,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.observacoes (
  id text primary key,
  texto text not null default '',
  projeto text not null default '',
  feito boolean not null default false,
  criada_em bigint not null default (extract(epoch from now()) * 1000)::bigint,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.configuracao (
  id text primary key,
  limite integer not null default 3 check (limite between 0 and 30)
);

-- Layout pessoal de cada usuário.
create table if not exists public.layouts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  panels jsonb not null,
  atualizado_em timestamptz not null default now()
);

create or replace function public.marcar_atualizacao()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

drop trigger if exists entregas_atualizacao on public.entregas;
create trigger entregas_atualizacao before update on public.entregas
  for each row execute function public.marcar_atualizacao();

drop trigger if exists observacoes_atualizacao on public.observacoes;
create trigger observacoes_atualizacao before update on public.observacoes
  for each row execute function public.marcar_atualizacao();

drop trigger if exists layouts_atualizacao on public.layouts;
create trigger layouts_atualizacao before update on public.layouts
  for each row execute function public.marcar_atualizacao();

-- Regras de acesso: só quem fez login acessa, e cada pessoa altera apenas o próprio layout.
alter table public.entregas enable row level security;
alter table public.observacoes enable row level security;
alter table public.configuracao enable row level security;
alter table public.layouts enable row level security;

drop policy if exists "equipe acessa entregas" on public.entregas;
create policy "equipe acessa entregas" on public.entregas
  for all to authenticated using (true) with check (true);

drop policy if exists "equipe acessa observacoes" on public.observacoes;
create policy "equipe acessa observacoes" on public.observacoes
  for all to authenticated using (true) with check (true);

drop policy if exists "equipe acessa configuracao" on public.configuracao;
create policy "equipe acessa configuracao" on public.configuracao
  for all to authenticated using (true) with check (true);

drop policy if exists "cada pessoa acessa o proprio layout" on public.layouts;
create policy "cada pessoa acessa o proprio layout" on public.layouts
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.entregas, public.observacoes, public.configuracao, public.layouts to authenticated;

-- Atualização ao vivo entre os aparelhos.
do $$
declare
  nome text;
begin
  foreach nome in array array['entregas', 'observacoes', 'configuracao'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = nome
    ) then
      execute format('alter publication supabase_realtime add table public.%I', nome);
    end if;
  end loop;
end;
$$;
