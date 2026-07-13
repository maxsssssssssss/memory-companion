type AudioInput = {
  name: string;
  type?: string;
  bytes: ArrayBuffer | Uint8Array;
};

type NormalizedAudio = {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  convertedFrom?: "raw-pcm" | "device-opus";
};

const RAW_PCM_SAMPLE_RATE = 16000;
const RAW_PCM_CHANNELS = 1;
const RAW_PCM_BITS_PER_SAMPLE = 16;
const DEVICE_OPUS_FRAME_SAMPLES = 3840;
const OGG_OPUS_SERIAL = 0x44425246;

const supportedMimeTypes = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/mpga",
  "audio/m4a",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "audio/x-pcm",
  "video/mp4"
]);

const supportedExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".mp4", ".mpga", ".ogg", ".opus", ".pcm", ".wav", ".webm"]);

const extensionToMimeType: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/m4a",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mpga": "audio/mpga",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".pcm": "audio/x-pcm",
  ".wav": "audio/wav",
  ".webm": "audio/webm"
};

const mimeTypeToExtension: Record<string, string> = {
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/m4a": ".m4a",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/mpga": ".mpga",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/x-pcm": ".pcm",
  "video/mp4": ".mp4"
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  }
  return value >>> 0;
});

function toBytes(bytes: ArrayBuffer | Uint8Array) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export function getUploadExtension(name: string) {
  const match = /\.[^.\\/]+$/.exec(name.trim().toLowerCase());
  return match?.[0] ?? "";
}

function replaceExtension(name: string, extension: string) {
  return name.replace(/\.[^.\\/]+$/, "") + extension;
}

function inferMimeType(name: string, type?: string) {
  const normalizedType = type?.trim().toLowerCase();
  if (normalizedType && normalizedType !== "application/octet-stream") {
    return normalizedType;
  }

  return extensionToMimeType[getUploadExtension(name)] ?? normalizedType ?? "";
}

export function mimeTypeToAudioExtension(mimeType: string) {
  return mimeTypeToExtension[mimeType.trim().toLowerCase()];
}

export function isSupportedAudioUpload(input: { name: string; type?: string }) {
  const mimeType = inferMimeType(input.name, input.type);
  const extension = getUploadExtension(input.name);

  return supportedMimeTypes.has(mimeType) || supportedExtensions.has(extension);
}

function writeAscii(target: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

function wrapRawPcmAsWav(pcmBytes: Uint8Array) {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const byteRate = RAW_PCM_SAMPLE_RATE * RAW_PCM_CHANNELS * (RAW_PCM_BITS_PER_SAMPLE / 8);
  const blockAlign = RAW_PCM_CHANNELS * (RAW_PCM_BITS_PER_SAMPLE / 8);

  writeAscii(header, 0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeAscii(header, 8, "WAVE");
  writeAscii(header, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, RAW_PCM_CHANNELS, true);
  view.setUint32(24, RAW_PCM_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, RAW_PCM_BITS_PER_SAMPLE, true);
  writeAscii(header, 36, "data");
  view.setUint32(40, pcmBytes.byteLength, true);

  return concatBytes([header, pcmBytes]);
}

function parseDeviceOpusPackets(bytes: Uint8Array) {
  const packets: Uint8Array[] = [];
  let offset = 0;

  while (offset + 8 <= bytes.byteLength) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);

    if (length <= 0 || length > 1500 || offset + 8 + length > bytes.byteLength) {
      return null;
    }

    packets.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }

  return offset === bytes.byteLength && packets.length > 0 ? packets : null;
}

function oggCrc(bytes: Uint8Array) {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) & 0xff) ^ byte]) >>> 0;
  }
  return crc >>> 0;
}

function makeLacingValues(packetLength: number) {
  const values: number[] = [];
  let remaining = packetLength;

  while (remaining >= 255) {
    values.push(255);
    remaining -= 255;
  }

  values.push(remaining);
  if (packetLength > 0 && packetLength % 255 === 0) {
    values.push(0);
  }

  return values;
}

