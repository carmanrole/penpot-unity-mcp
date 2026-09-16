const containerTypes = new Set(["board", "group", "boolean"]);
const asNumber = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function firstFillColor(fills) {
  if (!Array.isArray(fills)) return undefined;
  const fill = fills.find((item) => item?.fillColor || item?.color);
  return fill?.fillColor ?? fill?.color;
}

function inferKind(shape) {
  if (shape.type === "text") return "text";
  if (shape.fallbackAssetFileName || ["rectangle", "ellipse", "image"].includes(shape.type)) return "image";
  if (containerTypes.has(shape.type)) return "container";
  return "vector";
}

function normalizeText(content) {
  if (typeof content === "string") return { value: content };
  if (!content || typeof content !== "object") return undefined;
  return { value: content.text ?? content.characters ?? "", fontSize: content.fontSize, fontFamily: content.fontFamily, fontWeight: content.fontWeight, alignment: content.align };
}

function normalizedConstraint(value) { return String(value ?? "").toLowerCase().replace(/[^a-z]/g, ""); }

function horizontalRect(mode, left, right, width, frameWidth) {
  if (["left", "start"].includes(mode)) return { min: 0, max: 0, pivot: 0, position: left, size: width };
  if (["right", "end"].includes(mode)) return { min: 1, max: 1, pivot: 1, position: -right, size: width };
  if (["leftright", "both", "stretch", "scale"].includes(mode)) return { min: 0, max: 1, pivot: .5, position: (left - right) / 2, size: -(left + right) };
  return { min: .5, max: .5, pivot: .5, position: left + width / 2 - frameWidth / 2, size: width };
}

function verticalRect(mode, top, bottom, height, frameHeight) {
  if (["top", "start"].includes(mode)) return { min: 1, max: 1, pivot: 1, position: -top, size: height };
  if (["bottom", "end"].includes(mode)) return { min: 0, max: 0, pivot: 0, position: bottom, size: height };
  if (["topbottom", "both", "stretch", "scale"].includes(mode)) return { min: 0, max: 1, pivot: .5, position: (bottom - top) / 2, size: -(top + bottom) };
  return { min: .5, max: .5, pivot: .5, position: frameHeight / 2 - top - height / 2, size: height };
}

function toRect(shape, frame) {
  const left = asNumber(shape.x) - asNumber(frame.x); const top = asNumber(shape.y) - asNumber(frame.y);
  const width = asNumber(shape.width); const height = asNumber(shape.height);
  const horizontal = horizontalRect(normalizedConstraint(shape.constraints?.horizontal), left, asNumber(frame.width) - left - width, width, asNumber(frame.width));
  const vertical = verticalRect(normalizedConstraint(shape.constraints?.vertical), top, asNumber(frame.height) - top - height, height, asNumber(frame.height));
  return {
    anchorMin: { x: horizontal.min, y: vertical.min }, anchorMax: { x: horizontal.max, y: vertical.max }, pivot: { x: horizontal.pivot, y: vertical.pivot },
    anchoredPosition: { x: horizontal.position, y: vertical.position }, sizeDelta: { x: horizontal.size, y: vertical.size }
  };
}

function makeNode(shape, frame, includedIds) {
  const node = { sourceId: shape.id, parentSourceId: includedIds.has(shape.parentId) ? shape.parentId : null, name: shape.name || "Unnamed", kind: inferKind(shape), rect: toRect(shape, frame) };
  const color = firstFillColor(shape.fills); if (color) node.style = { color };
  const text = normalizeText(shape.content); if (text) node.text = text;
  if (shape.layout) node.layout = shape.layout;
  if (shape.constraints) node.constraints = shape.constraints;
  if (shape.component) node.component = shape.component;
  if (shape.autoLayout) node.autoLayout = shape.autoLayout;
  if (shape.accessibility) node.accessibility = shape.accessibility;
  if (shape.fallbackAssetFileName) node.asset = { fileName: shape.fallbackAssetFileName, reason: shape.fallbackReason, imageType: "simple" };
  return node;
}

export function buildUiPlan(exportData, pageId, frameId, prefabPath) {
  const page = exportData.pages.find((item) => item.id === pageId); if (!page) throw new Error(`Page not found: ${pageId}`);
  const byId = new Map(page.shapes.map((shape) => [shape.id, shape])); const frame = byId.get(frameId);
  if (!frame) throw new Error(`Penpot root node not found: ${frameId}`);
  const includedIds = new Set();
  const visit = (shape) => { if (!shape || includedIds.has(shape.id)) return; includedIds.add(shape.id); (shape.childIds ?? []).forEach((childId) => visit(byId.get(childId))); };
  visit(frame);
  const nodes = page.shapes.filter((shape) => shape.id !== frame.id && includedIds.has(shape.id)).map((shape) => makeNode(shape, frame, includedIds));
  return { schemaVersion: 2, source: { fileId: exportData.file.id, pageId: page.id, frameId: frame.id, frameName: frame.name }, target: { prefabPath, referenceResolution: { width: asNumber(frame.width), height: asNumber(frame.height) }, coordinateSystem: "penpot-top-left-to-unity-responsive" }, nodes };
}
