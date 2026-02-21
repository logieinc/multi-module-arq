/**
 * Signature: Fabian Giordano <fabian@logieinc.com>
 */
import { spawnSync } from 'node:child_process';

import { failWith, generateProfile, listEnabledServices, listProfileNames, resolveWorkspaceRoot } from './generator.js';

interface CliOptions {
  profile: string;
  profileProvided: boolean;
  apply: boolean;
  workspaceRoot?: string;
  envOnly: boolean;
  dockerArgs: string[];
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function colorize(text: string, color: string): string {
  if (!process.stdout.isTTY) return text;
  return `${color}${text}${ANSI.reset}`;
}

function formatProfilesOutput(profiles: string[], defaultProfile: string): string[] {
  const lines: string[] = [];
  lines.push(colorize('Dev Shell Contexts', `${ANSI.bold}${ANSI.cyan}`));
  lines.push(colorize('------------------', ANSI.dim));

  if (profiles.length === 0) {
    lines.push(colorize('No profiles found in config/profiles/profile-*.yaml', ANSI.yellow));
    return lines;
  }

  lines.push(`${colorize(String(profiles.length), ANSI.green)} profile(s) available:`);
  for (const profile of profiles) {
    const isDefault = profile === defaultProfile;
    const marker = isDefault ? colorize('●', ANSI.green) : colorize('○', ANSI.dim);
    const defaultTag = isDefault ? colorize(' (default)', ANSI.green) : '';
    lines.push(`${marker} ${profile}${defaultTag}`);
  }

  lines.push(colorize('Use: npm run dev-shell:generate <profile>', ANSI.cyan));
  return lines;
}

function usage(): string {
  return [
    'Usage: tsx src/cli.ts <command> [profile] [options] [-- <docker compose args>]',
    '',
    'Commands:',
    '  generate      Render env/compose/nginx for a profile',
    '  prepare-env   Render only env files',
    '  up            Generate and run docker compose up -d',
    '  down          Generate (if needed) and run docker compose down',
    '  services      Print enabled non-database services',
    '  profiles      List available profile contexts',
    '',
    'Options:',
    '  [profile]               Positional profile shorthand (e.g. `generate metro`)',
    '  --profile <name>       Profile name (default: metro)',
    '  --workspace-root <dir> Optional workspace root override',
    '  --no-apply             Do not copy generated artifacts to runtime paths',
    '  --env-only             Same as prepare-env',
  ].join('\n');
}

function parseArgs(argv: string[]): { command: string; options: CliOptions } {
  const command = argv[0] || 'generate';
  const rest = argv.slice(1);

  const separatorIndex = rest.indexOf('--');
  const cliArgs = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);
  const dockerArgs = separatorIndex === -1 ? [] : rest.slice(separatorIndex + 1);

  const options: CliOptions = {
    profile: 'metro',
    profileProvided: false,
    apply: true,
    envOnly: false,
    dockerArgs,
  };
  let positionalProfileUsed = false;

  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];

    if (arg === '--profile') {
      const value = cliArgs[i + 1];
      if (!value) throw new Error('Missing value for --profile');
      options.profile = value;
      options.profileProvided = true;
      i += 1;
      continue;
    }

    if (arg === '--workspace-root') {
      const value = cliArgs[i + 1];
      if (!value) throw new Error('Missing value for --workspace-root');
      options.workspaceRoot = value;
      i += 1;
      continue;
    }

    if (arg === '--no-apply') {
      options.apply = false;
      continue;
    }

    if (arg === '--env-only') {
      options.envOnly = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }

    // Convenience: allow positional profile (e.g. `generate metro`) in addition
    // to the explicit `--profile metro` form.
    if (!arg.startsWith('-') && !positionalProfileUsed) {
      options.profile = arg;
      options.profileProvided = true;
      positionalProfileUsed = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { command, options };
}

