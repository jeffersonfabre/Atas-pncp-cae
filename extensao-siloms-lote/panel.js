/* =========================================================================
   panel.js — cérebro da extensão
   Grava o roteiro, guarda a pasta escolhida e repete o processo por arquivo.
   ========================================================================= */

const $ = (id) => document.getElementById(id);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

let abaId = null;          // aba do SILOMS onde tudo acontece
let roteiro = { urlInicial: '', passos: [] };
let arquivos = [];         // FileSystemFileHandle[] ou File[]
let dirHandle = null;      // pasta persistida (File System Access API)
let executando = false;
let abortar = false;
let relatorio = [];        // linhas para o CSV

/* ===================== 0. IndexedDB p/ lembrar a pasta ==================== */

function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('siloms-lote', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(k);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/* ============================ 1. Log e estado ============================ */

function log(msg, classe = 'l-info') {
  const d = document.createElement('div');
  d.className = classe;
  d.textContent = `${new Date().toLocaleTimeString('pt-BR')}  ${msg}`;
  $('log').prepend(d);
  while ($('log').children.length > 400) $('log').lastChild.remove();
}

async function salvarRoteiro() {
  await chrome.storage.local.set({ roteiro });
}

async function salvarConfig() {
  await chrome.storage.local.set({
    config: {
      regex: $('regexNome').value,
      pausa: +$('pausaMs').value,
      voltar: $('optVoltar').checked,
      pararNoErro: $('optParar').checked,
    },
  });
}

/* ========================== 2. Aba alvo e injeção ========================= */

async function detectarAba() {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!aba || !aba.url || /^(chrome|edge|about|chrome-extension):/.test(aba.url)) {
    $('alvoUrl').textContent = 'abra a aba do sistema e clique aqui';
    return;
  }
  abaId = aba.id;
  $('alvoUrl').textContent = aba.url;
  $('alvoUrl').title = aba.url;
}

async function garantirInjecao(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => !!window.__silomsAPI,
    });
    if (r.some((x) => x.result)) return true;
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    return true;
  } catch (e) {
    log('Não consegui injetar o script nesta página: ' + e.message, 'l-err');
    return false;
  }
}

function esperarCarregar(tabId, timeout = 25000) {
  return new Promise((res) => {
    let pronto = false;
    const fim = () => {
      if (pronto) return;
      pronto = true;
      chrome.tabs.onUpdated.removeListener(ouv);
      res();
    };
    const ouv = (id, info) => {
      if (id === tabId && info.status === 'complete') setTimeout(fim, 250);
    };
    chrome.tabs.onUpdated.addListener(ouv);
    setTimeout(fim, timeout);
  });
}

async function estabilizar(tabId, ms) {
  await dormir(ms);
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t && t.status !== 'complete') await esperarCarregar(tabId);
}

async function navegarPara(tabId, url) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t && t.url === url) return;
  await chrome.tabs.update(tabId, { url });
  await esperarCarregar(tabId);
  await garantirInjecao(tabId);
}

/* ============================== 3. Gravação ============================== */

$('btnGravar').addEventListener('click', async () => {
  await detectarAba();
  if (!abaId) return log('Abra a aba do sistema antes de gravar.', 'l-err');

  const aba = await chrome.tabs.get(abaId);
  await garantirInjecao(abaId);

  roteiro = { urlInicial: aba.url, origem: new URL(aba.url).origin, passos: [] };
  await chrome.storage.local.set({ roteiroTmp: { passos: [] }, gravacaoAtiva: true });

  $('btnGravar').disabled = true;
  $('btnParar').disabled = false;
  $('avisoGravando').classList.remove('oculto');
  log('Gravação iniciada em ' + aba.url, 'l-av');
});

