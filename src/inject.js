'use strict';
// Collage du texte dans l'application active : presse-papiers sauvegardé → Cmd+V (System Events) → restauration.
// Les espaces et retours à la ligne finaux sont envoyés en touches, car Office les ignore au collage.
const { app, clipboard, ClipboardItem } = require('electron');
const { execFile } = require('child_process');

// osascript et pbpaste encodent leur sortie selon la locale : l'app lancée par le Finder n'en a pas → accents perdus sans ceci
const UTF8_ENV = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

const KEY_SPACE = 49;
const KEY_RETURN = 36;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runOsa(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { encoding: 'utf8', timeout: 15000, env: UTF8_ENV }, (err, stdout, stderr) => {
      if (err) {
        console.error('osascript :', (stderr || '').trim(), '|', err.message);
        const e = new Error((stderr || err.message || '').trim());
        e.missingAutomationRights = /-1743/.test(e.message);
        e.missingAccessibilityRights = /\b1002\b/.test(e.message);
        return reject(e);
      }
      resolve(stdout);
    });
  });
}

// Presse-papiers (API asynchrone W3C d'Electron 45) : on garde les éléments tels quels et on les remet après le collage.
async function saveClipboard() {
  try {
    const items = await clipboard.read();
    const text = await clipboard.readText().catch(() => '');
    return { items, text };
  } catch (e) {
    console.warn('lecture du presse-papiers impossible', e.message);
    return { items: [], text: '' };
  }
}

async function restoreClipboard(saved) {
  try {
    if (saved.items && saved.items.length) {
      // reconstruit chaque élément à partir de ses types (les objets issus de read() ne sont pas toujours réinscriptibles)
      const rebuilt = [];
      for (const it of saved.items) {
        const rec = {};
        for (const t of it.types || []) {
          try { rec[t] = await it.getType(t); } catch {}
        }
        if (Object.keys(rec).length) rebuilt.push(new ClipboardItem(rec));
      }
      if (rebuilt.length) { await clipboard.write(rebuilt); return; }
    }
    if (saved.text) await clipboard.writeText(saved.text);
    else clipboard.clear();
  } catch (e) {
    console.warn('restauration du presse-papiers partielle', e.message);
    if (saved.text) { try { await clipboard.writeText(saved.text); } catch {} }
  }
}

// attend que Ctrl/Option/Cmd soient relâchées (l'utilisateur vient peut-être d'appuyer sur un raccourci)
const WAIT_MODIFIERS = `
use framework "Cocoa"
use scripting additions
repeat 60 times
  set f to (current application's NSEvent's modifierFlags()) as integer
  set ctrlDown to ((f div 262144) mod 2) is 1
  set optDown to ((f div 524288) mod 2) is 1
  set cmdDown to ((f div 1048576) mod 2) is 1
  if not (ctrlDown or optDown or cmdDown) then exit repeat
  delay 0.05
end repeat
`;

const IS_WIN = process.platform === 'win32';

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { console.error('powershell :', (stderr || '').trim(), '|', err.message); return reject(new Error((stderr || err.message || '').trim())); }
        resolve(stdout);
      });
  });
}

// Windows : attend le relâchement de Ctrl/Alt/Win puis envoie Ctrl+V (et les espaces / retours finaux en touches)
async function pasteOnWindows(body, trailing) {
  let keys = body ? '^v' : '';
  for (const ch of trailing) keys += ch === ' ' ? ' ' : '{ENTER}';
  if (!keys) return;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
for ($i = 0; $i -lt 60; $i++) {
  $m = [System.Windows.Forms.Control]::ModifierKeys
  if (($m -band [System.Windows.Forms.Keys]::Control) -eq 0 -and ($m -band [System.Windows.Forms.Keys]::Alt) -eq 0) { break }
  Start-Sleep -Milliseconds 50
}
[System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')`;
  await runPowerShell(script);
}

async function pasteIntoActiveApp(text, opts = {}) {
  const afterDelay = opts.afterPasteDelayMs ?? 800;
  const m = text.match(/[\r\n ]*$/);
  const trailing = (m ? m[0] : '').replace(/\r/g, '');
  const body = text.slice(0, text.length - (m ? m[0].length : 0));

  const saved = await saveClipboard();
  try {
    if (IS_WIN) {
      if (body) await clipboard.writeText(body);
      await pasteOnWindows(body, trailing);
      return;
    }
    let script = WAIT_MODIFIERS;
    if (body) {
      await clipboard.writeText(body);
      script += '\ntell application "System Events" to keystroke "v" using command down';
    }
    for (const ch of trailing) {
      script += '\ndelay 0.08';
      script += `\ntell application "System Events" to key code ${ch === ' ' ? KEY_SPACE : KEY_RETURN}`;
    }
    await runOsa(script);
  } finally {
    await delay(afterDelay);
    await restoreClipboard(saved);
  }
}

function readClipboardText() {
  return new Promise((resolve) => {
    const fallback = () => clipboard.readText().then((t) => resolve(t || ''), () => resolve(''));
    if (IS_WIN) {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, out) => (err ? fallback() : resolve((out || '').replace(/\r\n/g, '\n').replace(/\n$/, ''))));
    } else {
      execFile('pbpaste', [], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: UTF8_ENV }, (err, out) => (err ? fallback() : resolve(out || '')));
    }
  });
}

