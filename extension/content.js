// Dictopen pour Chrome — content script (toutes les frames)
// Dérivé de l'extension Correcteur Claude (même capture, même panneau, même remplacement) ; la correction est faite par Dictopen.
// - frame d'origine : capture la sélection puis la remplace
// - frame principale : affiche le panneau de relecture

(() => {
  if (window.__dictopenChrome) return;
  window.__dictopenChrome = true;

  // ---------------------------------------------------------------- capture

  let capture = null; // { type: "champ", el, debut, fin, texte } | { type: "plage", range, hote, texte }

  function champTexte(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    return el.tagName === "INPUT" && /^(text|search|url|email|)$/i.test(el.type);
  }

  function elementActif() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function lireSelection(paragraphes = false, forcee = null) {
    const el = elementActif();
    if (!forcee && champTexte(el) && el.selectionStart !== el.selectionEnd) {
      const debut = el.selectionStart, fin = el.selectionEnd;
      return { type: "champ", el, debut, fin, texte: el.value.slice(debut, fin) };
    }
    const sel = window.getSelection();
    if (forcee || (sel && sel.rangeCount && !sel.isCollapsed)) {
      const range = forcee || sel.getRangeAt(0).cloneRange();
      const noeud = range.commonAncestorContainer;
      const base = noeud.nodeType === 1 ? noeud : noeud.parentElement;
      const hote = base?.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') || null;
      // Positions en caractères dans l'éditeur : survivent au re-rendu du DOM
      // (Slate/React remplacent les nœuds texte, ce qui invalide le Range).
      let debut = -1;
      if (hote) {
        const avant = document.createRange();
        avant.selectNodeContents(hote);
        avant.setEnd(range.startContainer, range.startOffset);
        debut = avant.toString().length;
      }
      // texte : contenu brut du Range (sert à retrouver la plage) ;
      // envoi : texte affiché (paragraphes séparés) ; parties : découpage Slate.
      const slate = !!hote?.hasAttribute("data-slate-editor");
      const decoupe = slate ? partiesSlate(range, hote, paragraphes) : null;
      const parties = decoupe?.parties || null;
      return {
        type: "plage", range, hote, debut, slate, parties, blocsSuppr: decoupe?.suppr || [], contexte: decoupe?.contexte || null,
        texte: range.toString(),
        envoi: parties ? parties.map(p => p.s).join("") : sansZeroWidth((forcee || sel).toString())
      };
    }
    return null;
  }

  // ---------------------------------------------------------------- Slate (Follow)
  // Les variables de Follow sont des inlines « void ». Juste avant la capture,
  // background.js les classe (attribut data-correcteur-var, d'après les réponses
  // enregistrées dans la page) :
  // - « libre » : réponse tapée → relue par Claude, puis remplacée par du texte ;
  // - « vide »  : case rouge, sans réponse → supprimée ;
  // - « coche » : réponse cochée (pré-écrite) → intouchée ;
  // - « donnee » : donnée du dossier (elle, patient·e…) → intouchée.
  // Le texte hors variables n'est pas relu non plus.
  // Option « paragraphes » : un paragraphe non rempli (au moins une variable vide,
  // aucune réponse tapée ou cochée) est supprimé en entier (courrier type avec
  // des paragraphes prévus pour un patient opéré, par exemple).

  const BLOC = '[data-slate-object="block"]';

  // Variable la plus externe contenant el (certaines embarquent un mini-éditeur)
  function variableDe(el, hote) {
    let v = null;
    for (let e = el; e && e !== hote; e = e.parentElement) if (e.hasAttribute("data-slate-void")) v = e;
    return v;
  }

  function classeVariable(v) {
    const c = v.getAttribute("data-correcteur-var");
    if (c) return c;
    // Non classée (classement impossible) : seules les rouges sont reconnues
    if (/\[par défaut\]/.test(v.textContent)) return "vide";
    const marque = v.querySelector("span[mode]");
    return marque && !marque.hasAttribute("title") ? "donnee" : "coche";
  }

  // Texte complet d'une variable, un paragraphe interne par ligne
  function texteVariable(v) {
    const w = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
    let s = "", n, bloc = null;
    while ((n = w.nextNode())) {
      if (n.parentElement.closest("[data-slate-spacer]")) continue;
      const t = sansZeroWidth(n.data);
      // paragraphe interne à la case (hors case : ligne unique)
      let b = n.parentElement.closest(BLOC);
      if (b && !v.contains(b)) b = null;
      // un paragraphe vide (ligne sautée) compte comme une ligne
      if (!t && !b) continue;
      if (bloc && b !== bloc) s += "\n";
      bloc = b;
      s += t;
    }
    return s;
  }

  const variablesDe = (bloc, hote) => [...bloc.querySelectorAll("[data-slate-void]")].filter(v => variableDe(v, hote) === v);
  const blocVide = (bloc, hote) => !variablesDe(bloc, hote).length && !sansZeroWidth(bloc.textContent).trim();
  function blocNonRempli(bloc, hote) {
    const classes = variablesDe(bloc, hote).map(classeVariable);
    return classes.includes("vide") && !classes.some(c => c === "libre" || c === "coche");
  }

  // Paragraphes à supprimer : les non remplis, plus les lignes vides qui
  // deviendraient doublées (ligne vide gardée, paragraphes supprimés, ligne vide).
  function blocsASupprimer(blocs, hote) {
    const suppr = new Set();
    const avant = blocs[0]?.previousElementSibling;
    let gardeVide = !!avant?.matches(BLOC) && blocVide(avant, hote), coupe = false;
    for (const b of blocs) {
      const vide = blocVide(b, hote);
      if (!vide && blocNonRempli(b, hote)) { suppr.add(b); coupe = true; continue; }
      if (vide && gardeVide && coupe) { suppr.add(b); continue; }
      gardeVide = vide;
      coupe = false;
    }
    // ligne vide juste après la sélection
    const apres = blocs.at(-1)?.nextElementSibling;
    if (coupe && gardeVide && apres?.matches(BLOC) && blocVide(apres, hote)) suppr.add(apres);
    return suppr;
  }

  // Lignes sautées d'une réponse : une seule ligne vide conservée (nouveau
  // paragraphe voulu), les lignes vides suivantes retirées.
  const lignesVides = s => s.replace(/\n[ \t]+(?=\n)/g, "\n").replace(/\n{3,}/g, "\n\n");

  // Fin de l'en-tête du courrier (index dans les blocs de premier niveau de l'éditeur) : la phrase
  // « Je vous remercie de m'avoir adressé… » (qui porte le nom du patient), sinon la formule d'appel.
  // RÈGLE ABSOLUE : rien de ce qui précède ou inclut cette phrase n'est jamais envoyé, même sélectionné à la main.
  function blocsPrincipaux(hote) {
    const principaux = [...hote.querySelectorAll(BLOC)].filter(b => !b.parentElement.closest("[data-slate-void]"));
    return principaux.filter(b => !principaux.some(o => o !== b && b.contains(o)));
  }
  function finEnTete(blocs) {
    const texte = b => sansZeroWidth(b.textContent).trim();
    let i = blocs.findIndex(b => INTRO.test(b.textContent));
    if (i < 0) i = blocs.findIndex(b => texte(b) && texte(b).length < 60 && /,$/.test(texte(b)));
    return i;
  }

  // Genre du patient et du destinataire, déduits localement de l'en-tête et des données du dossier :
  // seuls les mots « femme » / « homme » sortent, jamais la phrase.
  function contexteGenre(hote) {
    const blocs = blocsPrincipaux(hote);
    const fin = finEnTete(blocs);
    const enTete = blocs.slice(0, fin + 1).map(b => sansZeroWidth(b.textContent)).join("\n");
    let patient = null, destinataire = null;
    const intro = blocs.find(b => INTRO.test(b.textContent));
    const t = intro ? sansZeroWidth(intro.textContent) : "";
    if (/adress[ée]e?\s+(Madame|Mme|Mademoiselle|Mlle)\b/i.test(t) || /\bvotre patiente\b/i.test(t)) patient = "femme";
    else if (/adress[ée]e?\s+(Monsieur|M\.|Mr)\b/i.test(t) || /\bvotre patient\b/i.test(t)) patient = "homme";
    if (/\b(ch[èe]re\s+(consœur|consoeur|collègue|amie)|ma\s+ch[èe]re|Madame)\b/i.test(enTete)) destinataire = "femme";
    else if (/\b(cher\s+(confrère|collègue|ami)|mon\s+cher|Monsieur)\b/i.test(enTete)) destinataire = "homme";
    if (!patient) {
      // données du dossier (elle, patient·e…) dans le corps
      const donnees = [...hote.querySelectorAll("[data-slate-void]")].filter(v => classeVariable(v) === "donnee").map(v => sansZeroWidth(v.textContent).trim().toLowerCase());
      if (donnees.some(d => /^(elle|patiente|madame|mme|la patiente)$/.test(d))) patient = "femme";
      else if (donnees.some(d => /^(il|patient|monsieur|m\.|le patient)$/.test(d))) patient = "homme";
    }
    return { patient, destinataire };
  }

  // Découpe la sélection en parties { t: "fixe" | "libre" | "vide" | "donnee", s, cle?, bloc, sup? }
  // (sup : partie d'un paragraphe supprimé ; bloc : clé Slate du paragraphe). Une variable touchée par la
  // sélection est prise en entier. Les blocs de l'en-tête sont exclus quoi qu'il arrive.
  function partiesSlate(range, hote, paragraphes) {
    const tous = blocsPrincipaux(hote);
    const fin = finEnTete(tous);
    const blocs = tous.filter((b, i) => i > fin && range.intersectsNode(b));
    const suppr = paragraphes ? blocsASupprimer(blocs, hote) : new Set();
    const parties = [];
    let sup = false, blocCle = null;
    const pousser = (t, s, cle) => {
      if (!s) return;
      const d = parties[parties.length - 1];
      if (d && d.t === "fixe" && t === "fixe" && !d.sup === !sup && d.bloc === blocCle) d.s += s;
      else parties.push({ t, s, bloc: blocCle, ...(cle && { cle }), ...(sup && { sup }) });
    };
    let garde = false; // un paragraphe gardé précède-t-il ?
    blocs.forEach((bloc, i) => {
      sup = suppr.has(bloc);
      blocCle = bloc.getAttribute("data-key");
      // le saut de ligne qui précède un paragraphe part avec lui (ou avec le
      // suivant si tous les paragraphes précédents sont supprimés)
      const supLigne = sup;
      if (!sup && !garde) sup = true;
      if (i) pousser("fixe", "\n");
      sup = supLigne;
      if (!sup) garde = true;
      const w = document.createTreeWalker(bloc, NodeFilter.SHOW_TEXT);
      const vues = new Set();
      let n;
      while ((n = w.nextNode())) {
        if (!range.intersectsNode(n)) continue;
        const v = variableDe(n.parentElement, hote);
        if (v) {
          if (vues.has(v)) continue;
          vues.add(v);
          const t = classeVariable(v);
          const s = texteVariable(v);
          // une réponse sans lettres (nombre, date) n'a rien à relire
          if (t === "libre" && /\p{L}/u.test(s)) pousser("libre", lignesVides(s), v.getAttribute("data-key"));
          else if (t === "vide") pousser("vide", s, v.getAttribute("data-key"));
          else if (t === "donnee") pousser("donnee", s.replace(/\n/g, " "), v.getAttribute("data-key"));
          else pousser("fixe", s.replace(/\n/g, " "));
          continue;
        }
        const fin = n === range.endContainer ? range.endOffset : n.data.length;
        const debut = n === range.startContainer ? range.startOffset : 0;
        pousser("fixe", sansZeroWidth(n.data.slice(debut, fin)));
      }
    });
    return { parties, suppr: [...suppr].map(b => b.getAttribute("data-key")).filter(Boolean), contexte: contexteGenre(hote) };
  }

  // Sélection automatique (bouton de l'extension, raccourci sans sélection, ou « Corriger » de Dictopen) :
  // la page est reconnue et le texte à relire choisi sans que l'utilisateur sélectionne.
  // - Follow : corps du courrier sans l'en-tête (formule d'appel + « Je vous remercie de m'avoir adressé… »,
  //   qui porte l'identité du patient), jusqu'à la fin de l'éditeur ;
  // - sinon : le champ de saisie actif (zone de texte ou éditeur), sinon le plus grand éditeur de la page.
  // La plage est recalculée au moment de la capture : poser la sélection fait re-rendre certains éditeurs.
  let autoDemande = false;
  const INTRO = /vous remercie de m['’] ?avoir adress/i;
  const EDITABLE = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

  function plageFollow() {
    const editeurs = [...document.querySelectorAll("[data-slate-editor]")]
      .filter(e => !e.parentElement.closest("[data-slate-void]"));
    if (!editeurs.length) return null;
    const ed = editeurs.find(e => INTRO.test(e.textContent))
      || editeurs.sort((a, b) => b.textContent.length - a.textContent.length)[0];
    const blocs = blocsPrincipaux(ed);
    const texte = b => sansZeroWidth(b.textContent).trim();
    let debut = finEnTete(blocs) + 1;
    while (debut < blocs.length && !texte(blocs[debut])) debut++;
    if (debut >= blocs.length) return null;
    const range = document.createRange();
    range.setStart(blocs[debut], 0);
    const dernier = blocs[blocs.length - 1];
    range.setEnd(dernier, dernier.childNodes.length);
    return range;
  }

  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 20 && getComputedStyle(el).visibility !== "hidden"; };
  const hoteDe = el => { const h = el?.closest?.(EDITABLE); let top = h; while (top) { const p = top.parentElement?.closest(EDITABLE); if (!p) break; top = p; } return top; };

  // éditeur / champ à relire hors Follow : { champ } (textarea, input) ou { hote } (contenteditable)
  function zoneGenerique() {
    const actif = elementActif();
    if (champTexte(actif) && actif.value.trim()) return { champ: actif };
    const h = hoteDe(actif);
    if (h && sansZeroWidth(h.textContent).trim()) return { hote: h };
    const editeurs = [...document.querySelectorAll(EDITABLE)].filter(e => !e.parentElement?.closest(EDITABLE) && visible(e) && sansZeroWidth(e.textContent).trim().length > 20)
      .sort((a, b) => b.textContent.length - a.textContent.length);
    if (editeurs.length) return { hote: editeurs[0] };
    const champs = [...document.querySelectorAll("textarea")].filter(t => visible(t) && t.value.trim().length > 20).sort((a, b) => b.value.length - a.value.length);
    if (champs.length) return { champ: champs[0] };
    return null;
  }

  // plage à relire selon le site ; pour un champ texte, le sélectionne et renvoie { champ }
  function plageAuto() {
    if (document.querySelector("[data-slate-editor]")) {
      const r = plageFollow();
      if (r) return { range: r };
    }
    const z = zoneGenerique();
    if (!z) return null;
    if (z.champ) return z;
    const range = document.createRange();
    range.selectNodeContents(z.hote);
    return { range };
  }

  function selectionnerAuto() {
    const z = plageAuto();
    if (!z) return false;
    autoDemande = true;
    if (z.champ) { z.champ.focus(); z.champ.setSelectionRange(0, z.champ.value.length); return true; }
    // sélection visible, pour information
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(z.range);
    return true;
  }

  function plageForcee() {
    const z = plageAuto();
    return z && z.range ? z.range : null;
  }

  // Reconstruit un Range à partir de positions en caractères (même comptage
  // que Range.toString() : concaténation des nœuds texte dans l'ordre).
  function plageDepuisPositions(hote, debut, fin) {
    const w = document.createTreeWalker(hote, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let pos = 0, n, debutFixe = false;
    while ((n = w.nextNode())) {
      const l = n.data.length;
      if (!debutFixe && debut <= pos + l) { range.setStart(n, debut - pos); debutFixe = true; }
      if (debutFixe && fin <= pos + l) { range.setEnd(n, fin - pos); return range; }
      pos += l;
    }
    return null;
  }

  function texteDe(hote) {
    const r = document.createRange();
    r.selectNodeContents(hote);
    return r.toString();
  }

  // Retrouve la sélection d'origine dans le DOM actuel, même re-rendu.
  function retrouverPlage(c) {
    if (c.range.toString() === c.texte && c.hote.contains(c.range.commonAncestorContainer)) return c.range;
    const fin = c.debut + c.texte.length;
    const r = plageDepuisPositions(c.hote, c.debut, fin);
    if (r && r.toString() === c.texte) return r;
    // Le texte a bougé (ajout avant la sélection) : on accepte s'il n'apparaît qu'une fois.
    const tout = texteDe(c.hote);
    const i = tout.indexOf(c.texte);
    if (i >= 0 && tout.indexOf(c.texte, i + 1) < 0) return plageDepuisPositions(c.hote, i, i + c.texte.length);
    return null;
  }

  const attendre = ms => new Promise(r => setTimeout(r, ms));
  const ZWNBSP = String.fromCharCode(0xFEFF); // espace insécable de largeur nulle (Slate)
  const sansZeroWidth = s => s.split(ZWNBSP).join("");

  async function remplacer(texte) {
    const c = capture;
    if (!c) return { ok: false, erreur: "Sélection d'origine perdue." };

    if (c.type === "champ") {
      const { el, debut, fin } = c;
      if (!el.isConnected || el.value.slice(debut, fin) !== c.texte) {
        return { ok: false, erreur: "Le texte a changé depuis la sélection : copiez plutôt la correction." };
      }
      el.focus();
      el.setSelectionRange(debut, fin);
      // insertText conserve l'historique d'annulation (Ctrl+Z) et prévient les frameworks
      if (!document.execCommand("insertText", false, texte)) {
        el.setRangeText(texte, debut, fin, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      capture = null;
      return { ok: true };
    }

    if (!c.hote) {
      return { ok: false, erreur: "Zone non modifiable : utilisez « Copier »." };
    }
    if (!c.hote.isConnected) {
      // Éditeur entièrement remonté : chercher celui qui contient encore le texte
      c.hote = [...document.querySelectorAll('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]')]
        .find(e => !e.parentElement?.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]')
                   && texteDe(e).includes(c.texte)) || null;
      if (!c.hote) return { ok: false, erreur: "Le texte a changé depuis la sélection : copiez plutôt la correction." };
    }
    const range = retrouverPlage(c);
    if (!range) {
      return { ok: false, erreur: "Le texte a changé depuis la sélection : copiez plutôt la correction." };
    }
    if (c.slate) {
      // Slate ignore la sélection DOM posée par script et execCommand : le
      // remplacement passe par son API, exécutée dans la page (background.js).
      const avant = document.createRange();
      avant.selectNodeContents(c.hote);
      avant.setEnd(range.startContainer, range.startOffset);
      const debut = avant.toString().length;
      document.querySelectorAll("[data-correcteur-hote]").forEach(e => e.removeAttribute("data-correcteur-hote"));
      c.hote.setAttribute("data-correcteur-hote", "");
      return { slate: true, debut, fin: debut + c.texte.length };
    }
    c.hote.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // Laisser l'éditeur synchroniser sa sélection interne via selectionchange
    await attendre(60);
    // Range.toString (et non Selection.toString, qui ajoute des sauts de ligne entre blocs)
    if (!sel.rangeCount || sel.getRangeAt(0).toString() !== c.texte) {
      return { ok: false, erreur: "L'éditeur a modifié la sélection : copiez plutôt la correction." };
    }
    if (!document.execCommand("insertText", false, texte)) {
      return { ok: false, erreur: "L'éditeur a refusé l'insertion : utilisez « Copier »." };
    }
    capture = null;
    return { ok: true };
  }

  // ---------------------------------------------------------------- diagnostic anonymisé
  // Décrit la structure HTML autour du clic droit ; tout texte et toute valeur
  // sont masqués (lettres → x, chiffres → 9) : aucune donnée patient ne sort.

  let cibleClicDroit = null;
  document.addEventListener("contextmenu", e => { cibleClicDroit = e.composedPath()[0]; }, true);

  const masquer = s => s.replace(/\p{L}/gu, "x").replace(/\p{N}/gu, "9");
  const ATTRS_CLAIRS = new Set(["data-correcteur-var", "class", "id", "role", "contenteditable", "type", "draggable", "tabindex", "readonly", "disabled", "spellcheck", "slot"]);

  function decrire(racine) {
    const lignes = [];
    let reste = 40000;
    const pousser = (niv, s) => { if (reste > 0) { lignes.push("  ".repeat(niv) + s); reste -= s.length; } };

    const pseudo = (el, p) => {
      const c = getComputedStyle(el, p).content;
      return c && c !== "none" && c !== "normal" ? ` ${p}=${masquer(c).slice(0, 40)}` : "";
    };

    (function visiter(n, niv) {
      if (niv > 30 || reste <= 0) return;
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\s+/g, " ");
        if (t.trim()) pousser(niv, `"${masquer(t).slice(0, 80)}"`);
        return;
      }
      if (n.nodeType !== 1) return;
      const el = n;
      const attrs = [...el.attributes].map(a =>
        ATTRS_CLAIRS.has(a.name) || a.name.startsWith("data-v-")
          ? `${a.name}="${a.value.replace(/\p{N}/gu, "9").slice(0, 120)}"`
          : `${a.name}="${masquer(a.value).slice(0, 30)}"`
      ).join(" ");
      const cs = getComputedStyle(el);
      let extra = "";
      if (el === cibleClicDroit) extra += "  ◀ CLIC DROIT";
      if (cs.userSelect === "none") extra += " [user-select:none]";
      if (cs.display === "none") extra += " [caché]";
      if ("value" in el && typeof el.value === "string" && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
        extra += ` [valeur="${masquer(el.value).slice(0, 60)}"]`;
      }
      extra += pseudo(el, "::before") + pseudo(el, "::after");
      pousser(niv, `<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>${extra}`);
      if (el.tagName === "IFRAME") pousser(niv + 1, "(iframe : contenu dans une autre frame)");
      if (el.tagName === "SVG" || el.tagName === "svg") return;
      if (el.shadowRoot) {
        pousser(niv + 1, "#shadow-root");
        for (const c of el.shadowRoot.childNodes) visiter(c, niv + 2);
      }
      for (const c of el.childNodes) visiter(c, niv + 1);
    })(racine, 0);

    if (reste <= 0) lignes.push("… (tronqué)");
    return lignes.join("\n");
  }

  function diagnostiquer() {
    let cible = cibleClicDroit;
    if (cible?.nodeType === 3) cible = cible.parentElement;
    if (!cible) return null;
    // Remonter jusqu'à un bloc de taille raisonnable
    let bloc = cible;
    for (let i = 0; i < 8 && bloc.parentElement && bloc.parentElement !== document.body; i++) {
      if ((bloc.innerText || "").length >= 400) break;
      bloc = bloc.parentElement;
    }
    const chemin = [];
    for (let e = cible; e && e !== document.documentElement; e = e.parentElement) {
      chemin.unshift(e.tagName.toLowerCase() + (e.classList.length ? "." + [...e.classList].join(".") : ""));
    }
    const sel = window.getSelection();
    return [
      "url : " + location.hostname + location.pathname.replace(/\d/g, "9"),
      "chemin : " + chemin.join(" > "),
      "élément actif : " + (document.activeElement?.tagName || "-"),
      "sélection : " + (sel && !sel.isCollapsed ? `"${masquer(sel.toString()).slice(0, 200)}"` : "(aucune)"),
      "",
      decrire(bloc)
    ].join("\n");
  }

  // ---------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((msg, _sender, repondre) => {
    switch (msg.type) {
      case "sonder":
        repondre({ aSelection: !!lireSelection() });
        break;
      case "selectionnerAuto":
        repondre({ ok: selectionnerAuto() });
        break;
      case "capturer":
        capture = lireSelection(!!msg.paragraphes, autoDemande ? plageForcee() : null);
        autoDemande = false;
        // U+FEFF : caractères invisibles des variables Slate (cases bleues de Follow)
        repondre(capture
          ? { texte: capture.envoi ?? capture.texte, parties: capture.parties, blocsSuppr: capture.blocsSuppr, contexte: capture.contexte, site: location.hostname, remplacable: capture.type === "champ" || !!capture.hote }
          : { texte: "" });
        break;
      case "remplacer":
        remplacer(msg.texte).then(repondre);
        return true; // réponse asynchrone
      case "diagnostiquer":
        repondre({ texte: diagnostiquer() });
        break;
      case "diagnostic":
        if (window === top) panneau().diagnostic(msg.texte);
        break;
      case "attente":
        if (window === top) panneau().attente(msg.original);
        break;
      case "resultat":
        if (window === top) panneau().resultat(msg);
        break;
      case "erreur":
        if (window === top) panneau().erreur(msg.message);
        break;
    }
  });

  // ---------------------------------------------------------------- diff mot à mot

  function decouper(s) {
    return s.match(/\s+|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || [];
  }

  function diff(a, b) {
    const A = decouper(a), B = decouper(b);
    const n = A.length, m = B.length;
    if (n * m > 9e6) return [["-", a], ["+", b]]; // texte trop long : pas de diff fin
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * (m + 1) + j] = A[i] === B[j]
          ? L[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    const ops = [];
    const pousser = (t, s) => {
      const d = ops[ops.length - 1];
      if (d && d[0] === t) d[1] += s; else ops.push([t, s]);
    };
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { pousser("=", A[i]); i++; j++; }
      else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) pousser("-", A[i++]);
      else pousser("+", B[j++]);
    }
    while (i < n) pousser("-", A[i++]);
    while (j < m) pousser("+", B[j++]);
    return ops;
  }

  // Retouches à la main du texte proposé → nouvelles réponses, case par case.
  // libres : positions [s, e) de chaque réponse tapée dans le texte proposé.
  // Les morceaux de texte fixe du modèle servent d'ancres : ils doivent se
  // retrouver intacts et dans l'ordre ; ce qui les sépare est la nouvelle
  // réponse. Renvoie null si le texte fixe a été retouché (remplacement en bloc).
  function opsRetouchees(propose, texte, libres) {
    if (!libres.length) return texte === propose ? [] : null;
    const fixes = [];
    let pos = 0;
    for (const l of libres) { fixes.push([pos, l.s]); pos = l.e; }
    fixes.push([pos, propose.length]);
    // position attendue de chaque ancre (d'après le diff) pour départager
    // les occurrences multiples d'une ancre courte
    const vers = new Int32Array(propose.length + 1);
    let pa = 0, pb = 0;
    for (const [t, s] of diff(propose, texte)) {
      if (t === "+") { pb += s.length; continue; }
      for (let k = 0; k < s.length; k++) { pa++; if (t === "=") pb++; vers[pa] = pb; }
    }
    const places = [];
    let curseur = 0;
    for (let i = 0; i < fixes.length; i++) {
      const f = propose.slice(...fixes[i]);
      let p = -1;
      if (i === 0) p = texte.startsWith(f) ? 0 : -1;
      else if (i === fixes.length - 1) p = texte.endsWith(f) && texte.length - f.length >= curseur ? texte.length - f.length : -1;
      else {
        const vise = vers[fixes[i][0]];
        for (let k = texte.indexOf(f, curseur); k >= 0; k = texte.indexOf(f, k + 1)) {
          if (p < 0 || Math.abs(k - vise) < Math.abs(p - vise)) p = k;
          if (k >= vise) break;
        }
      }
      if (p < 0) return null;
      places.push(p);
      curseur = p + f.length;
    }
    return libres
      .map((l, i) => ({
        cle: l.cle, original: l.original, ...(l.bloc && { bloc: true }),
        texte: texte.slice(places[i] + fixes[i][1] - fixes[i][0], places[i + 1]).replace(/^\n+|\n+$/g, "")
      }))
      .filter(o => o.texte !== o.original);
  }

  // ---------------------------------------------------------------- panneau (frame principale)

  let ui = null;

  function panneau() {
    if (ui) { ui.hote.style.display = ""; return ui; }

    const hote = document.createElement("div");
    hote.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;";
    const racine = hote.attachShadow({ mode: "closed" });
    racine.innerHTML = `
      <style>
        :host { --fond:#fff; --texte:#1d1d1f; --doux:#6e6e73; --bord:#d9d9de; --acc:#c96442;
                --ins-f:#dff5e3; --ins-t:#136c2e; --del-f:#fde2e1; --del-t:#a1231b; }
        @media (prefers-color-scheme: dark) {
          :host { --fond:#1f1f22; --texte:#ececf1; --doux:#9a9aa3; --bord:#3a3a40; --acc:#e08a6a;
                  --ins-f:#173d22; --ins-t:#8ee0a4; --del-f:#4a1c1a; --del-t:#f3a29b; }
        }
        .p { width:min(520px, calc(100vw - 32px)); max-height:min(70vh, 640px); display:flex; flex-direction:column;
             background:var(--fond); color:var(--texte); border:1px solid var(--bord); border-radius:12px;
             box-shadow:0 12px 40px rgba(0,0,0,.22); font:14px/1.5 system-ui, "Segoe UI", sans-serif; }
        .t { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--bord); }
        .t b { font-weight:600; flex:1; }
        .t small { color:var(--doux); }
        .x { all:unset; cursor:pointer; color:var(--doux); padding:0 4px; font-size:18px; line-height:1; }
        .c { padding:12px 14px; overflow:auto; white-space:pre-wrap; word-wrap:break-word; flex:1; }
        .c ins { background:var(--ins-f); color:var(--ins-t); text-decoration:none; border-radius:3px; }
        .c del { background:var(--del-f); color:var(--del-t); border-radius:3px; user-select:none; }
        .c del.retab { cursor:pointer; }
        .c del.retab:hover { outline:1px solid var(--del-t); }
        .c[contenteditable="plaintext-only"] { outline:none; cursor:text; }
        .c[contenteditable="plaintext-only"]:focus { box-shadow:inset 0 0 0 2px var(--acc); }
        .aide { padding:0 14px 8px; font-size:12px; color:var(--doux); }
        textarea { font:inherit; color:inherit; background:transparent; border:1px solid var(--bord); border-radius:8px;
                   width:100%; box-sizing:border-box; min-height:180px; padding:8px; resize:vertical; }
        .b { display:flex; gap:8px; padding:10px 14px; border-top:1px solid var(--bord); flex-wrap:wrap; }
        button { font:inherit; cursor:pointer; border-radius:8px; padding:6px 12px; border:1px solid var(--bord);
                 background:transparent; color:var(--texte); }
        button.pr { background:var(--acc); border-color:var(--acc); color:#fff; font-weight:600; }
        button:disabled { opacity:.5; cursor:default; }
        .sp { flex:1; }
        .msg { color:var(--doux); font-size:13px; align-self:center; }
        .err { color:var(--del-t); }
        .ok  { color:var(--ins-t); }
        /* DEV — provisoire : volet « Envoyé à Claude » */
        .dev { border-top:1px dashed var(--bord); padding:6px 14px; font-size:12px; color:var(--doux); }
        .dev summary { cursor:pointer; }
        .dev pre { margin:6px 0 0; max-height:160px; overflow:auto; white-space:pre-wrap; word-wrap:break-word;
                   font:12px/1.4 ui-monospace, Consolas, monospace; color:var(--texte); }
        @keyframes r { to { transform:rotate(360deg) } }
        .rond { width:14px; height:14px; border:2px solid var(--bord); border-top-color:var(--acc); border-radius:50%;
                animation:r .8s linear infinite; display:inline-block; vertical-align:-2px; margin-right:6px; }
      </style>
      <div class="p" role="dialog" aria-label="Dictopen">
        <div class="t"><b>Dictopen — correction</b><small class="info"></small><button class="x" title="Fermer (Échap)">×</button></div>
        <div class="c"></div>
        <div class="b"></div>
      </div>`;
    document.documentElement.appendChild(hote);

    const $ = s => racine.querySelector(s);
    const corps = $(".c"), barre = $(".b"), info = $(".info");
    let dev = null; // DEV : volet « Envoyé à Claude »
    const retirerDev = () => { dev?.remove(); dev = null; };
    const fermer = () => { hote.style.display = "none"; };
    $(".x").onclick = fermer;
    racine.addEventListener("keydown", e => { if (e.key === "Escape") fermer(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && hote.style.display !== "none") fermer(); });

    const bouton = (libelle, action, principal) => {
      const b = document.createElement("button");
      b.textContent = libelle;
      if (principal) b.className = "pr";
      b.onclick = action;
      barre.appendChild(b);
      return b;
    };
    const message = (texte, cls = "") => {
      const s = document.createElement("span");
      s.className = "msg " + cls;
      s.textContent = texte;
      return s;
    };

    ui = {
      hote,
      attente() {
        retirerDev();
        racine.querySelector(".aide")?.remove();
        corps.contentEditable = "false";
        info.textContent = "";
        corps.innerHTML = '<span class="rond"></span>Relecture en cours…';
        barre.replaceChildren();
        bouton("Fermer", fermer);
      },
      diagnostic(texte) {
        retirerDev();
        racine.querySelector(".aide")?.remove();
        corps.contentEditable = "false";
        info.textContent = "diagnostic";
        const zone = document.createElement("textarea");
        zone.value = texte;
        zone.readOnly = true;
        zone.style.cssText = "min-height:320px;font:12px/1.4 Consolas,monospace;white-space:pre;";
        corps.replaceChildren(message("Structure anonymisée : aucun texte ni valeur en clair. Copiez-la et transmettez-la pour adapter l’extension à ce site."), zone);
        barre.replaceChildren();
        const statut = message("");
        bouton("Copier", async () => {
          await navigator.clipboard.writeText(texte);
          statut.textContent = "Copié.";
          statut.className = "msg ok";
        }, true);
        const espace = document.createElement("span");
        espace.className = "sp";
        barre.append(espace, statut);
        bouton("Fermer", fermer);
      },
      erreur(texte) {
        retirerDev();
        racine.querySelector(".aide")?.remove();
        corps.contentEditable = "false";
        info.textContent = "";
        corps.replaceChildren(message(texte, "err"));
        barre.replaceChildren();
        bouton("Fermer", fermer);
      },
      resultat({ original, corrige, duree, remplacable, frameId, envoye, libres }) {
        retirerDev();
        racine.querySelector(".aide")?.remove();
        corps.contentEditable = "false";
        info.textContent = duree ? (duree / 1000).toFixed(1) + " s" : "";
        // texte exact envoyé à Dictopen (vérification de confidentialité)
        if (envoye != null) {
          dev = document.createElement("details");
          dev.className = "dev";
          const titre = document.createElement("summary");
          titre.textContent = "Envoyé à Dictopen" + (envoye ? ` (${envoye.length} caractères)` : " : rien");
          const pre = document.createElement("pre");
          pre.textContent = envoye || "(aucun texte : rien à relire)";
          dev.append(titre, pre);
          barre.before(dev);
        }
        // Texte corrigé modifiable directement dans la vue des différences :
        // un passage barré suivi d'un ajout (correction) se rétablit d'un clic ;
        // les différences se recalculent quand on quitte la zone.
        const propose = corrige;
        corps.contentEditable = "plaintext-only";
        corps.spellcheck = false;
        const aide = message("");
        const lireTexte = () => {
          let t = "";
          (function lire(n) {
            for (const c of n.childNodes) {
              if (c.nodeType === 3) t += c.data;
              else if (c.tagName === "BR") t += "\n";
              else if (c.tagName === "DEL") continue;
              else {
                if (/^(DIV|P)$/.test(c.tagName) && t && !t.endsWith("\n")) t += "\n";
                lire(c);
              }
            }
          })(corps);
          return t;
        };
        const afficherDiff = texte => {
          const ops = diff(original, texte);
          corps.replaceChildren(...ops.map(([t, s], k) => {
            if (t === "=") return document.createTextNode(s);
            const e = document.createElement(t === "+" ? "ins" : "del");
            e.textContent = s;
            if (t === "-") {
              e.contentEditable = "false";
              if (ops[k + 1]?.[0] === "+") { e.className = "retab"; e.title = "Cliquer pour rétablir le texte d'origine"; }
            }
            return e;
          }));
          aide.textContent = original === texte ? "Aucune correction. " : "";
          aide.textContent += "Texte modifiable directement ; clic sur un passage barré pour le rétablir.";
        };
        afficherDiff(corrige);
        corps.onclick = e => {
          const d = e.target.closest?.("del.retab");
          if (!d) return;
          if (d.nextSibling?.tagName === "INS") d.nextSibling.remove();
          d.replaceWith(document.createTextNode(d.textContent));
        };
        corps.onfocusout = () => afficherDiff(lireTexte());
        const texteFinal = lireTexte;

        barre.replaceChildren();
        const statut = message("");
        const bRemplacer = bouton("Remplacer", async () => {
          bRemplacer.disabled = true;
          const texte = texteFinal();
          // Retouches limitées aux réponses tapées : remplacement case par case
          const ops = libres && texte !== propose ? opsRetouchees(propose, texte, libres) : null;
          const r = await chrome.runtime.sendMessage({ type: "remplacer", frameId, texte, ops });
          if (r?.ok) { fermer(); return; }
          statut.textContent = r?.erreur || "Échec du remplacement.";
          statut.className = "msg err";
          bRemplacer.disabled = false;
        }, true);
        if (!remplacable) { bRemplacer.disabled = true; bRemplacer.title = "La sélection n'est pas dans un champ modifiable"; }
        bouton("Copier", async () => {
          await navigator.clipboard.writeText(texteFinal());
          statut.textContent = "Copié.";
          statut.className = "msg ok";
        });
        bouton("Rétablir la proposition", () => afficherDiff(propose));
        const espace = document.createElement("span");
        espace.className = "sp";
        barre.append(espace, statut);
        bouton("Fermer", fermer);
        aide.className = "aide";
        corps.after(aide);
        bRemplacer.focus();
      }
    };
    return ui;
  }
})();
