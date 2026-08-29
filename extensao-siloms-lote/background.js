/* =========================================================================
   background.js — service worker (MV3)
   Responsabilidades:
     1. Abrir o painel lateral ao clicar no ícone da extensão.
     2. Serializar a gravação de passos (evita corrida entre frames).
   ========================================================================= */

// Clicar no ícone abre o painel lateral.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[SILOMS] sidePanel indisponível:', e.message));
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    // Fallback: abre o painel como aba normal.
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
  }
});

/* ------------------------------------------------------------------ *
 * Gravação de passos                                                  *
 * Todos os frames mandam os passos para cá. Um único ponto de escrita  *
 * na storage evita que dois frames sobrescrevam o buffer um do outro.  *
 * ------------------------------------------------------------------ */

let fila = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.acao === 'gravarPasso') {
    fila = fila.then(() => anexarPasso(msg.passo, sender));
    fila.then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, erro: err.message })
    );
    return true; // canal assíncrono
  }

  if (msg?.acao === 'abrirPainelAba') {
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function anexarPasso(passo, sender) {
  const { gravacaoAtiva } = await chrome.storage.local.get('gravacaoAtiva');
  if (!gravacaoAtiva) return; // gravação já foi encerrada

  const { roteiroTmp } = await chrome.storage.local.get('roteiroTmp');
  const buffer = roteiroTmp || { passos: [] };

  passo.frameUrl = sender?.url || '';
  passo.frameId = sender?.frameId ?? 0;
  passo.em = Date.now();

  const ultimo = buffer.passos[buffer.passos.length - 1];

  // Digitação contínua no mesmo campo vira UM passo só (o valor final).
  if (
    passo.tipo === 'fill' &&
    ultimo &&
    ultimo.tipo === 'fill' &&
    ultimo.chave === passo.chave
  ) {
    ultimo.valor = passo.valor;
  } else if (
    // Ignora clique repetido no mesmo alvo em menos de 400ms (duplo disparo).
    ultimo &&
    ultimo.tipo === 'click' &&
    passo.tipo === 'click' &&
    ultimo.chave === passo.chave &&
    passo.em - ultimo.em < 400
  ) {
    // descarta
  } else {
    buffer.passos.push(passo);
  }

  await chrome.storage.local.set({ roteiroTmp: buffer });
}
