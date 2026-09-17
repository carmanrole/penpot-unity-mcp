# Automatic Penpot-to-Unity Sync

Use one MCP tool for the production workflow:

```text
penpot_sync_selected_layout
```

Select one top-level layout in Penpot, then provide a Unity prefab path such as
`Assets/PenpotUI/Prefabs/Inventory.prefab`.

The tool performs the complete sync without a downloaded JSON file, a Penpot
Exporter button, or per-node Unity requests:

1. Reads the selected Penpot hierarchy through the official Penpot MCP plugin.
2. Exports only complex leaf layers as PNG. A parent, board, frame, or group is
   never exported as a PNG because it would include its children.
3. Reuses duplicate visual PNGs and imports all required assets in one Unity
   Editor request.
4. Builds Unity-native RectTransforms, TMP text, Buttons, layout groups, masks,
   colors, and Sprite references.
5. Applies the complete plan and saves the prefab once.

Plain-color layers remain Unity-native. A layer without a Fill or PNG fallback
becomes a transparent RectTransform; it never receives a default white Image.
Penpot clipping groups and clipping boards become `RectMask2D`.
