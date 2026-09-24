# nansen-mcp-dxt

One-click install of the Nansen MCP server for Claude Desktop: download [`nansen.dxt`](https://github.com/nansen-ai/nansen-mcp-dxt/raw/refs/heads/main/nansen.dxt) and open it. Setup guide: [docs.nansen.ai/mcp/connecting](https://docs.nansen.ai/mcp/connecting).

## What is generated

The connection settings (endpoint, `NANSEN-API-KEY` header, API-key URL, exact `mcp-remote` version) are **not** maintained here. The one maintained source is [`src/mcp-client-config.json` in nansen-cli](https://github.com/nansen-ai/nansen-cli/blob/main/src/mcp-client-config.json) (API-322).

| File | Maintained by hand? | Source |
|---|---|---|
| `config/mcp-client-config.json` | No | Byte-identical copy of the nansen-cli file at the commit in `config/upstream.json` |
| `config/upstream.json` | No | Written by `npm run sync` (commit SHA + sha256) |
| `manifest.base.json` | **Yes** | Extension metadata: name, description, version, icon |
| `bundle/manifest.json` | No | `manifest.base.json` + the config (`npm run generate`) |
| `bundle/package.json`, `bundle/package-lock.json` | No | Exact `mcp-remote` pin from the config (`npm run build`) |
| `nansen.dxt` | No | Packed from `bundle/` with `@anthropic-ai/mcpb` (`npm run build`) |

Do not edit generated files by hand. CI (`.github/workflows/check.yml`) fails when they drift from the config, when the config copy does not match its checksum or the upstream file, or when `nansen.dxt` holds a different manifest or `mcp-remote` version.

## How to update

Node.js 20 or later and `unzip` are required.

```bash
npm ci
npm run sync -- --ref <nansen-cli commit SHA>   # after the config changes in nansen-cli: re-vendor, regenerate, rebuild nansen.dxt
npm run build                                   # after you edit manifest.base.json (bump its "version")
npm run check                                   # offline drift check
```

Commit every changed file, including `nansen.dxt`. A weekly job fails when nansen-cli `main` has a newer config than the pinned commit.

The `mcp-remote` pin is owned by nansen-cli; see its `AGENTS.md` > MCP client config for the review and bump process.
