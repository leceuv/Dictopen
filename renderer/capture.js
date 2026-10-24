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

  window.dictee.onCaptureCommand(async ({ cmd, deviceId }) => {
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
