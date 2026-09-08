/* =========================================================================
   Separação Inteligente — motor de dados e UI
   App 100% client-side (sem backend). Lê planilhas cruas (Vendas,
   Endereçamento e Saldo de Estoque) e XMLs de NF-e direto no navegador,
   cruza tudo por código de material e devolve recomendações de
   endereçamento para a linha de separação (par = alto fluxo / ímpar =
   baixo fluxo).
   ========================================================================= */

(() => {
  'use strict';

  /* ---------------------------------------------------------------------
   * 1) UTILITÁRIOS
   * ------------------------------------------------------------------- */

  const STORAGE_PREFIX = 'sep_v1_';

  const norm = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  // Código de material: pode vir como número (Excel converte "0123" em 123,
  // ou "1023" em 1023.0). Normaliza para string comparável.
  function normalizeCode(v) {
    if (v === null || v === undefined) return '';
    let s = String(v).trim();
    if (s === '') return '';
    // remove ".0" que o Excel adiciona a códigos numéricos
    if (/^-?\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
    return s.toUpperCase();
  }

  // Números em formato BR ("1.234,56", "R$ 1.234,56") ou já numéricos.
  // Nulo/erro/inválido sempre volta 0 — nunca quebra a tela.
  function parseNumberBR(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    let s = String(v).trim();
    if (s === '' || /^(erro|error|#n\/a|null|undefined|-)$/i.test(s)) return 0;
    s = s.replace(/r\$\s?/i, '').trim();
    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    if (hasComma && hasDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (hasComma) {
      s = s.replace(',', '.');
    }
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  function formatNum(n, dec = 0) {
    const v = isFinite(n) ? n : 0;
    return v.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function formatBRL(n) {
    const v = isFinite(n) ? n : 0;
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  // "R01-(2)-1A" -> { enderecoCompleto, rack:'R01', vao:2, paridade:'par', nivel:'1A' }
  function parseEndereco(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const m = s.match(/\(([0-9]+)\)/);
    const vao = m ? parseInt(m[1], 10) : null;
    const paridade = vao === null ? 'indefinida' : (vao % 2 === 0 ? 'par' : 'impar');
    const partes = s.split('-').map((p) => p.trim()).filter(Boolean);
    const rack = partes[0] || '';
    const nivel = partes.length > 1 ? partes[partes.length - 1] : '';
    return { enderecoCompleto: s, rack, vao, paridade, nivel };
  }

  /* ---------------------------------------------------------------------
   * 2) ARMAZENAMENTO LOCAL (localStorage) — tudo fica no aparelho do usuário
   * ------------------------------------------------------------------- */

  const Store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        console.warn('Falha ao salvar', key, e);
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(STORAGE_PREFIX + key); } catch (e) { /* noop */ }
    },
  };

  /* ---------------------------------------------------------------------
   * 3) ESTADO GLOBAL
   * ------------------------------------------------------------------- */

  const DB = {
    estoque: Store.get('estoque', []),     // [{codigo, nome, custo, reposicao, padrao, fisico, alocado, disponivel}]
    endereco: Store.get('endereco', []),   // [{codigo, enderecoCompleto, rack, vao, paridade, nivel}]
    vendas: Store.get('vendas', []),       // [{codigo, qtd3m}]
    slotsLivres: Store.get('slotsLivres', []), // ["R01-(3)-2B", ...]
    mapeamentos: Store.get('mapeamentos', {}), // assinatura de cabeçalho -> mapeamento salvo
    meta: Store.get('meta', {}),           // {estoqueAt, enderecoAt, vendasAt}
    ultimaConferenciaNF: Store.get('ultimaConferenciaNF', null),
  };

  function persist() {
    Store.set('estoque', DB.estoque);
    Store.set('endereco', DB.endereco);
    Store.set('vendas', DB.vendas);
    Store.set('slotsLivres', DB.slotsLivres);
    Store.set('mapeamentos', DB.mapeamentos);
    Store.set('meta', DB.meta);
    Store.set('ultimaConferenciaNF', DB.ultimaConferenciaNF);
  }

  /* ---------------------------------------------------------------------
   * 4) LEITURA DE PLANILHAS (SheetJS) + MAPEAMENTO DE COLUNAS
   * ------------------------------------------------------------------- */

  const SYNONYMS = {
    codigo: ['codigo material', 'cod material', 'codigo produto', 'cod produto', 'codigo do produto', 'sku', 'codigo item', 'cod item', 'codigo'],
    nome: ['nome material', 'descricao material', 'nome produto', 'descricao produto', 'produto', 'descricao', 'nome'],
    custo: ['preco de custo', 'preco custo', 'custo'],
    reposicao: ['preco de reposicao', 'preco reposicao', 'reposicao'],
    padrao: ['preco padrao', 'preco venda', 'padrao'],
    fisico: ['total fisico', 'fisico', 'estoque fisico', 'saldo fisico'],
    alocado: ['total alocado', 'alocado', 'saldo alocado'],
    disponivel: ['total disponivel', 'disponivel', 'saldo disponivel'],
    enderecoCompleto: ['endereco agrupado', 'endereco completo', 'endereco linha', 'endereco separacao', 'localizacao', 'endereco'],
    quantidade: ['quantidade vendida', 'qtd vendida', 'quantidade', 'qtde vendida', 'qtd', 'qtde', 'unidades vendidas', 'unidades'],
    data: ['data venda', 'dt venda', 'data emissao', 'periodo', 'mes referencia', 'data'],
  };

  function autoDetect(headers, field) {
    const syns = SYNONYMS[field] || [];
    const normed = headers.map((h) => ({ h, n: norm(h) }));
    for (const syn of syns) {
      const exact = normed.find((x) => x.n === syn);
      if (exact) return exact.h;
    }
    for (const syn of syns) {
      const partial = normed.find((x) => x.n.includes(syn) || syn.includes(x.n));
      if (partial) return partial.h;
    }
    return '';
  }

  function readWorkbook(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const wb = XLSX.read(data, { type: 'array', cellDates: true });
          const sheets = {};
          wb.SheetNames.forEach((name) => {
            const ws = wb.Sheets[name];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
            const headers = rows.length
              ? Object.keys(rows[0])
              : (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []);
            sheets[name] = { headers, rows };
          });
          resolve({ sheetNames: wb.SheetNames, sheets });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error || new Error('Falha ao ler o arquivo'));
      reader.readAsArrayBuffer(file);
    });
  }

  function headerSignature(headers) {
    return headers.map(norm).sort().join('|');
  }

  // Agrupa abas que têm exatamente o mesmo conjunto de colunas — assim o
  // usuário mapeia uma vez só e o mapeamento vale pra todas as abas iguais.
  function groupSheetsBySignature(sheets, selectedNames) {
    const groups = new Map();
    selectedNames.forEach((name) => {
      const { headers } = sheets[name];
      const sig = headerSignature(headers);
      if (!groups.has(sig)) groups.set(sig, { sig, headers, sheetNames: [] });
      groups.get(sig).sheetNames.push(name);
    });
    return Array.from(groups.values());
  }

  const FIELD_LABELS = {
    codigo: 'Código do Material *',
    nome: 'Nome do Material *',
    custo: 'Preço de Custo',
    reposicao: 'Preço de Reposição',
    padrao: 'Preço Padrão *',
    fisico: 'Total - Físico *',
    alocado: 'Total - Alocado',
    disponivel: 'Total - Disponível *',
    enderecoCompleto: 'Endereço completo (já agrupado) *',
    quantidade: 'Quantidade Vendida *',
    data: 'Data da Venda (opcional)',
  };

  const SOURCE_FIELDS = {
    estoque: ['codigo', 'nome', 'custo', 'reposicao', 'padrao', 'fisico', 'alocado', 'disponivel'],
    endereco: ['codigo', 'enderecoCompleto'],
    vendas: ['codigo', 'quantidade', 'data'],
  };
  const REQUIRED_FIELDS = {
    estoque: ['codigo', 'nome', 'padrao', 'fisico', 'disponivel'],
    endereco: ['codigo', 'enderecoCompleto'],
    vendas: ['codigo', 'quantidade'],
  };

  /* ---------------------------------------------------------------------
   * 5) MOTOR DE NEGÓCIO: agregação, classificação de giro e recomendação
   * ------------------------------------------------------------------- */

  function aplicarMapeamentoEstoque(rows, map) {
    return rows.map((r) => ({
      codigo: normalizeCode(r[map.codigo]),
      nome: String(r[map.nome] ?? '').trim(),
      custo: parseNumberBR(r[map.custo]),
      reposicao: parseNumberBR(r[map.reposicao]),
      padrao: parseNumberBR(r[map.padrao]),
      fisico: parseNumberBR(r[map.fisico]),
      alocado: parseNumberBR(r[map.alocado]),
      disponivel: parseNumberBR(r[map.disponivel]),
    })).filter((r) => r.codigo);
  }

  function aplicarMapeamentoEndereco(rows, map) {
    return rows.map((r) => {
      const parsed = parseEndereco(r[map.enderecoCompleto]);
      return {
        codigo: normalizeCode(r[map.codigo]),
        enderecoCompleto: parsed ? parsed.enderecoCompleto : '',
        rack: parsed ? parsed.rack : '',
        vao: parsed ? parsed.vao : null,
        paridade: parsed ? parsed.paridade : 'indefinida',
        nivel: parsed ? parsed.nivel : '',
      };
    }).filter((r) => r.codigo && r.enderecoCompleto);
  }

  // Agrega vendas por código (mesma peça pode aparecer várias vezes nas
  // abas cruas — soma tudo e não repete o item na lista final).
  function agregarVendas(rowsPorGrupo) {
    const acc = new Map();
    rowsPorGrupo.forEach((rows) => {
      rows.forEach((r) => {
        if (!r.codigo) return;
        const atual = acc.get(r.codigo) || 0;
        acc.set(r.codigo, atual + r.quantidade);
      });
    });
    return Array.from(acc.entries()).map(([codigo, qtd3m]) => ({ codigo, qtd3m }));
  }

  function aplicarMapeamentoVendas(rows, map) {
    return rows.map((r) => ({
      codigo: normalizeCode(r[map.codigo]),
      quantidade: parseNumberBR(r[map.quantidade]),
    })).filter((r) => r.codigo);
  }

  // Curva ABC por volume: Alto = até 80% do volume acumulado (alto fluxo,
  // deve ficar na PAR); Médio = até 95% (neutro); Baixo/Sem saída = resto
  // (baixo fluxo, deve ficar na ÍMPAR).
  function classificarGiro(vendas) {
    const sorted = [...vendas].sort((a, b) => b.qtd3m - a.qtd3m);
    const total = sorted.reduce((s, v) => s + v.qtd3m, 0);
    const map = new Map();
    let acc = 0;
    sorted.forEach((v) => {
      acc += v.qtd3m;
      const pct = total > 0 ? acc / total : 1;
      let classe;
      if (v.qtd3m <= 0) classe = 'sem_saida';
      else if (pct <= 0.8) classe = 'alto';
      else if (pct <= 0.95) classe = 'medio';
      else classe = 'baixo';
      map.set(v.codigo, { qtd3m: v.qtd3m, mediaMensal: v.qtd3m / 3, classe });
    });
    return map;
  }

  const CLASSE_LABEL = {
    alto: 'Alto fluxo', medio: 'Médio fluxo', baixo: 'Baixo fluxo', sem_saida: 'Sem saída',
  };
  const CLASSE_BADGE = {
    alto: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
    medio: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
    baixo: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400',
    sem_saida: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400',
  };

  function paridadeEsperada(classe) {
    if (classe === 'alto') return 'par';
    if (classe === 'baixo' || classe === 'sem_saida') return 'impar';
    return null; // médio fluxo: neutro, não força relocação
  }

  // Monta o índice mestre cruzando as 3 bases por código de material.
  function buildMaster() {
    const map = new Map();
    const ensure = (codigo) => {
      if (!map.has(codigo)) {
        map.set(codigo, {
          codigo, nome: '', custo: 0, reposicao: 0, padrao: 0, fisico: 0, alocado: 0, disponivel: 0,
          endereco: null, vendas: { qtd3m: 0, mediaMensal: 0, classe: 'sem_saida' },
        });
      }
      return map.get(codigo);
    };
    DB.estoque.forEach((e) => {
      const o = ensure(e.codigo);
      Object.assign(o, {
        nome: e.nome, custo: e.custo, reposicao: e.reposicao, padrao: e.padrao,
        fisico: e.fisico, alocado: e.alocado, disponivel: e.disponivel,
      });
    });
    DB.endereco.forEach((e) => {
      const o = ensure(e.codigo);
      o.endereco = { enderecoCompleto: e.enderecoCompleto, rack: e.rack, vao: e.vao, paridade: e.paridade, nivel: e.nivel };
    });
    const giro = classificarGiro(DB.vendas);
    giro.forEach((info, codigo) => { ensure(codigo).vendas = info; });
    return map;
  }

  function findByCodigo(master, codigoDigitado) {
    const alvo = normalizeCode(codigoDigitado);
    if (master.has(alvo)) return master.get(alvo);
    // tenta remover zeros à esquerda como fallback
    const semZeros = alvo.replace(/^0+/, '');
    if (semZeros && master.has(semZeros)) return master.get(semZeros);
    for (const [cod, val] of master) {
      if (cod.replace(/^0+/, '') === semZeros) return val;
    }
    return null;
  }

  // Encontra o melhor endereço candidato para alocar um item, dada a
  // paridade desejada. Prioriza: 1) posição livre cadastrada; 2) posição
  // hoje ocupada por SKU zerado (que não veio na NF atual, se informado).
  function encontrarSlot(master, paridadeDesejada, usados, codigosNaoDisponiveis) {
    const tentativa = (paridade, aceitarZerado) => {
      for (const end of DB.slotsLivres) {
        const parsed = parseEndereco(end);
        if (!parsed) continue;
        if (paridade && parsed.paridade !== paridade) continue;
        if (usados.has(parsed.enderecoCompleto)) continue;
        return { endereco: parsed.enderecoCompleto, motivo: 'Posição livre cadastrada' };
      }
      if (!aceitarZerado) return null;
      for (const [codigo, item] of master) {
        if (!item.endereco) continue;
        if (paridade && item.endereco.paridade !== paridade) continue;
        if (usados.has(item.endereco.enderecoCompleto)) continue;
        const zerado = (item.disponivel <= 0 && item.fisico <= 0);
        if (!zerado) continue;
        if (codigosNaoDisponiveis && codigosNaoDisponiveis.has(codigo)) continue;
        return {
          endereco: item.endereco.enderecoCompleto,
          motivo: `Hoje ocupada pelo item ${codigo} (${item.nome || 'sem nome'}), com saldo zerado`,
        };
      }
      return null;
    };
    return tentativa(paridadeDesejada, false)
      || tentativa(paridadeDesejada, true)
      || tentativa(null, false)
      || tentativa(null, true)
      || null;
  }

  function recomendarParaItem(master, item) {
    const classe = item.vendas.classe;
    const desejada = paridadeEsperada(classe);
    if (!item.endereco) {
      const alvo = desejada || 'impar';
      const slot = encontrarSlot(master, alvo, new Set(), null);
      return {
        tipo: 'sem_endereco',
        mensagem: 'Sem endereço definido na linha de separação.',
        sugestao: slot,
        paridadeSugerida: alvo,
      };
    }
    if (!desejada) {
      return { tipo: 'ok', mensagem: 'Endereço compatível com o giro atual (médio fluxo, sem urgência de troca).' };
    }
    if (item.endereco.paridade === desejada) {
      return { tipo: 'ok', mensagem: 'Endereço adequado ao giro atual.' };
    }
    const usados = new Set([item.endereco.enderecoCompleto]);
    const slot = encontrarSlot(master, desejada, usados, null);
    return {
      tipo: 'relocar',
      mensagem: desejada === 'par'
        ? 'Alto fluxo em posição ÍMPAR (baixo fluxo). Sugerido mover para a PAR.'
        : 'Baixo fluxo (ou sem saída) em posição PAR (alto fluxo). Sugerido mover para a ÍMPAR.',
      sugestao: slot,
      paridadeSugerida: desejada,
    };
  }

  /* ---------------------------------------------------------------------
   * 6) NF-e (XML) — conferência de endereçamento na chegada da mercadoria
   * ------------------------------------------------------------------- */

  function parseNFeXML(xmlText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) {
      throw new Error('Arquivo XML inválido ou corrompido.');
    }
    const get = (root, tag) => root?.getElementsByTagName(tag)[0]?.textContent ?? '';
    const nNF = get(xml, 'nNF');
    const emit = xml.getElementsByTagName('emit')[0] || null;
    const emitente = emit ? get(emit, 'xNome') : '';
    const dets = Array.from(xml.getElementsByTagName('det'));
    if (!dets.length) throw new Error('Nenhum item (tag <det>) encontrado — confirme que é um XML de NF-e.');
    const itens = dets.map((det) => {
      const prod = det.getElementsByTagName('prod')[0] || det;
      return {
        codigo: normalizeCode(get(prod, 'cProd')),
        descricao: get(prod, 'xProd'),
        qtd: parseNumberBR(get(prod, 'qCom')),
        valor: parseNumberBR(get(prod, 'vProd')),
      };
    }).filter((i) => i.codigo);
    return { nNF, emitente, itens };
  }

  function conferirNotas(notas) {
    const master = buildMaster();
    const todosCodigosDaBatelada = new Set();
    notas.forEach((nf) => nf.itens.forEach((i) => todosCodigosDaBatelada.add(i.codigo)));
    const usados = new Set();
    const linhas = [];
    notas.forEach((nf) => {
      nf.itens.forEach((item) => {
        const master_item = master.get(item.codigo);
        if (master_item && master_item.endereco) {
          linhas.push({
            nNF: nf.nNF, emitente: nf.emitente, codigo: item.codigo,
            descricao: item.descricao || master_item.nome, qtd: item.qtd,
            status: 'ok', endereco: master_item.endereco.enderecoCompleto, motivo: '',
          });
        } else {
          const classe = master_item ? master_item.vendas.classe : 'sem_saida';
          const desejada = paridadeEsperada(classe) || 'impar';
          const slot = encontrarSlot(master, desejada, usados, todosCodigosDaBatelada);
          if (slot) usados.add(slot.endereco);
          linhas.push({
            nNF: nf.nNF, emitente: nf.emitente, codigo: item.codigo,
            descricao: item.descricao || (master_item ? master_item.nome : ''), qtd: item.qtd,
            status: 'sem_endereco',
            endereco: slot ? slot.endereco : null,
            motivo: slot ? slot.motivo : 'Nenhuma posição livre ou zerada disponível — cadastre um endereço novo.',
            novoItem: !master_item,
          });
        }
      });
    });
    return linhas;
  }

  /* =========================================================================
     7) INTERFACE (renderização das telas)
     ========================================================================= */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    tab: 'inicio',
    pendingImport: null, // { source, parsedWorkbook, selectedSheets, groups }
  };

  function setTab(tab) {
    state.tab = tab;
    $$('.tab-btn').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('tab-active', active);
      b.setAttribute('aria-current', active ? 'page' : 'false');
    });
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== tab));
    render();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function render() {
    if (state.tab === 'inicio') renderInicio();
    if (state.tab === 'consulta') renderConsulta();
    if (state.tab === 'relocacao') renderRelocacao();
    if (state.tab === 'nf') renderNF();
    if (state.tab === 'dados') renderDados();
  }

  /* ---- 7.1 Início / Dashboard ---- */
  function renderInicio() {
    const el = $('[data-view="inicio"]');
    const master = buildMaster();
    const itens = Array.from(master.values());
    const total = itens.length;
    const comEndereco = itens.filter((i) => i.endereco).length;
    const pctEndereco = total ? (comEndereco / total) * 100 : 0;
    const porClasse = { alto: 0, medio: 0, baixo: 0, sem_saida: 0 };
    let valorTotal = 0;
    let oportunidades = 0;
    let valorOportunidade = 0;
    itens.forEach((i) => {
      porClasse[i.vendas.classe] = (porClasse[i.vendas.classe] || 0) + 1;
      valorTotal += Math.max(i.disponivel, 0) * i.padrao;
      if (i.endereco && i.endereco.paridade === 'par' && (i.vendas.classe === 'baixo' || i.vendas.classe === 'sem_saida')) {
        oportunidades += 1;
        valorOportunidade += Math.max(i.disponivel, 0) * i.padrao;
      }
    });
    const semEndFlag = DB.endereco.length === 0 || DB.estoque.length === 0 || DB.vendas.length === 0;
    const ultimaNF = DB.ultimaConferenciaNF;
    const semEndNF = ultimaNF ? ultimaNF.linhas.filter((l) => l.status === 'sem_endereco').length : 0;

    el.innerHTML = `
      <div class="space-y-6">
        <div>
          <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Visão geral da linha</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">Calibragem de endereçamento com base nas vendas dos últimos 3 meses.</p>
        </div>

        ${semEndFlag ? `
        <div class="rounded-2xl border border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 p-4 text-sm text-amber-800 dark:text-amber-300">
          <strong>Comece carregando seus dados.</strong> Vá até a aba <button data-action="go-dados" class="underline font-medium">Dados</button> e importe as planilhas de Vendas, Endereçamento e Saldo de Estoque.
        </div>` : ''}

        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          ${kpiCard('SKUs cadastrados', formatNum(total), 'Base cruzada (estoque + endereço + vendas)')}
          ${kpiCard('% Endereçados', `${formatNum(pctEndereco, 1)}%`, `${formatNum(comEndereco)} de ${formatNum(total)}`)}
          ${kpiCard('Valor em estoque', formatBRL(valorTotal), 'Disponível × preço padrão')}
          ${kpiCard('Oportunidades de troca', formatNum(oportunidades), 'Baixo giro ocupando posição PAR', oportunidades > 0 ? 'warn' : 'ok')}
          ${kpiCard('Valor parado na PAR', formatBRL(valorOportunidade), 'Capital em posições de alto fluxo mal usadas', valorOportunidade > 0 ? 'warn' : 'ok')}
          ${kpiCard('Sem endereço (última NF)', formatNum(semEndNF), ultimaNF ? `NF conferida em ${new Date(ultimaNF.at).toLocaleString('pt-BR')}` : 'Nenhuma conferência ainda', semEndNF > 0 ? 'danger' : 'ok')}
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          ${classeCard('alto', porClasse.alto)}
          ${classeCard('medio', porClasse.medio)}
          ${classeCard('baixo', porClasse.baixo)}
          ${classeCard('sem_saida', porClasse.sem_saida)}
        </div>

        <div class="rounded-2xl border border-slate-200 dark:border-slate-800 p-4 sm:p-5 bg-white dark:bg-slate-900">
          <h2 class="font-medium text-slate-900 dark:text-slate-100 mb-2">Como funciona</h2>
          <ol class="text-sm text-slate-600 dark:text-slate-400 space-y-1.5 list-decimal list-inside">
            <li>Importe as 3 planilhas cruas na aba <strong>Dados</strong> (exportadas direto do sistema, sem tratamento).</li>
            <li>Use <strong>Consulta</strong> para digitar um código e ver onde alocar aquele item.</li>
            <li>Use <strong>Relocação</strong> para listar itens de baixo giro presos na PAR (e alto giro presos na ÍMPAR).</li>
            <li>Ao chegar mercadoria, jogue o XML da NF-e em <strong>Conferência NF</strong> para achar itens sem endereço e já receber a posição sugerida.</li>
          </ol>
        </div>
      </div>
    `;
    $('[data-action="go-dados"]', el)?.addEventListener('click', () => setTab('dados'));
  }

  function kpiCard(label, value, hint, tone = 'neutral') {
    const toneClass = {
      neutral: 'text-slate-900 dark:text-slate-100',
      ok: 'text-emerald-600 dark:text-emerald-400',
      warn: 'text-amber-600 dark:text-amber-400',
      danger: 'text-rose-600 dark:text-rose-400',
    }[tone];
    return `
      <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(label)}</div>
        <div class="text-xl sm:text-2xl font-semibold mt-1 ${toneClass}">${value}</div>
        <div class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">${escapeHtml(hint)}</div>
      </div>`;
  }

  function classeCard(classe, count) {
    return `
      <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 flex items-center justify-between">
        <span class="text-xs px-2 py-1 rounded-full font-medium ${CLASSE_BADGE[classe]}">${CLASSE_LABEL[classe]}</span>
        <span class="font-semibold text-slate-800 dark:text-slate-200">${formatNum(count)}</span>
      </div>`;
  }

  /* ---- 7.2 Consulta por código ---- */
  function renderConsulta() {
    const el = $('[data-view="consulta"]');
    el.innerHTML = `
      <div class="space-y-4">
        <div>
          <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Consultar código</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">Digite o código do material para ver giro, endereço atual e a posição recomendada.</p>
        </div>
        <form id="form-consulta" class="flex gap-2">
          <input id="input-codigo" inputmode="numeric" autocomplete="off" placeholder="Código do material"
            class="flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <button type="submit" class="rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white px-5 font-medium">Buscar</button>
        </form>
        <div id="resultado-consulta"></div>
      </div>
    `;
    const form = $('#form-consulta', el);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const codigo = $('#input-codigo', el).value.trim();
      if (!codigo) return;
      mostrarResultadoConsulta(codigo);
    });
  }

  function mostrarResultadoConsulta(codigoDigitado) {
    const master = buildMaster();
    const item = findByCodigo(master, codigoDigitado);
    const box = $('#resultado-consulta');
    if (!item) {
      box.innerHTML = `
        <div class="rounded-2xl border border-rose-300/60 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 p-4 text-sm text-rose-700 dark:text-rose-300">
          Código <strong>${escapeHtml(codigoDigitado)}</strong> não encontrado em nenhuma das bases carregadas.
        </div>`;
      return;
    }
    const rec = recomendarParaItem(master, item);
    const badgeParidade = (p) => p === 'par'
      ? '<span class="text-xs px-2 py-1 rounded-full font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">PAR · alto fluxo</span>'
      : p === 'impar'
        ? '<span class="text-xs px-2 py-1 rounded-full font-medium bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300">ÍMPAR · baixo fluxo</span>'
        : '<span class="text-xs px-2 py-1 rounded-full font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">indefinida</span>';

    const recTone = { ok: 'border-emerald-300/60 bg-emerald-50 dark:bg-emerald-500/10 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300',
      relocar: 'border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-300',
      sem_endereco: 'border-rose-300/60 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 text-rose-800 dark:text-rose-300' }[rec.tipo];

    box.innerHTML = `
      <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-xs text-slate-400 font-mono">${escapeHtml(item.codigo)}</div>
            <div class="text-lg font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(item.nome || 'Sem nome cadastrado')}</div>
          </div>
          <span class="text-xs px-2 py-1 rounded-full font-medium ${CLASSE_BADGE[item.vendas.classe]}">${CLASSE_LABEL[item.vendas.classe]}</span>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><div class="text-slate-400 text-xs">Vendido (3m)</div><div class="font-medium">${formatNum(item.vendas.qtd3m)} un</div></div>
          <div><div class="text-slate-400 text-xs">Média/mês</div><div class="font-medium">${formatNum(item.vendas.mediaMensal, 1)} un</div></div>
          <div><div class="text-slate-400 text-xs">Disponível</div><div class="font-medium">${formatNum(item.disponivel)} un</div></div>
          <div><div class="text-slate-400 text-xs">Valor disponível</div><div class="font-medium">${formatBRL(Math.max(item.disponivel, 0) * item.padrao)}</div></div>
        </div>

        <div class="flex items-center gap-3 text-sm">
          <span class="text-slate-400">Endereço atual:</span>
          ${item.endereco
            ? `<span class="font-mono font-medium">${escapeHtml(item.endereco.enderecoCompleto)}</span> ${badgeParidade(item.endereco.paridade)}`
            : '<span class="text-rose-600 dark:text-rose-400 font-medium">sem endereço</span>'}
        </div>

        <div class="rounded-xl border ${recTone} p-3 text-sm">
          <div class="font-medium">${escapeHtml(rec.mensagem)}</div>
          ${rec.sugestao ? `
            <div class="mt-1">Sugestão: <span class="font-mono font-semibold">${escapeHtml(rec.sugestao.endereco)}</span> — ${escapeHtml(rec.sugestao.motivo)}</div>
          ` : (rec.tipo !== 'ok' ? '<div class="mt-1">Nenhuma posição candidata encontrada automaticamente — cadastre um endereço livre em Dados.</div>' : '')}
        </div>
      </div>
    `;
  }

  /* ---- 7.3 Relocação (baixo giro na PAR / alto giro na ÍMPAR) ---- */
  function renderRelocacao() {
    const el = $('[data-view="relocacao"]');
    const master = buildMaster();
    const itens = Array.from(master.values()).filter((i) => i.endereco);

    const baixoNaPar = itens
      .filter((i) => i.endereco.paridade === 'par' && (i.vendas.classe === 'baixo' || i.vendas.classe === 'sem_saida'))
      .sort((a, b) => a.vendas.qtd3m - b.vendas.qtd3m);
    const altoNaImpar = itens
      .filter((i) => i.endereco.paridade === 'impar' && i.vendas.classe === 'alto')
      .sort((a, b) => b.vendas.qtd3m - a.vendas.qtd3m);

    const modo = state.relocacaoModo || 'baixoPar';
    const lista = modo === 'baixoPar' ? baixoNaPar : altoNaImpar;
    const paridadeDestino = modo === 'baixoPar' ? 'impar' : 'par';

    const linhas = lista.map((item) => {
      const usados = new Set([item.endereco.enderecoCompleto]);
      const slot = encontrarSlot(master, paridadeDestino, usados, null);
      return { item, slot };
    });

    el.innerHTML = `
      <div class="space-y-4">
        <div>
          <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Oportunidades de relocação</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">Calibragem par/ímpar conforme giro dos últimos 3 meses.</p>
        </div>

        <div class="flex gap-2 flex-wrap">
          <button data-action="modo-baixo" class="px-3 py-2 rounded-xl text-sm font-medium ${modo === 'baixoPar' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}">
            Baixo giro na PAR (${baixoNaPar.length})
          </button>
          <button data-action="modo-alto" class="px-3 py-2 rounded-xl text-sm font-medium ${modo === 'altoImpar' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}">
            Alto giro na ÍMPAR (${altoNaImpar.length})
          </button>
          <button data-action="exportar-relocacao" class="ml-auto px-3 py-2 rounded-xl text-sm font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">Exportar CSV</button>
        </div>

        <div class="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400">
              <tr>
                <th class="text-left px-3 py-2 font-medium">Código</th>
                <th class="text-left px-3 py-2 font-medium">Nome</th>
                <th class="text-left px-3 py-2 font-medium">Endereço atual</th>
                <th class="text-right px-3 py-2 font-medium">Vendido 3m</th>
                <th class="text-right px-3 py-2 font-medium">Disponível</th>
                <th class="text-right px-3 py-2 font-medium">Valor</th>
                <th class="text-left px-3 py-2 font-medium">Sugestão de novo endereço</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
              ${linhas.length ? linhas.map(({ item, slot }) => `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td class="px-3 py-2 font-mono text-xs">${escapeHtml(item.codigo)}</td>
                  <td class="px-3 py-2">${escapeHtml(item.nome || '—')}</td>
                  <td class="px-3 py-2 font-mono text-xs">${escapeHtml(item.endereco.enderecoCompleto)}</td>
                  <td class="px-3 py-2 text-right">${formatNum(item.vendas.qtd3m)}</td>
                  <td class="px-3 py-2 text-right">${formatNum(item.disponivel)}</td>
                  <td class="px-3 py-2 text-right">${formatBRL(Math.max(item.disponivel, 0) * item.padrao)}</td>
                  <td class="px-3 py-2">${slot ? `<span class="font-mono text-xs font-semibold">${escapeHtml(slot.endereco)}</span>` : '<span class="text-xs text-slate-400">sem posição candidata</span>'}</td>
                </tr>
              `).join('') : `<tr><td colspan="7" class="px-3 py-8 text-center text-slate-400">Nenhum item nessa condição. 🎉</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
    $('[data-action="modo-baixo"]', el).addEventListener('click', () => { state.relocacaoModo = 'baixoPar'; renderRelocacao(); });
    $('[data-action="modo-alto"]', el).addEventListener('click', () => { state.relocacaoModo = 'altoImpar'; renderRelocacao(); });
    $('[data-action="exportar-relocacao"]', el).addEventListener('click', () => {
      const rows = linhas.map(({ item, slot }) => ({
        codigo: item.codigo, nome: item.nome, endereco_atual: item.endereco.enderecoCompleto,
        vendido_3m: item.vendas.qtd3m, disponivel: item.disponivel,
        valor: (Math.max(item.disponivel, 0) * item.padrao).toFixed(2),
        endereco_sugerido: slot ? slot.endereco : '',
      }));
      exportCSV(rows, `relocacao_${modo}.csv`);
    });
  }

  /* ---- 7.4 Conferência de NF-e (XML) ---- */
  function renderNF() {
    const el = $('[data-view="nf"]');
    el.innerHTML = `
      <div class="space-y-4">
        <div>
          <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Conferência de NF-e</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">Solte o(s) XML(s) da nota para achar produtos sem endereço e já ver onde alocar.</p>
        </div>

        <label id="dropzone-nf" class="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-8 text-center cursor-pointer hover:border-indigo-400 transition-colors bg-white dark:bg-slate-900">
          <span class="text-3xl">📄</span>
          <span class="text-sm font-medium text-slate-700 dark:text-slate-300">Toque para escolher o(s) XML(s) da NF-e</span>
          <span class="text-xs text-slate-400">ou arraste os arquivos aqui</span>
          <input id="input-nf" type="file" accept=".xml,text/xml,application/xml" multiple class="hidden">
        </label>

        <div id="nf-resultado"></div>
      </div>
    `;
    const dropzone = $('#dropzone-nf', el);
    const input = $('#input-nf', el);
    input.addEventListener('change', () => processarXMLs(Array.from(input.files)));
    ['dragover', 'dragenter'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('border-indigo-400'); }));
    ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('border-indigo-400'); }));
    dropzone.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer.files).filter((f) => /\.xml$/i.test(f.name));
      if (files.length) processarXMLs(files);
    });

    if (DB.ultimaConferenciaNF) renderNFResultado(DB.ultimaConferenciaNF.linhas);
  }

  async function processarXMLs(files) {
    const resultBox = $('#nf-resultado');
    resultBox.innerHTML = `<div class="text-sm text-slate-400">Lendo ${files.length} arquivo(s)...</div>`;
    try {
      const notas = [];
      for (const file of files) {
        const text = await file.text();
        notas.push(parseNFeXML(text));
      }
      const linhas = conferirNotas(notas);
      DB.ultimaConferenciaNF = { at: Date.now(), linhas };
      persist();
      renderNFResultado(linhas);
    } catch (err) {
      resultBox.innerHTML = `<div class="rounded-2xl border border-rose-300/60 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 p-4 text-sm text-rose-700 dark:text-rose-300">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderNFResultado(linhas) {
    const resultBox = $('#nf-resultado');
    const semEndereco = linhas.filter((l) => l.status === 'sem_endereco');
    resultBox.innerHTML = `
      <div class="space-y-3">
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          ${kpiCard('Itens na nota', formatNum(linhas.length), 'Total de linhas de produto')}
          ${kpiCard('Já endereçados', formatNum(linhas.length - semEndereco.length), 'Prontos para conferência física', 'ok')}
          ${kpiCard('Sem endereço', formatNum(semEndereco.length), 'Precisam de alocação agora', semEndereco.length ? 'danger' : 'ok')}
        </div>
        <div class="flex justify-end">
          <button data-action="exportar-nf" class="px-3 py-2 rounded-xl text-sm font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">Exportar CSV</button>
        </div>
        <div class="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400">
              <tr>
                <th class="text-left px-3 py-2 font-medium">NF</th>
                <th class="text-left px-3 py-2 font-medium">Código</th>
                <th class="text-left px-3 py-2 font-medium">Descrição</th>
                <th class="text-right px-3 py-2 font-medium">Qtd</th>
                <th class="text-left px-3 py-2 font-medium">Status</th>
                <th class="text-left px-3 py-2 font-medium">Endereço / Sugestão</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
              ${linhas.map((l) => `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td class="px-3 py-2 text-xs text-slate-400">${escapeHtml(l.nNF || '—')}</td>
                  <td class="px-3 py-2 font-mono text-xs">${escapeHtml(l.codigo)}</td>
                  <td class="px-3 py-2">${escapeHtml(l.descricao || '—')}</td>
                  <td class="px-3 py-2 text-right">${formatNum(l.qtd)}</td>
                  <td class="px-3 py-2">
                    ${l.status === 'ok'
                      ? '<span class="text-xs px-2 py-1 rounded-full font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">✓ Endereçado</span>'
                      : `<span class="text-xs px-2 py-1 rounded-full font-medium bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400">${l.novoItem ? '🆕 Novo item' : 'Sem endereço'}</span>`}
                  </td>
                  <td class="px-3 py-2">
                    ${l.status === 'ok'
                      ? `<span class="font-mono text-xs">${escapeHtml(l.endereco)}</span>`
                      : (l.endereco
                          ? `<span class="font-mono text-xs font-semibold">${escapeHtml(l.endereco)}</span><div class="text-[11px] text-slate-400">${escapeHtml(l.motivo)}</div>`
                          : `<span class="text-xs text-slate-400">${escapeHtml(l.motivo)}</span>`)}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    $('[data-action="exportar-nf"]', resultBox).addEventListener('click', () => {
      exportCSV(linhas.map((l) => ({
        nf: l.nNF, codigo: l.codigo, descricao: l.descricao, qtd: l.qtd,
        status: l.status, endereco_ou_sugestao: l.endereco || '', motivo: l.motivo || '',
      })), 'conferencia_nf.csv');
    });
  }

  /* ---- 7.5 Dados (importação + mapeamento + configuração) ---- */
  function renderDados() {
    const el = $('[data-view="dados"]');
    const sources = [
      { key: 'estoque', label: 'Saldo de Estoque', count: DB.estoque.length, hint: 'Código, Nome, Preços e Totais Físico/Alocado/Disponível' },
      { key: 'endereco', label: 'Endereçamento', count: DB.endereco.length, hint: 'Código + coluna de endereço já agrupado (ex: R01-(2)-1A)' },
      { key: 'vendas', label: 'Vendas (últimos 3 meses)', count: DB.vendas.length, hint: 'Pode ter várias abas; itens repetidos são somados automaticamente' },
    ];
    el.innerHTML = `
      <div class="space-y-6">
        <div>
          <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Dados</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">Importe as planilhas cruas exportadas do sistema (.xlsx, .xls ou .csv). Tudo é processado no seu aparelho — nada é enviado a nenhum servidor.</p>
        </div>

        ${sources.map((s) => `
          <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5">
            <div class="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div class="font-medium text-slate-900 dark:text-slate-100">${s.label}</div>
                <div class="text-xs text-slate-400">${s.hint}</div>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs px-2 py-1 rounded-full font-medium ${s.count ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}">
                  ${s.count ? `${formatNum(s.count)} registros` : 'vazio'}
                </span>
                ${s.count ? `<button data-clear="${s.key}" class="text-xs text-rose-500 hover:underline">limpar</button>` : ''}
              </div>
            </div>
            <label class="mt-3 flex items-center justify-center gap-2 border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-4 text-sm text-slate-500 dark:text-slate-400 cursor-pointer hover:border-indigo-400">
              <span>📂 Selecionar arquivo (.xlsx / .csv)</span>
              <input type="file" data-upload="${s.key}" accept=".xlsx,.xls,.csv" class="hidden">
            </label>
            <div data-mapping-area="${s.key}" class="mt-2"></div>
          </div>
        `).join('')}

        <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5">
          <div class="font-medium text-slate-900 dark:text-slate-100 mb-1">Endereços livres conhecidos</div>
          <p class="text-xs text-slate-400 mb-2">A planilha de endereçamento geralmente só lista posições ocupadas. Cole aqui, um por linha, endereços vagos que você já sabe (ex: R02-(4)-3B) para o app poder sugerir esses lugares.</p>
          <textarea id="textarea-livres" rows="4" class="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-mono" placeholder="R02-(4)-3B\nR05-(6)-2C">${DB.slotsLivres.join('\n')}</textarea>
          <button data-action="salvar-livres" class="mt-2 px-3 py-2 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white">Salvar lista</button>
        </div>

        <div class="rounded-2xl border border-rose-300/40 dark:border-rose-500/20 p-4 sm:p-5">
          <div class="font-medium text-rose-600 dark:text-rose-400 mb-1">Zerar tudo</div>
          <p class="text-xs text-slate-400 mb-2">Remove todos os dados importados e configurações deste aparelho.</p>
          <button data-action="reset-app" class="px-3 py-2 rounded-xl text-sm font-medium bg-rose-600 hover:bg-rose-500 text-white">Apagar todos os dados</button>
        </div>
      </div>
    `;

    sources.forEach((s) => {
      $(`input[data-upload="${s.key}"]`, el).addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) iniciarImportacao(s.key, file);
      });
      const clearBtn = $(`[data-clear="${s.key}"]`, el);
      if (clearBtn) clearBtn.addEventListener('click', () => {
        DB[s.key] = [];
        persist();
        renderDados();
      });
    });

    $('[data-action="salvar-livres"]', el).addEventListener('click', () => {
      const raw = $('#textarea-livres', el).value;
      DB.slotsLivres = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      persist();
      renderDados();
    });

    $('[data-action="reset-app"]', el).addEventListener('click', () => {
      if (!confirm('Isso vai apagar todos os dados importados neste aparelho. Continuar?')) return;
      ['estoque', 'endereco', 'vendas', 'slotsLivres', 'mapeamentos', 'meta', 'ultimaConferenciaNF'].forEach((k) => Store.remove(k));
      DB.estoque = []; DB.endereco = []; DB.vendas = []; DB.slotsLivres = [];
      DB.mapeamentos = {}; DB.meta = {}; DB.ultimaConferenciaNF = null;
      renderDados();
    });
  }

  async function iniciarImportacao(sourceKey, file) {
    const area = $(`[data-mapping-area="${sourceKey}"]`);
    area.innerHTML = `<div class="text-sm text-slate-400 mt-2">Lendo "${escapeHtml(file.name)}"...</div>`;
    try {
      const wb = await readWorkbook(file);
      const defaultSelected = sourceKey === 'vendas' ? wb.sheetNames : [wb.sheetNames[0]];
      renderMappingUI(sourceKey, wb, defaultSelected);
    } catch (err) {
      area.innerHTML = `<div class="text-sm text-rose-600 mt-2">Erro ao ler o arquivo: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderMappingUI(sourceKey, wb, selectedSheets) {
    const area = $(`[data-mapping-area="${sourceKey}"]`);
    const groups = groupSheetsBySignature(wb.sheets, selectedSheets);
    const totalLinhas = selectedSheets.reduce((s, n) => s + wb.sheets[n].rows.length, 0);

    area.innerHTML = `
      <div class="mt-3 space-y-3">
        <div class="text-xs text-slate-500">${wb.sheetNames.length} aba(s) encontrada(s) · ${formatNum(totalLinhas)} linha(s) nas abas selecionadas</div>
        <div class="flex flex-wrap gap-2">
          ${wb.sheetNames.map((name) => `
            <label class="inline-flex items-center gap-1.5 text-xs bg-slate-100 dark:bg-slate-800 rounded-full px-3 py-1.5 cursor-pointer">
              <input type="checkbox" data-sheet-toggle="${escapeHtml(name)}" ${selectedSheets.includes(name) ? 'checked' : ''}>
              ${escapeHtml(name)} <span class="text-slate-400">(${wb.sheets[name].rows.length})</span>
            </label>
          `).join('')}
        </div>
        <div data-groups-container class="space-y-3"></div>
        <button data-action="processar" class="px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white">Processar dados</button>
        <div data-mapping-feedback class="text-sm text-rose-600"></div>
      </div>
    `;

    $$('input[data-sheet-toggle]', area).forEach((cb) => {
      cb.addEventListener('change', () => {
        const novaSelecao = $$('input[data-sheet-toggle]', area).filter((c) => c.checked).map((c) => c.dataset.sheetToggle);
        renderMappingUI(sourceKey, wb, novaSelecao);
      });
    });

    const groupsContainer = $('[data-groups-container]', area);
    const savedMap = DB.mapeamentos;
    groupsContainer.innerHTML = groups.map((g) => {
      const saved = savedMap[g.sig];
      const fields = SOURCE_FIELDS[sourceKey];
      return `
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3" data-group-sig="${escapeHtml(g.sig)}">
          <div class="text-xs text-slate-400 mb-2">Layout usado em: <strong>${g.sheetNames.map(escapeHtml).join(', ')}</strong></div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${fields.map((f) => {
              const pre = (saved && saved[f]) || autoDetect(g.headers, f);
              return `
                <div>
                  <label class="text-xs text-slate-500 dark:text-slate-400">${FIELD_LABELS[f]}</label>
                  <select data-field="${f}" class="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm px-2 py-1.5">
                    <option value="">-- selecione --</option>
                    ${g.headers.map((h) => `<option value="${escapeHtml(h)}" ${h === pre ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
                  </select>
                </div>`;
            }).join('')}
          </div>
        </div>`;
    }).join('');

    $('[data-action="processar"]', area).addEventListener('click', () => {
      const feedback = $('[data-mapping-feedback]', area);
      const groupBlocks = $$('[data-group-sig]', groupsContainer);
      const mapeamentosPorGrupo = [];
      let erro = '';
      groupBlocks.forEach((block) => {
        const sig = block.dataset.groupSig;
        const grupo = groups.find((g) => g.sig === sig);
        const mapa = {};
        $$('select[data-field]', block).forEach((sel) => { mapa[sel.dataset.field] = sel.value; });
        for (const req of REQUIRED_FIELDS[sourceKey]) {
          if (!mapa[req]) { erro = `Selecione a coluna "${FIELD_LABELS[req]}" para as abas: ${grupo.sheetNames.join(', ')}.`; }
        }
        mapeamentosPorGrupo.push({ grupo, mapa });
      });
      if (erro) { feedback.textContent = erro; return; }
      feedback.textContent = '';

      mapeamentosPorGrupo.forEach(({ grupo }) => {
        // salva o mapeamento pra próxima vez que aparecer esse mesmo layout de cabeçalho
      });

      if (sourceKey === 'estoque') {
        const rows = mapeamentosPorGrupo.flatMap(({ grupo, mapa }) =>
          grupo.sheetNames.flatMap((name) => aplicarMapeamentoEstoque(wb.sheets[name].rows, mapa)));
        DB.estoque = rows;
      } else if (sourceKey === 'endereco') {
        const rows = mapeamentosPorGrupo.flatMap(({ grupo, mapa }) =>
          grupo.sheetNames.flatMap((name) => aplicarMapeamentoEndereco(wb.sheets[name].rows, mapa)));
        DB.endereco = rows;
      } else if (sourceKey === 'vendas') {
        const rowsPorGrupo = mapeamentosPorGrupo.map(({ grupo, mapa }) =>
          grupo.sheetNames.flatMap((name) => aplicarMapeamentoVendas(wb.sheets[name].rows, mapa)));
        DB.vendas = agregarVendas(rowsPorGrupo);
      }

      mapeamentosPorGrupo.forEach(({ grupo, mapa }) => { DB.mapeamentos[grupo.sig] = mapa; });
      DB.meta[sourceKey + 'At'] = Date.now();
      persist();
      renderDados();
    });
  }

  function exportCSV(rows, filename) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const escape = (v) => {
      const s = String(v ?? '');
      return /[;,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.join(';'), ...rows.map((r) => headers.map((h) => escape(r[h])).join(';'))].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ---------------------------------------------------------------------
   * 8) DARK MODE + NAVEGAÇÃO + BOOT
   * ------------------------------------------------------------------- */

  function applyDarkMode(dark) {
    document.documentElement.classList.toggle('dark', dark);
    Store.set('dark', dark);
    const btn = $('#toggle-dark');
    if (btn) btn.textContent = dark ? '☀️' : '🌙';
  }

  function boot() {
    const dark = Store.get('dark', window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
    applyDarkMode(dark);

    $$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
    $('#toggle-dark')?.addEventListener('click', () => applyDarkMode(!document.documentElement.classList.contains('dark')));

    setTab('inicio');

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => { /* PWA opcional, ignora falha */ });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
