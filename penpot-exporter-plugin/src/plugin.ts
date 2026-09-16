/* global penpot */
declare const penpotUtils: any;

type ExportedShape = {
  id: string; name: string; type: string; parentId?: string; childIds: string[];
  x?: number; y?: number; width?: number; height?: number; rotation?: number;
  fills?: unknown; strokes?: unknown; content?: unknown; layout?: unknown; exports?: unknown;
  constraints?: { horizontal?: unknown; vertical?: unknown };
  component?: { kind?: string; componentId?: string; variantId?: string; variantName?: string; properties?: unknown };
  accessibility?: { label: string; description?: string; role?: string };
  autoLayout?: { type?: string; gap?: number; paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number; alignment?: string; wrap?: boolean; grow?: boolean; raw?: unknown };
  fallbackAssetFileName?: string; fallbackReason?: string;
};

type ExportedAsset = { sourceIds: string[]; name: string; width: number; height: number; fileName: string; fallbackReason: string; svgMarkup: string; };

function safeAssetFileName(shape: any): string {
  const name = String(shape.name ?? "asset").replace(/[^a-z0-9-_]+/gi, "_").replace(/^_+|_+$/g, "") || "asset";
  return `${name}_${String(shape.id).slice(0, 8)}.png`;
}

function componentInfo(shape: any): ExportedShape["component"] | undefined {
  const componentId = shape.componentId ?? shape.mainComponentId ?? shape.component?.id;
  const variantId = shape.variantId ?? shape.variant?.id;
  const variantName = shape.variantName ?? shape.variant?.name;
  const properties = shape.variantProperties ?? shape.componentProperties;
  const kind = componentId ? "instance" : (shape.isComponent || shape.component ? "component" : undefined);
  return kind || variantId || properties ? { kind, componentId: componentId ? String(componentId) : undefined, variantId: variantId ? String(variantId) : undefined, variantName, properties } : undefined;
}

function autoLayoutInfo(shape: any): ExportedShape["autoLayout"] | undefined {
  const layout = shape.layout ?? shape.autoLayout;
  if (!layout || typeof layout !== "object") return undefined;
  const direction = String(layout.direction ?? layout.layout ?? layout.flexDirection ?? "").toLowerCase();
  const type = direction.includes("horizontal") || direction === "row" ? "horizontal" : direction.includes("vertical") || direction === "column" ? "vertical" : direction.includes("grid") ? "grid" : undefined;
  return { type, gap: layout.gap ?? layout.spacing, paddingLeft: layout.paddingLeft ?? layout.padding?.left, paddingRight: layout.paddingRight ?? layout.padding?.right, paddingTop: layout.paddingTop ?? layout.padding?.top, paddingBottom: layout.paddingBottom ?? layout.padding?.bottom, alignment: layout.alignment ?? layout.contentAlign ?? layout.justifyContent, wrap: layout.wrap ?? layout.flexWrap === "wrap", grow: layout.grow ?? layout.flexGrow > 0, raw: layout };
}

function exportShape(shape: any): ExportedShape {
  const horizontal = shape.constraintsHorizontal ?? shape.constraints?.horizontal ?? shape.constraints?.h;
  const vertical = shape.constraintsVertical ?? shape.constraints?.vertical ?? shape.constraints?.v;
  return {
    id: String(shape.id), name: shape.name ?? "Unnamed", type: shape.type ?? "unknown",
    parentId: shape.parent?.id, childIds: Array.from(shape.children ?? [], (child: any) => String(child.id)),
    x: shape.x, y: shape.y, width: shape.width, height: shape.height, rotation: shape.rotation,
    fills: shape.fills, strokes: shape.strokes, content: shape.content, layout: shape.layout, exports: shape.exports,
    constraints: { horizontal, vertical }, component: componentInfo(shape), autoLayout: autoLayoutInfo(shape),
    accessibility: { label: String(shape.name ?? "Unnamed"), description: shape.description ?? shape.accessibility?.description, role: shape.type === "text" ? "text" : (shape.type === "image" ? "image" : "group") }
  };
}

function collectShapes(shape: any, output: ExportedShape[], sources: Map<string, any>, visited: Set<string>) {
  if (!shape || visited.has(String(shape.id))) return;
  visited.add(String(shape.id)); output.push(exportShape(shape)); sources.set(String(shape.id), shape);
  for (const child of Array.from(shape.children ?? [])) collectShapes(child, output, sources, visited);
}

function fallbackReason(shape: any): string | undefined {
  const fills = Array.isArray(shape.fills) ? shape.fills : [];
  const strokes = Array.isArray(shape.strokes) ? shape.strokes : [];
  if (["image", "svg-raw", "path", "boolean"].includes(shape.type)) return "vector-or-image";
  if (fills.some((fill: any) => fill.fillImage || fill.gradient || fill.fillColorGradient)) return "image-or-gradient-fill";
  if (strokes.length > 0) return "stroke";
  if (fills.length > 1) return "multiple-fills";
  if (shape.blur || shape.blurs?.length || (shape.blendMode && !["normal", "pass-through"].includes(String(shape.blendMode).toLowerCase()))) return "effect-or-blend-mode";
  const radius = shape.borderRadius;
  if (typeof radius === "number" ? radius > 0 : Array.isArray(radius) ? radius.some((value) => Number(value) > 0) : false) return "rounded-corners";
  return undefined;
}

const file: any = (penpot as any).currentFile;
const assetExports: ExportedAsset[] = [];
const assetBySignature = new Map<string, ExportedAsset>();
const pages = Array.from(file.pages ?? [], (page: any) => {
  const shapes: ExportedShape[] = []; const sources = new Map<string, any>(); const visited = new Set<string>();
  collectShapes(page.root, shapes, sources, visited);
  for (const shape of shapes) {
    const source = sources.get(shape.id); const reason = source ? fallbackReason(source) : undefined;
    if (!source || shape.type === "text" || !reason) continue;
    const signature = JSON.stringify({ reason, type: shape.type, width: shape.width, height: shape.height, fills: shape.fills, strokes: shape.strokes, borderRadius: source.borderRadius, blur: source.blur, blendMode: source.blendMode });
    let asset = assetBySignature.get(signature);
    if (!asset) {
      const markup = (penpot as any).generateMarkup([source], { type: "svg", withChildren: false });
      if (typeof markup !== "string" || markup.length === 0) continue;
      asset = { sourceIds: [], name: shape.name, width: shape.width ?? 1, height: shape.height ?? 1, fileName: safeAssetFileName(source), fallbackReason: reason, svgMarkup: markup };
      assetBySignature.set(signature, asset); assetExports.push(asset);
    }
    asset.sourceIds.push(shape.id); shape.fallbackAssetFileName = asset.fileName; shape.fallbackReason = reason;
  }
  return { id: String(page.id), name: page.name ?? "Untitled", shapes };
});

(penpot as any).ui.open("Penpot Unity UI Exporter", "ui.html", { width: 360, height: 120 });
(penpot as any).ui.sendMessage({ type: "penpot-unity-ui-export", payload: { schemaVersion: 2, source: "penpot-plugin", exportedAt: new Date().toISOString(), file: { id: String(file.id), name: file.name ?? "Untitled" }, pages, assets: assetExports.map(({ svgMarkup, ...asset }) => asset), assetExports } });
