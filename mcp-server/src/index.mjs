#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildUiPlan } from "./penpot-ui-plan.mjs";
import { comparePngFiles } from "./png-visual-diff.mjs";

const bridgeUrl = (process.env.PENPOT_UNITY_UI_BRIDGE_URL ?? "http://127.0.0.1:8091").replace(/\/$/, "");

async function bridgeRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${bridgeUrl}${path}`, {
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      ...options
    });
  } catch (error) {
    throw new Error(`Unity UI bridge is unreachable at ${bridgeUrl}. Open Tools > Penpot Unity UI MCP in Unity and select Connect. (${error.message})`);
  }

  const data = await response.json();
  if (!response.ok || data.status === "error") throw new Error(data.message ?? `Bridge request failed (${response.status}).`);
  if (data.status === "accepted") return waitForUnityJob(data.jobId);
  return data;
}

async function waitForUnityJob(jobId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const response = await fetch(`${bridgeUrl}/ui/job-status?id=${encodeURIComponent(jobId)}`);
    const job = await response.json();
    if (!response.ok || job.status === "error") throw new Error(job.message ?? `Unity job ${jobId} was not found.`);
    if (job.state === "done") {
      const result = JSON.parse(job.resultJson ?? "{}");
      if (result.status === "error") throw new Error(result.message ?? "Unity job failed.");
      return result;
    }
    await sleep(100);
  }
  throw new Error(`Unity job ${jobId} did not finish within 120 seconds.`);
}

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForCompilation(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status;
  do {
    status = await bridgeRequest("/ui/compilation-status", { method: "POST", body: "{}" });
    if (!status.isCompiling && !status.isUpdating) return status;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`Unity compilation did not finish within ${timeoutMs} ms.`);
}

async function waitForCapture(imagePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const file = await stat(imagePath);
      if (file.isFile() && file.size > 0) return { status: "ok", imagePath, byteLength: file.size };
    } catch { /* Unity has not written the screenshot yet. */ }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`Unity Game View capture was not written within ${timeoutMs} ms: ${imagePath}`);
}

async function readPenpotExport(exportPath) {
  let data;
  try {
    data = JSON.parse(await readFile(exportPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read Penpot export JSON: ${error.message}`);
  }
  if (![1, 2].includes(data?.schemaVersion) || data?.source !== "penpot-plugin" || !Array.isArray(data?.pages)) {
    throw new Error("The file is not a supported penpot-unity-ui.json export.");
  }
  return data;
}

const server = new McpServer({
  name: "penpot-unity-ui-mcp",
  version: "0.1.0"
});

server.tool(
  "penpot_load_export",
  "Read a penpot-unity-ui.json file downloaded by the Penpot Unity UI Exporter plugin. No Penpot API token is required.",
  { exportPath: z.string().describe("Absolute local path to penpot-unity-ui.json") },
  async ({ exportPath }) => {
    const data = await readPenpotExport(exportPath);
    return jsonResult({ file: data.file, exportedAt: data.exportedAt, pages: data.pages.map(({ id, name, shapes }) => ({ id, name, shapeCount: shapes.length })) });
  }
);

server.tool(
  "penpot_get_reusable_ui_assets",
  "List exported Penpot component instances, variants, responsive constraints, and PNG fallback assets before creating Unity prefabs.",
  { exportPath: z.string(), pageId: z.string().optional() },
  async ({ exportPath, pageId }) => {
    const data = await readPenpotExport(exportPath);
    const pages = pageId ? data.pages.filter((page) => page.id === pageId) : data.pages;
    if (pageId && pages.length === 0) throw new Error(`Page not found: ${pageId}`);
    const shapes = pages.flatMap((page) => page.shapes.map((shape) => ({ pageId: page.id, sourceId: shape.id, name: shape.name, component: shape.component, constraints: shape.constraints, fallbackAssetFileName: shape.fallbackAssetFileName, fallbackReason: shape.fallbackReason })))
      .filter((shape) => shape.component || shape.fallbackAssetFileName || shape.constraints?.horizontal || shape.constraints?.vertical);
    return jsonResult({ assets: data.assets ?? [], shapes });
  }
);