$('btnParar').addEventListener('click', async () => {
  await chrome.storage.local.set({ gravacaoAtiva: false });
  const { roteiroTmp } = await chrome.storage.local.get('roteiroTmp');
  roteiro.passos = (roteiroTmp && roteiroTmp.passos) || [];

  // Sugere ligar o campo cujo valor apareceu no nome do PDF enviado.
  const up = roteiro.passos.find((p) => p.tipo === 'upload' && p.exemplo);
  if (up) {
    const base = up.exemplo.replace(/\.pdf$/i, '');
    for (const p of roteiro.passos) {
      if (p.tipo !== 'fill' || !p.valor) continue;
      if (up.exemplo === p.valor) p.valor = '{{arquivo}}';
      else if (base === p.valor) p.valor = '{{nome}}';
      else if (base.includes(p.valor) && p.valor.length >= 4) p.sugestao = true;
    }
  }

  await salvarRoteiro();
  $('btnGravar').disabled = false;
  $('btnParar').disabled = true;
  $('avisoGravando').classList.add('oculto');
  log(`Gravação encerrada: ${roteiro.passos.length} passos.`, 'l-ok');
  renderPassos();
});

// A lista se atualiza sozinha enquanto você grava.
chrome.storage.onChanged.addListener((mud, area) => {
  if (area !== 'local' || !mud.roteiroTmp) return;
  const p = (mud.roteiroTmp.newValue && mud.roteiroTmp.newValue.passos) || [];
  $('contPassos').textContent = `${p.length} passos`;
  if (!$('btnParar').disabled) {
    roteiro.passos = p;
    renderPassos();
  }
});

/* ========================= 4. Lista de passos (UI) ======================= */

const ROTULO_TIPO = {
  fill: 'preencher',
  click: 'clicar',
  select: 'selecionar',
  check: 'marcar',
  upload: 'anexar PDF',
  key: 'tecla',
  esperar: 'esperar',
  navegar: 'ir para',
};

function renderPassos() {
  const box = $('listaPassos');
  box.innerHTML = '';
  $('contPassos').textContent = `${roteiro.passos.length} passos`;

  if (!roteiro.passos.length) {
    box.innerHTML = '<p class="vazio">Nenhum passo gravado ainda.</p>';
    return;
  }

  const ctxPrevia = arquivos.length ? montarCtx(nomeDe(arquivos[0]), 0) : null;

  roteiro.passos.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'passo' + (p._status ? ' ' + p._status : '');

    const editavel = ['fill', 'select', 'esperar', 'navegar', 'key'].includes(p.tipo);
    const valorAtual = p.tipo === 'esperar' ? p.ms ?? 1000 : p.valor ?? '';
    const previa =
      ctxPrevia && p.tipo === 'fill' && String(p.valor || '').includes('{{')
        ? `→ ${interpolarTexto(p.valor, ctxPrevia)}`
        : '';

    el.innerHTML = `
      <div class="idx">${String(i + 1).padStart(2, '0')}</div>
      <div class="corpo">
        <div class="tipo">${ROTULO_TIPO[p.tipo] || p.tipo}${p.tipo === 'upload' ? ' ◆' : ''}</div>
        <div class="rotulo" title="${escHtml(p.rotulo || '')}">${escHtml(p.rotulo || '—')}</div>
        ${editavel ? `<input class="val" data-i="${i}" value="${escHtml(valorAtual)}">` : ''}
        ${previa ? `<div class="previa">${escHtml(previa)}</div>` : ''}
        <div class="sel" title="${escHtml((p.seletores || []).join('  |  '))}">${escHtml(
      (p.seletores || [])[0] || '—'
    )}</div>
      </div>
      <div class="acoes">
        <button data-ac="ver" data-i="${i}" title="Destacar na página">🎯</button>
        <button data-ac="sobe" data-i="${i}" title="Subir">▲</button>
        <button data-ac="desce" data-i="${i}" title="Descer">▼</button>
        <button data-ac="del" data-i="${i}" title="Remover">✕</button>
      </div>`;
    box.appendChild(el);
  });

  box.querySelectorAll('input.val').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const p = roteiro.passos[+inp.dataset.i];
      if (p.tipo === 'esperar') p.ms = +inp.value || 0;
      else p.valor = inp.value;
      await salvarRoteiro();
      renderPassos();
    });
  });

  box.querySelectorAll('.acoes button').forEach((b) => {
    b.addEventListener('click', () => acaoPasso(b.dataset.ac, +b.dataset.i));
  });
}

