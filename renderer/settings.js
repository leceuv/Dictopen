(async () => {
  const $ = (id) => document.getElementById(id);
  const api = window.dictee;
  let settings = await api.getSettings();

  const BUTTONS = [
    ['eolOrPrio', 'EOL / Prio'], ['info', 'Info'], ['insOrOvr', 'INS / OVR'], ['playOrPause', 'Lecture / Pause'],
    ['rewind', 'Retour rapide'], ['fastForward', 'Avance rapide'], ['F1', 'F1'], ['F2', 'F2'], ['F3', 'F3'], ['F4', 'F4'], ['rear', 'Bouton arrière'],
  ];
  const ACTIONS = [
    ['none', '— rien —'], ['rediger', 'rédiger le courrier'], ['newDraft', 'nouveau courrier'], ['toggleMode', 'changer de mode'],
    ['toggleBar', 'afficher / masquer la barre'], ['toggleRecording', 'dicter marche/arrêt'], ['cancel', 'annuler l’énoncé'],
    ['copyLastText', 'copier le dernier texte'], ['correctSelection', 'corriger le texte sélectionné'], ['openSettings', 'ouvrir les réglages'], ['hotkey', 'raccourci clavier…'],
  ];

  function showSaved() {
    const s = $('saved');
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 1200);
  }

  async function save(partial) {
    settings = await api.saveSettings(partial);
    showSaved();
  }

  // --- mode ---
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = r.value === settings.mode;
    r.addEventListener('change', async () => { if (r.checked) { await api.setMode(r.value); showSaved(); } });
  }
  api.onState(({ mode }) => { for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === mode; });

  // --- autorisations macOS ---
  if (api.platform === 'darwin') {
    $('permsSection').hidden = false;
    const label = (v) => (v === 'granted' ? 'accordée' : v === 'denied' ? 'refusée' : v === 'not-determined' ? 'non demandée' : v);
    const renderPerms = (st) => {
      $('permsStatus').innerHTML = `Micro : <b class="${st.microphone === 'granted' ? 'ok' : 'ko'}">${label(st.microphone)}</b> · Accessibilité : <b class="${st.accessibility === 'granted' ? 'ok' : 'ko'}">${label(st.accessibility)}</b> · Automatisation : <b class="${st.automation === 'granted' ? 'ok' : 'ko'}">${label(st.automation)}</b>`;
    };
    api.checkPermissions().then(renderPerms);
    $('permsRequest').addEventListener('click', async () => { $('permsStatus').textContent = 'demande en cours…'; renderPerms(await api.requestPermissions()); });
  }

  // --- clé ---
  async function refreshKey() {
    const m = await api.getApiKeyMasked();
    $('keyMasked').textContent = m || 'aucune';
  }
  $('keyPaste').addEventListener('click', async () => { $('keyInput').value = (await api.readClipboardText()).trim(); });
  $('keySave').addEventListener('click', async () => {
    const v = $('keyInput').value.trim();
    if (!v) { $('keyResult').textContent = 'Le champ est vide.'; $('keyResult').className = 'hint ko'; return; }
    try { await api.setApiKey(v); } catch (e) { $('keyResult').textContent = 'Échec : ' + e.message; $('keyResult').className = 'hint ko'; return; }
    $('keyResult').textContent = 'Clé enregistrée. Cliquez sur « Tester ».'; $('keyResult').className = 'hint ok';
    $('keyInput').value = '';
    await refreshKey();
    showSaved();
  });
  $('keyTest').addEventListener('click', async () => {
    $('keyResult').textContent = 'Test en cours…';
    $('keyResult').className = 'hint';
    const r = await api.testApiKey();
    $('keyResult').textContent = r.message;
    $('keyResult').className = 'hint ' + (r.ok ? 'ok' : 'ko');
  });
  await refreshKey();

  // --- consommation ---
  function renderUsage(u) {
    $('usageUsd').textContent = u.usd.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' $';
    $('usageDetail').textContent = `depuis le ${new Date(u.since).toLocaleString('fr-FR')}`;
    $('usageAudio').textContent = `${(u.audioSeconds / 60).toFixed(1)} min`;
    $('usageUtt').textContent = u.utterances;
    $('usageLetters').textContent = u.letters || 0;
    $('usageCorrections').textContent = u.corrections || 0;
    $('usageTokens').textContent = `${u.textInputTokens || 0} / ${u.textOutputTokens || 0}`;
  }
  renderUsage(await api.getUsage());
  api.onUsage(renderUsage);
  $('usageReset').addEventListener('click', async () => { if (confirm('Remettre le compteur à zéro ?')) renderUsage(await api.resetUsage()); });

  // --- dictée directe ---
  $('d_model').value = settings.direct.transcriptionModel;
  $('d_delay').value = settings.direct.delay;
  const showDelay = (modelId, rowId) => { $(rowId).style.display = $(modelId).value === 'gpt-live-transcribe' ? '' : 'none'; };
  showDelay('d_model', 'd_delayRow');
  $('d_model').addEventListener('change', () => showDelay('d_model', 'd_delayRow'));
  $('d_punct').checked = !!settings.direct.localPunctuation;
  $('d_record').value = settings.direct.recordButtonMode || 'pressed';
  const saveDirect = () => save({ direct: { transcriptionModel: $('d_model').value, delay: $('d_delay').value, localPunctuation: $('d_punct').checked, recordButtonMode: $('d_record').value } });
  for (const id of ['d_model', 'd_delay', 'd_punct', 'd_record']) $(id).addEventListener('change', saveDirect);

  $('extInstall').addEventListener('click', async () => {
    const dest = await api.installExtension();
    $('extResult').textContent = 'Dossier prêt : ' + dest;
    const mod = api.platform === 'darwin' ? '⇧⌘G' : 'la barre d’adresse';
    $('extSteps').style.display = '';
    $('extSteps').innerHTML = `Dans la page des extensions qui vient de s'ouvrir (sinon tapez <code>chrome://extensions</code>) : 1. activez <b>Mode développeur</b> (en haut à droite) ; 2. cliquez <b>Charger l'extension non empaquetée</b> ; 3. choisissez le dossier montré dans le ${api.platform === 'darwin' ? 'Finder' : 'l’Explorateur'} (${mod} pour coller son chemin). C'est tout : l'extension se connecte à Dictopen toute seule. Pour une mise à jour, recliquez ici puis ↻ sur l'extension.`;
  });

  // jeton de l'API locale (partagé avec l'extension) : affiché masqué, copie, régénération
  const showToken = (t) => { $('extToken').value = t ? `${t.slice(0, 6)}…${t.slice(-4)}` : ''; $('extToken').title = t || ''; };
  showToken(await api.getLocalApiToken());
  $('extTokenCopy').addEventListener('click', async () => {
    const t = await api.getLocalApiToken();
    await api.reviewCopy(t);
    $('extTokenResult').textContent = 'Jeton copié : collez-le dans les options de l’extension.';
  });
  $('extTokenNew').addEventListener('click', async () => {
    if (!confirm('Régénérer le jeton ? Les extensions installées devront être mises à jour (bouton « Installer » puis ↻ dans Chrome, ou coller le nouveau jeton).')) return;
    showToken(await api.regenerateLocalApiToken());
    $('extTokenResult').textContent = 'Nouveau jeton. Recliquez « Installer » (ou recollez-le) puis rechargez l’extension.';
    showSaved();
  });

  // --- courrier ---
  $('c_model').value = settings.courrier.transcriptionModel;
  $('c_delay').value = settings.courrier.delay;
  showDelay('c_model', 'c_delayRow');
  $('c_model').addEventListener('change', () => showDelay('c_model', 'c_delayRow'));
  $('c_draft').value = settings.courrier.draftModel;
  $('c_effort').value = settings.courrier.reasoningEffort || 'low';
  $('c_prompt').value = settings.courrier.masterPrompt || '';
  $('c_record').value = settings.courrier.recordButtonMode || 'toggle';
  const saveCourrier = () => save({ courrier: { transcriptionModel: $('c_model').value, delay: $('c_delay').value, draftModel: $('c_draft').value, reasoningEffort: $('c_effort').value, masterPrompt: $('c_prompt').value, recordButtonMode: $('c_record').value } });
  for (const id of ['c_model', 'c_delay', 'c_draft', 'c_effort', 'c_prompt', 'c_record']) $(id).addEventListener('change', saveCourrier);
  $('c_promptDefault').addEventListener('click', async () => {
    if (!confirm('Effacer votre prompt et revenir au prompt par défaut ?')) return;
    $('c_prompt').value = '';
    await saveCourrier();
  });

  // --- correction de la sélection ---
  $('k_provider').value = settings.correction.provider || 'openai';
  $('k_anthropicModel').value = settings.correction.anthropicModel || 'claude-sonnet-5-5';
  $('k_claudeCodeModel').value = settings.correction.claudeCodeModel || 'sonnet';
  const showProvider = () => { const p = $('k_provider').value; for (const cls of ['k-openai', 'k-anthropic', 'k-claude-code']) for (const el of document.querySelectorAll('.' + cls)) el.style.display = cls === 'k-' + p ? '' : 'none'; };
  showProvider();
  $('k_model').value = settings.correction.model || 'gpt-5-mini';
  $('k_effort').value = settings.correction.reasoningEffort || 'minimal';
  $('k_level').value = settings.correction.level || 'ortho';
  $('k_instructions').value = settings.correction.instructions || '';
  const renderExt = () => {
    $('k_paragraphes').value = settings.correction.paragraphes === 'garder' ? 'garder' : 'supprimer';
    $('k_showSent').checked = settings.correction.showSent !== false;
    $('k_directSend').checked = !!settings.correction.directSend;
    $('k_directSendWarn').style.display = $('k_directSend').checked ? '' : 'none';
  };
  renderExt();
  api.onSettingsChanged((s) => { settings = s; renderExt(); });
  const saveCorrection = () => { showProvider(); $('k_directSendWarn').style.display = $('k_directSend').checked ? '' : 'none'; return save({ correction: { provider: $('k_provider').value, anthropicModel: $('k_anthropicModel').value, claudeCodeModel: $('k_claudeCodeModel').value, model: $('k_model').value, reasoningEffort: $('k_effort').value, level: $('k_level').value, instructions: $('k_instructions').value, paragraphes: $('k_paragraphes').value, showSent: $('k_showSent').checked, directSend: $('k_directSend').checked } }); };
  for (const id of ['k_provider', 'k_anthropicModel', 'k_claudeCodeModel', 'k_model', 'k_effort', 'k_level', 'k_instructions', 'k_paragraphes', 'k_showSent', 'k_directSend']) $(id).addEventListener('change', saveCorrection);
  // clé Anthropic
  const refreshAKey = async () => { $('akeyMasked').textContent = (await api.getApiKeyMasked('anthropic')) || 'aucune'; };
  refreshAKey();
  $('akeyPaste').addEventListener('click', async () => { $('akeyInput').value = (await api.readClipboardText()).trim(); });
  $('akeySave').addEventListener('click', async () => {
    const v = $('akeyInput').value.trim();
    if (!v) { $('akeyResult').textContent = 'Le champ est vide.'; $('akeyResult').className = 'hint ko k-anthropic'; return; }
    try { await api.setApiKey(v, 'anthropic'); } catch (e) { $('akeyResult').textContent = 'Échec : ' + e.message; $('akeyResult').className = 'hint ko k-anthropic'; return; }
    $('akeyResult').textContent = 'Clé enregistrée. Cliquez sur « Tester ».'; $('akeyResult').className = 'hint ok k-anthropic';
    $('akeyInput').value = ''; await refreshAKey(); showSaved();
  });
  $('akeyTest').addEventListener('click', async () => { $('akeyResult').textContent = 'Test en cours…'; const r = await api.testApiKey('anthropic'); $('akeyResult').textContent = r.message; $('akeyResult').className = 'hint k-anthropic ' + (r.ok ? 'ok' : 'ko'); });
  $('ccTest').addEventListener('click', async () => { $('ccResult').textContent = '…'; const r = await api.testApiKey('claude-code'); $('ccResult').textContent = r.message; $('ccResult').className = 'hint ' + (r.ok ? 'ok' : 'ko'); });

  // --- transcription commune ---
  const t = settings.transcription;
  $('t_languages').value = (t.languages || []).join(', ');
  $('t_prompt').value = t.prompt || '';
  $('t_keywords').value = (t.keywords || []).join('\n');
  $('t_corrections').value = (t.corrections || []).join('\n');
  $('t_phonetic').checked = t.phoneticCorrections !== false;
  $('t_noise').value = t.noiseReduction || 'none';
  $('t_keepOpen').checked = !!t.keepMicrophoneOpen;

  async function fillMics() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((x) => x.stop());
    } catch {}
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('t_mic');
    for (const d of devs) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || d.deviceId.slice(0, 8);
      sel.appendChild(o);
    }
    sel.value = t.microphoneId || '';
  }
  await fillMics();

  const saveTranscription = () => save({
    transcription: {
      languages: $('t_languages').value.split(',').map((x) => x.trim()).filter(Boolean),
      prompt: $('t_prompt').value.trim(),
      keywords: $('t_keywords').value.split('\n').map((x) => x.trim()).filter(Boolean),
      corrections: $('t_corrections').value.split('\n').map((x) => x.trim()).filter(Boolean),
      phoneticCorrections: $('t_phonetic').checked,
      noiseReduction: $('t_noise').value,
      microphoneId: $('t_mic').value,
      keepMicrophoneOpen: $('t_keepOpen').checked,
    },
  });
  for (const id of ['t_languages', 't_prompt', 't_keywords', 't_corrections', 't_phonetic', 't_noise', 't_mic', 't_keepOpen']) $(id).addEventListener('change', saveTranscription);

  // --- SpeechMike ---
  $('micPair').addEventListener('click', () => api.requestPairMicrophone());

  const table = $('buttons');
  for (const [key, label] of BUTTONS) {
    const tr = document.createElement('tr');
    const current = settings.speechMikeButtons[key] || 'none';
    const isHotkey = current.startsWith('hotkey:');
    tr.innerHTML = `<td>${label}</td><td style="display:flex;gap:6px"><select data-key="${key}">${ACTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><input type="text" data-hotkey="${key}" placeholder="Ctrl+Alt+Escape" style="${isHotkey ? '' : 'display:none'}"></td>`;
    table.appendChild(tr);
    const sel = tr.querySelector('select');
    const inp = tr.querySelector('input');
    sel.value = isHotkey ? 'hotkey' : (ACTIONS.some(([v]) => v === current) ? current : 'none');
    if (isHotkey) inp.value = current.slice(7);
    const commit = () => {
      inp.style.display = sel.value === 'hotkey' ? '' : 'none';
      const value = sel.value === 'hotkey' ? (inp.value.trim() ? 'hotkey:' + inp.value.trim() : 'none') : sel.value;
      save({ speechMikeButtons: { [key]: value } });
    };
    sel.addEventListener('change', commit);
    inp.addEventListener('change', commit);
  }

  // --- raccourcis : capture de la touche physique (event.code) → accélérateur Electron ---
  const CODE_TO_ACCEL = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Enter', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', CapsLock: 'Capslock', ScrollLock: 'Scrolllock',
  };
  function accelFromEvent(e) {
    const code = e.code || '';
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^Numpad[0-9]$/.test(code)) key = 'num' + code.slice(6);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
    else if (CODE_TO_ACCEL[code]) key = CODE_TO_ACCEL[code];
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Cmd');
    const symbols = (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '') + (e.metaKey ? '⌘' : '');
    // libellé = ce que la touche imprime sur CE clavier (sans modificateur), sinon le nom de la touche
    const printed = e.key && e.key.length === 1 && e.key !== ' ' ? e.key : (key === 'Space' ? '␣' : key.replace(/^num/, 'pavé '));
    return { accelerator: [...mods, key].join('+'), label: symbols + printed };
  }
  function renderHotkey(k) {
    const el = $('h_' + k);
    const acc = settings.hotkeys[k] || '';
    el.value = acc ? (settings.hotkeyLabels[k] || acc) : '';
    el.title = acc ? `accélérateur Electron : ${acc}` : 'aucun raccourci';
  }
  for (const k of ['toggleRecording', 'toggleBar', 'toggleMode', 'rediger', 'newDraft', 'copyLastText', 'correctSelection']) {
    const el = $('h_' + k);
    renderHotkey(k);
    el.addEventListener('focus', () => { el.value = 'appuyez sur une touche…'; });
    el.addEventListener('blur', () => renderHotkey(k));
    el.addEventListener('keydown', async (e) => {
      e.preventDefault();
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // on attend la touche finale
      const r = accelFromEvent(e);
      if (!r) { el.value = 'touche non prise en charge'; return; }
      await save({ hotkeys: { [k]: r.accelerator }, hotkeyLabels: { [k]: r.label } });
      el.blur();
    });
    document.querySelector(`button[data-clear="${k}"]`).addEventListener('click', async () => {
      await save({ hotkeys: { [k]: '' }, hotkeyLabels: { [k]: '' } });
      renderHotkey(k);
    });
  }

  // --- collage ---
  $('i_autoSpace').checked = !!settings.injection.autoSpace;
  $('i_autoSpace').addEventListener('change', () => save({ injection: { autoSpace: $('i_autoSpace').checked } }));

  $('launchAtLogin').checked = settings.launchAtLogin !== false;
  $('launchAtLogin').addEventListener('change', () => save({ launchAtLogin: $('launchAtLogin').checked }));

  // Textes explicatifs : chaque paragraphe est remplacé par un bouton « ? » placé sur la ligne qu'il commente
  // (ou dans le titre de la section) ; le texte apparaît dans une bulle au survol, ou au clic (touch).
  let popover = null; let popoverFor = null; let pinned = false;
  const hidePopover = () => { if (popover) { popover.remove(); popover = null; } if (popoverFor) { popoverFor.classList.remove('open'); popoverFor = null; } pinned = false; };
  const showPopover = (btn, html) => {
    if (popoverFor === btn) return;
    hidePopover();
    popover = document.createElement('div');
    popover.className = 'popover';
    popover.innerHTML = html;
    document.body.appendChild(popover);
    const r = btn.getBoundingClientRect();
    const w = Math.min(440, window.innerWidth - 24);
    popover.style.width = w + 'px';
    popover.style.left = Math.max(12, Math.min(r.left + window.scrollX, window.innerWidth - w - 12)) + 'px';
    popover.style.top = (r.bottom + window.scrollY + 4) + 'px';
    popoverFor = btn; btn.classList.add('open');
  };
  // le « ? » va sur le libellé de la ligne que le texte commente (zones de texte comprises), sinon dans le titre de la section
  const anchorFor = (p) => {
    const sec = p.closest('section'); const h2 = sec && sec.querySelector('h2');
    if (p.classList.contains('section-help')) return h2;
    let el = p.previousElementSibling;
    while (el && (el.tagName === 'TEXTAREA' || el.tagName === 'P')) el = el.previousElementSibling;
    if (el && el.classList.contains('row')) return el.querySelector('label') || el;
    return h2 || p.parentNode;
  };
  for (const p of document.querySelectorAll('section p.hint')) {
    if (p.id || p.classList.contains('warn') || !p.textContent.trim()) continue;
    const html = p.innerHTML;
    p.classList.add('help-text');
    const b = document.createElement('button');
    b.className = 'help secondary'; b.type = 'button'; b.textContent = '?';
    anchorFor(p).appendChild(b);
    // survol : apparition et disparition immédiates ; clic : la bulle reste jusqu'au prochain clic
    b.addEventListener('mouseenter', () => { if (!pinned) showPopover(b, html); });
    b.addEventListener('mouseleave', () => { if (!pinned) hidePopover(); });
    b.addEventListener('click', (e) => { e.preventDefault(); if (popoverFor === b && pinned) { hidePopover(); } else { showPopover(b, html); pinned = true; } });
  }
  document.addEventListener('click', (e) => { if (popover && !popover.contains(e.target) && !(e.target.closest && e.target.closest('button.help'))) hidePopover(); });
  window.addEventListener('scroll', hidePopover);

  $('quit').addEventListener('click', () => api.quit());
})();
