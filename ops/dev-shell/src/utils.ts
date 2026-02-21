import fs from 'node:fs';
import path from 'node:path';

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z0-9_]+)(:-([^}]*))?\}/g;

export function findWorkspaceRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    const composePath = path.join(current, 'docker-compose.yaml');
    if (fs.existsSync(composePath)) {
      return current;
    }

    // Fallback root markers for repos that keep compose templates elsewhere.
    const profilesDir = path.join(current, 'config', 'profiles');
    const devShellDir = path.join(current, 'ops', 'dev-shell');
    if (fs.existsSync(profilesDir) && fs.existsSync(devShellDir)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

export function ensureDir(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
}

export function readText(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function writeText(filePath: string, contents: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents);
}

export function interpolate(template: string, context: Record<string, string>): string {
  return template.replace(PLACEHOLDER_PATTERN, (_match, name: string, _withDefault: string, defaultValue: string) => {
    const value = context[name];
    if (value !== undefined && value !== '') {
      return value;
    }
    return defaultValue ?? '';
  });
}

export function interpolateRecord(input: Record<string, unknown>, context: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      continue;
    }

    const rawValue = String(value);
    output[key] = interpolate(rawValue, context);
  }

  return output;
}

export function normalizeServiceToken(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

export function isDatabaseService(serviceName: string, serviceConfig: Record<string, unknown>): boolean {
  const type = String(serviceConfig.type ?? serviceConfig.kind ?? '').toLowerCase();
  if (type === 'db' || type === 'database') {
    return true;
  }

  if (serviceConfig.db_key) {
    return true;
  }

  return /database|postgres|\bdb\b/i.test(serviceName);
}

export function getDbKey(serviceName: string, serviceConfig: Record<string, unknown>): string {
  const configured = serviceConfig.db_key;
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim().toLowerCase();
  }

  return serviceName
    .replace(/(^db-|-(db|database|postgres|postgresql)$)/gi, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
}

export function dbPrefix(dbKey: string): string {
  const normalized = dbKey.toLowerCase();
  if (normalized === 'security') return 'SECURITY';
  if (normalized === 'auth') return 'AUTH';
  if (normalized === 'wallet') return 'WALLET';
  return normalizeServiceToken(normalized);
}

export function toBoolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function serializeEnv(env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  const lines: string[] = [];

  for (const key of keys) {
    const value = env[key] ?? '';
    lines.push(`${key}=${value}`);
  }

  return `${lines.join('\n')}\n`;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return JSON.stringify(error);
}
