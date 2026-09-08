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

## Linha de Separação Inteligente (app de linha de separação)

Além da landing page, `public/separacao/` hospeda um segundo app estático,
independente do Vision Prime: uma ferramenta para calibrar a linha de
separação de um armazém conforme o giro de vendas.

- Acesse em `/separacao/` depois do deploy (ex.: `https://seu-site.netlify.app/separacao/`).
- É um PWA: pode ser instalado na tela de início do celular/tablet ("Adicionar
  à tela de início") e também abre normalmente no desktop.
- 100% client-side — as planilhas e os XMLs de NF-e são lidos no próprio
  navegador (SheetJS via CDN) e os dados ficam salvos só no `localStorage`
  do aparelho; nada é enviado a servidor.
- Funcionalidades: consulta de código com endereço/posição recomendada,
  relatório de oportunidades de relocação (baixo giro em posição PAR ↔ alto
  giro em posição ÍMPAR) e conferência de NF-e de entrada (acha itens sem
  endereço e sugere onde alocar).
- Detalhes de arquitetura e uso: `public/separacao/README.md`.
