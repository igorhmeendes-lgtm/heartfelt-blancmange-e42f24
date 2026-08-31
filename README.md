# Vision Prime

Landing page estática em português para apresentar o suplemento Vision Prime, seus componentes, proposta de rotina de uso, kits disponíveis e perguntas frequentes.

## Tecnologias

- HTML semântico em uma única página
- Tailwind CSS carregado por CDN
- CSS personalizado para identidade visual e responsividade
- Fontes Fraunces, Inter e IBM Plex Mono via Google Fonts
- Hospedagem e HTTPS pela Netlify

## Desenvolvimento local

Não há etapa de compilação. Para visualizar localmente, sirva a pasta `public` com um servidor HTTP estático de sua preferência.

Exemplo:

```bash
npx serve public
```

## Estrutura

- `public/index.html`: página pública completa
- `netlify.toml`: diretório de publicação e cabeçalhos HTTP
- `AGENTS.md`: orientações para futuras alterações no projeto

## Publicação

A Netlify publica diretamente o conteúdo da pasta `public`. Mudanças enviadas ao projeto entram no fluxo normal de deploy da plataforma.
