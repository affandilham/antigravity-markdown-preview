import pako from 'pako';

function encode6bit(b: number): string {
  if (b < 10) {
    return String.fromCharCode(48 + b);
  }
  b -= 10;
  if (b < 26) {
    return String.fromCharCode(65 + b);
  }
  b -= 26;
  if (b < 26) {
    return String.fromCharCode(97 + b);
  }
  b -= 26;
  if (b === 0) {
    return '-';
  }
  if (b === 1) {
    return '_';
  }
  return '?';
}

function append3bytes(b1: number, b2: number, b3: number): string {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3f;
  return (
    encode6bit(c1 & 0x3f) +
    encode6bit(c2 & 0x3f) +
    encode6bit(c3 & 0x3f) +
    encode6bit(c4 & 0x3f)
  );
}

function encode64(data: Uint8Array): string {
  let r = '';
  for (let i = 0; i < data.length; i += 3) {
    if (i + 2 === data.length) {
      r += append3bytes(data[i], data[i + 1], 0);
    } else if (i + 1 === data.length) {
      r += append3bytes(data[i], 0, 0);
    } else {
      r += append3bytes(data[i], data[i + 1], data[i + 2]);
    }
  }
  return r;
}

export function encodePlantUML(pumlText: string): string {
  const trimmed = pumlText.trim();
  const normalized = trimmed.startsWith('@start') ? trimmed : `@startuml\n${trimmed}\n@enduml`;
  const utf8Bytes = new TextEncoder().encode(normalized);
  const deflated = pako.deflateRaw(utf8Bytes, { level: 9 });
  return encode64(deflated);
}

export function getPlantUmlSvgUrl(pumlText: string, serverUrl = 'https://kroki.io'): string {
  const encoded = encodePlantUML(pumlText);
  if (serverUrl.includes('kroki.io')) {
    return `https://kroki.io/plantuml/svg/${encoded}`;
  }
  const cleanServer = serverUrl.replace(/\/+$/, '');
  return `${cleanServer}/svg/~1${encoded}`;
}