// Lit le texte sélectionné dans l'application active : presse-papiers vidé → Cmd+C / Ctrl+C → lecture, puis restauration.
// Résout avec '' si rien n'est sélectionné (le presse-papiers reste vide).
function clearClipboard() {
  return new Promise((resolve) => {
    if (IS_WIN) {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $null'], { timeout: 5000, windowsHide: true }, () => resolve());
    } else {
      const p = execFile('pbcopy', [], { timeout: 5000, env: UTF8_ENV }, () => resolve());
      p.stdin.end();
    }
  });
}

// macOS : texte sélectionné via l'accessibilité (AXSelectedText du champ actif), sans toucher au presse-papiers
function readSelectedTextAX() {
  return runOsa(`tell application "System Events"
  set p to first application process whose frontmost is true
  try
    set e to value of attribute "AXFocusedUIElement" of p
    return value of attribute "AXSelectedText" of e
  on error
    return ""
  end try
end tell`).then((out) => out.replace(/\n$/, ''), () => '');
}

// Lit le texte sélectionné dans l'application active : accessibilité (macOS), sinon presse-papiers vidé → Cmd+C / Ctrl+C → lecture, puis restauration.
// Résout avec '' si rien n'est sélectionné.
// nom de l'application au premier plan ('' sur Windows ou en cas d'erreur)
function frontmostApp() {
  if (IS_WIN) {
    const script = 'Add-Type @"\nusing System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}\n"@\n$p=0;[W]::GetWindowThreadProcessId([W]::GetForegroundWindow(),[ref]$p)|Out-Null;(Get-Process -Id $p).ProcessName';
    return runPowerShell(script).then((out) => out.trim(), () => '');
  }
  return runOsa('tell application "System Events" to get name of first application process whose frontmost is true').then((out) => out.trim(), () => '');
}

// Si Dictopen est passé au premier plan (clic sur la barre), il s'efface pour rendre la main à l'application
// où est le texte ; résout avec le nom de cette application. Appeler fn, puis restaurer avec app.show().
async function withTargetApp(fn) {
  let front = await frontmostApp();
  let hidden = false;
  if (/dictopen|electron/i.test(front)) {
    app.hide();
    hidden = true;
    await delay(350);
    front = await frontmostApp();
  }
  console.log(`sélection : premier plan = ${front}`);
  try {
    return await fn(front);
  } finally {
    if (hidden) app.show();
  }
}

async function copySelection() {
  return withTargetApp(() => copySelectionNow());
}

