export function mixAudioBufferToMono(audioBuffer: AudioBuffer): Float32Array {
  const samples = new Float32Array(audioBuffer.length);
  const channels = Math.max(1, audioBuffer.numberOfChannels);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);

    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = (samples[index] ?? 0) + (data[index] ?? 0) / channels;
    }
  }

  return samples;
}

export function createHannWindow(size: number): Float32Array {
  const window = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / Math.max(1, size - 1)));
  }

  return window;
}
