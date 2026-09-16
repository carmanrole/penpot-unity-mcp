# Contributing

1. Create a branch for one focused change.
2. Run `node --check mcp-server/src/index.mjs` for MCP server changes.
3. Run `npm run build` in `penpot-exporter-plugin` after changing its TypeScript source and commit the generated `public/plugin.js`.
4. Open a Unity project with `unity-package` installed and verify there are no compilation errors.
5. Describe the Unity and Penpot versions used for validation in the pull request.
