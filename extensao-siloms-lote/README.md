# SILOMS · Envio de PDFs em Lote

Extensão Chrome (Manifest V3) que **aprende** o processo de envio de um documento
observando você fazer uma vez e depois **repete** esse mesmo processo,
automaticamente, para cada PDF de uma pasta.

Não há seletor de tela escrito à mão: a extensão descobre sozinha onde ficam os
campos ao gravar você trabalhando. Funciona com o sistema **já logado** — ela usa
a sua própria sessão do navegador, não pede nem guarda senha.

---

## Instalação

1. Abra `chrome://extensions/`
2. Ligue o **Modo desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem compactação**
4. Selecione a pasta `extensao-siloms-lote`
5. Clique no ícone da extensão para abrir o painel lateral

---

## Como usar

### 1. Aprender (uma vez só)

1. Abra o SILOMS, faça login e navegue até a **tela inicial do envio**.
2. No painel, clique em **● Gravar**.
3. Faça o envio de **um** PDF do começo ao fim, normalmente: preencher campos,
   anexar o arquivo, salvar, confirmar.
4. Clique em **■ Parar**.

Os passos aparecem numerados no painel. Cada um mostra o que faz e onde clica.

### 2. Revisar

- **🎯** destaca na tela o elemento daquele passo (confere se acertou o alvo).
- **▲ ▼ ✕** reordenam ou removem passos.
- **Conferir na página** marca em verde os passos que existem na tela atual.
  É normal que passos de telas seguintes apareçam em vermelho.
- **+ Espera** insere uma pausa fixa, útil quando o sistema demora para responder.

### 3. Variáveis do nome do arquivo

Se um campo precisa mudar a cada PDF (o número da ata, por exemplo), troque o
valor fixo gravado por uma variável:

| Variável | Valor |
|---|---|
| `{{arquivo}}` | `ATA_00123-2026.pdf` |
| `{{nome}}` | `ATA_00123-2026` |
| `{{g1}}`…`{{g9}}` | grupos capturados pela regex |
| `{{indice}}` | posição na fila (1, 2, 3…) |
| `{{data}}` | data de hoje |

Exemplo — nomes no padrão `ATA_00123-2026.pdf` com a regex
`^ATA_(\d+)-(\d{4})`:

```
Campo "Número da Ata"  →  {{g1}}/{{g2}}     resulta em  00123/2026
```

O painel mostra a prévia do valor resolvido para o primeiro arquivo da fila.

> Ao parar a gravação, a extensão já sugere sozinha: se o que você digitou num
> campo era o nome do PDF, ela troca por `{{nome}}` automaticamente.

### 4. Escolher a pasta

**Escolher pasta…** abre o seletor de diretórios. A pasta fica memorizada entre
sessões — nas próximas vezes basta **Reler pasta**. Só arquivos `.pdf` entram na
fila, em ordem alfanumérica.

### 5. Executar

Sempre nesta ordem:

1. **▷ Testar com 1 arquivo** — valida o roteiro num envio real.
2. Confira no SILOMS se o documento entrou corretamente.
3. **▶ Executar lote** — processa o restante.

Durante a execução cada arquivo é marcado `OK` ou `ERRO`, e o registro mostra
passo a passo o que aconteceu. **■ Parar** interrompe após o passo atual.
**Baixar relatório CSV** exporta o resultado de todos os arquivos.

Opções:

- **Voltar à tela inicial antes de cada arquivo** — mantenha ligado; garante que
  cada envio comece do mesmo ponto.
- **Interromper no primeiro erro** — ligado por padrão. Desligue só depois de o
  roteiro estar comprovadamente estável.
- **Pausa entre arquivos** — aumente se o sistema for lento ou tiver limite de
  requisições.

---

## Como ela sobrevive a mudanças no sistema

Para cada elemento a extensão guarda **vários** caminhos alternativos, do mais
estável ao mais frágil, e tenta um por um na hora de repetir:

1. `id`, quando não é gerado automaticamente
2. atributo `name`
3. sufixo do ID em sistemas JSF/PrimeFaces — `[id$=":numeroAta"]`
4. `data-testid`, `aria-label`, `placeholder`, `title`
5. rótulo do campo — `LABEL:Número da Ata`
6. texto do botão — `TEXT:button|Salvar`
7. caminho CSS na árvore da página (último recurso)

IDs voláteis típicos de Java/JSF (`frmEnvio:j_idt91:numeroAta`) são descartados
já na gravação — eles mudam a cada nova versão da tela. Testado: quando o
sistema troca os IDs, o roteiro continua funcionando pelas alternativas.

Antes de cada passo a extensão **espera** o elemento aparecer (até 15s), o que
cobre telas com carregamento assíncrono. Se ele não aparecer, o arquivo é
marcado com erro explicando qual passo falhou — nunca clica em algo errado.

---

## Limitações conhecidas

- **O painel precisa ficar aberto** durante o lote; fechá-lo interrompe a fila.
- Não resolve **CAPTCHA** nem confirmação por token/2FA no meio do fluxo.
- Se o sistema abrir uma **janela nova** (não uma aba), o roteiro para ali.
- Sistemas que exigem eventos de mouse fisicamente reais (`isTrusted`) podem
  ignorar os cliques simulados — raro, mas se acontecer aparecerá como erro no
  passo de clique.
- A extensão **não valida** se o documento certo foi para o lugar certo. Confira
  uma amostra no sistema depois do lote.

---

## Restringindo a extensão ao seu sistema

O `manifest.json` vem com `<all_urls>` porque o endereço do SILOMS não era
conhecido na criação. Depois de identificar o domínio, troque nos **dois** lugares
para reduzir o alcance da extensão:

```json
"host_permissions": ["https://siloms.SEU-DOMINIO.mil.br/*"],
"content_scripts": [{ "matches": ["https://siloms.SEU-DOMINIO.mil.br/*"], ... }]
```

Recarregue a extensão em `chrome://extensions/` depois de editar.

---

## Arquivos

| Arquivo | Papel |
|---|---|
| `manifest.json` | Permissões e registro dos componentes (MV3) |
| `panel.html/.css/.js` | Painel lateral: gravação, roteiro, pasta, execução |
| `content.js` | Gravador e executor dentro da página; gera e resolve seletores |
| `background.js` | Service worker: abre o painel e serializa a gravação |

Os dados ficam só na sua máquina: roteiro e preferências em
`chrome.storage.local`, referência da pasta em IndexedDB. Nada é enviado para
fora do navegador.
