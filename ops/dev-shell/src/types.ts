export interface NginxRoute {
  path: string;
  service: string;
  strip_prefix?: boolean;
}

export interface NginxConfig {
  port?: number | string;
  routes?: NginxRoute[];
}

export interface ServiceConfig {
  enabled?: boolean;
  generate_env?: boolean;
  include_common_env?: boolean;
  env_output?: string;
  type?: string;
  kind?: string;
  db_key?: string;
  use_local?: boolean;
  host?: string;
  user?: string;
  password?: string;
  name?: string;
  port?: number | string;
  debug_port?: number | string;
  command?: string;
  repo?: string;
  env?: Record<string, unknown>;
}

export interface ProfileConfig {
  profile?: string;
  stack_env?: string;
  workspace_root?: string;
  merge_common_env_into_services?: boolean;
  auto_generate_common_env?: string[];
  vars?: Record<string, unknown>;
  common_env?: Record<string, unknown>;
  nginx?: NginxConfig;
  services?: Record<string, ServiceConfig>;
}

export interface DbConfig {
  dbKey: string;
  prefix: string;
  useLocal: boolean;
  host?: string;
  user?: string;
  password?: string;
  name?: string;
  port?: string;
}

export interface GenerateOptions {
  profile: string;
  workspaceRoot: string;
  apply: boolean;
  envOnly: boolean;
}

export interface GenerateResult {
  profile: string;
  stackEnv: string;
  generatedDir: string;
  stackEnvFile: string;
  composeFile: string;
  nginxFile: string;
  enabledServices: string[];
  generatedAutoKeys?: string[];
  autoSecretsFile?: string;
}
