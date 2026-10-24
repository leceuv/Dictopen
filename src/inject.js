'use strict';
// Collage du texte dans l'application active : presse-papiers sauvegardé → Cmd+V (System Events) → restauration.
// Les espaces et retours à la ligne finaux sont envoyés en touches, car Office les ignore au collage.
const { clipboard, ClipboardItem } = require('electron');
const { execFile } = require('child_process');

const KEY_SPACE = 49;
const KEY_RETURN = 36;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runOsa(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { encoding: 'utf8', timeout: 15000 }, (err, stdout, stderr) => {
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

async function pressHotkey(accelerator) {
  // accelerator façon Electron : "Ctrl+Alt+Escape" → System Events (macOS) ou SendKeys (Windows)
  const parts = accelerator.split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts.pop();
  if (IS_WIN) {
    const SK = { Escape: '{ESC}', Return: '{ENTER}', Enter: '{ENTER}', Tab: '{TAB}', Space: ' ', Backspace: '{BS}', Delete: '{DEL}', Up: '{UP}', Down: '{DOWN}', Left: '{LEFT}', Right: '{RIGHT}', Home: '{HOME}', End: '{END}', PageUp: '{PGUP}', PageDown: '{PGDN}' };
    let keys = '';
    for (const p of parts) { const q = p.toLowerCase(); if (q === 'ctrl' || q === 'control') keys += '^'; else if (q === 'alt' || q === 'option') keys += '%'; else if (q === 'shift') keys += '+'; }
    keys += SK[key] || (/^F\d+$/.test(key) ? `{${key}}` : key.length === 1 ? key.toLowerCase().replace(/[+^%~(){}\[\]]/g, (c) => `{${c}}`) : `{${key}}`);
    await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')`);
    return;
  }
  const mods = [];
  for (const p of parts) {
    const q = p.toLowerCase();
    if (q === 'ctrl' || q === 'control') mods.push('control down');
    else if (q === 'alt' || q === 'option') mods.push('option down');
    else if (q === 'shift') mods.push('shift down');
    else if (q === 'cmd' || q === 'command' || q === 'meta' || q === 'super') mods.push('command down');
  }
  const KEYCODES = { Escape: 53, Return: 36, Enter: 36, Tab: 48, Space: 49, Backspace: 51, Delete: 117, Up: 126, Down: 125, Left: 123, Right: 124, Home: 115, End: 119, PageUp: 116, PageDown: 121,
    F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111 };
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  const script = KEYCODES[key] !== undefined
    ? `tell application "System Events" to key code ${KEYCODES[key]}${using}`
    : `tell application "System Events" to keystroke "${key.toLowerCase().replace(/"/g, '\\"')}"${using}`;
  await runOsa(script);
}

module.exports = { pasteIntoActiveApp, pressHotkey };
