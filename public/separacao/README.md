# Linha de Separação Inteligente

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

- **Par/ímpar pelo endereço**: o app lê o número do meio do endereço
  agrupado — aceita tanto `R01-2-1A` (formato mais comum: estação-rack
  concatenados só com hífen, sem parênteses) quanto `R01-(2)-1A`. Vão par =
  alto fluxo; vão ímpar = baixo fluxo. Validado contra uma base real: as
  posições PAR têm ~7x mais saída média por posição que as ÍMPAR.
- **Classificação de giro**: curva ABC pela quantidade de **saída** do
  estoque nos últimos 3 meses (não pela entrada) — Alto (até 80% do volume
  acumulado), Médio (até 95%), Baixo (restante com saída), Sem saída (zero
  saída no período). Se a planilha de "Vendas" for na verdade um razão de
  movimentação (com colunas do tipo `QtdeEntrada`/`QtdeSaida`), o app nunca
  deixa a entrada ser confundida com a saída ao auto-detectar a coluna.
- **Recomendação**: Alto fluxo fora da PAR → sugere mover para PAR. Baixo
  fluxo/sem saída dentro da PAR → sugere mover para ÍMPAR. Médio fluxo é
  neutro (não força troca).
- **Slot candidato**: prioriza posições livres — detectadas automaticamente
  quando a planilha de Endereçamento já tem linhas com o código do material
  em branco, mais qualquer endereço extra que você cadastrar manualmente.
  Se não houver livre, usa um endereço hoje ocupado por um SKU com saldo
  zerado (Físico e Disponível = 0) — na conferência de NF, só considera
  "zerado liberável" o SKU que **não** veio na nota atual.
- **Importação de vendas em lotes**: cada arquivo de vendas importado entra
  como um lote separado e é **somado** aos lotes já carregados (não
  substitui) — assim você pode ir importando mês a mês conforme for
  exportando do sistema, sem perder o que já tinha subido antes. Cada lote
  aparece listado em Dados (arquivo, período, SKUs, unidades) com botão
  para remover, caso importe um mês errado ou duplicado.
- **Período das vendas**: com a coluna de data mapeada, o app calcula o
  intervalo coberto pela soma de todos os lotes e avisa se for bem menor
  que ~3 meses (sinal comum de exportação cortada no limite de linhas da
  planilha, ou de faltar importar mais algum mês).
- **Números/valores**: qualquer valor nulo, vazio ou não numérico é tratado
  como `0` (nunca quebra a tela com erro). Números em formato BR
  (`1.234,56`, `R$ 1.234,56`) e em formato com ponto decimal (`0.01`) são
  reconhecidos. Saldo negativo real (backorder) é preservado — não é
  zerado, porque é sinal de um problema real de estoque.

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
