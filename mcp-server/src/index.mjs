#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildUiPlan } from "./penpot-ui-plan.mjs";
import { comparePngFiles } from "./png-visual-diff.mjs";
import { PenpotMcpClient, imageContent, textContent } from "./penpot-mcp-client.mjs";

const bridgeUrl = (process.env.PENPOT_UNITY_UI_BRIDGE_URL ?? "http://127.0.0.1:8091").replace(/\/$/, "");
const capturedAssetCache = new Map();
const penpotExportParallelism = Math.max(1, Math.min(8, Number.parseInt(process.env.PENPOT_MCP_EXPORT_PARALLELISM ?? "4", 10) || 4));

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await callback(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const exportSelectedLayoutCode = `
const requestedName = __LAYOUT_NAME__;
const layoutTypes = ["board", "frame", "group"];
const candidates = requestedName ? penpot.currentFile.pages.flatMap((page) => Array.from(page.findShapes()).filter((shape) => layoutTypes.includes(shape.type)).map((shape) => ({ page, shape }))) : [];
const queryTokens = requestedName ? requestedName.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token && !["ui", "screen", "layout", "panel"].includes(token)) : [];
const exactMatches = requestedName ? candidates.filter((match) => String(match.shape.name || "").toLowerCase() === requestedName.toLowerCase()) : [];
const matches = requestedName ? (exactMatches.length ? exactMatches : candidates.filter((match) => queryTokens.length > 0 && queryTokens.every((token) => String(match.shape.name || "").toLowerCase().includes(token)))) : Array.from(penpot.selection || []).map((shape) => ({ page: penpot.currentPage, shape }));
const selected = matches.map((match) => match.shape);
const targetPage = matches[0]?.page ?? penpot.currentPage;
if (selected.length === 0) throw new Error(requestedName ? "No Penpot frame, board, or group named '" + requestedName + "' was found in this file." : "Select one Penpot frame or layout before requesting export.");
if (requestedName && selected.length > 1) throw new Error("Multiple Penpot layouts match '" + requestedName + "'. Ask the user which one to use: " + matches.slice(0, 12).map((match) => "[" + match.page.name + "] " + match.shape.name + " (" + match.shape.id + ")").join("; "));
const selectedIds = new Set(selected.map((shape) => String(shape.id)));
const roots = selected.filter((shape) => { let parent = shape.parent; while (parent) { if (selectedIds.has(String(parent.id))) return false; parent = parent.parent; } return true; });
const shapes = []; const seen = new Set();
function fallback(shape) {
  if (shape.type === "text" || Boolean(shape.characters)) return false;
  const fills = Array.isArray(shape.fills) ? shape.fills : []; const strokes = Array.isArray(shape.strokes) ? shape.strokes : [];
  const r = shape.borderRadius ?? shape.rx;
  const hasRoundedCorners = (typeof r === "number" && r > 0) || (Array.isArray(r) && r.some((value) => Number(value) > 0));
  const hasComplexFill = fills.some((fill) => fill.fillImage || fill.gradient || fill.fillColorGradient);
  const hasVisual = (fills.length > 0 && fills.some(f => f.fillColor || f.color)) || strokes.length > 0;
  return (["image", "svg-raw", "path", "boolean"].includes(shape.type) || strokes.length > 0 || hasRoundedCorners || hasComplexFill || (hasVisual && ["frame", "board", "group"].includes(shape.type)) || shape.blur || (shape.blurs && shape.blurs.length) || (shape.blendMode && !["normal", "pass-through"].includes(String(shape.blendMode).toLowerCase())));
}
function visit(shape) {
  if (!shape || seen.has(String(shape.id))) return; seen.add(String(shape.id));
  const children = Array.from(shape.children || []);
  const textChars = shape.characters || (typeof shape.content === "string" ? shape.content : shape.content?.characters || shape.content?.text);
  const isTextShape = shape.type === "text" || Boolean(textChars);
  const rawR = shape.borderRadius ?? shape.rx;
  const radius = typeof rawR === "number" ? rawR : (Array.isArray(rawR) && rawR.length > 0 ? Number(rawR[0]) || 0 : 0);
  const rawLayout = shape.layout;
  let autoLayout = undefined;
  if (rawLayout && rawLayout !== "none") {
    const dir = String(shape.layoutFlexDir || shape.flexDir || rawLayout).toLowerCase();
    const type = (dir === "row" || dir === "horizontal") ? "horizontal"
      : (dir === "column" || dir === "vertical") ? "vertical"
      : (dir === "grid") ? "grid"
      : undefined;
    if (type) {
      const rawGap = shape.layoutGap ?? shape.gap ?? shape.rowGap ?? shape.columnGap ?? 0;
      const gap = typeof rawGap === "number" ? rawGap : (typeof rawGap === "object" && rawGap ? (rawGap.row ?? rawGap.column ?? 0) : 0);
      const p = shape.layoutPadding ?? shape.padding ?? {};
      const padTop = Number(shape.paddingTop ?? p.top ?? 0) || 0;
      const padRight = Number(shape.paddingRight ?? p.right ?? 0) || 0;
      const padBottom = Number(shape.paddingBottom ?? p.bottom ?? 0) || 0;
      const padLeft = Number(shape.paddingLeft ?? p.left ?? 0) || 0;
      autoLayout = {
        type,
        gap: Number(gap) || 0,
        paddingTop: padTop,
        paddingRight: padRight,
        paddingBottom: padBottom,
        paddingLeft: padLeft,
        alignItems: shape.layoutAlignItems,
        justifyContent: shape.layoutJustifyContent
      };
    }
  }
  shapes.push({
    id: String(shape.id),
    name: shape.name || "Unnamed",
    type: isTextShape ? "text" : (shape.type || "unknown"),
    parentId: shape.parent ? String(shape.parent.id) : undefined,
    childIds: children.map((child) => String(child.id)),
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    rotation: shape.rotation,
    borderRadius: radius,
    fills: shape.fills,
    strokes: shape.strokes,
    content: isTextShape ? { characters: textChars || "", fontFamily: shape.fontFamily, fontSize: shape.fontSize || 14, fontWeight: shape.fontWeight, lineHeight: shape.lineHeight, align: shape.align } : shape.content,
    layout: shape.layout,
    autoLayout: autoLayout || shape.autoLayout,
    constraints: { horizontal: shape.constraintsHorizontal || shape.constraints?.horizontal, vertical: shape.constraintsVertical || shape.constraints?.vertical },
    isMask: typeof shape.isMask === "function" && shape.isMask(),
    clipContent: shape.clipContent === true,
    exportPng: fallback(shape)
  });
  children.forEach(visit);
}
roots.forEach(visit);
const byId = new Map(shapes.map((shape) => [shape.id, shape]));
function descendants(id, output = []) { const shape = byId.get(id); if (!shape) return output; for (const childId of shape.childIds) { const child = byId.get(childId); if (child) { output.push(child); descendants(childId, output); } } return output; }
const selectedRootIds = new Set(roots.map((shape) => String(shape.id)));
return { file: { id: String(penpot.currentFile?.id || "unknown"), name: penpot.currentFile?.name || "Untitled" }, page: { id: String(targetPage?.id || "unknown"), name: targetPage?.name || "Untitled" }, shapes };
`;

function exportLayoutCode(layoutName) {
  return exportSelectedLayoutCode.replace("__LAYOUT_NAME__", JSON.stringify(layoutName ?? ""));
}

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
  return validatePenpotExport(data);
}

