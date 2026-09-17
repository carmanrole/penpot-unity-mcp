# MCP server

Run `npm install`, then register `src/index.mjs` as a stdio MCP server. Set `PENPOT_UNITY_UI_BRIDGE_URL` when the Unity Bridge uses a non-default address.

Use `penpot_sync_selected_layout` for the complete automatic workflow. It reads the selected Penpot layout through the official Penpot MCP plugin, imports required PNG assets in one Unity request, and applies the Unity prefab in one request. It does not use a downloaded JSON file.

See the repository [guide](../docs/GUIDE.md) for the complete workflow.
