# Penpot Unity UI MCP

Generate production-ready Unity uGUI prefabs directly from Penpot layouts through the Model Context Protocol (MCP).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Unity](https://img.shields.io/badge/Unity-2022.3%2B-black.svg)](https://unity.com/)

---

## Overview

`penpot-unity-mcp` connects your Penpot workspace and Unity Editor through AI-assisted MCP tools. It eliminates manual asset slicing and UI coordinate recreation by synchronizing designs into native Unity UI hierarchies in a single automated step.

### Key Features

- **Direct MCP Sync (`penpot_sync_selected_layout`)**: Synchronizes the active Penpot selection directly into a Unity Prefab without downloading JSON or copying files manually.
- **Native uGUI Hierarchy**: Builds genuine Unity UI elements (`RectTransform`, `UnityEngine.UI.Text`, `Image`, `Button`, `RectMask2D`).
- **9-Slice (Sliced Sprite) Support**: Detects `borderRadius` from Penpot shapes, configures `TextureImporter.spriteBorder` in Unity, and sets `Image.Type.Sliced` to keep rounded corners crisp and undistorted at any aspect ratio.
- **AutoLayout & LayoutElement Integration**: Maps Penpot flex layouts (`row`, `column`, `gap`, `padding`, alignment) to `HorizontalLayoutGroup` and `VerticalLayoutGroup`, automatically configuring `LayoutElement` (`preferredWidth`, `preferredHeight`) on child items to prevent coordinate and scaling conflicts.
- **Selective Raster Fallback**: Exports PNG assets only for complex visual layers (gradients, strokes, SVGs, or custom shapes) while hiding nested children to keep container backgrounds pure.
- **Idempotent Updates**: Uses Penpot Source IDs to update existing prefabs non-destructively.

---

## Architecture

| Directory | Distribution | Purpose |
| --- | --- | --- |
| `unity-package` | Unity Package Manager | Local Unity Editor bridge running on port `8091` |
| `mcp-server` | npm / Node.js | Stdio MCP server for Claude Desktop, Codex, Cursor, and Antigravity |

---

## Installation

### 1. Unity Editor Bridge

Install `unity-package` via Unity Package Manager using a Git URL:

```text
https://github.com/ImHooya/penpot-unity-mcp.git?path=unity-package
```

Or add it locally from disk (`Add package from disk...` -> select `unity-package/package.json`).

After installation, open the bridge window in Unity:
> **Tools > Penpot Unity UI MCP** and click **Connect**.

### 2. MCP Server Setup

Clone or install the MCP server dependencies:

```bash
cd mcp-server
npm install
```

Register the server in your MCP client configuration (e.g., `claude_desktop_config.json`, Cursor, or Antigravity):

```json
{
  "mcpServers": {
    "penpot-unity-ui": {
      "command": "node",
      "args": ["/absolute/path/to/penpot-unity-mcp/mcp-server/src/index.mjs"],
      "env": {
        "PENPOT_UNITY_UI_BRIDGE_URL": "http://127.0.0.1:8091"
      }
    }
  }
}
```

### 3. Penpot Connection

Ensure your Penpot workspace is connected via the official Penpot MCP server. `penpot-unity-mcp` connects to Penpot's MCP interface to inspect selections and export assets seamlessly.

---

## Quick Start

1. Open your UI board in Penpot and select the frame or board you want to export.
2. In your MCP-enabled AI client (Claude, Cursor, Codex, etc.), invoke:
   ```text
   penpot_sync_selected_layout(
     prefabPath: "Assets/PenpotUI/Prefabs/MyScreen.prefab"
   )
   ```
3. The MCP server will:
   - Read the selected layout hierarchy from Penpot.
   - Export any necessary 9-slice or complex visual PNG assets.
   - Import textures into Unity with optimal sprite and border settings.
   - Build or update the Prefab with responsive anchors, text styles, and layout groups.

---

## Documentation

- [User Guide](docs/GUIDE.md)
- [MCP Client Setup Guide](docs/MCP_CLIENT_SETUP.md)
- [Changelog](CHANGELOG.md)

---

## License

MIT License. See [LICENSE](LICENSE) for details.

### Text and sizing on import

The selected layout supplies the prefab root size. Each child uses its immediate
parent's coordinates and constraints. Scale follows the parent's proportions,
while two-edge constraints keep their margins in pixels.

Native text imports as editable UnityEngine.UI.Text. For PSD lettering already
converted into pixels, save a UTF-8 JSON file alongside the prefab, for example
Card.prefab.penpot.json. Set fontAssetPath to a Unity .ttf or .otf path and
textOverrides to an object keyed by Penpot layer ID. Each entry accepts value,
fontSize, color, align and verticalAlign. Sync reads these settings again on
reimport. Explicit tool arguments take precedence.