function validatePenpotExport(data) {
  if (![1, 2].includes(data?.schemaVersion) || data?.source !== "penpot-plugin" || !Array.isArray(data?.pages)) throw new Error("The data is not a supported penpot-unity-ui.json export.");
  return data;
}


const server = new McpServer({
  name: "penpot-unity-ui-mcp",
  version: "0.1.0"
});


async function captureSelectedLayout(destinationAssetDirectory = "Assets/PenpotUI/Imported", layoutName, importAssets = true) {
  const penpot = new PenpotMcpClient();
  await penpot.connect();
  let snapshot;
  try {
    const raw = textContent(await penpot.callTool("execute_code", { code: exportLayoutCode(layoutName) }));
    let response;
    try { response = JSON.parse(raw); }
    catch { throw new Error(raw); }
    // The official Penpot MCP wraps execute_code output in { result, log }.
    // Accept both that response and the raw snapshot returned by older bridges.
    snapshot = response?.result ?? response;
  }
  catch (error) { throw new Error(`Penpot selection export failed: ${error.message}`); }
  async function exportShapePng(penpot, shape) {
    const hasChildren = Array.isArray(shape.childIds) && shape.childIds.length > 0;
    let savedStates = null;
    if (hasChildren) {
      try {
        const hideCode = `
        const targetId = ${JSON.stringify(shape.id)};
        const page = penpot.currentPage;
        let target = null;
        if (page && page.findShapes) {
          for (const s of page.findShapes()) {
            if (String(s.id) === targetId) { target = s; break; }
          }
        }
        if (target && target.children && target.children.length > 0) {
          const states = Array.from(target.children).map(c => ({ id: String(c.id), hidden: Boolean(c.hidden) }));
          for (const c of target.children) {
            c.hidden = true;
          }
          return states;
        }
        return [];
      `;
        const res = await penpot.callTool("execute_code", { code: hideCode });
        const raw = textContent(res);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        savedStates = parsed?.result ?? parsed;
      } catch (e) {
        console.error(`[Penpot MCP] Warning: Failed to hide children for ${shape.name}: ${e.message}`);
      }
    }

    let contentBase64;
    try {
      contentBase64 = imageContent(await penpot.callTool("export_shape", { shapeId: shape.id, format: "png", mode: "shape" }));
    } finally {
      if (hasChildren && Array.isArray(savedStates) && savedStates.length > 0) {
        try {
          const restoreCode = `
          const states = ${JSON.stringify(savedStates)};
          const page = penpot.currentPage;
          if (page && page.findShapes) {
            const stateMap = new Map(states.map(item => [item.id, item.hidden]));
            for (const s of page.findShapes()) {
              if (stateMap.has(String(s.id))) {
                s.hidden = stateMap.get(String(s.id));
              }
            }
          }
          return true;
        `;
          await penpot.callTool("execute_code", { code: restoreCode });
        } catch (e) {
          console.error(`[Penpot MCP] Warning: Failed to restore children for ${shape.name}: ${e.message}`);
        }
      }
    }
    return contentBase64;
  }

  // Export non-root shapes that require fallback graphics.
  // Root layouts were already marked exportPng = false above.
  const fallbackLeaves = snapshot.shapes.filter((shape) => shape.exportPng);
  const candidatesBySignature = new Map();
  for (const shape of fallbackLeaves) {
    const signature = JSON.stringify({ type: shape.type, width: shape.width, height: shape.height, rotation: shape.rotation, fills: shape.fills, strokes: shape.strokes, content: shape.content });
    const group = candidatesBySignature.get(signature) ?? [];
    group.push(shape);
    candidatesBySignature.set(signature, group);
  }
  const exported = await mapWithConcurrency(Array.from(candidatesBySignature.entries()), 1, async ([visualSignature, shapes]) => {
    const shape = shapes[0];
    const safeName = String(shape.name ?? "asset").replace(/[^a-z0-9-_]+/gi, "_").replace(/^_+|_+$/g, "") || "asset";
    const cached = capturedAssetCache.get(visualSignature);
    if (cached) return { shapes, asset: { sourceIds: shapes.map((item) => item.id), fileName: cached.fileName, contentBase64: cached.contentBase64 } };
    const fileName = `${safeName}_${String(shape.id).slice(0, 8)}.png`;
    try {
      const contentBase64 = await exportShapePng(penpot, shape);
      capturedAssetCache.set(visualSignature, { fileName, contentBase64 });
      return { shapes, asset: { sourceIds: shapes.map((item) => item.id), fileName, contentBase64 } };
    } catch (error) {
      throw new Error(`PNG export failed for Penpot shape '${shape.name}' (${shape.id}): ${error.message}`);
    }
  });
  const assets = exported.map(({ shapes, asset }) => {
    for (const shape of shapes) {
      shape.fallbackAssetFileName = asset.fileName;
      shape.fallbackReason = "complex-penpot-layer";
    }
    return asset;
  });
  for (const shape of snapshot.shapes) {
    // A complex parent without an exported leaf remains native instead of
    // forcing a second overlapping PNG export.
    delete shape.exportPng;
  }
  const data = validatePenpotExport({ schemaVersion: 2, source: "penpot-plugin", exportedAt: new Date().toISOString(), file: snapshot.file, pages: [{ id: snapshot.page.id, name: snapshot.page.name, shapes: snapshot.shapes }], assets: assets.map(({ contentBase64, ...asset }) => asset) });
  const captured = { data, assets, importedDirectory: undefined };
  const importResult = importAssets ? await importCapturedAssets(captured, destinationAssetDirectory) : { importedCount: 0, assets: [] };
  if (importAssets) captured.importedDirectory = destinationAssetDirectory;
  return { data, assets, destinationAssetDirectory, importResult };
}

