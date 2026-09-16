# MCP client setup

Install dependencies before registering the server:

```bash
cd mcp-server
npm install
```

Start the Unity Bridge first: open **Tools > Penpot Unity UI MCP** in Unity and select **Connect**. The default address is `http://127.0.0.1:8091`.

## Codex

Copy the contents of [codex-config.toml.example](codex-config.toml.example) into `~/.codex/config.toml`. Replace `<absolute-path-to-repository>` with the absolute path of the cloned `penpot-unity-mcp` repository.

Windows example:

```toml
[mcp_servers.penpot_unity_ui]
command = "node"
args = ["C:\\Projects\\penpot-unity-mcp\\mcp-server\\src\\index.mjs"]

[mcp_servers.penpot_unity_ui.env]
PENPOT_UNITY_UI_BRIDGE_URL = "http://127.0.0.1:8091"
```

Restart or reload Codex after saving the configuration. Codex supports stdio MCP servers with a command, arguments, and environment variables. [Official OpenAI API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents) describes the stdio transport fields.

## Claude Desktop

Copy the contents of [claude-desktop-config.json.example](claude-desktop-config.json.example) into Claude Desktop's `claude_desktop_config.json`, merging it with existing `mcpServers` entries when necessary.

Common locations:

| Platform | Configuration file |
| --- | --- |
| Windows | `%APPDATA%\\Claude\\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

On Windows, JSON paths must use escaped backslashes:

```json
{
  "args": [
    "C:\\Projects\\penpot-unity-mcp\\mcp-server\\src\\index.mjs"
  ]
}
```

Restart Claude Desktop after saving the file.

## Verify the connection

Ask the MCP client to call `unity_ui_get_context`. A successful response lists the Unity UI context. If it cannot connect, confirm that Unity is open, compilation has finished, and the Penpot Unity UI MCP Bridge is connected.
