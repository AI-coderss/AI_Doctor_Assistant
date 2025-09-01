export function encodeWAV(pcm, sampleRate, numChannels) {
    const length = pcm.byteLength;
    const buffer = new ArrayBuffer(44 + length);
    const view = new DataView(buffer);

    const writeString = (offset, str) =>
        str.split('').forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);                // sub-chunk size
    view.setUint16(20, 1, true);                 // PCM
    view.setUint16(22, numChannels, true);       // channels
    view.setUint32(24, sampleRate, true);        // sample rate
    view.setUint32(28, sampleRate * 2 * numChannels, true); // byte rate
    view.setUint16(32, numChannels * 2, true);   // block align
    view.setUint16(34, 16, true);                // bits per sample
    writeString(36, 'data');
    view.setUint32(40, length, true);

    new Uint8Array(buffer, 44).set(new Uint8Array(pcm));
    return buffer;
}