server.tool(
  "penpot_import_exported_assets",
  "Copy every PNG fallback asset listed in a Penpot export into one Assets/PenpotUI/ folder and import each as a Unity Sprite. The source directory is the directory that contains the plugin downloads.",
  { exportPath: z.string(), sourceDirectory: z.string(), destinationAssetDirectory: z.string().regex(/^Assets\/PenpotUI\/.+/, "Must be below Assets/PenpotUI/") },
  async ({ exportPath, sourceDirectory, destinationAssetDirectory }) => {
    const data = await readPenpotExport(exportPath);
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const destination = destinationAssetDirectory.replace(/\/+$/, "");
    const results = [];
    for (const asset of assets) {
      const fileName = basename(String(asset.fileName ?? ""));
      if (!fileName || fileName !== asset.fileName) throw new Error(`Invalid exported asset file name: ${asset.fileName}`);
      const sourceFilePath = resolve(sourceDirectory, fileName);
      const destinationAssetPath = `${destination}/${fileName}`;
      results.push(await bridgeRequest("/ui/copy-asset", { method: "POST", body: JSON.stringify({ sourceFilePath, destinationAssetPath, overwrite: false, importAsSprite: true, pixelsPerUnit: 100 }) }));
    }
    return jsonResult({ status: "ok", importedCount: results.length, assets: results });
  }
);

server.tool(
  "penpot_get_exported_frame",
  "Read one frame and its descendant shapes from a penpot-unity-ui.json plugin export.",
  { exportPath: z.string(), pageId: z.string(), frameId: z.string() },
  async ({ exportPath, pageId, frameId }) => {
    const data = await readPenpotExport(exportPath);
    const page = data.pages.find((item) => item.id === pageId);
    if (!page) throw new Error(`Page not found: ${pageId}`);
    const byId = new Map(page.shapes.map((shape) => [shape.id, shape]));
    const frame = byId.get(frameId);
    if (!frame || frame.type !== "frame") throw new Error(`Frame not found: ${frameId}`);
    const included = new Set();
    const visit = (shape) => {
      if (!shape || included.has(shape.id)) return;
      included.add(shape.id);
      shape.childIds.forEach((childId) => visit(byId.get(childId)));
    };
    visit(frame);
    return jsonResult({ file: data.file, page: { id: page.id, name: page.name }, frame, shapes: page.shapes.filter((shape) => included.has(shape.id)) });
  }
);

server.tool(
  "penpot_build_unity_ui_plan",
  "Convert one exported Penpot board into a read-only Unity UI Plan. The plan retains Penpot source IDs and does not create or modify Unity assets.",
  { exportPath: z.string(), pageId: z.string(), frameId: z.string(), prefabPath: z.string().regex(/^Assets\/.+\.prefab$/, "Must be a prefab path below Assets/") },
  async ({ exportPath, pageId, frameId, prefabPath }) => jsonResult(buildUiPlan(await readPenpotExport(exportPath), pageId, frameId, prefabPath))
);

server.tool(
  "penpot_build_component_prefab_plan",
  "Build a Unity UI Plan for one Penpot Component root, variant root, or reusable instance root. Create a separate Unity prefab from this plan, then reuse that prefab for matching Penpot component instances.",
  { exportPath: z.string(), pageId: z.string(), componentRootId: z.string(), prefabPath: z.string().regex(/^Assets\/.+\.prefab$/, "Must be a prefab path below Assets/") },
  async ({ exportPath, pageId, componentRootId, prefabPath }) => jsonResult(buildUiPlan(await readPenpotExport(exportPath), pageId, componentRootId, prefabPath))
);