async function copySelectionNow() {
  if (!IS_WIN) {
    const ax = await readSelectedTextAX();
    console.log(`sélection : accessibilité → ${ax.length} caractères`);
    if (ax.trim()) return ax;
  }
  const saved = await saveClipboard();
  try {
    await clearClipboard();
    console.log(`sélection : presse-papiers vidé (${(await readClipboardText()).length} caractères), copie par raccourci`);
    if (IS_WIN) {
      await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
for ($i = 0; $i -lt 60; $i++) {
  $m = [System.Windows.Forms.Control]::ModifierKeys
  if (($m -band [System.Windows.Forms.Keys]::Control) -eq 0 -and ($m -band [System.Windows.Forms.Keys]::Alt) -eq 0) { break }
  Start-Sleep -Milliseconds 50
}
[System.Windows.Forms.SendKeys]::SendWait('^c')`);
    } else {
      await runOsa(WAIT_MODIFIERS + '\ntell application "System Events" to keystroke "c" using command down');
    }
    // l'application cible remplit le presse-papiers de façon asynchrone ; lecture par l'outil système (fiable), puis Electron
    for (let i = 0; i < 30; i++) {
      await delay(50);
      const text = await readClipboardText();
      if (text) { console.log(`sélection : copie → ${text.length} caractères après ${(i + 1) * 50} ms`); return text; }
    }
    console.log('sélection : presse-papiers toujours vide après 1,5 s');
    return '';
  } finally {
    await restoreClipboard(saved);
  }
}

// Accélérateur façon Electron (« Ctrl+Alt+Escape ») → { key, mods }. Validation stricte : les accélérateurs viennent des
// réglages (fichier JSON modifiable à la main) et finissent dans un script AppleScript / PowerShell, donc rien d'autre
// qu'un modificateur connu et une touche de la liste blanche n'est accepté.
const ACCEL_MODS = { ctrl: 'control', control: 'control', alt: 'option', option: 'option', shift: 'shift', cmd: 'command', command: 'command', meta: 'command', super: 'command' };
const ACCEL_NAMED = new Set(['Escape', 'Return', 'Enter', 'Tab', 'Space', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown']);
const ACCEL_PUNCT = "`-=[]\\;',./"; // touches de ponctuation d'un clavier ANSI
function parseAccelerator(accelerator) {
  const parts = String(accelerator || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('raccourci vide');
  const key = parts.pop();
  const mods = [];
  for (const p of parts) {
    const m = ACCEL_MODS[p.toLowerCase()];
    if (!m) throw new Error(`raccourci « ${accelerator} » : modificateur inconnu « ${p} »`);
    if (!mods.includes(m)) mods.push(m);
  }
  const ok = /^[A-Za-z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || ACCEL_NAMED.has(key) || (key.length === 1 && ACCEL_PUNCT.includes(key));
  if (!ok) throw new Error(`raccourci « ${accelerator} » : touche non prise en charge « ${key} »`);
  return { key, mods };
}

async function pressHotkey(accelerator) {
  const { key, mods } = parseAccelerator(accelerator); // → System Events (macOS) ou SendKeys (Windows)
  if (IS_WIN) {
    const SK = { Escape: '{ESC}', Return: '{ENTER}', Enter: '{ENTER}', Tab: '{TAB}', Space: ' ', Backspace: '{BS}', Delete: '{DEL}', Up: '{UP}', Down: '{DOWN}', Left: '{LEFT}', Right: '{RIGHT}', Home: '{HOME}', End: '{END}', PageUp: '{PGUP}', PageDown: '{PGDN}' };
    const PREFIX = { control: '^', option: '%', shift: '+' }; // pas de touche Windows dans SendKeys
    let keys = mods.map((m) => PREFIX[m] || '').join('');
    keys += SK[key] || (/^F\d+$/.test(key) ? `{${key}}` : key.toLowerCase().replace(/[+^%~(){}\[\]]/g, (c) => `{${c}}`));
    await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')`);
    return;
  }
  // lettres et chiffres par code de touche (disposition ANSI) : avec Option, « keystroke » enverrait le caractère spécial
  // (⌥⇧C → Ç) et le raccourci ne serait pas reconnu par l'application
  const KEYCODES = { Escape: 53, Return: 36, Enter: 36, Tab: 48, Space: 49, Backspace: 51, Delete: 117, Up: 126, Down: 125, Left: 123, Right: 124, Home: 115, End: 119, PageUp: 116, PageDown: 121,
    F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
    A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46,
    1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29 };
  const using = mods.length ? ` using {${mods.map((m) => `${m} down`).join(', ')}}` : '';
  const code = KEYCODES[key] !== undefined ? KEYCODES[key] : KEYCODES[key.toUpperCase()];
  // sinon : un seul caractère de ponctuation de la liste blanche ; seule la barre oblique inverse demande un échappement
  const script = code !== undefined
    ? `tell application "System Events" to key code ${code}${using}`
    : `tell application "System Events" to keystroke "${key === '\\' ? '\\\\' : key}"${using}`;
  await runOsa(script);
}

module.exports = { pasteIntoActiveApp, pressHotkey, copySelection, copySelectionNow, withTargetApp, frontmostApp };
