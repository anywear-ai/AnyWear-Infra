import { createHash } from 'node:crypto';

// RFC 8785 uses ECMAScript number serialization and UTF-16 property sorting.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Unpaired Unicode surrogate');
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('Unpaired Unicode surrogate');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== undefined) return `{${Object.keys(value).sort()
    .map(key => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('Unsupported JSON value');
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const contentHash = value => sha256(canonicalJson(value));

export function parseJson(bytes) {
  const text = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
  if (typeof text !== 'string' || text.length > 10 * 1024 * 1024) throw new Error('JSON size invalid');
  let i = 0;
  const space = () => { while (/[ \t\r\n]/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw new Error('Unterminated JSON string');
  };
  const value = () => {
    space();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; space(); const out = {}; const keys = new Set();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        space(); if (text[i] !== '"') throw new Error('Expected JSON key');
        const key = string();
        if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
        keys.add(key); space(); if (text[i++] !== ':') throw new Error('Expected colon');
        Object.defineProperty(out, key, { value: value(), enumerable: true });
        space(); const end = text[i++]; if (end === '}') return out;
        if (end !== ',') throw new Error('Expected object delimiter');
      }
    }
    if (text[i] === '[') {
      i++; space(); const out = [];
      if (text[i] === ']') { i++; return out; }
      for (;;) { out.push(value()); space(); const end = text[i++]; if (end === ']') return out;
        if (end !== ',') throw new Error('Expected array delimiter'); }
    }
    const token = text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error('Invalid JSON value');
    i += token.length; return JSON.parse(token);
  };
  const result = value(); space(); if (i !== text.length) throw new Error('Trailing JSON input');
  canonicalJson(result); return result;
}

export function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error(`Invalid ${label} fields`);
  return value;
}
export function matches(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
export const SHA = /^[a-f0-9]{40}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export function integer(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}`);
  return value;
}
