const DEFAUTS = { niveau: "ortho", paragraphes: "supprimer", port: 47395, afficherEnvoi: true, jeton: "", envoiDirect: false };

// config.js (écrit par Dictopen à l'installation) fournit le jeton : le champ devient alors facultatif
const jetonInstalle = typeof self.DICTOPEN_TOKEN === "string" && self.DICTOPEN_TOKEN ? self.DICTOPEN_TOKEN : "";

chrome.storage.local.get(DEFAUTS).then(r => {
  document.getElementById("port").value = r.port;
  const jeton = document.getElementById("jeton");
  jeton.value = r.jeton || "";
  if (jetonInstalle) {
    jeton.placeholder = "fourni par l'installation Dictopen (config.js)";
    document.getElementById("jetonInfo").textContent = "Jeton fourni automatiquement par Dictopen à l'installation (config.js) : rien à faire. Un jeton collé ici n'est utilisé que si config.js manque.";
  }
});

function enregistre() {
  const ok = document.getElementById("ok");
  ok.textContent = "Enregistré.";
  setTimeout(() => (ok.textContent = ""), 1500);
}

document.addEventListener("change", async e => {
  const el = e.target;
  if (el.type === "radio") await chrome.storage.local.set({ [el.name]: el.value });
  else if (el.id === "port") await chrome.storage.local.set({ port: Math.max(1024, parseInt(el.value, 10) || DEFAUTS.port) });
  else if (el.id === "afficherEnvoi") await chrome.storage.local.set({ afficherEnvoi: el.checked });
  else if (el.id === "envoiDirect") {
    if (el.checked && !confirm("Envoyer sans vérification un texte que vous n'aurez pas vu ? Le masquage des identifiants peut laisser passer un nom de patient : vous en assumez la responsabilité.")) { el.checked = false; return; }
    await chrome.storage.local.set({ envoiDirect: el.checked });
  }
  else if (el.id === "jeton") await chrome.storage.local.set({ jeton: el.value.trim() });
  enregistre();
});
