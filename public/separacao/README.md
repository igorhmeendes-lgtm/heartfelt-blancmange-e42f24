# Separação Inteligente

App client-side (PWA) para calibrar a linha de separação de um armazém
conforme o giro de vendas dos últimos 3 meses. Roda em `/separacao/` deste
site, isolado da landing page do Vision Prime.

## Arquitetura

```
public/separacao/
├── index.html      → shell da UI (Tailwind via CDN), navegação por abas
├── app.js          → toda a lógica: parsing de planilhas/XML, cálculo de
│                      giro, motor de recomendação, renderização das telas
├── manifest.json   → metadados do PWA (nome, ícone, tela cheia)
├── sw.js           → service worker (cache do shell p/ instalar/offline)
├── icons/          → ícones do app (192/512/apple-touch)
└── README.md       → este arquivo
```

Fluxo de dados (tudo roda no navegador do usuário, nada é enviado a servidor):

```
Planilha crua (Vendas / Endereçamento / Estoque)
        │  usuário seleciona o arquivo .xlsx/.csv
        ▼
SheetJS lê as abas → usuário mapeia as colunas (uma vez por layout de cabeçalho)
        ▼
app.js normaliza, agrega vendas repetidas por código, classifica giro (curva ABC)
        ▼
localStorage guarda o resultado já processado (não guarda a planilha crua)
        ▼
Índice mestre (código → estoque + endereço + giro) alimenta as 3 telas:
  Consulta · Relocação · Conferência de NF-e
```

Para a NF-e, o XML é lido nativamente pelo `DOMParser` do navegador (não
precisa de biblioteca): extrai `cProd`, `xProd`, `qCom` de cada `<det><prod>`
e cruza com o índice mestre.

## Regras de negócio implementadas

- **Par/ímpar pelo endereço**: o app lê o número entre parênteses do
  endereço (`R01-(2)-1A` → vão `2`). Par = alto fluxo; ímpar = baixo fluxo.
- **Classificação de giro**: curva ABC por volume vendido nos últimos 3
  meses — Alto (até 80% do volume acumulado), Médio (até 95%), Baixo
  (restante com venda), Sem saída (zero venda no período).
- **Recomendação**: Alto fluxo fora da PAR → sugere mover para PAR. Baixo
  fluxo/sem saída dentro da PAR → sugere mover para ÍMPAR. Médio fluxo é
  neutro (não força troca).
- **Slot candidato**: prioriza endereços livres cadastrados manualmente;
  se não houver, usa um endereço hoje ocupado por um SKU com saldo zerado
  (Físico e Disponível = 0) — na conferência de NF, só considera "zerado
  liberável" o SKU que **não** veio na nota atual.
- **Números/valores**: qualquer valor nulo, vazio ou não numérico é tratado
  como `0` (nunca quebra a tela com erro). Números em formato BR
  (`1.234,56`, `R$ 1.234,56`) são reconhecidos.

## Guia de implementação / deploy

1. Este app não precisa de build. A Netlify já publica `public/` — então
   `public/separacao/index.html` fica disponível em `/separacao/` depois do
   deploy normal do repositório.
2. Para testar localmente: `npx serve public` e abrir
   `http://localhost:3000/separacao/`.
3. Uso no dia a dia:
   - Aba **Dados**: importe a planilha de Vendas (últimos 3 meses),
     Endereçamento (com a coluna já agrupada, ex. `R01-(2)-1A`) e Saldo de
     Estoque. Mapeie as colunas na primeira vez — o mapeamento é lembrado
     para planilhas com o mesmo cabeçalho nos próximos meses. Cadastre
     também os endereços livres que você já conhece (a planilha de
     endereçamento normalmente só lista posições ocupadas).
   - Aba **Consulta**: digite o código do produto e veja giro, endereço
     atual e a posição recomendada.
   - Aba **Relocação**: lista pronta de itens de baixo giro presos na PAR
     (e o inverso, alto giro presos na ÍMPAR), com endereço sugerido e
     exportação em CSV.
   - Aba **Conferência NF**: solte o(s) XML(s) da NF-e recebida; o app
     mostra todos os itens da nota e destaca os sem endereço, já sugerindo
     onde alocar.
4. "Instalar" no celular: abra `/separacao/` no Chrome/Safari mobile e use
   "Adicionar à tela de início" (Android mostra banner de instalação
   automático; iOS usa o menu de compartilhamento do Safari).
5. Os dados ficam salvos no `localStorage` do aparelho/navegador usado. Em
   outro aparelho ou navegador é preciso importar as planilhas novamente.
