const DEFAUTS = { niveau: "ortho", paragraphes: "supprimer", port: 47395, afficherEnvoi: false };

chrome.storage.local.get(DEFAUTS).then(r => {
  for (const nom of ["niveau", "paragraphes"]) {
    const el = document.querySelector(`input[name="${nom}"][value="${r[nom]}"]`);
    if (el) el.checked = true;
  }
  document.getElementById("port").value = r.port;
  document.getElementById("afficherEnvoi").checked = !!r.afficherEnvoi;
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
  enregistre();
});
