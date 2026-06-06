# Guia para agentes

Este repo contiene un MCP local para UEFN: un servidor Node por stdio, un puente Python dentro del editor y scripts de instalacion/verificacion. El objetivo al modificarlo es mantener herramientas utiles, compactas y seguras sin frenar el flujo con confirmaciones redundantes.

## Estructura que no debes romper

- `src/server.mjs`: punto de entrada MCP. Registra resources y tools.
- `src/lib/tools.mjs`: definicion de tools, schemas Zod, compactacion de respuestas y manejo de errores.
- `src/lib/resource_store.mjs`: resources `uefn://...` para datos grandes, capturas, logs y resultados generados.
- `src/lib/project.mjs`: validacion, busqueda y lectura de proyectos/Verse.
- `src/lib/bridge_client.mjs`: cliente HTTP local hacia el puente UEFN.
- `uefn-plugin/Content/Python/uefn_mcp_bridge/__init__.py`: puente Python que corre dentro de UEFN.
- `bridge/uefn_bridge.py`: bootstrap de compatibilidad; no debe convertirse en la implementacion principal.
- `scripts/`: instalacion, desinstalacion, smoke tests y bootstrap.
- `test/`: pruebas Node con `node --test`.

Si agregas una capacidad, normalmente toca ambos lados:

1. Tool MCP en `src/lib/tools.mjs`.
2. Endpoint/funcion del puente en `uefn_mcp_bridge/__init__.py` si requiere UEFN.
3. Tests enfocados en `test/`.
4. README solo si cambia la interfaz publica.

## Principios MCP del proyecto

- Disena tools por intencion, no por boton ni por endpoint crudo.
- Mantener pocas tools fuertes es mejor que muchas tools pequenas que llenan contexto.
- Las respuestas por defecto deben ser pequenas, JSON estructurado y accionable.
- Para datos grandes, devuelve un `resourceUri` y un resumen inmediato.
- Usa el patron `buscar -> listar compacto -> leer recurso/detalle necesario`.
- Toda tool con listas debe aceptar limites razonables y devolver conteos/omitidos.
- Incluye `nextStep` cuando el agente pueda corregir o continuar.
- Los errores deben ser compactos y utiles, no tracebacks completos salvo en resources.

## Tokens y flujo

- No devuelvas escenas, logs, archivos o screenshots completos en la respuesta de una tool.
- Usa `ResourceStore.addJson`, `addText` o `addFile` para artefactos grandes.
- Compacta previews: muestra pocos actores, pocas propiedades y pocos componentes.
- Permite `detailLevel: "summary" | "detail"` o `fields` cuando aplique.
- Reutiliza IDs/resource URIs entre llamadas en lugar de reenviar contenido grande.
- Evita tools que obliguen al agente a hacer 10 llamadas para una accion comun; crea operaciones compuestas cuando sean naturales.

## Seguridad sin friccion innecesaria

No agregues prompts de "pedir permiso" dentro de las tools para acciones normales: Codex, Claude y otros hosts ya manejan aprobaciones. En su lugar, usa controles tecnicos:

- `dryRun` por defecto en escrituras delicadas.
- validacion estricta con Zod en Node y validacion defensiva en Python.
- rutas acotadas al proyecto/configuracion, nunca `readAnyFile` o `writeAnyFile` generico.
- timeouts en llamadas al puente y operaciones lentas.
- logs/resultados como resources para auditoria sin inflar contexto.
- operaciones destructivas o irreversibles deben tener una fase de plan/dry-run clara.

Ejemplos existentes a preservar:

- `uefn_update_actor` usa `dryRun: true` por defecto; solo aplica cambios si el caller manda `dryRun: false`.
- `uefn_run_python` siempre empieza con dry-run. Si no hay warnings, auto-ejecuta el mismo script. Si hay warnings, devuelve `dryRunId`; ejecutar exige ese ID y el mismo hash del script.
- `python_dry_run` advierte sobre imports/calls riesgosos; no reemplaces esto con confirmaciones verbosas.

## Reglas para nuevas tools

Una tool nueva debe tener:

- nombre claro con prefijo `uefn_`.
- descripcion corta que diga que devuelve compacto si aplica.
- `inputSchema` estricto con Zod, limites min/max y defaults en el handler.
- salida JSON estable con `ok`, datos compactos, `resourceUri` si hay detalle grande, `warnings` y `nextStep` cuando aplique.
- errores envueltos por el patron actual de `toolResult(errorPayload(error), true)`.
- tests que cubran schema, compactacion o comportamiento clave.

Evita:

- `runCommand`, `executeShell`, `readAnyFile`, `writeAnyFile`, `deleteAnything`.
- tools que solo envuelven una funcion interna sin aportar intencion.
- respuestas con archivos completos, logs enormes o blobs inline.
- cambios que dependan de rutas de una maquina especifica.

## Puente Python de UEFN

- Mantener el servidor local en `127.0.0.1`; no exponerlo publicamente.
- Las llamadas que tocan UEFN deben ejecutarse en el editor/main thread usando los patrones existentes.
- Devuelve diccionarios JSON-serializables; usa helpers de truncado/serializacion ya existentes.
- Para actor tools, conserva resolucion por `label`, `name`, `path` o `auto`, candidatos compactos y warnings cuando se editan editor properties.
- Al agregar endpoints, registra la funcion en el mapa de tools del puente y agrega un `nextStep` util para fallos comunes.

## Instalacion y configuracion

- `uefn-mcp.config.json` es local y machine-specific; no lo conviertas en fuente de verdad compartida.
- No hardcodees rutas como `C:\Users\...` dentro del codigo o docs generales.
- Los scripts de instalacion/desinstalacion deben tocar solo archivos validados y gestionados por este MCP.
- Preserva bloques gestionados y codigo del usuario en `init_unreal.py`.
- Mantener `stdio` para el servidor MCP; el HTTP local es solo para el puente UEFN.

## Verificacion antes de terminar

Usa el menor set suficiente segun el cambio:

- Cambio JS rapido: `node --check <archivo>` y test enfocado.
- Cambio Python del plugin: `python -m py_compile ./uefn-plugin/Content/Python/uefn_mcp_bridge/__init__.py`.
- Cambio de tools/resources: `pnpm test` o tests enfocados en `test/*.test.mjs`.
- Cambio amplio o release-ready: `pnpm check`.
- Smoke MCP: `pnpm mcp:smoke`.

Si no puedes correr una verificacion porque UEFN no esta abierto o el puente no esta activo, dilo claramente y deja el siguiente paso exacto.

## Estilo de cambios

- Sigue los patrones actuales antes de crear abstracciones nuevas.
- Manten ediciones pequenas y enfocadas.
- No refactorices instaladores, puente y tools al mismo tiempo salvo que sea necesario.
- No reviertas cambios ajenos del workspace.
- Actualiza docs solo cuando cambie una interfaz, flujo de instalacion o comportamiento visible.
