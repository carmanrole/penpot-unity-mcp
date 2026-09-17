#if UNITY_EDITOR
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace PenpotUnityUiMcp
{
    /// <summary>
    /// Local-only HTTP bridge for the Penpot Unity UI MCP server.
    /// It exposes a deliberately small, UI-specific API; it never evaluates arbitrary C#.
    /// </summary>
    public sealed class PenpotUnityUiMcpBridge : EditorWindow
    {
        private const int Port = 8091;
        private const string Address = "http://127.0.0.1:8091/";
        private const int RequestTimeoutMs = 10000;
        private static readonly object ListenerLock = new object();
        private static readonly ConcurrentQueue<EditorRequest> EditorRequests = new ConcurrentQueue<EditorRequest>();
        private static readonly ConcurrentQueue<ConsoleEntry> ConsoleEntries = new ConcurrentQueue<ConsoleEntry>();
        private static HttpListener listener;
        private static CancellationTokenSource cancellation;
        private static Task listenerTask;
        private static bool hooksRegistered;
        private static SynchronizationContext unitySynchronizationContext;

        [InitializeOnLoadMethod]
        private static void InitializeBridgeEditorLoop()
        {
            RegisterHooks();
            unitySynchronizationContext = SynchronizationContext.Current;
            EditorApplication.update -= ProcessEditorRequests;
            EditorApplication.update += ProcessEditorRequests;
            EditorApplication.delayCall += () => StartBridge();
        }

        [Serializable] private class Response { public string status; public string message; }
        [Serializable] private class JobAcceptedResponse { public string status; public string jobId; }
        [Serializable] private class JobStatusResponse { public string status; public string jobId; public string state; public string resultJson; }
        [Serializable] private class CapabilityResponse { public string status; public string[] tools; }
        [Serializable] private class ContextResponse { public string status; public UiObject[] canvases; }
        [Serializable] private class UiObject { public string name; public string path; public int instanceId; public string[] components; }
        [Serializable] private class CreatePrefabRequest { public string prefabPath; public string rootName; public float width = 1920f; public float height = 1080f; }
        [Serializable] private class CreatePrefabResponse { public string status; public string message; public string prefabPath; }
        [Serializable] private class PlanRequest { public string prefabPath; public UiAction[] actions; }
        [Serializable] private class UiAction
        {
            public string operation;
            public string parentPath;
            public string name;
            public string elementType;
            public float x;
            public float y;
            public float width = 100f;
            public float height = 100f;
            public string color = "#FFFFFFFF";
            public string text;
            public float fontSize = 24f;
            public bool useResponsiveRect;
            public float anchorMinX; public float anchorMinY; public float anchorMaxX = 1f; public float anchorMaxY = 1f;
            public float pivotX = .5f; public float pivotY = .5f;
            public string sourceId; public string componentId; public string instanceId;
            public string accessibilityLabel; public string accessibilityDescription;
            public string layoutType; public float layoutSpacing; public float paddingLeft; public float paddingRight; public float paddingTop; public float paddingBottom;
            public string childAlignment; public bool childForceExpandWidth; public bool childForceExpandHeight;
            public bool childControlWidth = true; public bool childControlHeight = true;
            public string spriteAssetPath; public string imageType = "simple"; public float borderRadius; public bool preserveAspect; public bool addRectMask; public bool hasVisualFill = true;
        }
        [Serializable] private class PlanResponse { public string status; public string message; public int applied; }
        [Serializable] private class AssetSearchRequest { public string query; public string assetType; }
        [Serializable] private class AssetSearchResponse { public string status; public string[] assetPaths; }
        [Serializable] private class SpriteImportRequest { public string assetPath; public float pixelsPerUnit = 100f; }
        [Serializable] private class AssetCopyRequest { public string sourceFilePath; public string destinationAssetPath; public bool overwrite; public bool importAsSprite = true; public float pixelsPerUnit = 100f; }
        [Serializable] private class AssetBatchCopyRequest { public AssetCopyRequest[] assets; }
        [Serializable] private class ConsoleResponse { public string status; public ConsoleEntry[] entries; }
        [Serializable] private class ConsoleEntry { public string condition; public string stackTrace; public string type; }
        [Serializable] private class PrefabTargetRequest { public string prefabPath; public string targetPath; }
        [Serializable] private class RectTransformRequest
        {
            public string prefabPath; public string targetPath;
            public float anchorMinX; public float anchorMinY; public float anchorMaxX = 1f; public float anchorMaxY = 1f;
            public float pivotX = .5f; public float pivotY = .5f; public float x; public float y; public float width = 100f; public float height = 100f;
        }
        [Serializable] private class ComponentRequest { public string prefabPath; public string targetPath; public string componentType; }
        [Serializable] private class SerializedFieldRequest { public string prefabPath; public string targetPath; public string componentType; public string fieldPath; public string value; public string objectReferenceAssetPath; }
        [Serializable] private class FileWriteRequest { public string assetPath; public string content; public bool overwrite; }
        [Serializable] private class ScriptRunRequest { public string assetPath; public string methodName = "Run"; }
        [Serializable] private class CaptureRequest { public string outputPath; }
        [Serializable] private class CaptureResponse { public string status; public string message; public string assetPath; public string fullPath; }
        [Serializable] private class CompilationStatusResponse { public string status; public bool isCompiling; public bool isUpdating; public ConsoleEntry[] errors; }
        [Serializable] private class ValidationRequest { public string prefabPath; public bool checkActiveScene = true; }
        [Serializable] private class ValidationIssue { public string severity; public string code; public string path; public string component; public string message; }
        [Serializable] private class ValidationResponse { public string status; public ValidationIssue[] issues; public int errorCount; public int warningCount; }
        [Serializable] private class ImageStyleRequest { public string prefabPath; public string targetPath; public string spriteAssetPath; public string materialAssetPath; public string imageType = "simple"; public float borderRadius; public bool preserveAspect; }
        [Serializable] private class TextStyleRequest { public string prefabPath; public string targetPath; public string text; public string fontAssetPath; public float fontSize = 24f; public string color = "#FFFFFFFF"; public string alignment = "Center"; public bool enableWordWrapping = true; public string overflowMode = "Overflow"; }
        [Serializable] private class LayoutRequest { public string prefabPath; public string targetPath; public string layoutType; public float spacing; public float paddingLeft; public float paddingRight; public float paddingTop; public float paddingBottom; public int constraintCount = 1; public string childAlignment = "UpperLeft"; public bool childForceExpandWidth; public bool childForceExpandHeight; public bool childControlWidth = true; public bool childControlHeight = true; }
        [Serializable] private class ControlRequest { public string prefabPath; public string targetPath; public string controlType; public bool addMask; }
        [Serializable] private class SelectableStyleRequest { public string prefabPath; public string targetPath; public string transition = "ColorTint"; public string navigation = "Automatic"; public string normalColor = "#FFFFFFFF"; public string highlightedColor = "#FFFFFFFF"; public string pressedColor = "#C8C8C8FF"; public string disabledColor = "#78787880"; }

        private sealed class EditorRequest
        {
            public Func<string> Execute;
            public readonly ManualResetEventSlim Completed = new ManualResetEventSlim(false);
            public string Result;
        }

        private static bool IsConnected
        {
            get { lock (ListenerLock) return listener != null && listener.IsListening; }
        }

        [MenuItem("Tools/Penpot Unity UI MCP")]
        public static void OpenWindow()
        {
            var window = GetWindow<PenpotUnityUiMcpBridge>();
            window.titleContent = new GUIContent("Penpot UI MCP");
            window.minSize = new Vector2(360f, 150f);
            window.Show();
        }

        [InitializeOnLoadMethod]
        private static void RegisterLifecycleHooks()
        {
            AssemblyReloadEvents.beforeAssemblyReload -= StopBridgeBeforeReload;
            AssemblyReloadEvents.beforeAssemblyReload += StopBridgeBeforeReload;
            EditorApplication.quitting -= StopBridgeBeforeReload;
            EditorApplication.quitting += StopBridgeBeforeReload;
        }

        private static void StopBridgeBeforeReload()
        {
            // A listener thread survives long enough to keep 8091 occupied if an
            // assembly reload discards the static listener reference first.
            StopBridge();
        }

        private void OnEnable() { EditorApplication.update += Repaint; }
        private void OnDisable() { EditorApplication.update -= Repaint; }

        private void OnGUI()
        {
            GUILayout.Space(12f);
            bool connected = IsConnected;
            EditorGUILayout.HelpBox(connected ? "Connected: UI-only local bridge is running." : "Disconnected", connected ? MessageType.Info : MessageType.Warning);
            using (new EditorGUILayout.HorizontalScope())
            {
                using (new EditorGUI.DisabledScope(connected))
                    if (GUILayout.Button("Connect", GUILayout.Height(28f))) StartBridge();
                using (new EditorGUI.DisabledScope(!connected))
                    if (GUILayout.Button("Disconnect", GUILayout.Height(28f))) StopBridge();
            }
            GUILayout.Space(8f);
            EditorGUILayout.SelectableLabel(Address, EditorStyles.textField, GUILayout.Height(18f));
            EditorGUILayout.LabelField("MCP server endpoint", "Set PENPOT_UNITY_UI_BRIDGE_URL to this address.");
        }

        public static void StartBridge()
        {
            RegisterHooks();
            lock (ListenerLock)
            {
                if (listener != null && listener.IsListening) return;
                try
                {
                    listener = new HttpListener();
                    listener.Prefixes.Add(Address);
                    listener.Start();
                    cancellation = new CancellationTokenSource();
                    listenerTask = ListenAsync(listener, cancellation.Token);
                    InitializeBridgeEditorLoop();
                    Debug.Log("[Penpot UI MCP] Bridge connected at " + Address);
                }
                catch (Exception exception)
                {
                    Debug.LogError("[Penpot UI MCP] Failed to start bridge: " + exception.Message);
                    StopBridge();
                }
            }
        }

        public static void StopBridge()
        {
            EditorApplication.update -= ProcessEditorRequests;
            lock (ListenerLock)
            {
                try { cancellation?.Cancel(); } catch { }
                try { listener?.Stop(); } catch { }
                try { listener?.Close(); } catch { }
                try { cancellation?.Dispose(); } catch { }
                listener = null;
                cancellation = null;
                listenerTask = null;
            }
            Debug.Log("[Penpot UI MCP] Bridge disconnected");
        }

        private static void RegisterHooks()
        {
            if (hooksRegistered) return;
            hooksRegistered = true;
            EditorApplication.quitting += StopBridge;
            AssemblyReloadEvents.beforeAssemblyReload += StopBridge;
            Application.logMessageReceivedThreaded += CaptureConsole;
        }

        private static async Task ListenAsync(HttpListener activeListener, CancellationToken token)
        {
            while (!token.IsCancellationRequested && activeListener.IsListening)
            {
                try { HandleRequest(await activeListener.GetContextAsync()); }
                catch (HttpListenerException) when (token.IsCancellationRequested) { break; }
                catch (ObjectDisposedException) { break; }
                catch (Exception exception) { Debug.LogWarning("[Penpot UI MCP] Listener error: " + exception.Message); }
            }
        }

        private static void HandleRequest(HttpListenerContext context)
        {
            string response;
            try
            {
                string route = context.Request.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant();
                if (context.Request.HttpMethod == "GET" && route == "/health") response = JsonUtility.ToJson(new Response { status = "ok", message = "penpot-unity-ui-bridge" });
                else if (context.Request.HttpMethod == "GET" && route == "/capabilities") response = JsonUtility.ToJson(new CapabilityResponse { status = "ok", tools = new[] { "get_ui_context", "ensure_scene_ui", "get_prefab_hierarchy", "validate_ui_prefab", "get_compilation_status", "create_ui_prefab", "apply_ui_plan", "delete_ui_element", "set_rect_transform", "add_ui_component", "remove_ui_component", "set_serialized_field", "configure_image", "configure_tmp_text", "configure_layout", "add_ui_control", "configure_selectable", "search_ui_assets", "import_ui_sprite", "copy_ui_asset", "copy_ui_assets", "write_ui_file", "run_ui_editor_script", "get_console", "capture_game_view" } });
                else if (context.Request.HttpMethod == "GET" && route == "/ui/job-status") response = GetJobStatus(context.Request.QueryString["id"]);
                else response = QueueJob(route, ReadBody(context.Request));
            }
            catch (Exception exception)
            {
                Debug.LogError("[Penpot Unity UI MCP] HTTP request failed: " + exception);
                response = JsonUtility.ToJson(new Response { status = "error", message = "Bridge request failed. See the Unity Console for '[Penpot Unity UI MCP]' details. " + exception.Message });
            }

            byte[] bytes = Encoding.UTF8.GetBytes(response);
            context.Response.StatusCode = response.Contains("\"status\":\"error\"") ? 400 : 200;
            context.Response.ContentType = "application/json";
            context.Response.ContentEncoding = Encoding.UTF8;
            context.Response.OutputStream.Write(bytes, 0, bytes.Length);
            context.Response.Close();
        }

        private static string Dispatch(string route, string body)
        {
            switch (route)
            {
                case "/ui/context": return GetUiContext();
                case "/ui/validate-prefab": return ValidatePrefab(JsonUtility.FromJson<ValidationRequest>(body));
                case "/ui/compilation-status": return GetCompilationStatus();
                case "/ui/ensure-scene-ui": return EnsureSceneUi();
                case "/ui/prefab-hierarchy": return GetPrefabHierarchy(JsonUtility.FromJson<PrefabTargetRequest>(body));
                case "/ui/create-prefab": return CreatePrefab(JsonUtility.FromJson<CreatePrefabRequest>(body));
                case "/ui/apply-plan": return ApplyPlan(JsonUtility.FromJson<PlanRequest>(body));
                case "/ui/delete-element": return DeleteElement(JsonUtility.FromJson<PrefabTargetRequest>(body));
                case "/ui/set-rect-transform": return SetRectTransform(JsonUtility.FromJson<RectTransformRequest>(body));
                case "/ui/add-component": return ChangeComponent(JsonUtility.FromJson<ComponentRequest>(body), true);
                case "/ui/remove-component": return ChangeComponent(JsonUtility.FromJson<ComponentRequest>(body), false);
                case "/ui/set-serialized-field": return SetSerializedField(JsonUtility.FromJson<SerializedFieldRequest>(body));
                case "/ui/configure-image": return ConfigureImage(JsonUtility.FromJson<ImageStyleRequest>(body));
                case "/ui/configure-tmp-text": return ConfigureTmpText(JsonUtility.FromJson<TextStyleRequest>(body));
                case "/ui/configure-layout": return ConfigureLayout(JsonUtility.FromJson<LayoutRequest>(body));
                case "/ui/add-ui-control": return AddUiControl(JsonUtility.FromJson<ControlRequest>(body));
                case "/ui/configure-selectable": return ConfigureSelectable(JsonUtility.FromJson<SelectableStyleRequest>(body));
                case "/ui/search-assets": return SearchAssets(JsonUtility.FromJson<AssetSearchRequest>(body));
                case "/ui/import-sprite": return ImportSprite(JsonUtility.FromJson<SpriteImportRequest>(body));
                case "/ui/copy-asset": return CopyUiAsset(JsonUtility.FromJson<AssetCopyRequest>(body));
                case "/ui/copy-assets": return CopyUiAssets(JsonUtility.FromJson<AssetBatchCopyRequest>(body));
                case "/ui/write-file": return WriteUiFile(JsonUtility.FromJson<FileWriteRequest>(body));
                case "/ui/run-editor-script": return RunEditorScript(JsonUtility.FromJson<ScriptRunRequest>(body));
                case "/ui/console": return GetConsole();
                case "/ui/capture-game-view": return CaptureGameView(JsonUtility.FromJson<CaptureRequest>(body));
                default: return JsonUtility.ToJson(new Response { status = "error", message = "Unknown route: " + route });
            }
        }

        private static string QueueJob(string route, string body)
        {
            var job = PenpotUnityUiMcpJobStore.Enqueue(route, body);

            // EditorApplication.update normally drains this queue.  Posting to Unity's
            // editor synchronization context also wakes the queue immediately when the
            // editor is idle, so the bridge does not depend on this window being open.
            var synchronizationContext = unitySynchronizationContext;
            if (synchronizationContext != null)
            {
                synchronizationContext.Post(_ => ProcessEditorRequests(), null);
            }

            return JsonUtility.ToJson(new JobAcceptedResponse { status = "accepted", jobId = job.id });
        }

        private static string GetJobStatus(string jobId)
        {
            if (string.IsNullOrWhiteSpace(jobId) || !PenpotUnityUiMcpJobStore.TryGet(jobId, out var job)) return Error("Job was not found.");
            return JsonUtility.ToJson(new JobStatusResponse { status = "ok", jobId = job.id, state = job.state, resultJson = job.resultJson });
        }

        private static string ExecuteOnEditorThread(Func<string> operation)
        {
            var request = new EditorRequest { Execute = operation };
            EditorRequests.Enqueue(request);
            var synchronizationContext = unitySynchronizationContext;
            if (synchronizationContext == null)
            {
                EditorRequests.TryDequeue(out _);
                return JsonUtility.ToJson(new Response { status = "error", message = "Unity main-thread scheduler is not initialized. Reconnect the bridge from Tools > Penpot Unity UI MCP." });
            }
            synchronizationContext.Post(_ => ProcessEditorRequests(), null);
            if (!request.Completed.Wait(RequestTimeoutMs))
            {
                Debug.LogError("[Penpot Unity UI MCP] Editor request timed out after 10 seconds. The HTTP bridge received the request, but Unity did not execute the main-thread queue. Disconnect and reconnect the bridge after Unity finishes compiling.");
                return JsonUtility.ToJson(new Response { status = "error", message = "Unity Editor did not process this request within 10 seconds. Check the Unity Console for '[Penpot Unity UI MCP] Editor request timed out'." });
            }
            return request.Result;
        }

        private static void ProcessEditorRequests()
        {
            while (PenpotUnityUiMcpJobStore.Pending.TryDequeue(out var job))
            {
                job.state = "running";
                try { PenpotUnityUiMcpJobStore.Complete(job, Dispatch(job.route, job.body)); }
                catch (Exception exception)
                {
                    Debug.LogError("[Penpot Unity UI MCP] Main-thread request failed: " + exception);
                    PenpotUnityUiMcpJobStore.Complete(job, JsonUtility.ToJson(new Response { status = "error", message = "Unity main-thread request failed. See the Unity Console for '[Penpot Unity UI MCP]' details. " + exception.Message }));
                }
            }
        }


        private static string GetUiContext()
        {
            var canvases = new List<UiObject>();
            foreach (var canvas in Resources.FindObjectsOfTypeAll<Canvas>())
            {
                if (!canvas.gameObject.scene.IsValid()) continue;
                var names = new List<string>();
                foreach (var component in canvas.GetComponents<Component>()) if (component != null) names.Add(component.GetType().Name);
                canvases.Add(new UiObject { name = canvas.name, path = GetPath(canvas.transform), instanceId = canvas.GetInstanceID(), components = names.ToArray() });
            }
            return JsonUtility.ToJson(new ContextResponse { status = "ok", canvases = canvases.ToArray() });
        }

        private static string EnsureSceneUi()
        {
            var canvas = UnityEngine.Object.FindFirstObjectByType<Canvas>();
            if (canvas == null)
            {
                var canvasObject = new GameObject("Canvas", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
                canvas = canvasObject.GetComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                var scaler = canvasObject.GetComponent<CanvasScaler>();
                scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(1920f, 1080f);
                scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            }
            if (UnityEngine.Object.FindFirstObjectByType<EventSystem>() == null)
                new GameObject("EventSystem", typeof(EventSystem), typeof(StandaloneInputModule));
            return JsonUtility.ToJson(new Response { status = "ok", message = "Canvas and EventSystem are available." });
        }

        private static string CreatePrefab(CreatePrefabRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.prefabPath)) return Error("prefabPath is required.");
            if (!request.prefabPath.StartsWith("Assets/", StringComparison.Ordinal) || !request.prefabPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) return Error("prefabPath must be an .prefab path under Assets/.");
            if (AssetDatabase.LoadAssetAtPath<GameObject>(request.prefabPath) != null) return Error("Refusing to overwrite an existing prefab.");
            string directory = Path.GetDirectoryName(request.prefabPath)?.Replace('\\', '/');
            if (string.IsNullOrWhiteSpace(directory) || !AssetDatabase.IsValidFolder(directory)) return Error("The prefab destination folder must already exist.");

            var root = new GameObject(string.IsNullOrWhiteSpace(request.rootName) ? "PenpotUi" : request.rootName, typeof(RectTransform));
            var rect = root.GetComponent<RectTransform>();
            rect.sizeDelta = new Vector2(Mathf.Max(1, request.width), Mathf.Max(1, request.height));
            PrefabUtility.SaveAsPrefabAsset(root, request.prefabPath);
            DestroyImmediate(root);
            AssetDatabase.SaveAssets();
            return JsonUtility.ToJson(new CreatePrefabResponse { status = "ok", message = "UI prefab created.", prefabPath = request.prefabPath });
        }

        private static string GetPrefabHierarchy(PrefabTargetRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.prefabPath)) return Error("prefabPath is required.");
            var root = PrefabUtility.LoadPrefabContents(request.prefabPath);
            if (root == null) return Error("Prefab was not found.");
            try
            {
                var items = new List<UiObject>();
                CollectPrefabHierarchy(root.transform, root.transform, items);
                return JsonUtility.ToJson(new ContextResponse { status = "ok", canvases = items.ToArray() });
            }
            finally { PrefabUtility.UnloadPrefabContents(root); }
        }

        private static void CollectPrefabHierarchy(Transform node, Transform root, List<UiObject> items)
        {
            var components = new List<string>();
            foreach (var component in node.GetComponents<Component>()) if (component != null) components.Add(component.GetType().Name);
            items.Add(new UiObject { name = node.name, path = GetRelativePath(root, node), instanceId = node.GetInstanceID(), components = components.ToArray() });
            for (var i = 0; i < node.childCount; i++) CollectPrefabHierarchy(node.GetChild(i), root, items);
        }

        private static string ValidatePrefab(ValidationRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.prefabPath)) return Error("prefabPath is required.");
            var root = PrefabUtility.LoadPrefabContents(request.prefabPath);
            if (root == null) return Error("Prefab was not found.");
            var issues = new List<ValidationIssue>();
            try
            {
                var rootRect = root.GetComponent<RectTransform>();
                ValidateTransform(root.transform, root.transform, rootRect, issues);
                ValidateMissingReferences(root.transform, root.transform, issues);
            }
            finally { PrefabUtility.UnloadPrefabContents(root); }

            if (request.checkActiveScene)
            {
                if (UnityEngine.Object.FindFirstObjectByType<EventSystem>() == null)
                    issues.Add(Issue("warning", "missing-event-system", string.Empty, "EventSystem", "The active scene has no EventSystem."));
                if (UnityEngine.Object.FindFirstObjectByType<Canvas>() == null)
                    issues.Add(Issue("warning", "missing-canvas", string.Empty, "Canvas", "The active scene has no Canvas."));
            }
            int errors = 0;
            foreach (var issue in issues) if (issue.severity == "error") errors++;
            return JsonUtility.ToJson(new ValidationResponse { status = "ok", issues = issues.ToArray(), errorCount = errors, warningCount = issues.Count - errors });
        }

        private static ValidationIssue Issue(string severity, string code, string path, string component, string message)
        {
            return new ValidationIssue { severity = severity, code = code, path = path, component = component, message = message };
        }

        private static void ValidateTransform(Transform node, Transform root, RectTransform rootRect, List<ValidationIssue> issues)
        {
            var path = GetRelativePath(root, node);
            var siblingNames = new HashSet<string>();
            for (int index = 0; index < node.childCount; index++)
            {
                var child = node.GetChild(index);
                if (!siblingNames.Add(child.name)) issues.Add(Issue("warning", "duplicate-sibling-name", GetRelativePath(root, child), "Transform", "A sibling with the same name already exists."));
            }
            if (node != root && rootRect != null && node is RectTransform rect)
            {
                var corners = new Vector3[4];
                rect.GetWorldCorners(corners);
                bool outside = true;
                foreach (var corner in corners)
                {
                    var point = root.InverseTransformPoint(corner);
                    if (point.x >= rootRect.rect.xMin && point.x <= rootRect.rect.xMax && point.y >= rootRect.rect.yMin && point.y <= rootRect.rect.yMax) { outside = false; break; }
                }
                if (outside) issues.Add(Issue("warning", "rect-outside-root", path, "RectTransform", "All RectTransform corners are outside the prefab root bounds."));
            }
            foreach (var layout in node.GetComponents<LayoutGroup>())
            {
                if (layout is GridLayoutGroup grid && grid.constraintCount < 1)
                    issues.Add(Issue("error", "invalid-grid-constraint", path, "GridLayoutGroup", "Grid constraint count must be at least one."));
                if (layout.GetComponent<RectTransform>() == null)
                    issues.Add(Issue("error", "layout-missing-rect-transform", path, layout.GetType().Name, "A Layout Group requires a RectTransform."));
            }
            for (int index = 0; index < node.childCount; index++) ValidateTransform(node.GetChild(index), root, rootRect, issues);
        }

        private static void ValidateMissingReferences(Transform node, Transform root, List<ValidationIssue> issues)
        {
            foreach (var component in node.GetComponents<Component>())
            {
                if (component == null) { issues.Add(Issue("error", "missing-component", GetRelativePath(root, node), "Component", "A component script is missing.")); continue; }
                var serialized = new SerializedObject(component);
                var property = serialized.GetIterator();
                while (property.NextVisible(true))
                {
                    if (property.propertyType == SerializedPropertyType.ObjectReference && property.objectReferenceInstanceIDValue != 0 && property.objectReferenceValue == null)
                        issues.Add(Issue("error", "missing-object-reference", GetRelativePath(root, node), component.GetType().Name, "Missing reference at " + property.propertyPath + "."));
                }
            }
            for (int index = 0; index < node.childCount; index++) ValidateMissingReferences(node.GetChild(index), root, issues);
        }

        private static string GetCompilationStatus()
        {
            var errors = new List<ConsoleEntry>();
            foreach (var entry in ConsoleEntries) if (entry.type == LogType.Error.ToString() || entry.type == LogType.Exception.ToString() || entry.type == LogType.Assert.ToString()) errors.Add(entry);
            return JsonUtility.ToJson(new CompilationStatusResponse { status = "ok", isCompiling = EditorApplication.isCompiling, isUpdating = EditorApplication.isUpdating, errors = errors.ToArray() });
        }

        private static string ApplyPlan(PlanRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.prefabPath) || request.actions == null || request.actions.Length == 0) return Error("prefabPath and at least one action are required.");
            var root = PrefabUtility.LoadPrefabContents(request.prefabPath);
            if (root == null) return Error("Prefab was not found.");
            int applied = 0;
            try
            {
                foreach (var action in request.actions)
                {
                    if (action == null || (!string.Equals(action.operation, "create", StringComparison.OrdinalIgnoreCase) && !string.Equals(action.operation, "upsert", StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("Only the 'create' and 'upsert' operations are supported.");
                    var existing = string.Equals(action.operation, "upsert", StringComparison.OrdinalIgnoreCase) ? FindBySourceId(root.transform, action.sourceId) : null;
                    if (existing == null) CreateUiElement(root.transform, action);
                    else UpdateUiElement(existing, action);
                    applied++;
                }
                CleanMissingScripts(root);
                PrefabUtility.SaveAsPrefabAsset(root, request.prefabPath);
                AssetDatabase.SaveAssets();
                return JsonUtility.ToJson(new PlanResponse { status = "ok", message = "UI plan applied.", applied = applied });
            }
            finally { PrefabUtility.UnloadPrefabContents(root); }
        }

        private static void CleanMissingScripts(GameObject go)
        {
            if (go == null) return;
            GameObjectUtility.RemoveMonoBehavioursWithMissingScript(go);
            foreach (Transform child in go.transform)
            {
                CleanMissingScripts(child.gameObject);
            }
        }

        private static void CreateUiElement(Transform prefabRoot, UiAction action)
        {
            Transform parent = string.IsNullOrWhiteSpace(action.parentPath) ? prefabRoot : prefabRoot.Find(action.parentPath);
            if (parent == null) throw new InvalidOperationException("Parent path was not found: " + action.parentPath);
            string type = (action.elementType ?? "panel").ToLowerInvariant();
            var element = new GameObject(string.IsNullOrWhiteSpace(action.name) ? "Element" : action.name, typeof(RectTransform));
            element.transform.SetParent(parent, false);
            var rect = element.GetComponent<RectTransform>();
            rect.anchorMin = action.useResponsiveRect ? new Vector2(action.anchorMinX, action.anchorMinY) : new Vector2(0.5f, 0.5f);
            rect.anchorMax = action.useResponsiveRect ? new Vector2(action.anchorMaxX, action.anchorMaxY) : new Vector2(0.5f, 0.5f);
            rect.pivot = action.useResponsiveRect ? new Vector2(action.pivotX, action.pivotY) : new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = new Vector2(action.x, action.y);
            rect.sizeDelta = action.useResponsiveRect ? new Vector2(action.width, action.height) : new Vector2(Mathf.Max(1, action.width), Mathf.Max(1, action.height));
            ApplyParentLayoutElement(element.transform, parent, action);
            Color color;
            if (!ColorUtility.TryParseHtmlString(action.color, out color)) color = Color.white;

            if (type == "text")
            {
                var text = element.AddComponent<TextMeshProUGUI>();
                text.text = action.text ?? string.Empty;
                text.fontSize = Mathf.Max(1, action.fontSize);
                text.color = color;
            }
            else if (!string.IsNullOrWhiteSpace(action.spriteAssetPath) || (type != "container" && (action.hasVisualFill || type == "button")))
            {
                var image = element.AddComponent<Image>();
                ApplyActionSprite(image, action);
                if (image.sprite != null || !string.IsNullOrWhiteSpace(action.spriteAssetPath))
                {
                    image.color = Color.white;
                }
                else if (action.hasVisualFill)
                {
                    image.color = color;
                }
                else
                {
                    image.color = Color.clear;
                }
                if (type == "button")
                {
                    var btn = element.AddComponent<Button>();
                    btn.targetGraphic = image;
                }
            }
            ApplyMetadata(element, action);
            ApplyMask(element, action);
            ApplyActionLayout(element.GetComponent<RectTransform>(), action);
            if (string.Equals(action.name, "Background", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(action.parentPath))
            {
                element.transform.SetAsFirstSibling();
            }
        }

        private static Transform FindBySourceId(Transform root, string sourceId)
        {
            if (string.IsNullOrWhiteSpace(sourceId)) return null;
            foreach (var metadata in root.GetComponentsInChildren<PenpotUnityUiMetadata>(true)) if (metadata.PenpotSourceId == sourceId) return metadata.transform;
            return null;
        }

        private static void UpdateUiElement(Transform element, UiAction action)
        {
            element.name = string.IsNullOrWhiteSpace(action.name) ? element.name : action.name;
            var rect = element as RectTransform;
            rect.anchorMin = action.useResponsiveRect ? new Vector2(action.anchorMinX, action.anchorMinY) : new Vector2(.5f, .5f);
            rect.anchorMax = action.useResponsiveRect ? new Vector2(action.anchorMaxX, action.anchorMaxY) : new Vector2(.5f, .5f);
            rect.pivot = action.useResponsiveRect ? new Vector2(action.pivotX, action.pivotY) : new Vector2(.5f, .5f);
            rect.anchoredPosition = new Vector2(action.x, action.y); rect.sizeDelta = action.useResponsiveRect ? new Vector2(action.width, action.height) : new Vector2(Mathf.Max(1, action.width), Mathf.Max(1, action.height));
            ApplyParentLayoutElement(element, element.parent, action);
            Color color; if (!ColorUtility.TryParseHtmlString(action.color, out color)) color = Color.white;
            var text = element.GetComponent<TextMeshProUGUI>(); if (text != null) { text.text = action.text ?? text.text; text.fontSize = Mathf.Max(1, action.fontSize); text.color = color; }
            var image = element.GetComponent<Image>();
            bool isText = string.Equals(action.elementType, "text", StringComparison.OrdinalIgnoreCase) || element.GetComponent<TextMeshProUGUI>() != null;
            bool hasSprite = !isText && !string.IsNullOrWhiteSpace(action.spriteAssetPath);
            bool shouldHaveImage = !isText && (hasSprite || (!string.Equals(action.elementType, "container", StringComparison.OrdinalIgnoreCase) && (action.hasVisualFill || string.Equals(action.elementType, "button", StringComparison.OrdinalIgnoreCase))));

            if (!shouldHaveImage)
            {
                if (image != null && image.sprite == null && !hasSprite) DestroyImmediate(image);
            }
            else
            {
                image = image ?? element.gameObject.AddComponent<Image>();
                ApplyActionSprite(image, action);
                if (image != null)
                {
                    if (image.sprite != null || hasSprite)
                    {
                        image.color = Color.white;
                    }
                    else if (action.hasVisualFill)
                    {
                        image.color = color;
                    }
                    else
                    {
                        image.color = Color.clear;
                    }
                }
                if (string.Equals(action.elementType, "button", StringComparison.OrdinalIgnoreCase))
                {
                    var btn = GetOrAddComponent<Button>(element.gameObject);
                    if (image != null) btn.targetGraphic = image;
                }
            }
            ApplyMetadata(element.gameObject, action); ApplyMask(element.gameObject, action); ApplyActionLayout(rect, action);
            if (string.Equals(action.name, "Background", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(action.parentPath))
            {
                element.SetAsFirstSibling();
            }
        }

        private static void ApplyParentLayoutElement(Transform element, Transform parent, UiAction action)
        {
            if (element == null || parent == null) return;
            var parentLayout = parent.GetComponent<LayoutGroup>();
            if (parentLayout != null)
            {
                var le = element.GetComponent<LayoutElement>() ?? element.gameObject.AddComponent<LayoutElement>();
                if (action.width > 0)
                {
                    le.preferredWidth = action.width;
                    le.minWidth = action.width;
                }
                if (action.height > 0)
                {
                    le.preferredHeight = action.height;
                    le.minHeight = action.height;
                }
            }
        }

        private static void ApplyMask(GameObject element, UiAction action)
        {
            var mask = element.GetComponent<RectMask2D>();
            if (action.addRectMask) { if (mask == null) element.AddComponent<RectMask2D>(); }
            else if (mask != null) DestroyImmediate(mask);
        }

        private static void ApplyActionSprite(Image image, UiAction action)
        {
            if (image == null) return;
            if (string.IsNullOrWhiteSpace(action.spriteAssetPath))
            {
                image.sprite = null;
                image.type = Image.Type.Simple;
                image.preserveAspect = false;
                return;
            }
            if (action.borderRadius > 0)
            {
                var importer = AssetImporter.GetAtPath(action.spriteAssetPath) as TextureImporter;
                if (importer != null)
                {
                    float r = action.borderRadius;
                    Vector4 border = new Vector4(r, r, r, r);
                    if (importer.spriteBorder != border)
                    {
                        importer.spriteBorder = border;
                        importer.SaveAndReimport();
                    }
                }
            }
            image.sprite = AssetDatabase.LoadAssetAtPath<Sprite>(action.spriteAssetPath);
            if (image.sprite == null) throw new InvalidOperationException("Sprite asset was not found: " + action.spriteAssetPath);
            image.type = (string.Equals(action.imageType, "sliced", StringComparison.OrdinalIgnoreCase) || action.borderRadius > 0) ? Image.Type.Sliced : Image.Type.Simple;
            image.preserveAspect = action.preserveAspect;
            image.color = Color.white;
        }

        private static void ApplyMetadata(GameObject element, UiAction action)
        {
            if (string.IsNullOrWhiteSpace(action.sourceId) && string.IsNullOrWhiteSpace(action.accessibilityLabel) && string.IsNullOrWhiteSpace(action.accessibilityDescription)) return;
            var metadata = element.GetComponent<PenpotUnityUiMetadata>() ?? element.AddComponent<PenpotUnityUiMetadata>();
            metadata.Apply(action.sourceId, action.componentId, action.instanceId, action.accessibilityLabel, action.accessibilityDescription);
        }

        private static void ApplyActionLayout(RectTransform target, UiAction action)
        {
            if (string.IsNullOrWhiteSpace(action.layoutType)) return;
            ConfigureLayoutOnTarget(target, action.layoutType, action.layoutSpacing, action.paddingLeft, action.paddingRight, action.paddingTop, action.paddingBottom, action.childAlignment, action.childForceExpandWidth, action.childForceExpandHeight, 1, action.childControlWidth, action.childControlHeight);
        }

        private static string DeleteElement(PrefabTargetRequest request)
        {
            return WithPrefabTarget(request, target =>
            {
                if (target.parent == null) throw new InvalidOperationException("The prefab root cannot be deleted.");
                DestroyImmediate(target.gameObject);
                return "UI element deleted.";
            });
        }

        private static string SetRectTransform(RectTransformRequest request)
        {
            if (request == null) return Error("Request is required.");
            return WithPrefabTarget(new PrefabTargetRequest { prefabPath = request.prefabPath, targetPath = request.targetPath }, target =>
            {
                var rect = target as RectTransform;
                if (rect == null) throw new InvalidOperationException("Target does not have a RectTransform.");
                rect.anchorMin = new Vector2(request.anchorMinX, request.anchorMinY);
                rect.anchorMax = new Vector2(request.anchorMaxX, request.anchorMaxY);
                rect.pivot = new Vector2(request.pivotX, request.pivotY);
                rect.anchoredPosition = new Vector2(request.x, request.y);
                rect.sizeDelta = new Vector2(Mathf.Max(1, request.width), Mathf.Max(1, request.height));
                return "RectTransform updated.";
            });
        }

        private static string ChangeComponent(ComponentRequest request, bool add)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.componentType)) return Error("componentType is required.");
            return WithPrefabTarget(new PrefabTargetRequest { prefabPath = request.prefabPath, targetPath = request.targetPath }, target =>
            {
                var componentType = GetAllowedComponentType(request.componentType);
                if (componentType == null) throw new InvalidOperationException("Component type is not permitted: " + request.componentType);
                var existing = target.GetComponent(componentType);
                if (add)
                {
                    if (existing == null) target.gameObject.AddComponent(componentType);
                    return "Component added.";
                }
                if (existing == null) throw new InvalidOperationException("Component was not found on the target.");
                DestroyImmediate(existing);
                return "Component removed.";
            });
        }

        private static string SetSerializedField(SerializedFieldRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.componentType) || string.IsNullOrWhiteSpace(request.fieldPath)) return Error("componentType and fieldPath are required.");
            return WithPrefabTarget(new PrefabTargetRequest { prefabPath = request.prefabPath, targetPath = request.targetPath }, target =>
            {
                var componentType = GetAllowedComponentType(request.componentType);
                var component = componentType == null ? null : target.GetComponent(componentType);
                if (component == null) throw new InvalidOperationException("Allowed component was not found on the target.");
                var serializedObject = new SerializedObject(component);
                var property = serializedObject.FindProperty(request.fieldPath);
                if (property == null) throw new InvalidOperationException("Serialized field was not found: " + request.fieldPath);
                if (!SetSerializedValue(property, request.value, request.objectReferenceAssetPath)) throw new InvalidOperationException("Unsupported field type: " + property.propertyType);
                serializedObject.ApplyModifiedPropertiesWithoutUndo();
                return "Serialized field updated.";
            });
        }

        private static string ConfigureImage(ImageStyleRequest request)
        {
            if (request == null) return Error("Request is required.");
            return WithPrefabTarget(new PrefabTargetRequest { prefabPath = request.prefabPath, targetPath = request.targetPath }, target =>
            {
                var image = target.GetComponent<Image>() ?? target.gameObject.AddComponent<Image>();
                if (!string.IsNullOrWhiteSpace(request.spriteAssetPath))
                {
                    if (request.borderRadius > 0)
                    {
                        var importer = AssetImporter.GetAtPath(request.spriteAssetPath) as TextureImporter;
                        if (importer != null)
                        {
                            Vector4 border = new Vector4(request.borderRadius, request.borderRadius, request.borderRadius, request.borderRadius);
                            if (importer.spriteBorder != border)
                            {
                                importer.spriteBorder = border;
                                importer.SaveAndReimport();
                            }
                        }
                    }
                    image.sprite = AssetDatabase.LoadAssetAtPath<Sprite>(request.spriteAssetPath);
                    if (image.sprite == null) throw new InvalidOperationException("Sprite asset was not found.");
                }
                if (!string.IsNullOrWhiteSpace(request.materialAssetPath))
                {
                    image.material = AssetDatabase.LoadAssetAtPath<Material>(request.materialAssetPath);
                    if (image.material == null) throw new InvalidOperationException("Material asset was not found.");
                }
                image.type = (string.Equals(request.imageType, "sliced", StringComparison.OrdinalIgnoreCase) || request.borderRadius > 0) ? Image.Type.Sliced : Image.Type.Simple;
                image.preserveAspect = request.preserveAspect;
                if (image.sprite != null) image.color = Color.white;
                return "Image style configured.";
            });
        }

        private static string ConfigureTmpText(TextStyleRequest request)
        {
            if (request == null) return Error("Request is required.");
            return WithPrefabTarget(new PrefabTargetRequest { prefabPath = request.prefabPath, targetPath = request.targetPath }, target =>
            {
                var text = target.GetComponent<TextMeshProUGUI>() ?? target.gameObject.AddComponent<TextMeshProUGUI>();
                if (!string.IsNullOrWhiteSpace(request.fontAssetPath))
                {
                    text.font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(request.fontAssetPath);
                    if (text.font == null) throw new InvalidOperationException("TMP font asset was not found.");
                }
                text.text = request.text ?? string.Empty;
                text.fontSize = Mathf.Max(1f, request.fontSize);
                if (ColorUtility.TryParseHtmlString(request.color, out var color)) text.color = color;
                if (Enum.TryParse(request.alignment, true, out TextAlignmentOptions alignment)) text.alignment = alignment;
                text.textWrappingMode = request.enableWordWrapping ? TextWrappingModes.Normal : TextWrappingModes.NoWrap;
                if (Enum.TryParse(request.overflowMode, true, out TextOverflowModes overflowMode)) text.overflowMode = overflowMode;
                return "TMP text style configured.";
            });
        }

        private static string ConfigureLayout(LayoutRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.layoutType)) return Error("layoutType is required.");
            return WithPrefabTarget(new PrefabTargetRequest { prefabPath = request.prefabPath, targetPath = request.targetPath }, target =>
            {
                var rect = target as RectTransform;
                if (rect == null) throw new InvalidOperationException("Layout Group target must have a RectTransform.");
                ConfigureLayoutOnTarget(rect, request.layoutType, request.spacing, request.paddingLeft, request.paddingRight, request.paddingTop, request.paddingBottom, request.childAlignment, request.childForceExpandWidth, request.childForceExpandHeight, request.constraintCount, request.childControlWidth, request.childControlHeight);
                return "Layout group configured.";
            });
        }

        private static void ConfigureLayoutOnTarget(RectTransform target, string layoutType, float spacing, float paddingLeft, float paddingRight, float paddingTop, float paddingBottom, string childAlignment, bool childForceExpandWidth, bool childForceExpandHeight, int constraintCount, bool childControlWidth = true, bool childControlHeight = true)
        {
            LayoutGroup layout;
            switch (layoutType.ToLowerInvariant())
            {
                case "horizontal": layout = target.GetComponent<HorizontalLayoutGroup>() ?? target.gameObject.AddComponent<HorizontalLayoutGroup>(); break;
                case "vertical": layout = target.GetComponent<VerticalLayoutGroup>() ?? target.gameObject.AddComponent<VerticalLayoutGroup>(); break;
                case "grid":
                    var grid = target.GetComponent<GridLayoutGroup>() ?? target.gameObject.AddComponent<GridLayoutGroup>();
                    grid.constraint = GridLayoutGroup.Constraint.FixedColumnCount; grid.constraintCount = Mathf.Max(1, constraintCount); grid.spacing = new Vector2(Mathf.Max(0, spacing), Mathf.Max(0, spacing)); layout = grid; break;
                default: throw new InvalidOperationException("layoutType must be horizontal, vertical, or grid.");
            }
            if (Enum.TryParse(childAlignment, true, out TextAnchor alignment)) layout.childAlignment = alignment;
            var linear = layout as HorizontalOrVerticalLayoutGroup;
            if (linear != null)
            {
                linear.spacing = Mathf.Max(0, spacing);
                linear.childForceExpandWidth = childForceExpandWidth;
                linear.childForceExpandHeight = childForceExpandHeight;
                linear.childControlWidth = childControlWidth;
                linear.childControlHeight = childControlHeight;
            }
            layout.padding = new RectOffset(Mathf.RoundToInt(paddingLeft), Mathf.RoundToInt(paddingRight), Mathf.RoundToInt(paddingTop), Mathf.RoundToInt(paddingBottom));

            foreach (Transform child in target)
            {
                var childRect = child as RectTransform;
                if (childRect != null)
                {
                    var le = child.GetComponent<LayoutElement>() ?? child.gameObject.AddComponent<LayoutElement>();
                    if (le.preferredWidth <= 0 && childRect.rect.width > 0)
                    {
                        le.preferredWidth = childRect.rect.width;
                        le.minWidth = childRect.rect.width;
                    }
                    if (le.preferredHeight <= 0 && childRect.rect.height > 0)
                    {
                        le.preferredHeight = childRect.rect.height;
                        le.minHeight = childRect.rect.height;
                    }
                }
            }
        }

        private static string AddUiControl(ControlRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.controlType)) return Error("controlType is required.");
            return WithPrefabTarget(new PrefabTargetRequest { prefabPath = request.prefabPath, targetPath = request.targetPath }, target =>
            {
                switch (request.controlType.ToLowerInvariant())
                {
                    case "button": GetOrAddComponent<Image>(target.gameObject); GetOrAddComponent<Button>(target.gameObject); break;
                    case "toggle": GetOrAddComponent<Toggle>(target.gameObject); break;
                    case "slider": GetOrAddComponent<Slider>(target.gameObject); break;
                    case "scrollrect": GetOrAddComponent<ScrollRect>(target.gameObject); break;
                    case "inputfield": GetOrAddComponent<TMP_InputField>(target.gameObject); break;
                    default: throw new InvalidOperationException("Unsupported controlType.");
                }
                if (request.addMask && target.GetComponent<RectMask2D>() == null) target.gameObject.AddComponent<RectMask2D>();
                return "UI control added.";
            });
        }

        private static string ConfigureSelectable(SelectableStyleRequest request)
        {
            if (request == null) return Error("Request is required.");
            return WithPrefabTarget(new PrefabTargetRequest { prefabPath = request.prefabPath, targetPath = request.targetPath }, target =>
            {
                var selectable = target.GetComponent<Selectable>();
                if (selectable == null) throw new InvalidOperationException("targetPath must contain a Selectable component such as Button, Toggle, or Slider.");
                if (Enum.TryParse(request.transition, true, out Selectable.Transition transition)) selectable.transition = transition;
                if (Enum.TryParse(request.navigation, true, out Navigation.Mode navigationMode))
                {
                    var navigation = selectable.navigation;
                    navigation.mode = navigationMode;
                    selectable.navigation = navigation;
                }
                var colors = selectable.colors;
                if (ColorUtility.TryParseHtmlString(request.normalColor, out var normal)) colors.normalColor = normal;
                if (ColorUtility.TryParseHtmlString(request.highlightedColor, out var highlighted)) colors.highlightedColor = highlighted;
                if (ColorUtility.TryParseHtmlString(request.pressedColor, out var pressed)) colors.pressedColor = pressed;
                if (ColorUtility.TryParseHtmlString(request.disabledColor, out var disabled)) colors.disabledColor = disabled;
                selectable.colors = colors;
                return "Selectable transition, colors, and navigation configured.";
            });
        }

        private static T GetOrAddComponent<T>(GameObject gameObject) where T : Component
        {
            return gameObject.GetComponent<T>() ?? gameObject.AddComponent<T>();
        }

        private static string WithPrefabTarget(PrefabTargetRequest request, Func<Transform, string> operation)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.prefabPath)) return Error("prefabPath is required.");
            var root = PrefabUtility.LoadPrefabContents(request.prefabPath);
            if (root == null) return Error("Prefab was not found.");
            try
            {
                Transform target = string.IsNullOrWhiteSpace(request.targetPath) ? root.transform : root.transform.Find(request.targetPath);
                if (target == null) return Error("targetPath was not found in the prefab.");
                var message = operation(target);
                CleanMissingScripts(root);
                PrefabUtility.SaveAsPrefabAsset(root, request.prefabPath);
                AssetDatabase.SaveAssets();
                return JsonUtility.ToJson(new Response { status = "ok", message = message });
            }
            finally { PrefabUtility.UnloadPrefabContents(root); }
        }

        private static Type GetAllowedComponentType(string value)
        {
            switch (value)
            {
                case "Image": return typeof(Image);
                case "Button": return typeof(Button);
                case "Slider": return typeof(Slider);
                case "ScrollRect": return typeof(ScrollRect);
                case "TextMeshProUGUI": return typeof(TextMeshProUGUI);
                case "CanvasGroup": return typeof(CanvasGroup);
                case "LayoutElement": return typeof(LayoutElement);
                case "HorizontalLayoutGroup": return typeof(HorizontalLayoutGroup);
                case "VerticalLayoutGroup": return typeof(VerticalLayoutGroup);
                case "GridLayoutGroup": return typeof(GridLayoutGroup);
                case "Toggle": return typeof(Toggle);
                case "TMP_InputField": return typeof(TMP_InputField);
                case "Mask": return typeof(Mask);
                case "RectMask2D": return typeof(RectMask2D);
                default: return null;
            }
        }

        private static bool SetSerializedValue(SerializedProperty property, string value, string objectReferenceAssetPath)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.String: property.stringValue = value ?? string.Empty; return true;
                case SerializedPropertyType.Boolean: if (bool.TryParse(value, out var boolean)) { property.boolValue = boolean; return true; } return false;
                case SerializedPropertyType.Integer: if (int.TryParse(value, out var integer)) { property.intValue = integer; return true; } return false;
                case SerializedPropertyType.Float: if (float.TryParse(value, out var number)) { property.floatValue = number; return true; } return false;
                case SerializedPropertyType.Color: if (ColorUtility.TryParseHtmlString(value, out var color)) { property.colorValue = color; return true; } return false;
                case SerializedPropertyType.Enum: property.enumValueIndex = int.TryParse(value, out var enumIndex) ? enumIndex : Array.IndexOf(property.enumNames, value); return property.enumValueIndex >= 0;
                case SerializedPropertyType.ObjectReference:
                    if (string.IsNullOrWhiteSpace(objectReferenceAssetPath)) return false;
                    var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(objectReferenceAssetPath);
                    if (asset == null) return false;
                    property.objectReferenceValue = asset;
                    return true;
                default: return false;
            }
        }

        private static string SearchAssets(AssetSearchRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.query)) return Error("query is required.");
            string filter = string.IsNullOrWhiteSpace(request.assetType) ? request.query : request.query + " t:" + request.assetType;
            var guids = AssetDatabase.FindAssets(filter);
            var paths = new List<string>();
            foreach (var guid in guids) paths.Add(AssetDatabase.GUIDToAssetPath(guid));
            return JsonUtility.ToJson(new AssetSearchResponse { status = "ok", assetPaths = paths.ToArray() });
        }

        private static string ImportSprite(SpriteImportRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.assetPath)) return Error("assetPath is required.");
            var importer = AssetImporter.GetAtPath(request.assetPath) as TextureImporter;
            if (importer == null) return Error("A texture asset was not found at assetPath.");
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spritePixelsPerUnit = Mathf.Max(1, request.pixelsPerUnit);
            importer.SaveAndReimport();
            return JsonUtility.ToJson(new Response { status = "ok", message = "Sprite import settings applied." });
        }

        private static string CopyUiAsset(AssetCopyRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.sourceFilePath) || string.IsNullOrWhiteSpace(request.destinationAssetPath)) return Error("sourceFilePath and destinationAssetPath are required.");
            var destination = request.destinationAssetPath.Replace('\\', '/');
            if (!File.Exists(request.sourceFilePath)) return Error("Source asset was not found.");
            if (!destination.StartsWith("Assets/PenpotUI/")) return Error("destinationAssetPath must be below Assets/PenpotUI/.");
            var extension = Path.GetExtension(destination).ToLowerInvariant();
            if (extension != ".png" && extension != ".svg" && extension != ".ttf" && extension != ".otf") return Error("Only PNG, SVG, TTF, and OTF assets are supported.");
            var fullPath = Path.Combine(Directory.GetParent(Application.dataPath).FullName, destination);
            if (File.Exists(fullPath) && !request.overwrite) return Error("Destination exists. Set overwrite to true to replace it.");
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
            File.Copy(request.sourceFilePath, fullPath, true);
            AssetDatabase.Refresh();
            if (request.importAsSprite && (extension == ".png" || extension == ".svg"))
            {
                var importer = AssetImporter.GetAtPath(destination) as TextureImporter;
                if (importer != null) { importer.textureType = TextureImporterType.Sprite; importer.spriteImportMode = SpriteImportMode.Single; importer.spritePixelsPerUnit = Mathf.Max(1, request.pixelsPerUnit); importer.SaveAndReimport(); }
            }
            return JsonUtility.ToJson(new Response { status = "ok", message = "Asset copied and imported." });
        }

        private static string CopyUiAssets(AssetBatchCopyRequest request)
        {
            if (request == null || request.assets == null || request.assets.Length == 0) return Error("At least one asset is required.");
            foreach (var asset in request.assets)
            {
                if (asset == null || string.IsNullOrWhiteSpace(asset.sourceFilePath) || string.IsNullOrWhiteSpace(asset.destinationAssetPath)) return Error("Every asset requires sourceFilePath and destinationAssetPath.");
                var destination = asset.destinationAssetPath.Replace('\\', '/');
                if (!File.Exists(asset.sourceFilePath)) return Error("Source asset was not found: " + asset.sourceFilePath);
                if (!destination.StartsWith("Assets/PenpotUI/")) return Error("destinationAssetPath must be below Assets/PenpotUI/.");
                var extension = Path.GetExtension(destination).ToLowerInvariant();
                if (extension != ".png" && extension != ".svg" && extension != ".ttf" && extension != ".otf") return Error("Only PNG, SVG, TTF, and OTF assets are supported.");
                var fullPath = Path.Combine(Directory.GetParent(Application.dataPath).FullName, destination);
                if (File.Exists(fullPath) && !asset.overwrite) return Error("Destination exists. Set overwrite to true to replace it: " + destination);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
                File.Copy(asset.sourceFilePath, fullPath, true);
            }
            AssetDatabase.Refresh();
            foreach (var asset in request.assets)
            {
                var destination = asset.destinationAssetPath.Replace('\\', '/');
                var extension = Path.GetExtension(destination).ToLowerInvariant();
                if (!asset.importAsSprite || (extension != ".png" && extension != ".svg")) continue;
                var importer = AssetImporter.GetAtPath(destination) as TextureImporter;
                if (importer == null) return Error("Texture importer was not found: " + destination);
                importer.textureType = TextureImporterType.Sprite;
                importer.spriteImportMode = SpriteImportMode.Single;
                importer.spritePixelsPerUnit = Mathf.Max(1, asset.pixelsPerUnit);
                importer.SaveAndReimport();
            }
            return JsonUtility.ToJson(new Response { status = "ok", message = request.assets.Length + " assets copied and imported." });
        }

        private static string WriteUiFile(FileWriteRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.assetPath)) return Error("assetPath is required.");
            const string allowedPrefix = "Assets/PenpotUI/";
            if (!request.assetPath.Replace('\\', '/').StartsWith(allowedPrefix, StringComparison.Ordinal)) return Error("Files may only be written under Assets/PenpotUI/.");
            if (!request.assetPath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) && !request.assetPath.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) return Error("Only .cs and .json files are supported.");
            string fullPath = Path.Combine(Directory.GetParent(Application.dataPath).FullName, request.assetPath);
            if (File.Exists(fullPath) && !request.overwrite) return Error("File already exists. Set overwrite to true to replace it.");
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
            File.WriteAllText(fullPath, request.content ?? string.Empty, new UTF8Encoding(false));
            AssetDatabase.Refresh();
            return JsonUtility.ToJson(new Response { status = "ok", message = "File written and asset database refreshed." });
        }

        private static string RunEditorScript(ScriptRunRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.assetPath)) return Error("assetPath is required.");
            const string allowedPrefix = "Assets/PenpotUI/Editor/";
            if (!request.assetPath.Replace('\\', '/').StartsWith(allowedPrefix, StringComparison.Ordinal) || !request.assetPath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return Error("Only .cs scripts below Assets/PenpotUI/Editor/ may run.");
            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(request.assetPath);
            var type = script == null ? null : script.GetClass();
            if (type == null)
            {
                string className = Path.GetFileNameWithoutExtension(request.assetPath);
                foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try
                    {
                        foreach (var t in assembly.GetTypes())
                        {
                            if (t.Name == className) { type = t; break; }
                        }
                    }
                    catch { }
                    if (type != null) break;
                }
            }
            var method = type?.GetMethod(request.methodName ?? "Run", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
            if (method == null) return Error("A public static parameterless method was not found. Unity may still be compiling the script.");
            method.Invoke(null, null);
            return JsonUtility.ToJson(new Response { status = "ok", message = "Editor script method executed." });
        }

        private static string CaptureGameView(CaptureRequest request)
        {
            if (!Application.isPlaying) return Error("Game View capture requires Play Mode so ScreenCapture includes the running UI.");
            string assetPath = string.IsNullOrWhiteSpace(request?.outputPath) ? "Assets/PenpotUI/Captures/GameView.png" : request.outputPath;
            if (!assetPath.Replace('\\', '/').StartsWith("Assets/PenpotUI/") || !assetPath.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) return Error("outputPath must be a .png below Assets/PenpotUI/.");
            string fullPath = Path.Combine(Directory.GetParent(Application.dataPath).FullName, assetPath);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
            if (File.Exists(fullPath)) File.Delete(fullPath);
            ScreenCapture.CaptureScreenshot(fullPath);
            return JsonUtility.ToJson(new CaptureResponse { status = "ok", message = "Game View capture scheduled.", assetPath = assetPath, fullPath = fullPath });
        }

        private static void CaptureConsole(string condition, string stackTrace, LogType type)
        {
            ConsoleEntries.Enqueue(new ConsoleEntry { condition = condition, stackTrace = stackTrace, type = type.ToString() });
            while (ConsoleEntries.Count > 200) ConsoleEntries.TryDequeue(out _);
        }

        private static string GetConsole()
        {
            return JsonUtility.ToJson(new ConsoleResponse { status = "ok", entries = ConsoleEntries.ToArray() });
        }

        private static string GetPath(Transform transform)
        {
            var parts = new Stack<string>();
            while (transform != null) { parts.Push(transform.name); transform = transform.parent; }
            return string.Join("/", parts);
        }

        private static string GetRelativePath(Transform root, Transform transform)
        {
            if (transform == root) return string.Empty;
            var parts = new Stack<string>();
            while (transform != null && transform != root) { parts.Push(transform.name); transform = transform.parent; }
            return string.Join("/", parts);
        }

        private static string ReadBody(HttpListenerRequest request)
        {
            using (var reader = new StreamReader(request.InputStream, request.ContentEncoding)) return reader.ReadToEnd();
        }

        private static string Error(string message) { return JsonUtility.ToJson(new Response { status = "error", message = message }); }
    }
}
#endif
