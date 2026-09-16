using UnityEngine;

namespace PenpotUnityUiMcp
{
    /// <summary>Preserves the Penpot origin and accessibility semantics of a generated UI object.</summary>
    [DisallowMultipleComponent]
    public sealed class PenpotUnityUiMetadata : MonoBehaviour
    {
        [SerializeField] private string penpotSourceId;
        [SerializeField] private string penpotComponentId;
        [SerializeField] private string penpotInstanceId;
        [SerializeField] private string accessibilityLabel;
        [TextArea, SerializeField] private string accessibilityDescription;

        public string PenpotSourceId => penpotSourceId;
        public void Apply(string sourceId, string componentId, string instanceId, string label, string description)
        {
            penpotSourceId = sourceId ?? string.Empty;
            penpotComponentId = componentId ?? string.Empty;
            penpotInstanceId = instanceId ?? string.Empty;
            accessibilityLabel = label ?? string.Empty;
            accessibilityDescription = description ?? string.Empty;
        }
    }
}
