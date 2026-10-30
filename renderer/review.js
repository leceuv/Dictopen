// Fenêtre de relecture d'une correction : différences (rouge = retiré, vert = ajouté), texte modifiable, puis « Remplacer ».
(() => {
  const $ = (id) => document.getElementById(id);
  const corps = $('corps'); const aide = $('aide'); const statut = $('statut'); const info = $('info');
  let original = ''; let propose = '';

  function decouper(s) {
    return s.match(/\s+|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || [];
  }

  // plus longue sous-séquence commune sur les mots → opérations =, -, +
  function diff(a, b) {
    const A = decouper(a); const B = decouper(b);
    const n = A.length; const m = B.length;
    if (n * m > 9e6) return [['-', a], ['+', b]];
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
      }
    }
    const ops = [];
    const pousser = (t, s) => { const d = ops[ops.length - 1]; if (d && d[0] === t) d[1] += s; else ops.push([t, s]); };
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { pousser('=', A[i]); i++; j++; } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) pousser('-', A[i++]); else pousser('+', B[j++]);
    }
    while (i < n) pousser('-', A[i++]);
    while (j < m) pousser('+', B[j++]);
    return ops;
  }

  // texte courant de la zone (les passages barrés ne comptent pas)
  function lireTexte() {
    let t = '';
    (function lire(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) t += c.data;
        else if (c.tagName === 'BR') t += '\n';
        else if (c.tagName === 'DEL') continue;
        else { if (/^(DIV|P)$/.test(c.tagName) && t && !t.endsWith('\n')) t += '\n'; lire(c); }
      }
    })(corps);
    return t;
  }

  function afficherDiff(texte) {
    const ops = diff(original, texte);
    corps.replaceChildren(...ops.map(([t, s], k) => {
      if (t === '=') return document.createTextNode(s);
      const e = document.createElement(t === '+' ? 'ins' : 'del');
      e.textContent = s;
      if (t === '-') {
        e.contentEditable = 'false';
        if (ops[k + 1] && ops[k + 1][0] === '+') { e.className = 'retab'; e.title = 'Cliquer pour rétablir le texte d’origine'; }
      }
      return e;
    }));
    const n = ops.filter(([t]) => t !== '=').length;
    aide.textContent = (original === texte ? 'Aucune correction. ' : `${n} modification(s). `) + 'Texte modifiable directement ; clic sur un passage barré pour le rétablir.';
  }

  function afficherErreur(message) {
    corps.contentEditable = 'false';
    corps.replaceChildren(Object.assign(document.createElement('span'), { className: 'err', textContent: message }));
    aide.textContent = '';
    for (const id of ['bRemplacer', 'bCopier', 'bRetablir']) $(id).disabled = true;
  }

  window.dictee.onReviewData(({ original: o, corrected, ms, error }) => {
    statut.textContent = '';
    statut.className = 'msg';
    if (error) { afficherErreur(error); return; }
    original = o; propose = corrected;
    info.textContent = ms ? `${(ms / 1000).toFixed(1)} s` : '';
    corps.contentEditable = 'plaintext-only';
    corps.spellcheck = false;
    afficherDiff(propose);
    for (const id of ['bRemplacer', 'bCopier', 'bRetablir']) $(id).disabled = false;
    $('bRemplacer').focus();
  });

  corps.addEventListener('click', (e) => {
    const d = e.target.closest && e.target.closest('del.retab');
    if (!d) return;
    if (d.nextSibling && d.nextSibling.tagName === 'INS') d.nextSibling.remove();
    d.replaceWith(document.createTextNode(d.textContent));
  });
  corps.addEventListener('focusout', () => { if (corps.isContentEditable) afficherDiff(lireTexte()); });

  $('bRemplacer').addEventListener('click', async () => {
    $('bRemplacer').disabled = true;
    const r = await window.dictee.reviewReplace(lireTexte());
    if (r && r.error) { statut.textContent = r.error; statut.className = 'msg err'; $('bRemplacer').disabled = false; }
  });
  $('bCopier').addEventListener('click', async () => {
    await window.dictee.reviewCopy(lireTexte());
    statut.textContent = 'Copié.'; statut.className = 'msg ok';
  });
  $('bRetablir').addEventListener('click', () => afficherDiff(propose));
  $('bFermer').addEventListener('click', () => window.dictee.reviewClose());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.dictee.reviewClose();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('bRemplacer').disabled) $('bRemplacer').click();
  });
})();
