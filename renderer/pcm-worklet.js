// Convertit le flux micro (float 32, 24 kHz grâce au sampleRate du contexte) en PCM 16 bits mono,
// par paquets de 100 ms (2400 échantillons), et envoie un niveau sonore.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(2400);
    this.pos = 0;
    this.frames = 0;
    this.peak = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      const a = s < 0 ? -s : s;
      if (a > this.peak) this.peak = a;
      this.buf[this.pos++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.pos === this.buf.length) {
        this.port.postMessage({ type: 'chunk', data: this.buf.buffer.slice(0) });
        this.pos = 0;
      }
    }
    if (++this.frames % 8 === 0) { // ~ toutes les 43 ms
      this.port.postMessage({ type: 'level', value: this.peak });
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
