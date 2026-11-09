-- Rode este arquivo uma vez, em Supabase > SQL Editor, depois do 1-estrutura.sql.
-- Cria o histórico: quando todas as entregas de um projeto ficam "Concluído",
-- o projeto, com as entregas e as anotações, sai do painel e vai para o histórico.
-- Pode rodar de novo sem perder dados.

alter table public.entregas add column if not exists arquivado_em timestamptz;
alter table public.observacoes add column if not exists arquivado_em timestamptz;

create index if not exists entregas_arquivado_em on public.entregas (arquivado_em);
create index if not exists entregas_projeto on public.entregas (projeto);
create index if not exists observacoes_projeto on public.observacoes (projeto);

-- Texto em minúsculas e sem acentos, usado na busca.
create or replace function public.sem_acento(texto text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(lower(coalesce(texto, '')),
    'áàâãäåéèêëíìîïóòôõöúùûüçñý',
    'aaaaaaeeeeiiiiooooouuuucny');
$$;

-- Arquiva ou devolve ao painel um projeto, conforme o status das entregas.
create or replace function public.atualizar_arquivo(nome text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  concluido boolean;
  quando timestamptz;
begin
  select count(*) > 0 and bool_and(e.status = 'Concluído')
    into concluido
    from public.entregas e
   where e.projeto = nome;

  if concluido then
    select coalesce(max(e.arquivado_em), now()) into quando
      from public.entregas e where e.projeto = nome;
    update public.entregas set arquivado_em = quando
     where projeto = nome and arquivado_em is distinct from quando;
    update public.observacoes set arquivado_em = quando
     where projeto = nome and arquivado_em is distinct from quando;
  else
    update public.entregas set arquivado_em = null
     where projeto = nome and arquivado_em is not null;
    update public.observacoes set arquivado_em = null
     where projeto = nome and arquivado_em is not null;
  end if;
end;
$$;

create or replace function public.entregas_arquivo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Ignora as alterações feitas pela própria função de arquivo.
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.atualizar_arquivo(new.projeto);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or old.projeto is distinct from new.projeto) then
    perform public.atualizar_arquivo(old.projeto);
  end if;
  return null;
end;
$$;

drop trigger if exists entregas_arquivo on public.entregas;
create trigger entregas_arquivo
  after insert or delete or update of projeto, status on public.entregas
  for each row execute function public.entregas_arquivo();

-- Uma anotação criada ou movida para um projeto arquivado vai junto para o histórico.
create or replace function public.observacoes_arquivo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  select case when count(*) > 0 and bool_and(e.arquivado_em is not null) then max(e.arquivado_em) end
    into new.arquivado_em
    from public.entregas e
   where e.projeto = new.projeto;
  return new;
end;
$$;

drop trigger if exists observacoes_arquivo on public.observacoes;
create trigger observacoes_arquivo
  before insert or update of projeto on public.observacoes
  for each row execute function public.observacoes_arquivo();

-- Arquiva os projetos que já estão concluídos.
do $$
declare
  nome text;
begin
  for nome in select distinct projeto from public.entregas loop
    perform public.atualizar_arquivo(nome);
  end loop;
end;
$$;

-- Busca no histórico: um projeto por linha, do mais recente para o mais antigo.
-- Procura no nome do projeto, nas entregas e nas anotações. Várias palavras: todas precisam aparecer.
create or replace function public.buscar_historico(
  termo text default '',
  desde timestamptz default null,
  limite integer default 10,
  pular integer default 0
)
returns table (projeto text, concluido_em timestamptz, entregas bigint, anotacoes bigint, total bigint)
language sql
stable
set search_path = ''
as $$
  with proj as (
    select e.projeto,
           max(e.arquivado_em) as concluido_em,
           count(*) as entregas,
           string_agg(concat_ws(' ', e.campanha, e.fase, e.entrega), ' ') as texto
      from public.entregas e
     where e.arquivado_em is not null
     group by e.projeto
  ),
  notas as (
    select o.projeto, count(*) as anotacoes, string_agg(o.texto, ' ') as texto
      from public.observacoes o
     where o.arquivado_em is not null
     group by o.projeto
  ),
  base as (
    select p.projeto, p.concluido_em, p.entregas, coalesce(n.anotacoes, 0) as anotacoes,
           public.sem_acento(concat_ws(' ', p.projeto, p.texto, n.texto)) as busca
      from proj p
      left join notas n on n.projeto = p.projeto
  ),
  palavras as (
    select array_remove(regexp_split_to_array(public.sem_acento(btrim(coalesce(termo, ''))), '\s+'), '') as lista
  )
  select b.projeto, b.concluido_em, b.entregas, b.anotacoes, count(*) over () as total
    from base b, palavras w
   where (desde is null or b.concluido_em >= desde)
     and not exists (select 1 from unnest(w.lista) as x(palavra) where strpos(b.busca, x.palavra) = 0)
   order by b.concluido_em desc, b.projeto
   limit greatest(1, least(coalesce(limite, 10), 50))
  offset greatest(coalesce(pular, 0), 0);
$$;

revoke execute on function public.buscar_historico(text, timestamptz, integer, integer) from public, anon;
grant execute on function public.buscar_historico(text, timestamptz, integer, integer) to authenticated;
revoke execute on function public.atualizar_arquivo(text) from public, anon;
grant execute on function public.atualizar_arquivo(text) to authenticated;