async function acaoPasso(ac, i) {
  if (ac === 'del') roteiro.passos.splice(i, 1);
  if (ac === 'sobe' && i > 0)
    [roteiro.passos[i - 1], roteiro.passos[i]] = [roteiro.passos[i], roteiro.passos[i - 1]];
  if (ac === 'desce' && i < roteiro.passos.length - 1)
    [roteiro.passos[i + 1], roteiro.passos[i]] = [roteiro.passos[i], roteiro.passos[i + 1]];

  if (ac === 'ver') {
    await detectarAba();
    if (!abaId) return;
    await garantirInjecao(abaId);
    const r = await chrome.scripting.executeScript({
      target: { tabId: abaId, allFrames: true },
      func: (s) => (window.__silomsAPI ? window.__silomsAPI.destacar(s) : { ok: false }),
      args: [roteiro.passos[i].seletores],
    });
    const achou = r.map((x) => x.result).find((x) => x && x.ok);
    log(
      achou
        ? `Passo ${i + 1} localizado via ${achou.seletor}${achou.ambiguo ? ' (vários iguais!)' : ''}`
        : `Passo ${i + 1} NÃO foi localizado na página atual.`,
      achou ? 'l-ok' : 'l-err'
    );
    return;
  }

  await salvarRoteiro();
  renderPassos();
}

$('btnAddEspera').addEventListener('click', async () => {
  roteiro.passos.push({ tipo: 'esperar', ms: 2000, rotulo: 'pausa manual', seletores: [] });
  await salvarRoteiro();
  renderPassos();
});

$('btnLimpar').addEventListener('click', async () => {
  if (!confirm('Apagar o roteiro gravado?')) return;
  roteiro = { urlInicial: '', passos: [] };
  await salvarRoteiro();
  renderPassos();
  log('Roteiro apagado.', 'l-av');
});

$('btnConferir').addEventListener('click', async () => {
  await detectarAba();
  if (!abaId || !roteiro.passos.length) return;
  await garantirInjecao(abaId);
  const r = await chrome.scripting.executeScript({
    target: { tabId: abaId, allFrames: true },
    func: (ps) => (window.__silomsAPI ? window.__silomsAPI.conferir(ps) : null),
    args: [roteiro.passos],
  });
  const frames = r.map((x) => x.result).filter(Boolean);
  let achados = 0;
  roteiro.passos.forEach((p, i) => {
    const ok = frames.some((f) => f[i] && f[i].ok);
    p._status = ok ? 'achou' : 'falhou';
    if (ok) achados++;
  });
  renderPassos();
  log(
    `Conferência: ${achados}/${roteiro.passos.length} passos existem na tela atual. ` +
      'É normal que passos de telas seguintes apareçam como não encontrados.',
    'l-info'
  );
});

/* ============================ 5. Pasta e nomes =========================== */

function nomeDe(x) {
  return x.name;
}

async function pegarFile(x) {
  return x.getFile ? await x.getFile() : x;
}

async function escolherPasta() {
  // Caminho preferido: lembra a pasta entre sessões.
  if (window.showDirectoryPicker) {
    try {
      const h = await window.showDirectoryPicker({ id: 'pdfs-siloms', mode: 'read' });
      dirHandle = h;
      await idbSet('pasta', h);
      await lerPasta();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      log('Seletor de pasta indisponível aqui; usando o modo simples. ' + e.message, 'l-av');
    }
  }
  $('inputPasta').click();
}

$('inputPasta').addEventListener('change', (e) => {
  arquivos = [...e.target.files].filter((f) => /\.pdf$/i.test(f.name));
  ordenar();
  renderArquivos();
  log(`${arquivos.length} PDFs carregados (modo simples — reescolha a cada sessão).`, 'l-ok');
});

async function lerPasta() {
  if (!dirHandle) return;
  const opt = { mode: 'read' };
  let perm = await dirHandle.queryPermission(opt);
  if (perm !== 'granted') perm = await dirHandle.requestPermission(opt);
  if (perm !== 'granted') return log('Permissão de leitura da pasta negada.', 'l-err');

  arquivos = [];
  for await (const [nome, h] of dirHandle.entries()) {
    if (h.kind === 'file' && /\.pdf$/i.test(nome)) arquivos.push(h);
  }
  ordenar();
  renderArquivos();
  log(`Pasta "${dirHandle.name}": ${arquivos.length} PDFs.`, 'l-ok');
}

function ordenar() {
  arquivos.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
}

