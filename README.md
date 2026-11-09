# DashBoard_Control_

Painel de prazos e entregas com radar, linha do tempo, observações e pomodoro. Funciona no navegador e pode ser instalado no celular ou no computador, com sincronização pelo Supabase.

## Estrutura

- `site/`: arquivos publicados.
- `supabase/1-estrutura.sql`: tabelas, regras de acesso e atualização ao vivo.
- `supabase/3-historico.sql`: arquivo automático dos projetos concluídos e busca do histórico.
- `.github/workflows/pages.yml`: publica `site/` no GitHub Pages a cada alteração na branch `main`.

## Como colocar no ar

1. Crie um projeto em https://supabase.com e rode `supabase/1-estrutura.sql` em **SQL Editor**. Depois, em outra consulta, rode `supabase/3-historico.sql`.
2. Em **Authentication**, desative novos cadastros e crie os usuários.
3. Em **Project Settings > API**, copie **Project URL** e a chave **anon public** para `site/config.js`.
4. No repositório, abra **Settings > Pages** e, em **Source**, escolha **GitHub Actions**.
5. Envie as alterações para a branch `main`.

O endereço aparece em **Settings > Pages** depois da publicação.

## Histórico

Quando todas as entregas de um projeto ficam **Concluído**, o projeto sai do painel e vai para a página **Histórico**, com as entregas e as anotações reunidas. O painel mostra um aviso com **Desfazer**.

- A busca procura no nome do projeto, nas entregas e nas anotações, sem diferenciar acentos e maiúsculas. Com várias palavras, todas precisam aparecer.
- O filtro de período mostra os projetos concluídos nos últimos 30 dias ou 12 meses.
- A lista carrega 10 projetos por vez.
- **Reabrir projeto** muda a entrega com o prazo mais distante para **Em andamento**, e o projeto volta ao painel.
- Uma anotação nova com o nome de um projeto arquivado vai direto para o histórico.

## Segurança

- Não coloque dados reais de projetos no repositório. Cadastre-os pelo app ou diretamente no Supabase.
- A chave **anon public** pode ficar em `site/config.js`, porque o acesso aos dados é protegido pelas regras do banco e pelo login.
- Nunca coloque a chave **service_role** no repositório.

## Atualizações

Ao alterar os arquivos de `site/`, aumente a versão em `site/sw.js`, por exemplo de `dashboard-control-v1` para `dashboard-control-v2`.

## Instalação

- **iPhone (Safari):** **Compartilhar > Adicionar à Tela de Início**.
- **Android (Chrome):** menu **⋮ > Instalar app** ou **Adicionar à tela inicial**.
- **Computador (Chrome ou Edge):** ícone de instalar na barra de endereços.
