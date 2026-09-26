// Minimal .env parser — no dependency (ARCHITECTURE.md §6 "의존성 없음 원칙", ARCHITECTURE.md
// "pnpm add 금지"). Supports KEY=VALUE, `export KEY=VALUE`, quoted values (single/double, with
// backslash escapes in double quotes), `#` comments (only when not inside quotes), and blank lines.
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      // Unquoted — strip a trailing inline comment (` # ...`), keep everything else as-is.
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads `.env` from `filePath` (if it exists) and merges it with `process.env`.
 * `process.env` wins for any key already set there (matches common dotenv convention —
 * shell/CI env should be able to override a committed .env without editing the file).
 */
export async function loadEnvFile(filePath: string): Promise<{ merged: Record<string, string | undefined>; fileVars: Record<string, string>; found: boolean }> {
  const { promises: fs } = await import('node:fs');
  let fileVars: Record<string, string> = {};
  let found = false;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    fileVars = parseEnvFile(content);
    found = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const merged: Record<string, string | undefined> = { ...fileVars };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && v !== '') merged[k] = v;
  }
  return { merged, fileVars, found };
}
