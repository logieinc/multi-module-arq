import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import {
  DbConfig,
  GenerateOptions,
  GenerateResult,
  NginxRoute,
  ProfileConfig,
  ServiceConfig,
} from './types.js';
import {
  dbPrefix,
  ensureDir,
  findWorkspaceRoot,
  formatError,
  getDbKey,
  interpolate,
  interpolateRecord,
  isDatabaseService,
  normalizeServiceToken,
  readText,
  serializeEnv,
  toBoolean,
  writeText,
} from './utils.js';

const SERVICE_DB_MAP: Record<string, string> = {
  authorizer: 'security',
  'api-security': 'security',
  'api-auth': 'auth',
  'api-wallet': 'wallet',
};

interface RuntimeConfig {
  workspaceRoot: string;
  profileName: string;
  profilePath: string;
  profile: ProfileConfig;
  stackEnv: string;
  sourceContext: Record<string, string>;
  generatedContext: Record<string, string>;
  commonEnv: Record<string, string>;
  dbConfigs: Map<string, DbConfig>;
  enabledServices: string[];
}

interface ResolvedNginxRoute {
  path: string;
  service: string;
  stripPrefix: boolean;
}

function generatedProfileDir(workspaceRoot: string, profileName: string): string {
  return path.join(workspaceRoot, '.generated', 'dev-shell', profileName);
}

function resolveProfilePath(workspaceRoot: string, profileName: string): string {
  const preferred = path.join(workspaceRoot, 'config', 'profiles', `profile-${profileName}.yaml`);
  if (fs.existsSync(preferred)) {
    return preferred;
  }

  throw new Error(`Profile not found: ${preferred}`);
}

function toStringMap(env: NodeJS.ProcessEnv): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    output[key] = value;
  }
  return output;
}

function loadProfileConfig(workspaceRoot: string, profileName: string): { profilePath: string; profile: ProfileConfig } {
  const profilePath = resolveProfilePath(workspaceRoot, profileName);
  const raw = readText(profilePath);
  const parsed = (YAML.parse(raw) ?? {}) as ProfileConfig;

  return { profilePath, profile: parsed };
}

