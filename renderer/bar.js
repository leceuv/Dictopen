(() => {
  const $ = (id) => document.getElementById(id);
  const LABELS = {
    idle: 'Prêt', connecting: 'Connexion à OpenAI…', listening: 'Écoute…', transcribing: 'Transcription…',
    writing: 'Rédaction du courrier…', error: 'Erreur',
  };
  const PLACEHOLDER = {
    direct: 'Maintenez Record et dictez : chaque phrase est collée dans l’application active.',
    courrier: 'Dictez la consultation (plusieurs appuis possibles), puis « Rédiger » : le courrier est collé dans l’application active. Redictez une correction puis « Rédiger » pour reprendre le courrier.',
  };
  let currentMode = 'direct';
  let draft = { text: '', letter: '' };
  let showingLive = false;

  function renderText() {
    const el = $('text');
    if (showingLive) return;
    if (currentMode === 'courrier') {
      el.textContent = draft.text || (draft.letter ? '(courrier rédigé — dictez une correction ou « Nouveau »)' : '');
      el.classList.remove('live');
    }
  }

  window.dictee.onState(({ state, detail, recording, mode, provider, hasDraft, hasLetter, mic, audioDevice, hotkey }) => {
    currentMode = mode;
    document.body.classList.toggle('courrier', mode === 'courrier');
    $('mode').textContent = (mode === 'courrier' ? 'Courrier' : 'Dictée directe') + (provider === 'local' ? ' · local' : '');
    $('mode').title = (provider === 'local' ? 'Transcription locale (sur cet ordinateur). ' : 'Transcription OpenAI. ') + 'Cliquer pour changer de mode (Ctrl+Alt+M).';
    $('mode').classList.toggle('courrier', mode === 'courrier');
    $('dot').className = 'dot ' + state;
    const draftInfo = mode === 'courrier' && hasDraft && document.body.classList.contains('compact') ? ` · brouillon ${draft.text.split('\n').filter(Boolean).length} énoncé(s)` : '';
    $('status').textContent = LABELS[state] + (detail ? ` — ${detail}` : '') + draftInfo;
    $('btnRec').classList.toggle('on', recording);
    $('btnRec').textContent = recording ? '■' : '●';
    $('btnRediger').disabled = !hasDraft || state === 'writing';
    const keyLabel = hotkey ? hotkey.replace('Ctrl', '⌃').replace('Alt', '⌥').replace('Shift', '⇧').replace('Cmd', '⌘').replace(/\+/g, '') : '';
    const devLabel = (audioDevice || 'micro ?').replace(/^default\s*-\s*/i, '').replace(/\s*\((built-in|intégré)\)\s*/i, '');
    if (mic && mic.connected) {
      $('mic').textContent = '● ' + (mic.name || 'micro');
      $('mic').title = 'SpeechMike connecté';
    } else {
      $('mic').innerHTML = '🎤 ' + devLabel.replace(/</g, '&lt;') + (keyLabel ? ` — dicter : <kbd>${keyLabel.replace(/</g, '&lt;')}</kbd>` : '');
      $('mic').title = `Pas de SpeechMike : micro « ${audioDevice || '?'} » ; dicter avec la touche ${hotkey || '(aucune)'} (marche/arrêt)`;
    }
    $('text').dataset.placeholder = mic && mic.connected ? PLACEHOLDER[mode] : PLACEHOLDER[mode].replace('Maintenez Record', `Appuyez sur ${keyLabel || 'la touche de dictée'}`).replace('plusieurs appuis possibles', `${keyLabel || 'touche'} pour démarrer et arrêter`);
    $('mic').classList.toggle('on', !!(mic && mic.connected));
    if (state !== 'listening') $('vu').style.width = '0';
    if (state === 'idle' && !recording) { showingLive = false; renderText(); }
  });

  window.dictee.onPanel(({ show }) => { document.body.classList.toggle('compact', !show); });
  $('btnPanel').addEventListener('click', () => window.dictee.setPanel(!document.body.classList.contains('compact') ? false : true));
  $('btnPanelClose').addEventListener('click', () => window.dictee.setPanel(false));

  window.dictee.onLiveText(({ text, final }) => {
    const el = $('text');
    if (currentMode === 'courrier' && !final && !text) { showingLive = false; renderText(); return; }
    showingLive = !final || currentMode === 'direct';
    el.textContent = text;
    el.classList.toggle('live', !final);
    el.scrollTop = el.scrollHeight;
    if (final && currentMode === 'courrier') { showingLive = false; setTimeout(renderText, 1500); }
  });

  window.dictee.onDraft((d) => { draft = d; renderText(); });

  window.dictee.onUsage((u) => {
    $('cost').textContent = u.usd.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
    $('cost').title = `${u.utterances} énoncés, ${(u.audioSeconds / 60).toFixed(1)} min d'audio, ${u.letters || 0} courriers depuis le ${new Date(u.since).toLocaleDateString('fr-FR')}`;
  });

  // plus de bandeau : les erreurs passent dans la ligne d'état quelques secondes, le reste est silencieux
  let errorTimer = null;
  window.dictee.onNotice(({ level, message }) => {
    if (level !== 'error') return;
    const s = $('status');
    s.textContent = message;
    s.classList.add('error');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => s.classList.remove('error'), 6000);
  });

  // retour visuel sur chaque bouton (y compris quand l'action vient du clavier ou du micro, via onState)
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('button, .mode');
    if (!el) return;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 160);
  });

  window.dictee.onLevel((level) => { $('vu').style.width = Math.min(100, Math.round(level * 140)) + '%'; });

  $('btnRec').addEventListener('click', () => window.dictee.toggleRecording());
  $('btnCancel').addEventListener('click', () => window.dictee.cancelRecording());
  $('btnRediger').addEventListener('click', () => window.dictee.rediger());
  $('btnNew').addEventListener('click', () => window.dictee.newDraft());
  $('btnCopy').addEventListener('click', () => window.dictee.copyLastText());
  $('mode').addEventListener('click', () => window.dictee.toggleMode());
  $('btnSettings').addEventListener('click', () => window.dictee.openSettings());
  $('btnHide').addEventListener('click', () => window.dictee.hideBar());

  window.dictee.getUsage().then((u) => { if (u) $('cost').textContent = u.usd.toFixed(2).replace('.', ',') + ' $'; });
  window.dictee.getDraft().then((d) => { if (d) { draft = d; renderText(); } });
})();
