/* Generated distribution file. Build from src/plugin.ts when esbuild is available. */
(function () {
  function fileName(shape) { var name = String(shape.name || "asset").replace(/[^a-z0-9-_]+/gi, "_").replace(/^_+|_+$/g, "") || "asset"; return name + "_" + String(shape.id).slice(0, 8) + ".png"; }
  function componentInfo(shape) {
    var componentId = shape.componentId || shape.mainComponentId || (shape.component && shape.component.id);
    var variantId = shape.variantId || (shape.variant && shape.variant.id);
    var variantName = shape.variantName || (shape.variant && shape.variant.name);
    var properties = shape.variantProperties || shape.componentProperties;
    var kind = componentId ? "instance" : ((shape.isComponent || shape.component) ? "component" : undefined);
    return kind || variantId || properties ? { kind:kind, componentId:componentId ? String(componentId) : undefined, variantId:variantId ? String(variantId) : undefined, variantName:variantName, properties:properties } : undefined;
  }
  function autoLayoutInfo(shape) {
    var layout = shape.layout || shape.autoLayout; if (!layout || typeof layout !== "object") return undefined;
    var direction = String(layout.direction || layout.layout || layout.flexDirection || "").toLowerCase();
    var type = direction.indexOf("horizontal") >= 0 || direction === "row" ? "horizontal" : (direction.indexOf("vertical") >= 0 || direction === "column" ? "vertical" : (direction.indexOf("grid") >= 0 ? "grid" : undefined));
    return { type:type, gap:layout.gap || layout.spacing, paddingLeft:layout.paddingLeft || (layout.padding && layout.padding.left), paddingRight:layout.paddingRight || (layout.padding && layout.padding.right), paddingTop:layout.paddingTop || (layout.padding && layout.padding.top), paddingBottom:layout.paddingBottom || (layout.padding && layout.padding.bottom), alignment:layout.alignment || layout.contentAlign || layout.justifyContent, wrap:layout.wrap || layout.flexWrap === "wrap", grow:layout.grow || layout.flexGrow > 0, raw:layout };
  }
  function exported(shape) {
    var constraints = shape.constraints || {};
    return { id:String(shape.id), name:shape.name || "Unnamed", type:shape.type || "unknown", parentId:shape.parent && shape.parent.id, childIds:Array.from(shape.children || [], function (child) { return String(child.id); }), x:shape.x, y:shape.y, width:shape.width, height:shape.height, rotation:shape.rotation, fills:shape.fills, strokes:shape.strokes, content:shape.content, layout:shape.layout, exports:shape.exports, constraints:{ horizontal:shape.constraintsHorizontal || constraints.horizontal || constraints.h, vertical:shape.constraintsVertical || constraints.vertical || constraints.v }, component:componentInfo(shape), autoLayout:autoLayoutInfo(shape), accessibility:{ label:String(shape.name || "Unnamed"), description:shape.description || (shape.accessibility && shape.accessibility.description), role:shape.type === "text" ? "text" : (shape.type === "image" ? "image" : "group") } };
  }
  function collect(shape, result, sources, visited) { if (!shape || visited[String(shape.id)]) return; visited[String(shape.id)] = true; result.push(exported(shape)); sources[String(shape.id)] = shape; Array.from(shape.children || []).forEach(function (child) { collect(child, result, sources, visited); }); }
  function reason(shape) {
    var fills = Array.isArray(shape.fills) ? shape.fills : [], strokes = Array.isArray(shape.strokes) ? shape.strokes : [];
    if (["image", "svg-raw", "path", "boolean"].indexOf(shape.type) >= 0) return "vector-or-image";
    if (fills.some(function (fill) { return fill.fillImage || fill.gradient || fill.fillColorGradient; })) return "image-or-gradient-fill";
    if (strokes.length) return "stroke";
    if (fills.length > 1) return "multiple-fills";
    if (shape.blur || (shape.blurs && shape.blurs.length) || (shape.blendMode && ["normal", "pass-through"].indexOf(String(shape.blendMode).toLowerCase()) < 0)) return "effect-or-blend-mode";
    var radius = shape.borderRadius;
    if ((typeof radius === "number" && radius > 0) || (Array.isArray(radius) && radius.some(function (value) { return Number(value) > 0; }))) return "rounded-corners";
  }
  var file = penpot.currentFile, exports = [], signatures = {};
  var pages = Array.from(file.pages || [], function (page) {
    var shapes = [], sources = {}, visited = {}; collect(page.root, shapes, sources, visited);
    shapes.forEach(function (shape) {
      var source = sources[shape.id], fallback = source && reason(source); if (!source || shape.type === "text" || !fallback) return;
      var signature = JSON.stringify({ reason:fallback, type:shape.type, width:shape.width, height:shape.height, fills:shape.fills, strokes:shape.strokes, borderRadius:source.borderRadius, blur:source.blur, blendMode:source.blendMode });
      var asset = signatures[signature];
      if (!asset) { var markup = penpot.generateMarkup([source], { type:"svg", withChildren:false }); if (typeof markup !== "string" || !markup.length) return; asset = { sourceIds:[], name:shape.name, width:shape.width || 1, height:shape.height || 1, fileName:fileName(source), fallbackReason:fallback, svgMarkup:markup }; signatures[signature] = asset; exports.push(asset); }
      asset.sourceIds.push(shape.id); shape.fallbackAssetFileName = asset.fileName; shape.fallbackReason = fallback;
    });
    return { id:String(page.id), name:page.name || "Untitled", shapes:shapes };
  });
  penpot.ui.open("Penpot Unity UI Exporter", "ui.html", { width:360, height:120 });
  penpot.ui.sendMessage({ type:"penpot-unity-ui-export", payload:{ schemaVersion:2, source:"penpot-plugin", exportedAt:new Date().toISOString(), file:{ id:String(file.id), name:file.name || "Untitled" }, pages:pages, assets:exports.map(function (asset) { return { sourceIds:asset.sourceIds, name:asset.name, width:asset.width, height:asset.height, fileName:asset.fileName, fallbackReason:asset.fallbackReason }; }), assetExports:exports } });
}());
