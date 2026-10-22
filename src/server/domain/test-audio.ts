/** Sample rate of the generated test sound: what speech recognizers resample to anyway. */
const SAMPLE_RATE = 16000;
const TONE_HZ = 440;
/** Quiet enough not to clip, loud enough not to be dropped as silence before recognition. */
const AMPLITUDE = 0.2;

/**
 * A short mono 16-bit PCM WAV tone for "test connection" of an ASR model:
 * generated rather than shipped, it carries no speech, so a provider that bills speech
 * only bills nothing, and a "no speech" answer still proves the model runs.
 */
export function testToneWav(durationMs: number): Uint8Array {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE) * AMPLITUDE * 0x7fff);
    view.setInt16(44 + i * 2, value, true);
  }
  return bytes;
}
