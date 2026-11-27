// Captation du micro dans la fenêtre « barre » : flux gardé ouvert (réactivité), envoi des paquets PCM
// au processus principal seulement pendant l'enregistrement.
(() => {
  let ctx = null;
  let stream = null;
  let node = null;
  let streaming = false;
  let currentDeviceId = '';

  async function pickDeviceId(wanted) {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (wanted && devs.some((d) => d.deviceId === wanted)) return wanted;
    const sm = devs.find((d) => /speechmike|powermic|rm-40|microphone streaming/i.test(d.label));
    return sm ? sm.deviceId : '';
  }

  async function open(deviceId) {
    if (stream && currentDeviceId === (deviceId || '')) return;
    await close();
    currentDeviceId = deviceId || '';
    const id = await pickDeviceId(deviceId);
    const constraints = {
      audio: {
        deviceId: id ? { exact: id } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    window.dictee.sendAudioDevice(stream.getAudioTracks()[0].label || 'micro');
    ctx = new AudioContext({ sampleRate: 24000 });
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-processor');
    node.port.onmessage = (e) => {
      if (e.data.type === 'chunk') { if (streaming) window.dictee.sendAudioChunk(new Uint8Array(e.data.data)); }
      else if (e.data.type === 'level') window.dictee.sendAudioLevel(streaming ? e.data.value : 0);
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
    stream.getAudioTracks()[0].addEventListener('ended', () => { window.dictee.reportCaptureError('flux micro interrompu'); close(); });
  }

  async function close() {
    streaming = false;
    if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (ctx) { try { await ctx.close(); } catch {} ctx = null; }
  }

  // signale le micro qui sera utilisé (affiché dans la barre quand il n'y a pas de SpeechMike)
  let wantedDeviceId = '';
  async function reportDevice() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const id = await pickDeviceId(wantedDeviceId);
      const dev = devs.find((d) => d.deviceId === id) || devs.find((d) => d.deviceId === 'default') || devs[0];
      window.dictee.sendAudioDevice(dev ? (dev.label || 'micro') : 'aucun micro');
    } catch (e) {
      window.dictee.sendAudioDevice('micro ?');
    }
  }
  navigator.mediaDevices.addEventListener('devicechange', reportDevice);
  window.dictee.getSettings().then((s) => { wantedDeviceId = s.transcription.microphoneId || ''; reportDevice(); });

  // Casque sans fil (SteelSeries Arctis…) : il s'éteint après quelques minutes sans son en SORTIE, même si son micro
  // sert. Un signal inaudible (bruit à -80 dBFS) joué en continu sur la sortie du casque le garde allumé,
  // comme le font les applis de visio. Sortie choisie : celle du même périphérique que le micro, sinon le défaut.
  let eveil = null;
  async function garderEveille(on) {
    if (!on) { if (eveil) { try { await eveil.close(); } catch {} eveil = null; } return; }
    if (eveil) return;
    eveil = new AudioContext();
    const buf = eveil.createBuffer(1, eveil.sampleRate * 2, eveil.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.0001;
    const src = eveil.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(eveil.destination);
    src.start();
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const micId = await pickDeviceId(wantedDeviceId);
      const mic = devs.find((x) => x.kind === 'audioinput' && x.deviceId === (micId || 'default')) || devs.find((x) => x.kind === 'audioinput');
      const sortie = (mic && devs.find((x) => x.kind === 'audiooutput' && x.groupId === mic.groupId && x.deviceId !== 'default'))
        || devs.find((x) => x.kind === 'audiooutput' && /arctis|steelseries|headset|casque/i.test(x.label) && x.deviceId !== 'default');
      if (sortie && eveil.setSinkId) await eveil.setSinkId(sortie.deviceId);
      window.dictee.logInfo(`casque gardé éveillé : sortie « ${sortie ? sortie.label : 'par défaut'} »`);
    } catch (e) { window.dictee.logInfo(`casque gardé éveillé (sortie par défaut) : ${e.message}`); }
    if (eveil.state === 'suspended') { try { await eveil.resume(); } catch {} }
  }

  window.dictee.onCaptureCommand(async ({ cmd, deviceId, on }) => {
    if (cmd === 'awake') { try { await garderEveille(!!on); } catch (e) { window.dictee.logInfo('éveil casque : ' + e.message); } return; }
    if (deviceId !== undefined) { wantedDeviceId = deviceId || ''; reportDevice(); }
    try {
      if (cmd === 'open') await open(deviceId);
      else if (cmd === 'close') await close();
      else if (cmd === 'start') { await open(deviceId); if (ctx.state === 'suspended') await ctx.resume(); streaming = true; }
      else if (cmd === 'stop') { streaming = false; }
    } catch (e) {
      window.dictee.reportCaptureError(e.message || String(e));
    }
  });
})();
