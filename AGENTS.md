# AGENTS.md

## Visão geral

Este repositório hospeda dois sites estáticos independentes na Netlify, sem
backend, banco de dados, autenticação ou etapa de compilação compartilhada:

1. `public/index.html` — landing page do Vision Prime (produto de
   suplemento). Público-alvo: visitantes/compradores.
2. `public/separacao/` — app "Linha de Separação Inteligente", uma ferramenta interna
   de logística (calibragem de linha de separação por giro de vendas,
   consulta de endereçamento, conferência de NF-e). Ver
   `public/separacao/README.md` para arquitetura e regras de negócio
   específicas. **Não misture conteúdo dos dois**: a landing page não deve
   linkar nem referenciar o app de logística, e vice-versa.

## Arquitetura

- `public/index.html` concentra marcação, estilos personalizados e conteúdo da landing page.
- O Tailwind CSS é carregado por CDN e usado diretamente nas classes HTML.
- As imagens principais estão incorporadas como data URIs para manter a publicação autocontida.
- `netlify.toml` define `public` como diretório publicado e adiciona cabeçalhos HTTP.
- `public/separacao/` é um PWA separado (`manifest.json` + `sw.js` próprios,
  escopo `./` dentro da pasta) — cada app cuida do próprio cache/instalação.

## Convenções

- Preserve o idioma `pt-BR` e a identidade visual existente.
- Mantenha a experiência responsiva e os estados de foco acessíveis.
- Ao alterar links de compra, preserve `target="_blank"` junto de `rel="noopener"`.
- Evite adicionar dependências ou uma etapa de build sem necessidade clara.
- Não exponha segredos, tokens ou credenciais no HTML público.

## Validação

Confira a estrutura HTML, os links externos e o comportamento responsivo após alterações. A validação de deploy é executada pela pipeline da plataforma.
