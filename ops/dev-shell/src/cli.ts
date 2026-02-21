import { spawnSync } from 'node:child_process';

import { failWith, generateProfile, listEnabledServices, listProfileNames, resolveWorkspaceRoot } from './generator.js';

interface CliOptions {
  profile: string;
  apply: boolean;
  workspaceRoot?: string;
  envOnly: boolean;
  dockerArgs: string[];
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

function main(): void {
  const { command, options } = parseArgs(process.argv.slice(2));
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);

  if (command === 'profiles') {
    const profiles = listProfileNames(workspaceRoot);
    for (const profile of profiles) {
      console.log(profile);
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
    generateProfile({
      profile: options.profile,
      workspaceRoot,
      apply: options.apply,
      envOnly: true,
    });
    return;
  }

  if (command === 'generate') {
    generateProfile({
      profile: options.profile,
      workspaceRoot,
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
