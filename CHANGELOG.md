# Changelog

All notable changes to the `penpot-unity-mcp` project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-18

### Added
- **9-Slice (Sliced Sprite) Support**:
  - Automatically extracts `borderRadius` and `rx` from Penpot shapes.
  - Automatically configures `TextureImporter.spriteBorder` with 4-corner border values and sets `Image.Type.Sliced` on Unity `Image` components, keeping rounded corners sharp and undistorted at any resolution or aspect ratio.
  - Added `borderRadius` parameter support to `unity_ui_apply_plan` and `unity_ui_configure_image` tools.
- **AutoLayout & LayoutElement Integration**:
  - Maps Penpot flex properties (`row`, `column`, `gap`, `padding`, `alignItems`, `justifyContent`) to Unity `HorizontalLayoutGroup` and `VerticalLayoutGroup`.
  - Automatically attaches and synchronizes `LayoutElement` components (`preferredWidth`, `preferredHeight`, `minWidth`, `minHeight`) on child elements within layout groups.
  - Enables `childControlWidth = true` and `childControlHeight = true` by default to ensure child element dimensions and layouts are governed reliably by their LayoutElements without coordinate conflicts.

### Fixed
- **Asset Import & Sprite Loading Failures**:
  - Resolved asset import failures during `penpot_sync_selected_layout` where exported PNG assets were not being properly imported into Unity before prefab application.
  - Fixed Unity Prefab save failures (`PrefabUtility.SaveAsPrefabAsset`) caused by missing MonoBehaviours / corrupt component states on newly generated or updated UI hierarchies (`CleanMissingScripts`).
  - Fixed container background PNG export failures where nested child layers prevented clean asset generation.
  - Ensured reliable batch asset copying and TextureImporter sprite conversion (`single` sprite mode with appropriate pixels per unit).
- **Nested Coordinate Offsets (Off-Screen Elements)**:
  - Fixed an issue where nested elements (buttons, labels, containers) flew far off-screen due to calculating absolute root frame positions instead of parent-relative local coordinates (`toRect`).
- **Text & Image Component Conflicts**:
  - Fixed an issue where TextMeshPro elements were assigned an empty or default white `Image` component, obscuring text content.
- **Hierarchy Sibling Ordering**:
  - Fixed an issue where container backgrounds could be rendered above child UI elements rather than behind them (`SetAsFirstSibling`).

### Changed
- **Pure Container Background Export**:
  - Container shapes (frames, boards, groups) now hide direct children during PNG raster export, ensuring background sprites are clean and pure without baking child elements into the texture.
- **Text Layer Handling**:
  - Text shapes strictly enforce `TextMeshProUGUI` and prevent redundant `Image` component attachments.

### Removed
- Removed all dependencies on the legacy `penpot-exporter-plugin`. UI synchronization now communicates directly via the official Penpot MCP interface and `penpot_sync_selected_layout`. Manual JSON export is no longer needed.

---

## [1.0.0] - 2026-09-17

### Added
- Initial open source release of `penpot-unity-mcp`.
- **Unity Package (`unity-package`)**:
  - Local HTTP Editor bridge on port `8091` (`Tools > Penpot Unity UI MCP`).
  - Native uGUI element generation: `RectTransform`, `Image`, `Button`, `TextMeshProUGUI`, `RectMask2D`.
  - Selective raster export for complex visual layers (strokes, gradients, complex fills, SVGs).
  - Prefab validation endpoint `unity_ui_validate_prefab` for detecting missing references, duplicate sibling names, and layout issues.
- **MCP Server (`mcp-server`)**:
  - Model Context Protocol (MCP) stdio server for AI agents and LLM clients.
  - High-level workflow tool `penpot_sync_selected_layout` for end-to-end synchronization from Penpot selection directly to a Unity Prefab.
  - Granular UI tools: `unity_ui_apply_plan`, `unity_ui_configure_image`, `unity_ui_configure_tmp_text`, `unity_ui_configure_layout`, `unity_ui_add_control`, and asset management tools.