function buildRuntimeConfig(profileName: string, workspaceRootInput?: string): RuntimeConfig {
  const startDir = workspaceRootInput ? path.resolve(workspaceRootInput) : process.cwd();
  const workspaceRoot = findWorkspaceRoot(startDir);
  const { profilePath, profile } = loadProfileConfig(workspaceRoot, profileName);

  const stackEnv = String(profile.stack_env || profile.profile || profileName);

  const sourceContext = toStringMap(process.env);
  const generatedContext: Record<string, string> = {
    STACK_ENV: stackEnv,
    WORKSPACE_ROOT: String(profile.workspace_root || workspaceRoot),
  };

  if (profile.nginx?.port !== undefined) {
    generatedContext.NGINX_PORT = String(profile.nginx.port);
  }

  const contextForInterpolation = () => ({ ...sourceContext, ...generatedContext });

  const vars = profile.vars ?? {};
  for (const [key, value] of Object.entries(vars)) {
    generatedContext[key] = interpolate(String(value), contextForInterpolation());
  }

  const commonEnv: Record<string, string> = {};
  const profileCommonEnv = profile.common_env ?? {};
  for (const [key, value] of Object.entries(profileCommonEnv)) {
    if (value === undefined || value === null) {
      continue;
    }

    const resolvedValue = interpolate(String(value), {
      ...contextForInterpolation(),
      ...commonEnv,
    });
    commonEnv[key] = resolvedValue;
    generatedContext[key] = resolvedValue;
  }

  const services = profile.services ?? {};
  const dbConfigs = new Map<string, DbConfig>();
  const enabledServices: string[] = [];

  for (const [serviceName, service] of Object.entries(services)) {
    const serviceConfig = (service ?? {}) as ServiceConfig;
    const serviceAsRecord = serviceConfig as unknown as Record<string, unknown>;

    if (isDatabaseService(serviceName, serviceAsRecord)) {
      const dbKey = getDbKey(serviceName, serviceAsRecord);
      const prefix = dbPrefix(dbKey);
      const useLocal = toBoolean(serviceConfig.use_local, false);
      const currentContext = contextForInterpolation();

      const host = serviceConfig.host
        ? interpolate(String(serviceConfig.host), currentContext)
        : useLocal
          ? `${dbKey}-postgresql`
          : undefined;

      const user = serviceConfig.user ? interpolate(String(serviceConfig.user), currentContext) : undefined;
      const password = serviceConfig.password ? interpolate(String(serviceConfig.password), currentContext) : undefined;
      const name = serviceConfig.name ? interpolate(String(serviceConfig.name), currentContext) : undefined;
      const port = serviceConfig.port !== undefined ? interpolate(String(serviceConfig.port), currentContext) : undefined;

      const dbConfig: DbConfig = {
        dbKey,
        prefix,
        useLocal,
        host,
        user,
        password,
        name,
        port,
      };

      dbConfigs.set(dbKey, dbConfig);

      generatedContext[`USE_LOCAL_${prefix}_DB`] = String(useLocal);
      if (host) generatedContext[`${prefix}_DB_HOST`] = host;
      if (user) generatedContext[`${prefix}_DB_USER`] = user;
      if (password) generatedContext[`${prefix}_DB_PASSWORD`] = password;
      if (name) generatedContext[`${prefix}_DB_NAME`] = name;
      if (port) generatedContext[`${prefix}_DB_PORT`] = port;
      continue;
    }

    const enabled = serviceConfig.enabled !== false;
    const serviceRepoPath = path.join(
      workspaceRoot,
      String(serviceConfig.repo || path.join('repos', serviceName)),
    );
    const repoExists = fs.existsSync(serviceRepoPath);
    const effectiveEnabled = enabled && repoExists;

    if (enabled && !repoExists) {
      console.warn(
        `[generate] Service ${serviceName} is enabled in profile but repo is missing: ${serviceRepoPath}. Skipping service.`,
      );
    }

    if (effectiveEnabled) {
      enabledServices.push(serviceName);
    }

    const token = normalizeServiceToken(serviceName);
    const resolvedServicePort = serviceConfig.port !== undefined
      ? interpolate(String(serviceConfig.port), contextForInterpolation())
      : undefined;

    const resolvedServiceDebugPort = serviceConfig.debug_port !== undefined
      ? interpolate(String(serviceConfig.debug_port), contextForInterpolation())
      : (resolvedServicePort && /^\d+$/.test(resolvedServicePort))
        ? String(Number(resolvedServicePort) + 2)
        : undefined;

    if (serviceConfig.port !== undefined && effectiveEnabled) {
      generatedContext[`${token}_PORT`] = resolvedServicePort || '';
    }
    if (resolvedServiceDebugPort && effectiveEnabled) {
      generatedContext[`${token}_DEBUG_PORT`] = resolvedServiceDebugPort;
    }
    if (serviceConfig.command !== undefined && effectiveEnabled) {
      generatedContext[`${token}_CMD`] = interpolate(String(serviceConfig.command), contextForInterpolation());
    }
  }

  return {
    workspaceRoot,
    profileName,
    profilePath,
    profile,
    stackEnv,
    sourceContext,
    generatedContext,
    commonEnv,
    dbConfigs,
    enabledServices,
  };
}

function ensureDatabaseUrls(serviceName: string, envMap: Record<string, string>, runtime: RuntimeConfig): void {
  const dbKey = SERVICE_DB_MAP[serviceName];
  if (!dbKey) {
    return;
  }

  const db = runtime.dbConfigs.get(dbKey);
  if (!db) {
    return;
  }

  const prefix = db.prefix;
  const host = envMap[`${prefix}_DB_HOST`] || db.host;
  const user = envMap[`${prefix}_DB_USER`] || db.user;
  const password = envMap[`${prefix}_DB_PASSWORD`] || db.password;
  const name = envMap[`${prefix}_DB_NAME`] || db.name;
  const port = envMap[`${prefix}_DB_PORT`] || db.port || '5432';

  if (!user || !password || !host || !name) {
    return;
  }

  const dbUrl = `postgresql://${user}:${password}@${host}:${port}/${name}?schema=public`;

  if (!envMap.DATABASE_URL) {
    envMap.DATABASE_URL = dbUrl;
  }

  if (!envMap.REPORTS_DATABASE_URL && serviceName !== 'authorizer') {
    envMap.REPORTS_DATABASE_URL = dbUrl;
  }
}