function renderArquivos() {
  const box = $('listaArquivos');
  if (!arquivos.length) {
    box.innerHTML = '<p class="vazio">Nenhuma pasta escolhida.</p>';
    return;
  }
  box.innerHTML = '';
  arquivos.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'arq';
    d.id = 'arq-' + i;
    d.innerHTML = `<span class="n">${escHtml(a.name)}</span><span class="st">·</span>`;
    box.appendChild(d);
  });
  renderPassos(); // atualiza a prévia das variáveis
}

function marcarArquivo(i, estado, texto) {
  const d = $('arq-' + i);
  if (!d) return;
  const s = d.querySelector('.st');
  s.className = 'st ' + estado;
  s.textContent = texto;
}

$('btnPasta').addEventListener('click', escolherPasta);
$('btnRecarregar').addEventListener('click', lerPasta);

/* ========================== 6. Variáveis do nome ========================= */

function montarCtx(nomeArq, indice) {
  const semExt = nomeArq.replace(/\.[^.]+$/, '');
  const ctx = {
    arquivo: nomeArq,
    nome: semExt,
    indice: String(indice + 1),
    data: new Date().toLocaleDateString('pt-BR'),
  };
  const fonte = ($('regexNome').value || '').trim();
  if (fonte) {
    try {
      const m = nomeArq.match(new RegExp(fonte));
      if (m) {
        for (let g = 1; g <= 9; g++) ctx['g' + g] = m[g] ?? '';
        if (m.groups) Object.assign(ctx, m.groups);
      }
    } catch {
      /* regex inválida — ignora */
    }
  }
  return ctx;
}

function interpolarTexto(txt, ctx) {
  return String(txt ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in ctx ? ctx[k] : `{{${k}}}`));
}

function interpolarPasso(p, ctx) {
  const c = { ...p };
  if (typeof c.valor === 'string') c.valor = interpolarTexto(c.valor, ctx);
  return c;
}

/* ============================== 7. Execução ============================== */

async function fileParaBase64(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function executarPasso(passo, file) {
  let extra = null;
  if (passo.tipo === 'upload') {
    if (!file) return { ok: false, motivo: 'nenhum arquivo para anexar' };
    extra = {
      nome: file.name,
      tipo: file.type || 'application/pdf',
      b64: await fileParaBase64(file),
    };
  }

  let res;
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: abaId, allFrames: true },
      func: (p, a) => (window.__silomsAPI ? window.__silomsAPI.exec(p, a) : { ok: false, motivo: 'script ausente' }),
      args: [passo, extra],
    });
    const saidas = r.map((x) => x.result).filter(Boolean);
    res = saidas.find((s) => s.ok) || saidas[0] || { ok: false, motivo: 'sem resposta da página' };
  } catch (e) {
    // A página navegou no meio do passo: espera carregar e considera feito.
    await esperarCarregar(abaId);
    await garantirInjecao(abaId);
    return { ok: true, seletor: '(a página navegou)', navegou: true };
  }

  if (res.ok && ['click', 'key', 'upload'].includes(passo.tipo)) {
    await estabilizar(abaId, passo.espera ?? 800);
    await garantirInjecao(abaId);
  }
  return res;
}

async function processarArquivo(item, indice) {
  const file = await pegarFile(item);
  const ctx = montarCtx(file.name, indice);
  marcarArquivo(indice, 'run', '…');
  log(`▶ ${file.name}`, 'l-av');

  if ($('optVoltar').checked && roteiro.urlInicial) {
    await navegarPara(abaId, roteiro.urlInicial);
  }
  await garantirInjecao(abaId);

  for (let i = 0; i < roteiro.passos.length; i++) {
    if (abortar) throw new Error('interrompido pelo usuário');
    const p = interpolarPasso(roteiro.passos[i], ctx);
    const res = await executarPasso(p, file);
    if (!res.ok) {
      const erro = `passo ${i + 1} (${ROTULO_TIPO[p.tipo] || p.tipo} · ${p.rotulo || ''}): ${res.motivo}`;
      log('  ✕ ' + erro, 'l-err');
      throw new Error(erro);
    }
    log(`  ✓ ${i + 1}. ${ROTULO_TIPO[p.tipo] || p.tipo}${p.valor ? ' = ' + p.valor : ''}`, 'l-ok');
  }
}

