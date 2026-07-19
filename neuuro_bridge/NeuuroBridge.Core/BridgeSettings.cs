using System;

namespace NeuuroBridge
{
    /// <summary>
    /// The two endpoints that cannot be known until the production domain exists.
    /// When Rashid's domain + Eugene's nginx work land, update the two constants below —
    /// that is the ENTIRE code change required on our side. Until then the defaults are
    /// placeholders, and both can be overridden per-machine for dev/testing via env or
    /// .env keys (ACTIVATION_URL / UPDATE_FEED_URL) without rebuilding.
    /// </summary>
    public static class BridgeSettings
    {
        // TODO(domain): replace with https://<domain> once infra exists.
        private const string DefaultActivationUrl = "https://REPLACE-WITH-DOMAIN/bridge/activate";
        private const string DefaultUpdateFeedUrl = "https://REPLACE-WITH-DOMAIN/bridge-updates/";

        /// <summary>Full URL of the backend activation endpoint (the bridge's only backend call).</summary>
        public static string ActivationUrl =>
            EnvConfig.FindDotEnvValue("ACTIVATION_URL") ?? DefaultActivationUrl;

        /// <summary>Velopack release feed — an HTTPS URL in prod, or a local folder path in dev tests.</summary>
        public static string UpdateFeedUrl =>
            EnvConfig.FindDotEnvValue("UPDATE_FEED_URL") ?? DefaultUpdateFeedUrl;

        /// <summary>True while the constants above are still placeholders — used to skip update checks.</summary>
        public static bool IsPlaceholderFeed =>
            UpdateFeedUrl.IndexOf("REPLACE-WITH-DOMAIN", StringComparison.Ordinal) >= 0;
    }
}