function buildServiceEnv(serviceName: string, serviceConfig: ServiceConfig, runtime: RuntimeConfig): Record<string, string> {
  const interpolationBase = {
    ...runtime.sourceContext,
    ...runtime.generatedContext,
  };

  const envMap: Record<string, string> = { ...runtime.commonEnv };

  const profileEnv = serviceConfig.env ?? {};
  const resolvedProfileEnv = interpolateRecord(
    profileEnv,
    {
      ...interpolationBase,
      ...envMap,
    },
  );
  Object.assign(envMap, resolvedProfileEnv);

  if (serviceConfig.port !== undefined && !envMap.API_PORT) {
    envMap.API_PORT = interpolate(String(serviceConfig.port), {
      ...interpolationBase,
      ...envMap,
    });
  }

  if (!envMap.LOG_LEVEL && runtime.generatedContext.LOG_LEVEL) {
    envMap.LOG_LEVEL = runtime.generatedContext.LOG_LEVEL;
  }

  ensureDatabaseUrls(serviceName, envMap, runtime);

  return envMap;
}

function pruneCompose(composeSource: Record<string, unknown>, servicesToRemove: Set<string>): Record<string, unknown> {
  const compose = JSON.parse(JSON.stringify(composeSource)) as Record<string, unknown>;
  const services = (compose.services ?? {}) as Record<string, Record<string, unknown>>;

  for (const serviceName of servicesToRemove) {
    delete services[serviceName];
  }

  for (const serviceConfig of Object.values(services)) {
    if (!serviceConfig || typeof serviceConfig !== 'object') {
      continue;
    }

    const dependsOn = serviceConfig.depends_on;
    if (Array.isArray(dependsOn)) {
      serviceConfig.depends_on = dependsOn.filter((dependency) => !servicesToRemove.has(String(dependency)));
    } else if (dependsOn && typeof dependsOn === 'object') {
      const mutable = dependsOn as Record<string, unknown>;
      for (const serviceName of servicesToRemove) {
        delete mutable[serviceName];
      }
      serviceConfig.depends_on = mutable;
    }
  }

  compose.services = services;
  return compose;
}

function ensureComposeDebugPorts(compose: Record<string, unknown>, runtime: RuntimeConfig): void {
  const services = (compose.services ?? {}) as Record<string, Record<string, unknown>>;

  for (const serviceName of runtime.enabledServices) {
    const serviceConfig = services[serviceName];
    if (!serviceConfig || typeof serviceConfig !== 'object') {
      continue;
    }

    const rawPorts = serviceConfig.ports;
    const ports = Array.isArray(rawPorts) ? rawPorts.map((entry) => String(entry)) : [];
    const hasDebugPort = ports.some((entry) => entry.includes(':9229'));
    if (hasDebugPort) {
      serviceConfig.ports = ports;
      continue;
    }

    const debugPort = resolveServiceDebugPort(runtime, serviceName);
    if (!debugPort) {
      serviceConfig.ports = ports;
      continue;
    }

    ports.push(`${debugPort}:9229`);
    serviceConfig.ports = ports;
  }

  compose.services = services;
}

