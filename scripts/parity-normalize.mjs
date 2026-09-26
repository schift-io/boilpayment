import { readFileSync } from 'node:fs';

// This is representation comparison, not behavioral coverage. Preserve quoted values.
const source = readFileSync(0, 'utf8').replace(
  /[A-Za-z_][A-Za-z0-9_]*\(((?:[A-Za-z_][A-Za-z0-9_]*=)[^()]*)\)/g,
  (_match, fields) => '{' + fields.replace(/([A-Za-z_][A-Za-z0-9_]*)=/g, '$1:') + '}');
const snake = (value) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
let result = '';
let cursor = 0;
const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const normalizeDate = (date) => /\.\d{3}\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/.test(date)
  ? date : new Date(date).toISOString();
const outside = (text) => text
  .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
  .replace(/\bdid not raise\b/g, 'did not throw')
  .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (word, _group, offset) =>
    /:\s*$/.test(text.slice(0, offset)) && !/^=/.test(text.slice(offset + word.length)) ? word : snake(word))
  .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, normalizeDate);
for (const match of source.matchAll(tokens)) {
  result += outside(source.slice(cursor, match.index));
  const token = match[0];
  const end = match.index + token.length;
  if (/^\s*:/.test(source.slice(end))) {
    result += snake(token.slice(1, -1));
  } else {
    result += token.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
        normalizeDate);
  }
  cursor = end;
}
result += outside(source.slice(cursor));
// Layout whitespace is cosmetic; quoted strings retain every space.
result = result.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\s+/g, (part) =>
  part.startsWith('"') || part.startsWith("'") ? part : '');
// Sort object fields without parsing numbers or changing any value. Arrays retain order.
const frames = [{ open: '', parts: [], current: '' }];
for (const token of result.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}\[\],]|[^"'{}\[\],]+/g) ?? []) {
  const frame = frames.at(-1);
  if (token === '{' || token === '[') {
    frames.push({ open: token, parts: [], current: '' });
  } else if ((token === '}' && frame.open === '{') || (token === ']' && frame.open === '[')) {
    const parts = [...frame.parts, frame.current];
    if (frame.open === '{' && parts.every((part) => /^[a-z_][a-z0-9_]*:/.test(part))) {
      parts.sort((a, b) => a.slice(0, a.indexOf(':')).localeCompare(b.slice(0, b.indexOf(':'))));
    }
    frames.pop();
    frames.at(-1).current += frame.open + parts.join(',') + token;
  } else if (token === ',' && frame.open) {
    frame.parts.push(frame.current);
    frame.current = '';
  } else {
    frame.current += token;
  }
}
if (frames.length !== 1) throw new Error('Unbalanced structured parity output');
process.stdout.write(frames[0].current);
