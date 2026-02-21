# napa-multi-module

Monorepo para levantar entornos locales (profiles) y operar seguridad/devops via `api-devops` + `shell-devops`.

## Quick start (root)

```bash
npm run dev-shell:profiles
npm run dev-shell:generate -- metro
npm run dev-shell:up -- metro
```

## DevOps quick reference

### `nd security` (tabla rapida)

| Comando | Uso |
| --- | --- |
| `nd security who-can --api <api> --method <METHOD> --path <PATH> [--profile <profile>]` | Quienes pueden acceder a un endpoint |
| `nd security who-can [--api <api>] [--method <METHOD>] [--path <PATH>] [--profile <profile>]` | Modo browse (arbol de cobertura) |
| `nd security call-map generate [--profile <profile>]` | Mapa de dependencias entre APIs (codigo/OpenAPI) |
| `nd security can-user <identifier> [--api <api>] [--method <METHOD>] [--path <PATH>] [--profile <profile>]` | Evalua acceso efectivo de un usuario |
| `nd security can-role <role> [--api <api>] [--method <METHOD>] [--path <PATH>] [--profile <profile>]` | Evalua acceso efectivo de un rol |
| `nd security user-effective <identifier> [--profile <profile>]` | Resumen de endpoints/features efectivos por usuario |
| `nd security role-effective <role> [--profile <profile>]` | Resumen de endpoints/features efectivos por rol |
| `nd security coverage [--api <api>] [--method <METHOD>] [--path <PATH>] [--profile <profile>]` | Cobertura del security-map |
| `nd security coverage --api <api> --spec <openapi.yaml> [--profile <profile>]` | Diff coverage vs OpenAPI local |
| `nd security api-keys generate <identifier>` | Genera API key para un usuario |
| `nd security api-keys list [--user <identifier>]` | Lista API keys registradas en api-devops |
| `nd security api-keys inspect <keyId\|fingerprint\|secret>` | Inspecciona API key por referencia |
| `nd security roles list` | Lista roles |
| `nd security users list [pattern]` | Lista usuarios (filtro opcional) |
| `nd security features [pattern]` | Lista features (filtro opcional) |

## Documentacion completa

- Shell CLI: `repos/devops-module/shell-devops/README.md`
- API DevOps: `repos/devops-module/api-devops/README.md`

## Author

- Fabian Giordano <fabian@logieinc.com>