function normalizeRoutePath(input: string): string {
  let value = String(input || '').trim();
  if (!value) value = '/';
  if (!value.startsWith('/')) value = `/${value}`;
  if (!value.endsWith('/')) value = `${value}/`;
  return value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRewriteRegex(pathValue: string): string {
  const trimmed = pathValue.endsWith('/') ? pathValue.slice(0, -1) : pathValue;
  const normalized = trimmed || '/';
  return `^${escapeRegex(normalized)}/?(.*)$`;
}

function countBraces(line: string): number {
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  return opens - closes;
}

function formatNginxLocationBlock(raw: string, baseIndentLevel = 1): string {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let depth = 0;
  const output: string[] = [];

  for (const line of lines) {
    const delta = countBraces(line);
    const startsWithClose = line.startsWith('}');
    const currentDepth = Math.max(depth - (startsWithClose ? 1 : 0), 0);
    const indent = '  '.repeat(baseIndentLevel + currentDepth);
    output.push(`${indent}${line}`);
    depth = Math.max(depth + delta, 0);
  }

  return output.join('\n');
}

function extractLocationHeader(block: string): string | null {
  const match = block.match(/^\s*location\s+([^\n{]+)\{/m);
  if (!match) {
    return null;
  }

  const locationTarget = match[1].replace(/\s+/g, ' ').trim();
  return `location ${locationTarget} {`;
}

function extractLocationBlocks(raw: string): string[] {
  const lines = raw.split('\n');
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!/^\s*location\b/.test(line)) {
      index += 1;
      continue;
    }

    const blockLines: string[] = [line];
    let depth = countBraces(line);
    index += 1;

    while (index < lines.length && depth > 0) {
      const current = lines[index];
      blockLines.push(current);
      depth += countBraces(current);
      index += 1;
    }

    blocks.push(blockLines.join('\n').trim());
  }

  return blocks.filter((block) => block.length > 0);
}

function resolveServicePort(runtime: RuntimeConfig, serviceName: string): string {
  const token = normalizeServiceToken(serviceName);
  const fromContext = runtime.generatedContext[`${token}_PORT`];
  if (fromContext) {
    return fromContext;
  }

  const service = runtime.profile.services?.[serviceName];
  if (service?.port !== undefined) {
    return interpolate(String(service.port), {
      ...runtime.sourceContext,
      ...runtime.generatedContext,
    });
  }

  return '80';
}

function resolveServiceDebugPort(runtime: RuntimeConfig, serviceName: string): string | undefined {
  const token = normalizeServiceToken(serviceName);
  const fromContext = runtime.generatedContext[`${token}_DEBUG_PORT`];
  if (fromContext) {
    return fromContext;
  }

  const service = runtime.profile.services?.[serviceName];
  if (service?.debug_port !== undefined) {
    return interpolate(String(service.debug_port), {
      ...runtime.sourceContext,
      ...runtime.generatedContext,
    });
  }

  const servicePort = resolveServicePort(runtime, serviceName);
  if (/^\d+$/.test(servicePort)) {
    return String(Number(servicePort) + 2);
  }

  return undefined;
}

function resolveNginxRoutes(runtime: RuntimeConfig): ResolvedNginxRoute[] {
  const configured = runtime.profile.nginx?.routes ?? [];
  const configuredRoutes: ResolvedNginxRoute[] = [];

  for (const route of configured) {
    const routeConfig = (route ?? {}) as NginxRoute;
    if (!routeConfig.service || !routeConfig.path) {
      continue;
    }

    if (!runtime.enabledServices.includes(routeConfig.service)) {
      continue;
    }

    configuredRoutes.push({
      service: routeConfig.service,
      path: normalizeRoutePath(routeConfig.path),
      stripPrefix: routeConfig.strip_prefix !== false,
    });
  }

  const defaultRoutes: ResolvedNginxRoute[] = runtime.enabledServices.flatMap((serviceName) => {
    const routes: ResolvedNginxRoute[] = [{
      service: serviceName,
      path: normalizeRoutePath(serviceName),
      stripPrefix: true,
    }];

    if (serviceName === 'api-auth') {
      routes.push({
        service: serviceName,
        path: '/login/',
        stripPrefix: false,
      });
      routes.push({
        service: serviceName,
        path: '/user/',
        stripPrefix: false,
      });
    }

    return routes;
  });

  const unique = new Map<string, ResolvedNginxRoute>();
  for (const route of defaultRoutes) {
    unique.set(`${route.service}::${route.path}`, route);
  }
  for (const route of configuredRoutes) {
    unique.set(`${route.service}::${route.path}`, route);
  }

  return Array.from(unique.values());
}

function resolveNginxSnippetPath(runtime: RuntimeConfig, serviceName: string): string | null {
  const candidates = [
    path.join(runtime.workspaceRoot, 'temp', 'nginx', runtime.profileName, `${serviceName}.conf`),
    path.join(runtime.workspaceRoot, 'temp', 'nginx', runtime.profileName, `${serviceName}-nginx.conf`),
    path.join(runtime.workspaceRoot, 'temp', 'nginx', `${serviceName}.conf`),
    path.join(runtime.workspaceRoot, 'temp', 'nginx', `${serviceName}-nginx.conf`),
    path.join(runtime.workspaceRoot, 'temp', `${serviceName}-nginx.conf`),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = readText(filePath).trim();
    if (!content) {
      continue;
    }
    return filePath;
  }

  return null;
}

function buildDefaultNginxLocationBlock(route: ResolvedNginxRoute, runtime: RuntimeConfig): string {
  const port = resolveServicePort(runtime, route.service);
  const rewriteLine = route.stripPrefix ? `rewrite ${buildRewriteRegex(route.path)} /$1 break;` : '';

  if (route.service === 'authorizer') {
    const lines = [
      `location ${route.path} {`,
      'proxy_pass_request_headers on;',
      'proxy_set_header Host             $host;',
      'proxy_set_header X-Real-IP        $remote_addr;',
      'proxy_set_header X-Real-URI       $request_uri;',
      'proxy_set_header X-Real-Method    $request_method;',
      'proxy_set_header X-Real-Host      $host;',
      'proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;',
      'proxy_set_header X-Forwarded-Proto $forwarded_proto;',
      rewriteLine,
      `proxy_pass http://${route.service}:${port};`,
      '}',
    ].filter((line) => line !== '');

    return formatNginxLocationBlock(lines.join('\n'));
  }

  const genericLines = [
    `location ${route.path} {`,
    // Keep the original host to avoid Vite rejecting proxied requests with upstream hostnames.
    'proxy_set_header Host             $host;',
    'proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;',
    'proxy_set_header X-Forwarded-Proto $forwarded_proto;',
    rewriteLine,
    `proxy_pass http://${route.service}:${port};`,
    '}',
  ].filter((line) => line !== '');

  return formatNginxLocationBlock(genericLines.join('\n'));
}

function normalizeSnippetContent(raw: string, route: ResolvedNginxRoute, runtime: RuntimeConfig): string {
  const extractedBlocks = extractLocationBlocks(raw);
  const source = extractedBlocks.length > 0 ? extractedBlocks.join('\n\n') : raw.trim();
  const servicePort = resolveServicePort(runtime, route.service);
  const authorizerPort = resolveServicePort(runtime, 'authorizer');

  return source
    .replace(
      /proxy_pass\s+http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?;/g,
      `proxy_pass http://${route.service}:${servicePort};`,
    )
    .replace(
      /proxy_pass\s+http:\/\/authorizer[^;]*;/g,
      `proxy_pass http://authorizer:${authorizerPort};`,
    );
}

function buildNginxServiceLocations(runtime: RuntimeConfig): string {
  const routes = resolveNginxRoutes(runtime);
  const blocks: string[] = [];
  const handledServiceSnippets = new Set<string>();
  const seenLocationHeaders = new Set<string>();

  const pushBlock = (block: string): void => {
    const formatted = formatNginxLocationBlock(block);
    if (!formatted.trim()) {
      return;
    }

    const header = extractLocationHeader(formatted);
    if (header) {
      if (seenLocationHeaders.has(header)) {
        return;
      }
      seenLocationHeaders.add(header);
    }

    blocks.push(formatted);
  };

  for (const route of routes) {
    const snippetPath = resolveNginxSnippetPath(runtime, route.service);

    if (!snippetPath) {
      pushBlock(buildDefaultNginxLocationBlock(route, runtime));
      continue;
    }

    if (!handledServiceSnippets.has(route.service)) {
      handledServiceSnippets.add(route.service);
      const raw = readText(snippetPath).trim();
      const normalized = normalizeSnippetContent(raw, route, runtime);
      const interpolated = interpolate(normalized, {
        ...runtime.sourceContext,
        ...runtime.generatedContext,
        SERVICE_NAME: route.service,
        SERVICE_PORT: resolveServicePort(runtime, route.service),
        SERVICE_PATH: route.path,
      });
      const extracted = extractLocationBlocks(interpolated);
      if (extracted.length > 0) {
        for (const block of extracted) {
          pushBlock(block);
        }
      } else {
        pushBlock(interpolated);
      }
    }

    const serviceDefaultPath = normalizeRoutePath(route.service);
    if (route.path !== serviceDefaultPath) {
      pushBlock(buildDefaultNginxLocationBlock(route, runtime));
    }
  }

  return blocks.join('\n\n');
}

function writeGeneratedEnvs(runtime: RuntimeConfig, apply: boolean): void {
  const generatedServicesDir = path.join(generatedProfileDir(runtime.workspaceRoot, runtime.profileName), 'services');
  ensureDir(generatedServicesDir);

  const enabledSet = new Set(runtime.enabledServices);
  const existingGenerated = fs
    .readdirSync(generatedServicesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.env'))
    .map((entry) => entry.name);

  for (const fileName of existingGenerated) {
    const serviceName = fileName.replace(/\.env$/, '');
    if (enabledSet.has(serviceName)) {
      continue;
    }
    fs.unlinkSync(path.join(generatedServicesDir, fileName));
  }

  const services = runtime.profile.services ?? {};
  for (const serviceName of runtime.enabledServices) {
    const serviceConfig = services[serviceName] as ServiceConfig;
    const envMap = buildServiceEnv(serviceName, serviceConfig, runtime);
    const serialized = serializeEnv(envMap);

    const generatedPath = path.join(generatedServicesDir, `${serviceName}.env`);
    writeText(generatedPath, serialized);

    if (!apply) {
      continue;
    }

    const targetPath = path.join(runtime.workspaceRoot, 'repos', serviceName, `.env.${runtime.stackEnv}`);
    if (!fs.existsSync(path.dirname(targetPath))) {
      console.warn(`[generate] Skipping ${serviceName}: repo folder not found (${path.dirname(targetPath)})`);
      continue;
    }

    writeText(targetPath, serialized);
  }
}

function writeGeneratedStackEnv(runtime: RuntimeConfig): string {
  const stackEnvPath = path.join(generatedProfileDir(runtime.workspaceRoot, runtime.profileName), 'stack.env');
  writeText(stackEnvPath, serializeEnv(runtime.generatedContext));
  return stackEnvPath;
}

function writeGeneratedCompose(runtime: RuntimeConfig, stackEnvPath: string): string {
  const templateCandidates = [
    path.join(runtime.workspaceRoot, 'docker-compose.yaml'),
    path.join(runtime.workspaceRoot, '.generated', 'dev-shell', runtime.profileName, 'docker-compose.yaml'),
    path.join(runtime.workspaceRoot, 'ops', 'generated', runtime.profileName, 'docker-compose.yaml'),
  ];

  let templatePath = '';
  let template = '';
  for (const candidate of templateCandidates) {
    const content = readText(candidate);
    if (!content.trim()) {
      continue;
    }
    templatePath = candidate;
    template = content;
    break;
  }

  if (!templatePath) {
    throw new Error(
      `Compose template not found. Checked:\n- ${templateCandidates.join('\n- ')}`,
    );
  }

  if (templatePath !== templateCandidates[0]) {
    console.warn(`[generate] Using fallback compose template: ${templatePath}`);
  }

  const interpolationContext = {
    ...runtime.sourceContext,
    ...runtime.generatedContext,
  };
  const rendered = interpolate(template, interpolationContext);
  const parsed = (YAML.parse(rendered) ?? {}) as Record<string, unknown>;

  const disabledServices = new Set<string>();
  const services = runtime.profile.services ?? {};

  for (const [serviceName, serviceConfigRaw] of Object.entries(services)) {
    const serviceConfig = (serviceConfigRaw ?? {}) as ServiceConfig;
    const asRecord = serviceConfig as unknown as Record<string, unknown>;

    if (isDatabaseService(serviceName, asRecord)) {
      const dbKey = getDbKey(serviceName, asRecord);
      const db = runtime.dbConfigs.get(dbKey);
      if (!db || !db.useLocal) {
        disabledServices.add(`${dbKey}-postgresql`);
      }
      continue;
    }

    if (serviceConfig.enabled === false) {
      disabledServices.add(serviceName);
    }

    if (!runtime.enabledServices.includes(serviceName)) {
      disabledServices.add(serviceName);
    }
  }

  const pruned = pruneCompose(parsed, disabledServices);
  ensureComposeDebugPorts(pruned, runtime);
  const outputPath = path.join(generatedProfileDir(runtime.workspaceRoot, runtime.profileName), 'docker-compose.yaml');
  writeText(outputPath, YAML.stringify(pruned));

  void stackEnvPath;
  return outputPath;
}

function writeGeneratedNginx(runtime: RuntimeConfig, apply: boolean): string {
  const templatePath = path.join(runtime.workspaceRoot, 'config', 'nginx', 'default.conf.template');
  const template = readText(templatePath);
  if (!template.trim()) {
    throw new Error(`Nginx template not found or empty: ${templatePath}`);
  }

  const rendered = interpolate(template, {
    ...runtime.sourceContext,
    ...runtime.generatedContext,
    NGINX_SERVICE_LOCATIONS: buildNginxServiceLocations(runtime),
  });

  const generatedPath = path.join(generatedProfileDir(runtime.workspaceRoot, runtime.profileName), 'nginx.conf');
  writeText(generatedPath, rendered);

  if (apply) {
    const targetPath = path.join(runtime.workspaceRoot, 'config', 'nginx', 'default.conf');
    writeText(targetPath, rendered);
  }

  return generatedPath;
}

export function listEnabledServices(profileName: string, workspaceRoot?: string): string[] {
  const runtime = buildRuntimeConfig(profileName, workspaceRoot);
  return runtime.enabledServices;
}

export function listProfileNames(workspaceRoot?: string): string[] {
  const startDir = workspaceRoot ? path.resolve(workspaceRoot) : process.cwd();
  const root = findWorkspaceRoot(startDir);
  const profilesDir = path.join(root, 'config', 'profiles');
  if (!fs.existsSync(profilesDir)) {
    return [];
  }

  const discovered = fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name.match(/^profile-(.+)\.ya?ml$/i))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1])
    .filter((name) => name.length > 0);

  return Array.from(new Set(discovered)).sort((a, b) => a.localeCompare(b));
}

