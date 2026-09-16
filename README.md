# Penpot Unity UI MCP

Generate Unity uGUI prefabs from Penpot UI exports through MCP.

## Packages

| Directory | Distribution | Purpose |
| --- | --- | --- |
| `unity-package` | Unity Package Manager | Local Unity Editor bridge on port `8091` |
| `mcp-server` | npm | Stdio MCP server for Codex and other MCP clients |
| `penpot-exporter-plugin` | Penpot local plugin | Downloads Penpot JSON and deduplicated PNG assets |

## Install

### Unity

Install the `unity-package` directory through Unity Package Manager using a local path or a Git URL with `?path=unity-package`.

```text
https://github.com/ImHooya/penpot-unity-mcp.git?path=unity-package
```

Open **Tools > Penpot Unity UI MCP** and select **Connect**.

### MCP server

```bash
cd mcp-server
npm install
```

```json
{
  "mcpServers": {
    "penpot-unity-ui": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/src/index.mjs"],
      "env": {
        "PENPOT_UNITY_UI_BRIDGE_URL": "http://127.0.0.1:8091"
      }
    }
  }
}
```

### Penpot plugin

```bash
cd penpot-exporter-plugin
npm install
npm run build
npx serve public -l 4400
```

Install `http://localhost:4400/manifest.json` in Penpot Plugin Manager.

## Documentation

- [Full guide](docs/GUIDE.md)
- [한국어 가이드](docs/GUIDE.ko.md)
- [Codex and Claude Desktop setup](docs/MCP_CLIENT_SETUP.md)
- [Storage Box sample](samples/StorageBox)

The exporter preserves Penpot Component and Variant metadata, converts responsive constraints into Unity RectTransform values, maps Auto Layout to Unity Layout Groups, stores accessibility metadata, supports idempotent source-ID updates, and emits PNG assets only for complex visual layers that require raster fallback.

## License

MIT. See [LICENSE](LICENSE).
