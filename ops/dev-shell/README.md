# Dev Shell (TypeScript)

Automatización del entorno multimódulo usando un **perfil YAML** como única fuente de configuración.

## Estructura

- `config/profiles/profile-<profile>.yaml`: fuente de verdad del perfil (servicios, puertos, comandos, DBs, flags).
- `config/profiles/templates/profile-template.yaml`: plantilla base para crear nuevos perfiles.
- `common_env` en `profile-<profile>.yaml`: variables compartidas del perfil.
- `services.<service>.env` en `profile-<profile>.yaml`: overrides por servicio.
- `temp/nginx/`: snippets opcionales por servicio (`<service>-nginx.conf`) o por perfil en `temp/nginx/<profile>/`.
- `ops/dev-shell/src/`: CLI TypeScript (`generate`, `prepare-env`, `up`, `down`, `services`, `profiles`).
- `.generated/dev-shell/<profile>/`: artefactos generados (`stack.env`, `docker-compose.yaml`, `nginx.conf`, `services/*.env`).

## Nuevo Perfil

```bash
cp config/profiles/templates/profile-template.yaml config/profiles/profile-mi-contexto.yaml
```

Luego edita:
- `profile` y `stack_env`
- `common_env` (DB/secretos/base URLs)
- `services.*` habilitados, puertos y comandos

## Convención de merge de variables

Precedencia (de menor a mayor):
1. `common_env` del `profile-<profile>.yaml`
2. `services.<service>.env` del `profile-<profile>.yaml`
3. Variables del shell (`process.env`) para interpolación `${VAR}` / `${VAR:-default}`

## Comandos

Desde la raíz del workspace:

```bash
# Generar env + compose + nginx
./ops/dev-shell/bin/render.sh metro

# Generar solo env de servicios
./ops/dev-shell/bin/prepare-env.sh metro

# Levantar stack (default: up -d)
./ops/dev-shell/bin/dev.sh metro

# Ejecutar cualquier comando docker compose
./ops/dev-shell/bin/dev.sh metro down
./ops/dev-shell/bin/dev.sh metro ps

# Instalar dependencias dentro de contenedores habilitados
./ops/dev-shell/bin/bootstrap-deps.sh metro
```

## Salidas generadas

- `.generated/dev-shell/metro/stack.env`
- `.generated/dev-shell/metro/docker-compose.yaml`
- `.generated/dev-shell/metro/nginx.conf`
- `.generated/dev-shell/metro/services/<service>.env`

Además, en modo aplicado:
- Copia `.env.<stack_env>` a `repos/<service>/.env.<stack_env>`
- Actualiza `config/nginx/default.conf`
- Si existe snippet en `temp/nginx`, lo usa para ese servicio; si no, genera `location` automático.
- El snippet puede ser solo `location ... {}` o un `nginx.conf` más grande: se extraen automáticamente los bloques `location`.
- Puedes definir `debug_port` por servicio en el profile para mapear el puerto `9229` de cada contenedor.

## Nota de migración

Se retiró la capa Ruby (`config-utils.rb` / `prune-compose.rb`), el perfil legacy en `ops/dev-shell/env/`,
y la compatibilidad basada en archivos `.env` de configuración de perfil.
Ahora la configuración vive en `config/profiles/`.

`default.conf.template` sigue siendo requerido como base del render de nginx.
