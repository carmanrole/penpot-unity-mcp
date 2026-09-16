#if UNITY_EDITOR
using System;
using System.Collections.Concurrent;

namespace PenpotUnityUiMcp
{
    internal static class PenpotUnityUiMcpJobStore
    {
        internal sealed class Job { internal string id; internal string route; internal string body; internal string state; internal string resultJson; internal DateTime createdUtc; }
        internal static readonly ConcurrentQueue<Job> Pending = new ConcurrentQueue<Job>();
        private static readonly ConcurrentDictionary<string, Job> Jobs = new ConcurrentDictionary<string, Job>();

        internal static Job Enqueue(string route, string body)
        {
            var job = new Job { id = Guid.NewGuid().ToString("N"), route = route, body = body ?? "{}", state = "queued", createdUtc = DateTime.UtcNow };
            Jobs[job.id] = job;
            Pending.Enqueue(job);
            return job;
        }

        internal static bool TryGet(string id, out Job job) => Jobs.TryGetValue(id, out job);
        internal static void Complete(Job job, string resultJson) { job.resultJson = resultJson; job.state = "done"; }
    }
}
#endif