server.tool(
  "penpot_build_unity_apply_actions",
  "Build idempotent unity_ui_apply_plan actions from an exported Penpot frame. Actions preserve source IDs, accessibility metadata, responsive constraints, and Auto Layout settings.",
  { exportPath: z.string(), pageId: z.string(), frameId: z.string(), prefabPath: z.string().regex(/^Assets\/.+\.prefab$/, "Must be a prefab path below Assets/") },
  async ({ exportPath, pageId, frameId, prefabPath }) => {
    const plan = buildUiPlan(await readPenpotExport(exportPath), pageId, frameId, prefabPath);
    const byId = new Map(plan.nodes.map((node) => [node.sourceId, node]));
    const pathFor = (node) => {
      if (!node.parentSourceId) return undefined;
      const parent = byId.get(node.parentSourceId); if (!parent) return undefined;
      const parentPath = pathFor(parent); return parentPath ? `${parentPath}/${parent.name}` : parent.name;
    };
    const actions = plan.nodes.map((node) => ({
      operation: "upsert", parentPath: pathFor(node), name: node.name,
      elementType: node.kind === "text" ? "text" : node.kind === "image" ? "image" : "panel",
      x: node.rect.anchoredPosition.x, y: node.rect.anchoredPosition.y, width: node.rect.sizeDelta.x, height: node.rect.sizeDelta.y,
      color: node.style?.color ?? "#FFFFFFFF", text: node.text?.value, fontSize: node.text?.fontSize,
      useResponsiveRect: true, anchorMinX: node.rect.anchorMin.x, anchorMinY: node.rect.anchorMin.y, anchorMaxX: node.rect.anchorMax.x, anchorMaxY: node.rect.anchorMax.y, pivotX: node.rect.pivot.x, pivotY: node.rect.pivot.y,
      sourceId: node.sourceId, componentId: node.component?.componentId, instanceId: node.component?.kind === "instance" ? node.sourceId : undefined,
      accessibilityLabel: node.accessibility?.label ?? node.name, accessibilityDescription: node.accessibility?.description,
      layoutType: node.autoLayout?.type, layoutSpacing: node.autoLayout?.gap ?? 0, paddingLeft: node.autoLayout?.paddingLeft ?? 0, paddingRight: node.autoLayout?.paddingRight ?? 0, paddingTop: node.autoLayout?.paddingTop ?? 0, paddingBottom: node.autoLayout?.paddingBottom ?? 0,
      childAlignment: node.autoLayout?.alignment, childForceExpandWidth: Boolean(node.autoLayout?.grow), childForceExpandHeight: Boolean(node.autoLayout?.grow)
    }));
    return jsonResult({ plan, actions });
  }
);

server.tool(
  "unity_ui_get_context",
  "List existing Canvas roots so a Penpot UI can be created without overwriting existing UI.",
  {},
  async () => jsonResult(await bridgeRequest("/ui/context", { method: "POST", body: "{}" }))
);