function runDockerCompose(workspaceRoot: string, stackEnvFile: string, composeFile: string, args: string[]): number {
  const docker = spawnSync(
    'docker',
    ['compose', '--project-directory', workspaceRoot, '--env-file', stackEnvFile, '-f', composeFile, ...args],
    {
      cwd: workspaceRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  return docker.status ?? 1;
}

function printGenerateSummary(args: {
  profile: string;
  stackEnv: string;
  generatedDir: string;
  stackEnvFile: string;
  composeFile: string;
  nginxFile: string;
  apply: boolean;
  envOnly: boolean;
  generatedAutoKeys?: string[];
  autoSecretsFile?: string;
}): void {
  console.log(
    `[dev-shell] Rendered profile=${args.profile} stack_env=${args.stackEnv}` +
    `${args.envOnly ? ' (env-only)' : ''}`,
  );
  console.log(`[dev-shell] stack env: ${args.stackEnvFile}`);
  console.log(`[dev-shell] services env: ${args.generatedDir}/services`);
  if (!args.envOnly) {
    console.log(`[dev-shell] compose: ${args.composeFile}`);
    console.log(`[dev-shell] nginx: ${args.nginxFile}`);
  }
  if (args.apply) {
    console.log('[dev-shell] applied env files to service repos');
  }
  if (Array.isArray(args.generatedAutoKeys) && args.generatedAutoKeys.length > 0 && args.autoSecretsFile) {
    console.log(
      `[dev-shell] auto-generated keys: ${args.generatedAutoKeys.join(', ')} (stored in ${args.autoSecretsFile})`,
    );
  }
}

function main(): void {
  const { command, options } = parseArgs(process.argv.slice(2));
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);

  if (command !== 'profiles' && !options.profileProvided) {
    const profiles = listProfileNames(workspaceRoot);
    const profileList = profiles.length > 0 ? profiles.join(', ') : '(none)';
    console.log(`[dev-shell] No profile provided; using default profile: ${options.profile}`);
    console.log(`[dev-shell] Available profiles: ${profileList}`);
    console.log('[dev-shell] List profiles: npm run dev-shell:profiles');
  }

  if (command === 'profiles') {
    const profiles = listProfileNames(workspaceRoot);
    const lines = formatProfilesOutput(profiles, options.profile);
    for (const line of lines) {
      console.log(line);
    }
    return;
  }

  if (command === 'services') {
    const services = listEnabledServices(options.profile, workspaceRoot);
    for (const service of services) {
      console.log(service);
    }
    return;
  }

  if (command === 'prepare-env') {
    const generated = generateProfile({
      profile: options.profile,
      workspaceRoot,
      apply: options.apply,
      envOnly: true,
    });
    printGenerateSummary({
      ...generated,
      apply: options.apply,
      envOnly: true,
    });
    return;
  }

  if (command === 'generate') {
    const generated = generateProfile({
      profile: options.profile,
      workspaceRoot,
      apply: options.apply,
      envOnly: options.envOnly,
    });
    printGenerateSummary({
      ...generated,
      apply: options.apply,
      envOnly: options.envOnly,
    });
    return;
  }

  if (command === 'up') {
    const generated = generateProfile({
      profile: options.profile,
      workspaceRoot,
      apply: true,
      envOnly: false,
    });

    const args = options.dockerArgs.length > 0 ? options.dockerArgs : ['up', '-d'];
    const status = runDockerCompose(workspaceRoot, generated.stackEnvFile, generated.composeFile, args);
    process.exit(status);
  }

  if (command === 'down') {
    const generated = generateProfile({
      profile: options.profile,
      workspaceRoot,
      apply: true,
      envOnly: false,
    });

    const args = options.dockerArgs.length > 0 ? options.dockerArgs : ['down'];
    const status = runDockerCompose(workspaceRoot, generated.stackEnvFile, generated.composeFile, args);
    process.exit(status);
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  failWith(error);
}