async function rodar(lista) {
  if (!roteiro.passos.length) return log('Grave o processo antes de executar.', 'l-err');
  if (!lista.length) return log('Escolha a pasta com os PDFs.', 'l-err');
  await detectarAba();
  if (!abaId) return log('Abra a aba do sistema.', 'l-err');

  executando = true;
  abortar = false;
  relatorio = [];
  $('btnLote').disabled = $('btnTeste').disabled = true;
  $('btnAbortar').disabled = false;

  let ok = 0;
  let falhas = 0;

  for (let i = 0; i < lista.length; i++) {
    if (abortar) break;
    const nome = nomeDe(lista[i]);
    try {
      await processarArquivo(lista[i], i);
      ok++;
      marcarArquivo(i, 'ok', 'OK');
      relatorio.push({ arquivo: nome, situacao: 'OK', detalhe: '' });
    } catch (e) {
      falhas++;
      marcarArquivo(i, 'err', 'ERRO');
      relatorio.push({ arquivo: nome, situacao: 'ERRO', detalhe: e.message });
      if ($('optParar').checked) {
        log('Lote interrompido no primeiro erro.', 'l-err');
        break;
      }
    }
    $('progresso').style.width = `${((i + 1) / lista.length) * 100}%`;
    $('resumo').textContent = `${i + 1}/${lista.length} · ${ok} enviados · ${falhas} com erro`;
    if (i < lista.length - 1) await dormir(+$('pausaMs').value || 0);
  }

  executando = false;
  $('btnLote').disabled = $('btnTeste').disabled = false;
  $('btnAbortar').disabled = true;
  log(`Fim: ${ok} enviados, ${falhas} com erro.`, falhas ? 'l-av' : 'l-ok');
}

$('btnTeste').addEventListener('click', () => rodar(arquivos.slice(0, 1)));

$('btnLote').addEventListener('click', () => {
  const msg =
    `Confirma o envio automático de ${arquivos.length} PDFs?\n\n` +
    `Cada arquivo repetirá os ${roteiro.passos.length} passos gravados no sistema real.\n` +
    `Recomendado: rode antes o teste com 1 arquivo.`;
  if (confirm(msg)) rodar(arquivos);
});

$('btnAbortar').addEventListener('click', () => {
  abortar = true;
  log('Interrompendo após o passo atual…', 'l-av');
});

/* ============================== 8. Relatório ============================= */

$('btnCsv').addEventListener('click', () => {
  if (!relatorio.length) return log('Nada para exportar ainda.', 'l-av');
  const linhas = [
    'arquivo;situacao;detalhe',
    ...relatorio.map((r) => `"${r.arquivo}";"${r.situacao}";"${String(r.detalhe).replace(/"/g, "'")}"`),
  ];
  const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: `envio-lote-${new Date().toISOString().slice(0, 10)}.csv`,
  });
});

$('btnLimparLog').addEventListener('click', () => ($('log').innerHTML = ''));

/* ============================== 9. Utilidades =========================== */

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

['regexNome', 'pausaMs', 'optVoltar', 'optParar'].forEach((id) =>
  $(id).addEventListener('change', () => {
    salvarConfig();
    renderPassos();
  })
);

$('alvo').addEventListener('click', detectarAba);

/* ============================== 10. Início ============================== */

(async function iniciar() {
  await detectarAba();

  const { roteiro: r, config: c, gravacaoAtiva } = await chrome.storage.local.get([
    'roteiro',
    'config',
    'gravacaoAtiva',
  ]);
  if (r) roteiro = r;
  if (c) {
    $('regexNome').value = c.regex || '';
    $('pausaMs').value = c.pausa ?? 1500;
    $('optVoltar').checked = c.voltar !== false;
    $('optParar').checked = c.pararNoErro !== false;
  }
  if (gravacaoAtiva) {
    // Painel reaberto no meio de uma gravação.
    $('btnGravar').disabled = true;
    $('btnParar').disabled = false;
    $('avisoGravando').classList.remove('oculto');
  }

  try {
    const h = await idbGet('pasta');
    if (h) {
      dirHandle = h;
      const perm = await h.queryPermission({ mode: 'read' });
      if (perm === 'granted') await lerPasta();
      else log(`Pasta "${h.name}" lembrada — clique em "Reler pasta" para liberar o acesso.`, 'l-av');
    }
  } catch {}

  renderPassos();
  log('Painel pronto.', 'l-info');
})();