async function importCapturedAssets(captured, destinationAssetDirectory) {
  const directory = await mkdtemp(join(tmpdir(), "penpot-unity-mcp-"));
  try {
    const assetRequests = [];
    for (const asset of captured.assets) {
      const fileName = basename(asset.fileName);
      const sourceFilePath = join(directory, fileName);
      await writeFile(sourceFilePath, Buffer.from(asset.contentBase64, "base64"));
      assetRequests.push({ sourceFilePath, destinationAssetPath: `${destinationAssetDirectory.replace(/\/+$/, "")}/${fileName}`, overwrite: true, importAsSprite: true, pixelsPerUnit: 100 });
    }
    if (assetRequests.length === 0) return { importedCount: 0, assets: [] };
    const result = await bridgeRequest("/ui/copy-assets", { method: "POST", body: JSON.stringify({ assets: assetRequests }) });
    return { importedCount: assetRequests.length, assets: assetRequests.map((asset) => ({ destinationAssetPath: asset.destinationAssetPath })), message: result.message };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function mapChildAlignment(layoutType, align, justify) {
  const a = String(align || "start").toLowerCase();
  const j = String(justify || "start").toLowerCase();
  if (layoutType === "horizontal") {
    const v = a.includes("center") ? "Middle" : a.includes("end") ? "Lower" : "Upper";
    const h = j.includes("center") ? "Center" : j.includes("end") ? "Right" : "Left";
    return `${v}${h}`;
  } else if (layoutType === "vertical") {
    const v = j.includes("center") ? "Middle" : j.includes("end") ? "Lower" : "Upper";
    const h = a.includes("center") ? "Center" : a.includes("end") ? "Right" : "Left";
    return `${v}${h}`;
  }
  return "UpperLeft";
}

function buildApplyPayload(data, frameId, prefabPath, destinationAssetDirectory) {
  const plan = buildUiPlan(data, data.pages[0].id, frameId, prefabPath);
  const byId = new Map(plan.nodes.map((node) => [node.sourceId, node]));
  const safeName = (name) => String(name ?? "PenpotUi").replace(/\s*\/\s*/g, " - ").replace(/[:\\]/g, " ").trim();
  const pathFor = (node) => {
    if (!node.parentSourceId) return undefined;
    const parent = byId.get(node.parentSourceId);
    if (!parent) return undefined;
    const parentPath = pathFor(parent);
    return parentPath ? `${parentPath}/${safeName(parent.name)}` : safeName(parent.name);
  };
  const directory = destinationAssetDirectory.replace(/\/+$/, "");
  const isButton = (node) => /(?:button|btn|slot|tab|toggle)/i.test(node.name ?? "");
  const actions = plan.nodes.map((node) => {
    const childAlignment = node.autoLayout ? mapChildAlignment(node.autoLayout.type, node.autoLayout.alignItems, node.autoLayout.justifyContent) : undefined;
    return {
      operation: "upsert", parentPath: pathFor(node), name: safeName(node.name),
      elementType: node.kind === "text" ? "text" : isButton(node) ? "button" : (node.kind === "image" || Boolean(node.asset?.fileName)) ? "image" : (node.kind === "container" || !node.style?.color) ? "container" : "panel",
      x: node.rect.anchoredPosition.x, y: node.rect.anchoredPosition.y,
      width: node.rect.sizeDelta.x, height: node.rect.sizeDelta.y,
      color: node.asset?.fileName ? "#FFFFFFFF" : (node.style?.color ?? "#FFFFFFFF"), text: node.text?.value, fontSize: Number(node.text?.fontSize) || undefined,
      useResponsiveRect: true, anchorMinX: node.rect.anchorMin.x, anchorMinY: node.rect.anchorMin.y,
      anchorMaxX: node.rect.anchorMax.x, anchorMaxY: node.rect.anchorMax.y,
      pivotX: node.rect.pivot.x, pivotY: node.rect.pivot.y, sourceId: node.sourceId,
      accessibilityLabel: node.name,
      layoutType: node.autoLayout?.type,
      layoutSpacing: node.autoLayout?.gap ?? 0,
      paddingLeft: node.autoLayout?.paddingLeft ?? 0,
      paddingRight: node.autoLayout?.paddingRight ?? 0,
      paddingTop: node.autoLayout?.paddingTop ?? 0,
      paddingBottom: node.autoLayout?.paddingBottom ?? 0,
      childAlignment,
      childForceExpandWidth: false,
      childForceExpandHeight: false,
      borderRadius: node.borderRadius ?? 0,
      imageType: (node.borderRadius && node.borderRadius > 0) ? "sliced" : (node.asset?.imageType ?? "simple"),
      spriteAssetPath: node.asset?.fileName ? `${directory}/${node.asset.fileName}` : undefined,
      hasVisualFill: Boolean(node.style?.color || node.asset?.fileName),
      addRectMask: node.clipChildren === true
    };
  });
  return { plan, actions };
}

server.tool(
  "penpot_sync_selected_layout",
  "One automatic Penpot-to-Unity workflow. Provide layoutName to find a named Penpot frame, board, or group anywhere in the current Penpot file; otherwise it syncs the current Penpot selection. It exports only required leaf PNG assets, imports them in one Unity Editor request, then creates or updates all native UI, Buttons, colors, masks, layouts, and Sprite references in one Prefab apply request.",
  {
    prefabPath: z.string().regex(/^Assets\/.+\.prefab$/, "Must be a prefab path below Assets/"),
    layoutName: z.string().min(1).optional().describe("Exact Penpot frame, board, or group name anywhere in the current file. Omit only to use the current selection."),
    destinationAssetDirectory: z.string().regex(/^Assets\/PenpotUI\/.+/).optional(),
    createIfMissing: z.boolean().optional(),
    dryRun: z.boolean().optional().describe("Read Penpot and build the full Unity plan without importing assets or modifying Unity.")
  },
  async ({ prefabPath, layoutName, destinationAssetDirectory = "Assets/PenpotUI/Imported", createIfMissing = true, dryRun = false }) => {
    const captured = await captureSelectedLayout(destinationAssetDirectory, layoutName, !dryRun);
    const page = captured.data.pages[0];
    const frameId = page.shapes[0]?.id;
    if (!frameId) throw new Error("The selected Penpot layout did not contain a root frame.");
    const { plan, actions } = buildApplyPayload(captured.data, frameId, prefabPath, destinationAssetDirectory);
    if (dryRun) return jsonResult({ status: "dry-run", resolvedLayout: { id: frameId, name: plan.source.frameName, page: page.name }, nodeCount: actions.length, pngAssetCount: captured.assets.length, imageCount: actions.filter((action) => action.spriteAssetPath).length, buttonCount: actions.filter((action) => action.elementType === "button").length, containerCount: actions.filter((action) => action.elementType === "container").length });
    if (createIfMissing) {
      const rootName = String(page.shapes.find((shape) => shape.id === frameId)?.name ?? "PenpotUi").replace(/\s*\/\s*/g, " - ").replace(/[:\\]/g, " ").trim();
      try { await bridgeRequest("/ui/create-prefab", { method: "POST", body: JSON.stringify({ prefabPath, rootName }) }); }
      catch (error) {
        const message = String(error.message);
        if (!message.includes("already exists") && !message.includes("Refusing to overwrite")) throw error;
      }
    }
    const applied = await bridgeRequest("/ui/apply-plan", { method: "POST", body: JSON.stringify({ prefabPath, actions }) });
    return jsonResult({ status: "ok", prefabPath, importedCount: captured.importResult.importedCount, appliedCount: applied.applied, nodeCount: actions.length });
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
      operation: z.enum(["create", "upsert"]),
      parentPath: z.string().optional().describe("Path relative to the prefab root; omit for the root."),
      name: z.string(),
      elementType: z.enum(["container", "panel", "image", "button", "text"]),
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
      pivotX: z.number().min(0).max(1).optional(), pivotY: z.number().min(0).max(1).optional(),
      sourceId: z.string().optional(), componentId: z.string().optional(), instanceId: z.string().optional(),
      accessibilityLabel: z.string().optional(), accessibilityDescription: z.string().optional(),
      layoutType: z.enum(["horizontal", "vertical", "grid"]).optional(), layoutSpacing: z.number().optional(),
      paddingLeft: z.number().optional(), paddingRight: z.number().optional(), paddingTop: z.number().optional(), paddingBottom: z.number().optional(),
      childAlignment: z.string().optional(), childForceExpandWidth: z.boolean().optional(), childForceExpandHeight: z.boolean().optional(),
      borderRadius: z.number().optional(),
      spriteAssetPath: z.string().optional(), imageType: z.enum(["simple", "sliced"]).optional(), preserveAspect: z.boolean().optional(), addRectMask: z.boolean().optional(), hasVisualFill: z.boolean().optional()
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
  "Configure an Image on a prefab element. Supports Sprite assignment, Material assignment, Simple or Sliced 9-slice mode, borderRadius, and preserve aspect.",
  { prefabPath: z.string(), targetPath: z.string().optional(), spriteAssetPath: z.string().optional(), materialAssetPath: z.string().optional(), imageType: z.enum(["simple", "sliced"]).optional(), borderRadius: z.number().optional(), preserveAspect: z.boolean().optional() },
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

