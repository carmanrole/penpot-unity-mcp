const containerTypes = new Set(["board", "group", "boolean"]);
const asNumber = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function firstFillColor(fills) {
  if (!Array.isArray(fills)) return undefined;
  const fill = fills.find((item) => item?.fillColor || item?.color);
  return fill?.fillColor ?? fill?.color;
}

function inferKind(shape) {
  const text = normalizeText(shape.content);
  if (shape.type === "text" || (text && text.value && text.value.trim().length > 0)) return "text";
  if (shape.fallbackAssetFileName || shape.type === "image") return "image";
  // An empty rectangle is commonly a clipping or spacing layer. Rendering it
  // as a Unity Image gives it Unity's default white sprite/color.
  if (["rectangle", "ellipse"].includes(shape.type) && firstFillColor(shape.fills)) return "image";
  if (containerTypes.has(shape.type)) return "container";
  return "container";
}

function normalizeText(content) {
  if (typeof content === "string") return { value: content };
  if (!content || typeof content !== "object") return undefined;
  return { value: content.text ?? content.characters ?? "", fontSize: content.fontSize, fontFamily: content.fontFamily, fontWeight: content.fontWeight, alignment: content.align, verticalAlign: content.verticalAlign };
}

function normalizedConstraint(value) { return String(value ?? "").toLowerCase().replace(/[^a-z]/g, ""); }

function horizontalRect(mode, left, right, width, frameWidth) {
  if (mode === "scale" && frameWidth > 0) return { min: left / frameWidth, max: (left + width) / frameWidth, pivot: .5, position: 0, size: 0 };
  if (["left", "start"].includes(mode)) return { min: 0, max: 0, pivot: 0, position: left, size: width };
  if (["right", "end"].includes(mode)) return { min: 1, max: 1, pivot: 1, position: -right, size: width };
  if (["leftright", "both", "stretch"].includes(mode)) return { min: 0, max: 1, pivot: .5, position: (left - right) / 2, size: -(left + right) };
  return { min: .5, max: .5, pivot: .5, position: left + width / 2 - frameWidth / 2, size: width };
}

function verticalRect(mode, top, bottom, height, frameHeight) {
  if (mode === "scale" && frameHeight > 0) return { min: bottom / frameHeight, max: (bottom + height) / frameHeight, pivot: .5, position: 0, size: 0 };
  if (["top", "start"].includes(mode)) return { min: 1, max: 1, pivot: 1, position: -top, size: height };
  if (["bottom", "end"].includes(mode)) return { min: 0, max: 0, pivot: 0, position: bottom, size: height };
  if (["topbottom", "both", "stretch"].includes(mode)) return { min: 0, max: 1, pivot: .5, position: (bottom - top) / 2, size: -(top + bottom) };
  return { min: .5, max: .5, pivot: .5, position: frameHeight / 2 - top - height / 2, size: height };
}

function toRect(shape, parent, frame) {
  const isDirectChild = !parent || parent.id === frame?.id;
  const parentWidth = asNumber(parent?.width, asNumber(frame?.width, 1920));
  const parentHeight = asNumber(parent?.height, asNumber(frame?.height, 1080));
  const frameX = asNumber(frame?.x);
  const frameY = asNumber(frame?.y);
  const parentX = isDirectChild ? frameX : asNumber(parent?.x, frameX);
  const parentY = isDirectChild ? frameY : asNumber(parent?.y, frameY);
  const localX = asNumber(shape.parentX, asNumber(shape.x) - parentX);
  const localY = asNumber(shape.parentY, asNumber(shape.y) - parentY);
  const width = asNumber(shape.width);
  const height = asNumber(shape.height);
  const horizontal = horizontalRect(normalizedConstraint(shape.constraints?.horizontal ?? (parent?.type === "group" ? "scale" : "left")), localX, parentWidth - localX - width, width, parentWidth);
  const vertical = verticalRect(normalizedConstraint(shape.constraints?.vertical ?? (parent?.type === "group" ? "scale" : "top")), localY, parentHeight - localY - height, height, parentHeight);
  return {
    anchorMin: { x: horizontal.min, y: vertical.min }, anchorMax: { x: horizontal.max, y: vertical.max }, pivot: { x: horizontal.pivot, y: vertical.pivot },
    anchoredPosition: { x: horizontal.position, y: vertical.position }, sizeDelta: { x: horizontal.size, y: vertical.size }
  };
}

