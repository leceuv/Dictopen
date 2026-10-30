// Fenêtre « Autorisations » (macOS) : n'affiche que ce qui manque, se met à jour, se ferme quand tout est accordé.
(() => {
  const api = window.dictee;
  const ITEMS = {
    microphone: { title: 'Micro', hint: 'Réglages Système → Confidentialité et sécurité → Microphone → activer Dictopen.', pane: 'Privacy_Microphone' },
    accessibility: { title: 'Accessibilité', hint: 'Réglages Système → Confidentialité et sécurité → Accessibilité → activer Dictopen. S’il n’est pas dans la liste : bouton + puis choisir Dictopen dans Applications. S’il est déjà coché : décocher puis recocher.', pane: 'Privacy_Accessibility' },
    automation: { title: 'Automatisation (System Events)', hint: 'Réglages Système → Confidentialité et sécurité → Automatisation → Dictopen → System Events.', pane: 'Privacy_Automation' },
  };
  const list = document.getElementById('list');
  function render(st) {
    const missing = Object.keys(ITEMS).filter((k) => st[k] !== 'granted');
    if (!missing.length) { list.innerHTML = '<div class="done">Toutes les autorisations sont accordées.</div>'; return true; }
    list.innerHTML = missing.map((k) => `<div class="item"><div class="txt"><b>${ITEMS[k].title}</b><span>${ITEMS[k].hint}</span></div><button data-pane="${ITEMS[k].pane}">Ouvrir</button></div>`).join('');
    return false;
  }
  list.addEventListener('click', (e) => { const b = e.target.closest('button[data-pane]'); if (b) api.openPrivacyPane(b.dataset.pane); });
  document.getElementById('later').addEventListener('click', () => api.closePermissionsWindow());
  async function tick() {
    const st = await api.checkPermissions();
    if (render(st)) setTimeout(() => api.closePermissionsWindow(), 1200);
    else setTimeout(tick, 2000);
  }
  tick();
})();
