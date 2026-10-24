// SpeechMike / PowerMic 4 / RecMic par WebHID. Tables de boutons établies par observation des rapports HID (page d'utilisation 0xFFA0).
(() => {
  const USAGE_PAGE_PHILIPS = 0xffa0;
  const devices = new Map(); // HIDDevice -> { type, listener }
  let pressed = null;

  function micType(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('speechmike')) return 'SpeechMike';
    if (n.includes('powermic 4')) return 'PowerMic4';
    if (n.includes('microphone streaming (rm)') || n.includes('rm-40')) return 'RecMic';
    return null;
  }

  function isMicrophone(d) {
    const t = micType(d.productName);
    if (!t) return false;
    const c = d.collections && d.collections[0];
    if (t === 'RecMic') return !!(c && c.outputReports && c.outputReports.length);
    return !!(c && c.usagePage === USAGE_PAGE_PHILIPS);
  }

  const SPEECHMIKE = {
    '0-0--128': null, '0-32--128': 'eolOrPrio', '0--128--128': 'info', '0-64--128': 'insOrOvr', '0-1--128': 'startRecord',
    '0-16--128': 'rewind', '0-4--128': 'playOrPause', '0-8--128': 'fastForward', '2-0--128': 'F1', '4-0--128': 'F2',
    '8-0--128': 'F3', '16-0--128': 'F4', '32-0--128': 'rear', '33-0--128': 'rear',
  };
  const POWERMIC4 = {
    '0-0': null, '0-32': 'eolOrPrio', '0-128': 'info', '0-64': 'insOrOvr', '0-1': 'startRecord', '0-16': 'rewind',
    '0-4': 'playOrPause', '0-8': 'fastForward', '2-0': 'F1', '4-0': 'F2', '8-0': 'F3', '16-0': 'F4', '32-0': 'rear',
  };
  const RECMIC = {
    '0-0-0-0': null, '0-4-0-0': 'eolOrPrio', '64-0-0-0': 'info', '0-0-0-1': 'insOrOvr', '16-0-0-0': 'startRecord',
    '4-0-0-0': 'rewind', '2-0-0-0': 'playOrPause', '8-0-0-0': 'fastForward', '0-64-0-0': 'F1', '0-128-0-0': 'F2',
    '0-0-8-0': 'F3', '0-0-64-0': 'F4', '0-0-128-0': 'rear',
  };

  function decode(type, data) {
    if (type === 'SpeechMike') {
      if (data.byteLength < 9) return undefined;
      const id = `${data.getInt8(7)}-${data.getInt8(8)}-${data.getInt8(0)}`;
      return id in SPEECHMIKE ? SPEECHMIKE[id] : undefined;
    }
    if (type === 'PowerMic4') {
      if (data.byteLength < 9) return undefined;
      const id = `${data.getUint8(7)}-${data.getUint8(8)}`;
      return id in POWERMIC4 ? POWERMIC4[id] : undefined;
    }
    if (data.byteLength < 4) return undefined;
    const id = `${data.getUint8(0)}-${data.getUint8(1)}-${data.getUint8(2)}-${data.getUint8(3)}`;
    return id in RECMIC ? RECMIC[id] : undefined;
  }

  function onReport(type, ev) {
    const button = decode(type, ev.data);
    if (button === undefined) return; // rapport inconnu (ex. : état des LED)
    if (button === null) {
      if (pressed) { window.dictee.sendMicButton({ type: pressed, released: true }); pressed = null; }
      return;
    }
    if (pressed === button) return;
    pressed = button;
    window.dictee.sendMicButton({ type: button, released: false });
  }

  function publish() {
    const list = [...devices.entries()].map(([d, i]) => `${i.type} (${d.productName})`);
    window.dictee.sendMicStatus({ connected: devices.size > 0, name: list.join(', ') });
  }

  async function attach(d) {
    if (devices.has(d) || !isMicrophone(d)) return;
    const type = micType(d.productName);
    try {
      if (!d.opened) await d.open();
    } catch (e) {
      console.warn('ouverture HID impossible', d.productName, e);
      return;
    }
    // journalise le descripteur (rapports d'entrée/sortie/feature) pour construire les commandes LED
    try {
      const desc = (d.collections || []).map((c) => ({
        usagePage: c.usagePage, usage: c.usage,
        input: (c.inputReports || []).map((r) => ({ id: r.reportId, items: (r.items || []).map((i) => ({ usagePage: i.usagePage, usages: i.usages, size: i.reportSize, count: i.reportCount })) })),
        output: (c.outputReports || []).map((r) => ({ id: r.reportId, items: (r.items || []).map((i) => ({ usagePage: i.usagePage, usages: i.usages, size: i.reportSize, count: i.reportCount })) })),
        feature: (c.featureReports || []).map((r) => ({ id: r.reportId, items: (r.items || []).map((i) => ({ usagePage: i.usagePage, usages: i.usages, size: i.reportSize, count: i.reportCount })) })),
      }));
      window.dictee.logInfo(`HID ${d.vendorId.toString(16)}:${d.productId.toString(16)} ${d.productName} ${JSON.stringify(desc)}`);
    } catch (e) { window.dictee.logInfo('HID descripteur : ' + e.message); }
    const listener = (ev) => onReport(type, ev);
    d.addEventListener('inputreport', listener);
    devices.set(d, { type, listener });
    publish();
  }

  async function detach(d) {
    const info = devices.get(d);
    if (!info) return;
    d.removeEventListener('inputreport', info.listener);
    try { if (d.opened) await d.close(); } catch {}
    devices.delete(d);
    publish();
  }

  async function refresh() {
    if (!navigator.hid) return;
    const all = await navigator.hid.getDevices();
    for (const d of all) await attach(d);
    publish();
  }

  navigator.hid?.addEventListener('connect', (e) => attach(e.device));
  navigator.hid?.addEventListener('disconnect', (e) => detach(e.device));

  // envoi d'un rapport de sortie (LED…) demandé par le processus principal
  window.dictee.onHidOutput(async ({ reportId, data }) => {
    for (const [d] of devices) {
      try { await d.sendReport(reportId, new Uint8Array(data)); window.dictee.logInfo(`HID sendReport id=${reportId} [${data.join(',')}] ok`); }
      catch (e) { window.dictee.logInfo(`HID sendReport id=${reportId} échec : ${e.message}`); }
    }
  });

  // association explicite (si l'autorisation automatique ne suffit pas)
  window.dictee.onPairMicrophone(async () => {
    try {
      const list = await navigator.hid.requestDevice({ filters: [{ usagePage: USAGE_PAGE_PHILIPS }, { vendorId: 0x0911 }, { vendorId: 0x0554 }, { vendorId: 0x07b4 }] });
      for (const d of list) await attach(d);
    } catch (e) {
      console.warn('association HID', e);
    }
  });

  refresh();
  setInterval(refresh, 15000);
})();
