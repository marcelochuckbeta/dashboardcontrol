# DashBoard_Control_

Painel de prazos e entregas com radar, linha do tempo, observações e pomodoro. Funciona no navegador e pode ser instalado no celular ou no computador, com sincronização pelo Supabase.

## Estrutura

- `site/`: arquivos publicados.
- `supabase/1-estrutura.sql`: tabelas, regras de acesso e atualização ao vivo.
- `.github/workflows/pages.yml`: publica `site/` no GitHub Pages a cada alteração na branch `main`.

## Como colocar no ar

1. Crie um projeto em https://supabase.com e rode `supabase/1-estrutura.sql` em **SQL Editor**.
2. Em **Authentication**, desative novos cadastros e crie os usuários.
3. Em **Project Settings > API**, copie **Project URL** e a chave **anon public** para `site/config.js`.
4. No repositório, abra **Settings > Pages** e, em **Source**, escolha **GitHub Actions**.
5. Envie as alterações para a branch `main`.

O endereço aparece em **Settings > Pages** depois da publicação.

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
