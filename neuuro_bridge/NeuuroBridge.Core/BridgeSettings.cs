using System;

namespace NeuuroBridge
{
    /// <summary>
    /// The bridge's two production endpoints, overridable per-machine for dev/testing
    /// via env or .env keys (ACTIVATION_URL / UPDATE_FEED_URL) without rebuilding.
    /// </summary>
    public static class BridgeSettings
    {
        // Both live on the droplet's nginx (clinics.axonview.sg). The feed location is
        // ours: nginx/nginx.conf `/bridge-updates/` serving /var/bridge-updates,
        // populated by neuuro_bridge/packaging/publish.ps1.
        // Path history: #118 exposed /api/activate; #119 moved it to /api/clinics/activate
        // (still public — registered on the root router ABOVE the authenticated /clinics
        // router, so it matches first). This is the final path per Eugene.
        private const string DefaultActivationUrl = "https://clinics.axonview.sg/api/clinics/activate";
        private const string DefaultUpdateFeedUrl = "https://clinics.axonview.sg/bridge-updates/";

        /// <summary>Full URL of the backend activation endpoint (the bridge's only backend call).</summary>
        public static string ActivationUrl =>
            EnvConfig.FindDotEnvValue("ACTIVATION_URL") ?? DefaultActivationUrl;

        /// <summary>Velopack release feed — an HTTPS URL in prod, or a local folder path in dev tests.</summary>
        public static string UpdateFeedUrl =>
            EnvConfig.FindDotEnvValue("UPDATE_FEED_URL") ?? DefaultUpdateFeedUrl;

        /// <summary>False when the feed URL is blanked out (UPDATE_FEED_URL= in env/.env) — skips update checks.</summary>
        public static bool IsFeedConfigured => !string.IsNullOrWhiteSpace(UpdateFeedUrl);
    }
}