function writeUint64LittleEndian(target: DataView, offset: number, value: number) {
  const bigValue = BigInt(value);
  target.setUint32(offset, Number(bigValue & 0xffffffffn), true);
  target.setUint32(offset + 4, Number(bigValue >> 32n), true);
}

function createOggPage(input: { packet: Uint8Array; headerType: number; granulePosition: number; sequence: number }) {
  const lacingValues = makeLacingValues(input.packet.byteLength);
  const header = new Uint8Array(27 + lacingValues.length);
  const view = new DataView(header.buffer);

  writeAscii(header, 0, "OggS");
  header[4] = 0;
  header[5] = input.headerType;
  writeUint64LittleEndian(view, 6, input.granulePosition);
  view.setUint32(14, OGG_OPUS_SERIAL, true);
  view.setUint32(18, input.sequence, true);
  view.setUint32(22, 0, true);
  header[26] = lacingValues.length;
  header.set(lacingValues, 27);

  const page = concatBytes([header, input.packet]);
  new DataView(page.buffer, page.byteOffset, page.byteLength).setUint32(22, oggCrc(page), true);
  return page;
}

function concatBytes(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function createOpusHeadPacket() {
  const packet = new Uint8Array(19);
  const view = new DataView(packet.buffer);

  writeAscii(packet, 0, "OpusHead");
  packet[8] = 1;
  packet[9] = 1;
  view.setUint16(10, 312, true);
  view.setUint32(12, RAW_PCM_SAMPLE_RATE, true);
  view.setInt16(16, 0, true);
  packet[18] = 0;

  return packet;
}

function createOpusTagsPacket() {
  const vendor = new TextEncoder().encode("daily-brief");
  const packet = new Uint8Array(8 + 4 + vendor.byteLength + 4);
  const view = new DataView(packet.buffer);

  writeAscii(packet, 0, "OpusTags");
  view.setUint32(8, vendor.byteLength, true);
  packet.set(vendor, 12);
  view.setUint32(12 + vendor.byteLength, 0, true);

  return packet;
}

function wrapDeviceOpusAsOgg(packets: Uint8Array[]) {
  const pages: Uint8Array[] = [];
  let sequence = 0;
  let granulePosition = 0;

  pages.push(createOggPage({ packet: createOpusHeadPacket(), headerType: 2, granulePosition: 0, sequence: sequence++ }));
  pages.push(createOggPage({ packet: createOpusTagsPacket(), headerType: 0, granulePosition: 0, sequence: sequence++ }));

  packets.forEach((packet, index) => {
    granulePosition += DEVICE_OPUS_FRAME_SAMPLES;
    pages.push(
      createOggPage({
        packet,
        headerType: index === packets.length - 1 ? 4 : 0,
        granulePosition,
        sequence: sequence++
      })
    );
  });

  return concatBytes(pages);
}

function isOggContainer(bytes: Uint8Array) {
  return bytes.byteLength >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
}

export function normalizeAudioForTranscription(input: AudioInput): NormalizedAudio {
  const bytes = toBytes(input.bytes);
  const extension = getUploadExtension(input.name);
  const mimeType = inferMimeType(input.name, input.type);

  if (extension === ".pcm" || mimeType === "audio/x-pcm") {
    return {
      name: replaceExtension(input.name, ".wav"),
      mimeType: "audio/wav",
      bytes: wrapRawPcmAsWav(bytes),
      convertedFrom: "raw-pcm"
    };
  }

  if (extension === ".opus" || mimeType === "audio/opus") {
    if (isOggContainer(bytes)) {
      return {
        name: replaceExtension(input.name, ".ogg"),
        mimeType: "audio/ogg",
        bytes
      };
    }

    const packets = parseDeviceOpusPackets(bytes);
    if (packets) {
      return {
        name: replaceExtension(input.name, ".ogg"),
        mimeType: "audio/ogg",
        bytes: wrapDeviceOpusAsOgg(packets),
        convertedFrom: "device-opus"
      };
    }
  }

  return {
    name: input.name,
    mimeType: mimeType || "application/octet-stream",
    bytes
  };
}