export function generateProfile(options: GenerateOptions): GenerateResult {
  const runtime = buildRuntimeConfig(options.profile, options.workspaceRoot);

  console.log(`[generate] profile=${runtime.profileName} stack_env=${runtime.stackEnv}`);
  console.log(`[generate] profile source: ${runtime.profilePath}`);

  writeGeneratedEnvs(runtime, options.apply);
  const stackEnvFile = writeGeneratedStackEnv(runtime);
  const composeFile = options.envOnly ? '' : writeGeneratedCompose(runtime, stackEnvFile);
  const nginxFile = options.envOnly ? '' : writeGeneratedNginx(runtime, options.apply);

  console.log(`[generate] stack env: ${stackEnvFile}`);
  if (!options.envOnly) {
    console.log(`[generate] compose: ${composeFile}`);
    console.log(`[generate] nginx: ${nginxFile}`);
  }

  return {
    profile: runtime.profileName,
    stackEnv: runtime.stackEnv,
    generatedDir: generatedProfileDir(runtime.workspaceRoot, runtime.profileName),
    stackEnvFile,
    composeFile,
    nginxFile,
    enabledServices: runtime.enabledServices,
  };
}

export function resolveWorkspaceRoot(input?: string): string {
  const startDir = input ? path.resolve(input) : process.cwd();
  return findWorkspaceRoot(startDir);
}

export function failWith(error: unknown): never {
  console.error(`[dev-shell] ${formatError(error)}`);
  process.exit(1);
}
