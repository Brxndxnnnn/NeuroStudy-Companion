using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace NeuuroBridge
{
    /// <summary>Everything the backend returns on a successful activation.</summary>
    public sealed class ActivationResult
    {
        public string ActivationId;
        public string ClinicId;
        public string ClinicName;       // not in Eugene's shape yet — requested, tolerated absent
        public string PostgresHost;
        public string PostgresPort;
        public string PostgresDb;
        public string PostgresUser;
        public string PostgresPassword;
        public string PostgresSslMode;  // Npgsql enum name, e.g. VerifyFull
        public string LicenseKey;       // not in Eugene's shape yet — REQUIRED for SenzeBand auth, requested
    }

    public sealed class ActivationException : Exception
    {
        public ActivationException(string message) : base(message) { }
        public ActivationException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary>
    /// First-run enrollment: POSTs the activation code to the backend and returns the
    /// clinic's credentials. This is the ONLY backend call the bridge ever makes — the
    /// session data path stays direct-to-DB (see docs/bridge-packaging-plan.md §4).
    /// </summary>
    public static class ActivationClient
    {
        public static async Task<ActivationResult> ActivateAsync(string code)
        {
            // Shape per Eugene's endpoint (POST /api/clinics/activate, 19 Jul screenshot).
            // machine_name/bridge_version are extras for server-side audit; harmless if ignored.
            var js = new JavaScriptSerializer();
            var payload = js.Serialize(new Dictionary<string, object>
            {
                ["activation_code"] = code?.Trim(),
                ["machine_name"] = Environment.MachineName,
                ["bridge_version"] = typeof(ActivationClient).Assembly.GetName().Version?.ToString(3),
            });

            // net48 defaults can exclude TLS 1.2 on older configs; nginx will require it.
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

            HttpResponseMessage resp;
            string body;
            try
            {
                using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) })
                {
                    resp = await http.PostAsync(BridgeSettings.ActivationUrl,
                        new StringContent(payload, Encoding.UTF8, "application/json")).ConfigureAwait(false);
                    body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                }
            }
            catch (Exception ex) when (ex is HttpRequestException || ex is TaskCanceledException)
            {
                throw new ActivationException(
                    "Could not reach the activation server. Check the internet connection and try again.", ex);
            }

            switch ((int)resp.StatusCode)
            {
                case 200: break;
                case 404: throw new ActivationException("Unknown activation code. Check for typos and try again.");
                case 409: throw new ActivationException("This activation code has already been used. Ask the administrator for a new one.");
                case 410: throw new ActivationException("This activation code has expired or was revoked. Ask the administrator for a new one.");
                default: throw new ActivationException($"Activation server error ({(int)resp.StatusCode}). Try again or contact the administrator.");
            }

            try
            {
                // Envelope: { "status": "success", "data": { activation_id, clinic_id,
                //   database: { host, port, name, username, password, ssl_mode }, ... } }
                var root = (Dictionary<string, object>)js.DeserializeObject(body);
                var data = (Dictionary<string, object>)root["data"];
                var db = (Dictionary<string, object>)data["database"];
                string Opt(Dictionary<string, object> d, string k) =>
                    d.TryGetValue(k, out var v) && v != null ? Convert.ToString(v) : null;
                return new ActivationResult
                {
                    ActivationId = Opt(data, "activation_id"),
                    ClinicId = Convert.ToString(data["clinic_id"]),
                    ClinicName = Opt(data, "clinic_name"),
                    PostgresHost = Convert.ToString(db["host"]),
                    PostgresPort = Convert.ToString(db["port"]),
                    PostgresDb = Convert.ToString(db["name"]),
                    PostgresUser = Convert.ToString(db["username"]),
                    PostgresPassword = Convert.ToString(db["password"]),
                    PostgresSslMode = Opt(db, "ssl_mode") ?? "Require",
                    // license_key still missing from Eugene's shape; tolerate absence so the
                    // client doesn't break, but activation is incomplete without it.
                    LicenseKey = Opt(data, "license_key") ?? Opt(root, "license_key"),
                };
            }
            catch (Exception ex)
            {
                throw new ActivationException("Activation server returned an unexpected response.", ex);
            }
        }

        /// <summary>Persists a successful activation into the machine config store.</summary>
        public static void SaveToStore(ActivationResult r)
        {
            ConfigStore.Write(new Dictionary<string, string>
            {
                ["ACTIVATION_ID"] = r.ActivationId,
                ["CLINIC_ID"] = r.ClinicId,
                ["CLINIC_NAME"] = r.ClinicName,
                ["POSTGRES_HOST"] = r.PostgresHost,
                ["POSTGRES_PORT"] = r.PostgresPort,
                ["POSTGRES_DB"] = r.PostgresDb,
                ["POSTGRES_USER"] = r.PostgresUser,
                ["POSTGRES_PASSWORD"] = r.PostgresPassword,
                ["POSTGRES_SSLMODE"] = r.PostgresSslMode,
                ["NEUURO_LICENSE_KEY"] = r.LicenseKey,
            }, new HashSet<string> { "POSTGRES_PASSWORD", "NEUURO_LICENSE_KEY" });
        }
    }
}
