# AGENTS.md

## Visão geral

Este projeto contém uma landing page estática do Vision Prime hospedada na Netlify. A página não possui backend, banco de dados, autenticação ou etapa de compilação.

## Arquitetura

- `public/index.html` concentra marcação, estilos personalizados e conteúdo da landing page.
- O Tailwind CSS é carregado por CDN e usado diretamente nas classes HTML.
- As imagens principais estão incorporadas como data URIs para manter a publicação autocontida.
- `netlify.toml` define `public` como diretório publicado e adiciona cabeçalhos HTTP.

## Convenções

- Preserve o idioma `pt-BR` e a identidade visual existente.
- Mantenha a experiência responsiva e os estados de foco acessíveis.
- Ao alterar links de compra, preserve `target="_blank"` junto de `rel="noopener"`.
- Evite adicionar dependências ou uma etapa de build sem necessidade clara.
- Não exponha segredos, tokens ou credenciais no HTML público.

## Validação

Confira a estrutura HTML, os links externos e o comportamento responsivo após alterações. A validação de deploy é executada pela pipeline da plataforma.