server.tool(
  "unity_ui_validate_prefab",
  "Validate a UI prefab without modifying it. Detects broken object references, RectTransforms outside the root, duplicate sibling names, invalid layout groups, and missing Canvas or EventSystem in the active scene.",
  { prefabPath: z.string(), checkActiveScene: z.boolean().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/validate-prefab", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_wait_for_compile",
  "Wait until Unity finishes compiling or updating, then return Error, Exception, and Assert messages captured by the Unity UI bridge. Does not modify Unity assets.",
  { timeoutMs: z.number().int().min(250).max(120000).optional() },
  async ({ timeoutMs = 30000 }) => jsonResult(await waitForCompilation(timeoutMs))
);

server.tool(
  "unity_ui_ensure_scene_ui",
  "Ensure the active scene has a Canvas with Canvas Scaler and Graphic Raycaster, plus an EventSystem. Creates only missing objects.",
  {},
  async () => jsonResult(await bridgeRequest("/ui/ensure-scene-ui", { method: "POST", body: "{}" }))
);

server.tool(
  "unity_ui_get_prefab_hierarchy",
  "Read the full hierarchy and components of a UI prefab before modifying it.",
  { prefabPath: z.string() },
  async (input) => jsonResult(await bridgeRequest("/ui/prefab-hierarchy", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_create_prefab",
  "Create a new empty RectTransform UI prefab. The destination folder must already exist and existing prefabs are never overwritten.",
  {
    prefabPath: z.string().describe("Unity project path such as Assets/PenpotUI/InventoryPanel.prefab"),
    rootName: z.string().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional()
  },
  async (input) => jsonResult(await bridgeRequest("/ui/create-prefab", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_apply_plan",
  "Apply a restricted UI plan to an existing prefab. Each action currently creates a panel, image, button, or TMP text element.",
  {
    prefabPath: z.string(),
    actions: z.array(z.object({
      operation: z.literal("create"),
      parentPath: z.string().optional().describe("Path relative to the prefab root; omit for the root."),
      name: z.string(),
      elementType: z.enum(["panel", "image", "button", "text"]),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number(),
      height: z.number(),
      color: z.string().optional().describe("#RRGGBB or #RRGGBBAA"),
      text: z.string().optional(),
      fontSize: z.number().positive().optional(),
      useResponsiveRect: z.boolean().optional().describe("Apply the supplied responsive anchors and pivot."),
      anchorMinX: z.number().min(0).max(1).optional(), anchorMinY: z.number().min(0).max(1).optional(),
      anchorMaxX: z.number().min(0).max(1).optional(), anchorMaxY: z.number().min(0).max(1).optional(),
      pivotX: z.number().min(0).max(1).optional(), pivotY: z.number().min(0).max(1).optional()
    })).min(1)
  },
  async (input) => jsonResult(await bridgeRequest("/ui/apply-plan", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_delete_element",
  "Delete one non-root UI element from a prefab by its exact path relative to the prefab root.",
  { prefabPath: z.string(), targetPath: z.string().min(1) },
  async (input) => jsonResult(await bridgeRequest("/ui/delete-element", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_set_rect_transform",
  "Set a UI element's anchors, pivot, anchored position, and size in a prefab.",
  {
    prefabPath: z.string(), targetPath: z.string().optional(),
    anchorMinX: z.number(), anchorMinY: z.number(), anchorMaxX: z.number(), anchorMaxY: z.number(),
    pivotX: z.number(), pivotY: z.number(), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive()
  },
  async (input) => jsonResult(await bridgeRequest("/ui/set-rect-transform", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_add_component",
  "Add an allowed Unity UI component to a prefab element: Image, Button, Slider, ScrollRect, TextMeshProUGUI, CanvasGroup, LayoutElement, HorizontalLayoutGroup, VerticalLayoutGroup, or GridLayoutGroup.",
  { prefabPath: z.string(), targetPath: z.string().optional(), componentType: z.string() },
  async (input) => jsonResult(await bridgeRequest("/ui/add-component", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_remove_component",
  "Remove an allowed Unity UI component from a prefab element.",
  { prefabPath: z.string(), targetPath: z.string().optional(), componentType: z.string() },
  async (input) => jsonResult(await bridgeRequest("/ui/remove-component", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_set_serialized_field",
  "Set a string, bool, integer, float, enum, color, or asset Object Reference SerializedProperty on an allowed UI component. Use objectReferenceAssetPath for Sprite, TMP font, and Material fields.",
  { prefabPath: z.string(), targetPath: z.string().optional(), componentType: z.string(), fieldPath: z.string(), value: z.string().optional(), objectReferenceAssetPath: z.string().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/set-serialized-field", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_configure_image",
  "Configure an Image on a prefab element. Supports Sprite assignment, Material assignment, Simple or Sliced 9-slice mode, and preserve aspect.",
  { prefabPath: z.string(), targetPath: z.string().optional(), spriteAssetPath: z.string().optional(), materialAssetPath: z.string().optional(), imageType: z.enum(["simple", "sliced"]).optional(), preserveAspect: z.boolean().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/configure-image", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_configure_tmp_text",
  "Configure TextMeshProUGUI text, font asset, font size, color, alignment, word wrapping, and overflow on a prefab element.",
  { prefabPath: z.string(), targetPath: z.string().optional(), text: z.string().optional(), fontAssetPath: z.string().optional(), fontSize: z.number().positive().optional(), color: z.string().optional(), alignment: z.string().optional(), enableWordWrapping: z.boolean().optional(), overflowMode: z.string().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/configure-tmp-text", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_configure_layout",
  "Add and configure a Horizontal, Vertical, or Grid Layout Group on a prefab element. Use this for Penpot Auto Layout conversion.",
  { prefabPath: z.string(), targetPath: z.string().optional(), layoutType: z.enum(["horizontal", "vertical", "grid"]), spacing: z.number().min(0).optional(), paddingLeft: z.number().min(0).optional(), paddingRight: z.number().min(0).optional(), paddingTop: z.number().min(0).optional(), paddingBottom: z.number().min(0).optional(), constraintCount: z.number().int().positive().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/configure-layout", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_add_control",
  "Add a UI control to a prefab element: Button, Toggle, Slider, ScrollRect, or TMP InputField. A RectMask2D can be added when required.",
  { prefabPath: z.string(), targetPath: z.string().optional(), controlType: z.enum(["button", "toggle", "slider", "scrollrect", "inputfield"]), addMask: z.boolean().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/add-ui-control", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_configure_selectable",
  "Configure a Button, Toggle, or Slider Selectable's transition mode, navigation mode, and ColorTint state colors.",
  { prefabPath: z.string(), targetPath: z.string().optional(), transition: z.enum(["None", "ColorTint", "SpriteSwap", "Animation"]).optional(), navigation: z.enum(["None", "Horizontal", "Vertical", "Automatic", "Explicit"]).optional(), normalColor: z.string().optional(), highlightedColor: z.string().optional(), pressedColor: z.string().optional(), disabledColor: z.string().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/configure-selectable", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_search_assets",
  "Find Unity assets by name and optional Unity AssetDatabase type, for example Sprite, TMP_FontAsset, or Material.",
  { query: z.string(), assetType: z.string().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/search-assets", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_import_sprite",
  "Configure a PNG or SVG texture asset for Unity UI sprite use.",
  { assetPath: z.string(), pixelsPerUnit: z.number().positive().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/import-sprite", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_copy_penpot_asset",
  "Copy an exported Penpot PNG, SVG, TTF, or OTF from an absolute local path into Assets/PenpotUI/ and import PNG/SVG files as Unity Sprites. Returns only after Unity refreshes the asset database.",
  { sourceFilePath: z.string(), destinationAssetPath: z.string().regex(/^Assets\/PenpotUI\/.+/, "Must be below Assets/PenpotUI/"), overwrite: z.boolean().optional(), importAsSprite: z.boolean().optional(), pixelsPerUnit: z.number().positive().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/copy-asset", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_write_file",
  "Create or update a .cs or .json file below Assets/PenpotUI/. Existing files require overwrite=true.",
  { assetPath: z.string(), content: z.string(), overwrite: z.boolean().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/write-file", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_run_editor_script",
  "Run a public static parameterless method from a C# script below Assets/PenpotUI/Editor/. Use after Unity finishes compiling the script.",
  { assetPath: z.string(), methodName: z.string().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/run-editor-script", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_get_console",
  "Read Unity log messages captured while the Penpot UI bridge has been connected.",
  {},
  async () => jsonResult(await bridgeRequest("/ui/console", { method: "POST", body: "{}" }))
);

server.tool(
  "unity_ui_capture_game_view",
  "Capture the running Unity Game View, including the active UI, to a PNG below Assets/PenpotUI/. Requires Play Mode.",
  { outputPath: z.string().optional() },
  async (input) => jsonResult(await bridgeRequest("/ui/capture-game-view", { method: "POST", body: JSON.stringify(input) }))
);

server.tool(
  "unity_ui_wait_for_capture",
  "Wait until a Game View PNG capture exists and has content, then return its path and byte length. Use the fullPath returned by unity_ui_capture_game_view.",
  { imagePath: z.string(), timeoutMs: z.number().int().min(250).max(120000).optional() },
  async ({ imagePath, timeoutMs = 30000 }) => jsonResult(await waitForCapture(imagePath, timeoutMs))
);

server.tool(
  "penpot_compare_unity_screenshot",
  "Compare a Penpot PNG export with a Unity Game View PNG at the same resolution. Reads the supplied images only and never creates or modifies Unity UI.",
  {
    penpotImagePath: z.string().describe("Absolute path to the PNG exported from the Penpot frame"),
    unityImagePath: z.string().describe("Absolute path to the PNG captured from Unity Game View"),
    perChannelThreshold: z.number().int().min(0).max(255).optional().describe("Per-channel difference that counts as a changed pixel; defaults to 16")
  },
  async ({ penpotImagePath, unityImagePath, perChannelThreshold }) => jsonResult(await comparePngFiles(penpotImagePath, unityImagePath, perChannelThreshold))
);

server.tool(
  "penpot_find_visual_mismatches",
  "Compare Penpot and Unity screenshots, then return Penpot node IDs whose bounds intersect the changed image region. This reads files only and does not modify Unity UI.",
  { exportPath: z.string(), pageId: z.string(), frameId: z.string(), penpotImagePath: z.string(), unityImagePath: z.string(), perChannelThreshold: z.number().int().min(0).max(255).optional() },
  async ({ exportPath, pageId, frameId, penpotImagePath, unityImagePath, perChannelThreshold }) => {
    const data = await readPenpotExport(exportPath);
    const page = data.pages.find((item) => item.id === pageId);
    const frame = page?.shapes.find((item) => item.id === frameId && item.type === "frame");
    if (!page || !frame) throw new Error("The requested Penpot frame was not found.");
    const comparison = await comparePngFiles(penpotImagePath, unityImagePath, perChannelThreshold);
    if (!comparison.comparable || !comparison.changedBounds) return jsonResult({ comparison, nodes: [] });
    const scaleX = comparison.reference.width / frame.width;
    const scaleY = comparison.reference.height / frame.height;
    const changed = comparison.changedBounds;
    const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    const nodes = page.shapes.filter((shape) => shape.id !== frame.id && Number.isFinite(shape.x) && Number.isFinite(shape.y) && shape.width > 0 && shape.height > 0)
      .map((shape) => ({ sourceId: shape.id, name: shape.name, bounds: { x: (shape.x - frame.x) * scaleX, y: (shape.y - frame.y) * scaleY, width: shape.width * scaleX, height: shape.height * scaleY } }))
      .filter((shape) => overlaps(shape.bounds, changed));
    return jsonResult({ comparison, nodes });
  }
);

await server.connect(new StdioServerTransport());
