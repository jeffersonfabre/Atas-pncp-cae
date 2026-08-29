/* =========================================================================
   content.js — gravador + executor de passos
   Roda em todos os frames da página. Fica inerte enquanto não há gravação
   ativa nem execução em andamento.
   Expõe window.__silomsAPI para o painel chamar via chrome.scripting.
   ========================================================================= */

(() => {
  if (window.__silomsLoteCarregado) return;
  window.__silomsLoteCarregado = true;

  /* ----------------------------- utilidades ----------------------------- */

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // IDs gerados automaticamente por frameworks — não servem de seletor.
  const ID_INSTAVEL = /^(j_id|yui_|yui-gen|ext-gen|ui-id|ember|mat-|react-|:r[0-9a-z]+:)/i;

  function trechoEstavel(s) {
    if (!s) return false;
    if (ID_INSTAVEL.test(s)) return false;
    if (/^\d+$/.test(s)) return false; // índice de repetição: "tabela:3:campo"
    if (/\d{5,}/.test(s)) return false; // #campo1737382910
    return true;
  }

  // JSF/PrimeFaces monta IDs compostos ("frmEnvio:j_idt91:numeroAta"): basta um
  // trecho volátil no meio para o ID inteiro mudar na próxima versão da tela.
  function idEstavel(id) {
    if (!id || typeof id !== 'string') return false;
    return id.split(':').every(trechoEstavel);
  }

  function escAttr(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function normalizar(t) {
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  function textoDe(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT') return normalizar(el.value);
    // innerText respeita o que está visível; textContent cobre os casos em que
    // o elemento está fora do fluxo de renderização.
    return normalizar(el.innerText || el.textContent).slice(0, 100);
  }

  function visivel(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }

  function rotuloDe(el) {
    // <label for="id">
    if (el.id) {
      let lb = null;
      try {
        lb = document.querySelector(`label[for="${escAttr(el.id)}"]`);
      } catch {
        lb = [...document.querySelectorAll('label[for]')].find((l) => l.htmlFor === el.id) || null;
      }
      if (lb) return textoDe(lb).slice(0, 80);
    }
    // <label><input ...></label>
    const pai = el.closest && el.closest('label');
    if (pai) return textoDe(pai).slice(0, 80);
    return '';
  }

  /* --------------------- geração de seletores robustos ------------------- *
   * Para cada elemento geramos VÁRIOS candidatos, do mais estável ao mais
   * frágil. Na hora de repetir, tentamos um a um até achar o elemento.
   * Formatos especiais:
   *   TEXT:tag|texto   → casa pelo texto visível (botões, links)
   *   LABEL:texto      → casa pelo rótulo do campo
   * ---------------------------------------------------------------------- */

  function caminhoCss(el) {
    const partes = [];
    let n = el;
    let prof = 0;
    while (n && n.nodeType === 1 && prof < 7) {
      if (n.id && idEstavel(n.id)) {
        partes.unshift('#' + CSS.escape(n.id));
        break;
      }
      let sel = n.tagName.toLowerCase();
      const pai = n.parentElement;
      if (pai) {
        const irmaos = [...pai.children].filter((c) => c.tagName === n.tagName);
        if (irmaos.length > 1) sel += `:nth-of-type(${irmaos.indexOf(n) + 1})`;
      }
      partes.unshift(sel);
      n = pai;
      prof++;
    }
    return partes.join(' > ');
  }

  function gerarSeletores(el) {
    const c = [];
    const tag = el.tagName.toLowerCase();

    if (el.id && idEstavel(el.id)) c.push('#' + CSS.escape(el.id));
    if (el.name) c.push(`${tag}[name="${escAttr(el.name)}"]`);

    // JSF/PrimeFaces: "formulario:aba:btnSalvar" → casa pelo sufixo estável.
    if (el.id && el.id.includes(':')) {
      const suf = el.id.split(':').pop();
      if (suf && idEstavel(suf) && !/^\d+$/.test(suf)) {
        c.push(`[id$="${escAttr(':' + suf)}"]`);
      }
    }

    for (const a of ['data-testid', 'data-test', 'data-cy', 'aria-label', 'placeholder', 'title', 'alt']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && v.length < 80) c.push(`${tag}[${a}="${escAttr(v)}"]`);
    }

    const rot = rotuloDe(el);
    if (rot && ['input', 'select', 'textarea'].includes(tag)) c.push(`LABEL:${rot}`);

    const clicavel =
      ['button', 'a', 'summary'].includes(tag) ||
      (tag === 'input' && ['submit', 'button', 'reset'].includes(el.type)) ||
      el.getAttribute('role') === 'button';
    if (clicavel) {
      const t = tag === 'input' ? normalizar(el.value) : textoDe(el);
      if (t && t.length <= 60) c.push(`TEXT:${tag}|${t}`);
    }

    c.push(caminhoCss(el));
    return [...new Set(c)].filter(Boolean);
  }

  /* ------------------------ resolução de seletores ----------------------- */

  function candidatosPara(sel) {
    try {
      if (sel.startsWith('TEXT:')) {
        const corte = sel.slice(5);
        const tag = corte.slice(0, corte.indexOf('|'));
        const txt = normalizar(corte.slice(corte.indexOf('|') + 1)).toLowerCase();
        return [...document.querySelectorAll(tag)].filter(
          (e) => textoDe(e).toLowerCase() === txt
        );
      }
      if (sel.startsWith('LABEL:')) {
        const txt = normalizar(sel.slice(6)).toLowerCase();
        const achados = [];
        for (const lb of document.querySelectorAll('label')) {
          if (textoDe(lb).toLowerCase() !== txt) continue;
          let alvo = lb.htmlFor ? document.getElementById(lb.htmlFor) : null;
          if (!alvo) alvo = lb.querySelector('input, select, textarea');
          if (alvo) achados.push(alvo);
        }
        return achados;
      }
      return [...document.querySelectorAll(sel)];
    } catch {
      return [];
    }
  }

  function resolver(seletores, exigirVisivel = true) {
    for (const sel of seletores || []) {
      const brutos = candidatosPara(sel);
      if (!brutos.length) continue;
      const lista = exigirVisivel ? brutos.filter(visivel) : brutos;
      if (!lista.length) continue;
      return { el: lista[0], seletor: sel, ambiguo: lista.length > 1, total: lista.length };
    }
    return null;
  }

  async function esperarElemento(seletores, timeout = 15000, exigirVisivel = true) {
    const fim = Date.now() + timeout;
    for (;;) {
      const achado = resolver(seletores, exigirVisivel);
      if (achado) return achado;
      if (Date.now() > fim) return null;
      await dormir(150);
    }
  }

  /* ------------------------- manipulação de campos ----------------------- */

  // Usa o setter nativo para que React/Angular/Vue percebam a mudança.
  function setarValor(el, valor) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, valor);
    else el.value = valor;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clicarDeVerdade(el) {
    const op = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', op));
    } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', op));
    try {
      el.focus({ preventScroll: true });
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseup', op));
    el.click();
  }

  function base64ParaFile(b64, nome, tipo) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], nome, { type: tipo || 'application/pdf' });
  }

  function anexarArquivo(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ------------------------------ execução ------------------------------- */

  async function exec(passo, extra) {
    try {
      if (passo.tipo === 'esperar') {
        await dormir(passo.ms || 1000);
        return { ok: true, seletor: '—' };
      }

      if (passo.tipo === 'navegar') {
        location.href = passo.valor;
        return { ok: true, seletor: passo.valor, navegou: true };
      }

      // Campos de arquivo costumam estar escondidos atrás de um botão bonito.
      const exigirVisivel = passo.tipo !== 'upload';
      const achado = await esperarElemento(
        passo.seletores,
        passo.timeout || 15000,
        exigirVisivel
      );

      if (!achado) {
        return { ok: false, motivo: 'elemento não encontrado neste frame' };
      }

      const el = achado.el;
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch {}

      switch (passo.tipo) {
        case 'fill':
          setarValor(el, passo.valor ?? '');
          break;

        case 'select': {
          const alvo = String(passo.valor ?? '');
          let opt = [...el.options].find((o) => o.value === alvo);
          if (!opt) opt = [...el.options].find((o) => normalizar(o.text) === normalizar(passo.texto || alvo));
          if (!opt) return { ok: false, motivo: `opção "${alvo}" não existe na lista` };
          el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }

        case 'check':
          if (el.checked !== !!passo.marcado) clicarDeVerdade(el);
          break;

        case 'click':
          clicarDeVerdade(el);
          break;

        case 'key': {
          const op = { bubbles: true, cancelable: true, key: passo.valor || 'Enter' };
          el.dispatchEvent(new KeyboardEvent('keydown', op));
          el.dispatchEvent(new KeyboardEvent('keyup', op));
          if ((passo.valor || 'Enter') === 'Enter' && el.form) {
            const sub = el.form.querySelector('[type=submit]');
            if (sub) clicarDeVerdade(sub);
          }
          break;
        }

        case 'upload': {
          if (!extra || !extra.b64) return { ok: false, motivo: 'arquivo não recebido' };
          if (el.tagName !== 'INPUT' || el.type !== 'file') {
            return { ok: false, motivo: 'o alvo gravado não é um campo de arquivo' };
          }
          anexarArquivo(el, base64ParaFile(extra.b64, extra.nome, extra.tipo));
          break;
        }

        default:
          return { ok: false, motivo: `tipo de passo desconhecido: ${passo.tipo}` };
      }

      return { ok: true, seletor: achado.seletor, ambiguo: achado.ambiguo, total: achado.total };
    } catch (err) {
      return { ok: false, motivo: err.message };
    }
  }

  /* ------------------------------ gravação ------------------------------- */

  let gravando = false;

  chrome.storage.local.get('gravacaoAtiva').then(({ gravacaoAtiva }) => {
    gravando = !!gravacaoAtiva;
  });

  chrome.storage.onChanged.addListener((mud, area) => {
    if (area === 'local' && mud.gravacaoAtiva) gravando = !!mud.gravacaoAtiva.newValue;
  });

  function registrar(passo) {
    // O elemento em si não é serializável — usamos só para o efeito visual.
    const alvoEl = passo.alvoEl;
    delete passo.alvoEl;
    passo.chave = passo.seletores?.[0] || '';
    passo.url = location.href;
    chrome.runtime.sendMessage({ acao: 'gravarPasso', passo }).catch(() => {});
    piscar(alvoEl);
  }

  function piscar(el) {
    if (!el || !el.style) return;
    const antes = el.style.outline;
    el.style.outline = '2px solid #33e3c8';
    setTimeout(() => {
      el.style.outline = antes;
    }, 350);
  }

  function ehCampoArquivo(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT' && el.type === 'file') return true;
    if (el.tagName === 'LABEL') {
      const alvo = el.htmlFor ? document.getElementById(el.htmlFor) : el.querySelector('input[type=file]');
      return !!(alvo && alvo.type === 'file');
    }
    return false;
  }

  function acionavel(el) {
    if (!el || !el.closest) return el;
    return (
      el.closest(
        'button, a, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="menuitem"], [onclick]'
      ) || el
    );
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!gravando) return;
      const el = acionavel(e.target);
      if (!el || el === document.documentElement || el === document.body) return;
      const tag = el.tagName.toLowerCase();

      // Campo de texto: a digitação já vira um passo "fill".
      if (tag === 'textarea') return;
      if (tag === 'input' && !['submit', 'button', 'reset', 'checkbox', 'radio', 'file'].includes(el.type)) return;
      // Selecionar arquivo abre o diálogo do sistema — nunca repetir isso.
      if (ehCampoArquivo(el)) return;
      // Checkbox/radio são tratados no evento "change".
      if (tag === 'input' && ['checkbox', 'radio'].includes(el.type)) return;

      registrar({
        tipo: 'click',
        seletores: gerarSeletores(el),
        rotulo: textoDe(el) || el.getAttribute('aria-label') || tag,
        espera: 800,
        alvoEl: el,
      });
    },
    true
  );

  document.addEventListener(
    'change',
    (e) => {
      if (!gravando) return;
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();

      if (tag === 'select') {
        const opt = el.options[el.selectedIndex];
        registrar({
          tipo: 'select',
          seletores: gerarSeletores(el),
          valor: el.value,
          texto: opt ? normalizar(opt.text) : '',
          rotulo: rotuloDe(el) || el.name || 'lista',
          alvoEl: el,
        });
        return;
      }

      if (tag === 'input' && el.type === 'file') {
        registrar({
          tipo: 'upload',
          seletores: gerarSeletores(el),
          exemplo: el.files && el.files[0] ? el.files[0].name : '',
          rotulo: rotuloDe(el) || el.name || 'arquivo',
          espera: 1200,
          alvoEl: el,
        });
        return;
      }

      if (tag === 'input' && ['checkbox', 'radio'].includes(el.type)) {
        registrar({
          tipo: 'check',
          seletores: gerarSeletores(el),
          marcado: el.checked,
          rotulo: rotuloDe(el) || el.name || el.type,
          alvoEl: el,
        });
        return;
      }

      if (tag === 'input' || tag === 'textarea') {
        registrar({
          tipo: 'fill',
          seletores: gerarSeletores(el),
          valor: el.value,
          rotulo: rotuloDe(el) || el.name || el.placeholder || 'campo',
          alvoEl: el,
        });
      }
    },
    true
  );

  // Alguns sistemas nunca disparam "change" — capturamos a digitação também.
  let tmrInput = null;
  document.addEventListener(
    'input',
    (e) => {
      if (!gravando) return;
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return;
      if (tag === 'input' && ['file', 'checkbox', 'radio', 'submit', 'button'].includes(el.type)) return;
      clearTimeout(tmrInput);
      tmrInput = setTimeout(() => {
        registrar({
          tipo: 'fill',
          seletores: gerarSeletores(el),
          valor: el.value,
          rotulo: rotuloDe(el) || el.name || el.placeholder || 'campo',
          alvoEl: el,
        });
      }, 700);
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (!gravando) return;
      if (e.key !== 'Enter') return;
      const el = e.target;
      if (!el || !el.tagName) return;
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      registrar({
        tipo: 'key',
        seletores: gerarSeletores(el),
        valor: 'Enter',
        rotulo: 'Enter em ' + (rotuloDe(el) || el.name || 'campo'),
        espera: 800,
        alvoEl: el,
      });
    },
    true
  );

  /* -------------------------------- API ---------------------------------- */

  window.__silomsAPI = {
    exec,

    // Destaca na tela o elemento de um passo (botão 🎯 do painel).
    destacar(seletores) {
      const achado = resolver(seletores, false);
      if (!achado) return { ok: false };
      const el = achado.el;
      el.scrollIntoView({ block: 'center' });
      const antes = el.style.outline;
      el.style.outline = '3px solid #f2a93b';
      setTimeout(() => {
        el.style.outline = antes;
      }, 2000);
      return { ok: true, seletor: achado.seletor, ambiguo: achado.ambiguo };
    },

    // Confere quais passos do roteiro existem na página atual.
    conferir(passos) {
      return (passos || []).map((p) => {
        if (p.tipo === 'esperar' || p.tipo === 'navegar') return { ok: true };
        const achado = resolver(p.seletores, p.tipo !== 'upload');
        return achado
          ? { ok: true, seletor: achado.seletor, ambiguo: achado.ambiguo }
          : { ok: false };
      });
    },

    pronto: true,
  };
})();
