# @riposte/mcp

MCP server exposing Riposte to AI clients (Claude Code, Claude Desktop, anything
speaking MCP). The tools are **self-documenting**: every MCP client receives each
tool's description and input schema via the protocol's `tools/list` — this README
only covers setup.

## Prerequisites

The Riposte server must be running (`npm run server`, port 5720 — override with
the `RIPOSTE_URL` env var). Rendering tools need Edge or Chrome installed
(override the binary with `RIPOSTE_BROWSER`).

## Register

- **Claude Code**: the repo's `.mcp.json` registers the server automatically —
  approve it once via `/mcp`.
- **Claude Desktop** (e.g. for the designer): add to the MCP config:

  ```json
  {
    "mcpServers": {
      "riposte": {
        "command": "node",
        "args": ["<repo>/packages/mcp/src/index.ts"]
      }
    }
  }
  ```

## Tools

| Tool | Purpose |
| --- | --- |
| `list_sets` / `list_scenes` / `get_scene` | discover sets, scenes, data keys, full scene JSON |
| `open_scene` | navigate the running editor UI (live, via SSE) |
| `set_element` | edit element properties (validated; animated props protected) |
| `add_layer` | new image/text layer at a position (images at natural size) |
| `import_assets` | pull images/fonts from any local folder (USB stick…) into the pool |
| `render_scene` | render one frame (default: hold) with template data → PNG |
| `render_filmstrip` | render several frames in one call — review whole animations |
| `export_set` / `deploy_set` | incremental CasparCG export / additive deploy |

Edits made through these tools appear **live** in an open editor (server-sent
events); unsaved editor work is never overwritten.

## Browse the interface

```
npx @modelcontextprotocol/inspector node packages/mcp/src/index.ts
```

## Smoke test

```
node packages/mcp/test/smoke.ts   # needs the server on :5720
```
