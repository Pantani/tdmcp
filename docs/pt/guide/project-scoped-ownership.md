---
title: Ownership por projeto
description: Gerencie pacotes e registros MCP do tdmcp com ownership explícito por projeto TouchDesigner.
---

# Ownership por projeto

<FeatureAvailability status="source-only" locale="pt" />

A Wave 3 torna o setup local explícito, inspecionável e reversível. Arquivos de
pacotes podem pertencer a um projeto em vez de um cache global implícito, e o
setup do cliente altera apenas um registro nomeado no alvo nativo verificado.

## Armazenamento de pacotes

O escopo de usuário preserva compatibilidade em `~/.tdmcp/packages`. O escopo de
projeto é opt-in, exige o diretório explícito e usa
`<projeto>/.tdmcp/packages`:

```bash
tdmcp packages path --scope project --project-dir "$PWD" --json
tdmcp list --installed --scope project --project-dir "$PWD" --json
tdmcp install raytk --scope project --project-dir "$PWD" --dry-run --json
```

O mesmo contrato existe em `manage_packages`; `install_library_package` também
aceita escopo de projeto sem exigir o `dest_dir` legado. O modo project rejeita
`packages_root` concorrente, projeto ausente e roots com symlink.

## Setup dos clientes

| Cliente | Projeto | Usuário |
| --- | --- | --- |
| Claude Code | `<projeto>/.mcp.json` | `~/.claude.json` |
| Cursor | `<projeto>/.cursor/mcp.json` | `~/.cursor/mcp.json` |
| Codex | Não suportado, fail closed | `~/.codex/config.toml` |

Planeje, aplique e confira:

```bash
tdmcp install-client claude --scope project --project-dir "$PWD" --diff --json
tdmcp install-client claude --scope project --project-dir "$PWD" --write --json
tdmcp install-client claude --scope project --project-dir "$PWD" --check --json
```

Remova somente o nome gerenciado:

```bash
tdmcp install-client claude --scope project --project-dir "$PWD" --remove --diff --json
tdmcp install-client claude --scope project --project-dir "$PWD" --remove --write --json
```

`--name` escolhe um nome seguro. Chaves JSON e seções TOML de outras ferramentas
são preservadas. Configs inválidas, maiores que 1 MiB, com symlink ou alteradas
concorrentemente são rejeitadas. `--write` promove um arquivo irmão atômico e
confere os bytes gravados. A saída informa apenas presença do token, nunca seu
valor.

`tdmcp install-client <cliente>` sem escopo/ação continua imprimindo o snippet
legado. `--write --path <arquivo>` também permanece por compatibilidade, mas o
alvo nativo com escopo é o caminho recomendado.

## Namespace do doctor

O comando top-level agora diagnostica o ambiente:

```bash
tdmcp doctor --json
tdmcp doctor --fix
```

O diagnóstico de dependências de pacotes ficou explícito:

```bash
tdmcp packages doctor raytk --json
```

Chamadas conhecidas no formato `tdmcp doctor <pacote>` continuam funcionando
temporariamente com aviso de depreciação.

## Linguagem de evidência

- **PASS** — testes offline provaram resolução por escopo, preservação de config
  alheia, plano redigido, check/remove, rejeição de concorrência, read-back
  atômico e compatibilidade do namespace.
- **FAIL** — input inválido ou estado inseguro do filesystem é rejeitado sem
  escrita do tdmcp e deve retornar resultado não-zero.
- **UNVERIFIED — pending bridge** — import live de pacote e reconciliação com
  operadores já carregados no TouchDesigner não são declarados sem bridge ativo.

`tdmcp status --json` observa apenas o registro padrão `tdmcp` nos alvos nativos
suportados, sem expor paths ou secrets. Entradas arbitrárias de `--name` não são
varridas de propósito.