function makeNode(shape, parent, frame, includedIds) {
  const node = { sourceId: shape.id, parentSourceId: includedIds.has(shape.parentId) ? shape.parentId : null, name: shape.name || "Unnamed", kind: inferKind(shape), rect: toRect(shape, parent, frame) };
  const color = firstFillColor(shape.fills); if (color) node.style = { color };
  const text = normalizeText(shape.content) || (shape.characters ? { value: String(shape.characters) } : undefined);
  if (text) node.text = text;
  if (shape.borderRadius > 0) node.borderRadius = shape.borderRadius;
  if (shape.hidden) node.hidden = true;
  if (shape.layout) node.layout = shape.layout;
  if (shape.constraints) node.constraints = shape.constraints;
  if (shape.component) node.component = shape.component;
  if (shape.autoLayout) node.autoLayout = shape.autoLayout;
  if (shape.accessibility) node.accessibility = shape.accessibility;
  if (shape.isMask || shape.clipContent) node.clipChildren = true;
  if (node.kind === "text") {
    delete node.asset;
  } else if (shape.fallbackAssetFileName) {
    node.asset = { fileName: shape.fallbackAssetFileName, reason: shape.fallbackReason, imageType: (shape.borderRadius > 0) ? "sliced" : "simple" };
  }
  return node;
}

export function buildUiPlan(exportData, pageId, frameId, prefabPath) {
  const page = exportData.pages.find((item) => item.id === pageId); if (!page) throw new Error(`Page not found: ${pageId}`);
  const byId = new Map(page.shapes.map((shape) => [shape.id, shape])); const frame = byId.get(frameId);
  if (!frame) throw new Error(`Penpot root node not found: ${frameId}`);
  const includedIds = new Set();
  const visit = (shape) => {
    if (!shape || includedIds.has(shape.id)) return;
    includedIds.add(shape.id);
    if (!shape.flattenedPngGroup) (shape.childIds ?? []).forEach((childId) => visit(byId.get(childId)));
  };
  visit(frame);
  const nodes = Array.from(includedIds, id => byId.get(id)).filter((shape) => shape.id !== frame.id && includedIds.has(shape.id) && !shape.skipNative).map((shape) => {
    const parentShape = byId.get(shape.parentId) || frame;
    return makeNode(shape, parentShape, frame, includedIds);
  });
  if (frame.fallbackAssetFileName || firstFillColor(frame.fills)) {
    nodes.unshift({
      sourceId: `${frame.id}_bg`,
      parentSourceId: null,
      name: "Background",
      kind: "image",
      rect: {
        anchorMin: { x: 0, y: 0 }, anchorMax: { x: 1, y: 1 }, pivot: { x: .5, y: .5 },
        anchoredPosition: { x: 0, y: 0 }, sizeDelta: { x: 0, y: 0 }
      },
      style: frame.fills ? { color: firstFillColor(frame.fills) } : undefined,
      asset: frame.fallbackAssetFileName ? { fileName: frame.fallbackAssetFileName, imageType: "simple" } : undefined
    });
  }
  return { schemaVersion: 2, source: { fileId: exportData.file.id, pageId: page.id, frameId: frame.id, frameName: frame.name }, target: { prefabPath, clipChildren: Boolean(frame.clipContent || frame.isMask), referenceResolution: { width: asNumber(frame.width), height: asNumber(frame.height) }, coordinateSystem: "penpot-top-left-to-unity-responsive" }, nodes };
}
