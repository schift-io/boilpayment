// Minimal argv parser. No dependency (ARCHITECTURE.md §6: "의존성 없음 원칙").
// Supports: `cmd pos1 pos2 --flag --key value --key=value`
export interface ParsedArgv {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export function csv(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
