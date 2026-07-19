using System;
using System.IO;

namespace NeuuroBridge
{
    /// <summary>
    /// Resolves the Neeuro license and the Postgres connection string. Precedence:
    /// the activation-written <see cref="ConfigStore"/> (clinic machines), then
    /// environment variables / a <c>.env</c> file walking up from both the working
    /// directory and the executable directory (dev boxes). Shared by the console app
    /// and the WPF app so both read configuration identically.
    /// </summary>
    public static class EnvConfig
    {
        /// <summary>NEUURO_LICENSE_KEY from env var, then .env. Null if not found.</summary>
        public static string ResolveLicense()
        {
            var env = Environment.GetEnvironmentVariable("NEUURO_LICENSE_KEY");
            if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
            return FindDotEnvValue("NEUURO_LICENSE_KEY");
        }

        /// <summary>Npgsql connection string from POSTGRES_* keys, dev-compose defaults as fallback.</summary>
        public static string BuildConnectionString()
        {
            string host = FindDotEnvValue("POSTGRES_HOST") ?? "localhost";
            string port = FindDotEnvValue("POSTGRES_PORT") ?? "5433";
            string dbName = FindDotEnvValue("POSTGRES_DB") ?? "neurostudy";
            string user = FindDotEnvValue("POSTGRES_USER") ?? "neurostudy_user";
            string pass = FindDotEnvValue("POSTGRES_PASSWORD") ?? "neurostudy_pass";
            var cs = $"Host={host};Port={port};Database={dbName};Username={user};Password={pass};" +
                     "Timeout=5;Command Timeout=10;Pooling=true";

            // Activation hands out sslmode with the creds; dev compose has no key → no clause,
            // identical behaviour to before. Npgsql 6 validates the server cert under Require;
            // POSTGRES_TRUST_SERVER_CERT=true opts out (self-signed certs only, not for prod).
            string sslMode = FindDotEnvValue("POSTGRES_SSLMODE");
            if (!string.IsNullOrWhiteSpace(sslMode)) cs += $";SSL Mode={sslMode.Trim()}";
            string trust = FindDotEnvValue("POSTGRES_TRUST_SERVER_CERT");
            if (string.Equals(trust?.Trim(), "true", StringComparison.OrdinalIgnoreCase))
                cs += ";Trust Server Certificate=true";
            return cs;
        }

        public static string FindDotEnvValue(string key)
        {
            var env = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrWhiteSpace(env)) return env.Trim();

            // Clinic machines: the activation-written store wins over any stray .env.
            var stored = ConfigStore.Read(key);
            if (!string.IsNullOrWhiteSpace(stored)) return stored;

            foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
            {
                var dir = start;
                for (int depth = 0; depth < 8 && dir != null; depth++)
                {
                    var path = Path.Combine(dir, ".env");
                    if (File.Exists(path))
                    {
                        var value = ReadEnvKey(path, key);
                        if (!string.IsNullOrWhiteSpace(value)) return value;
                    }
                    dir = Directory.GetParent(dir)?.FullName;
                }
            }
            return null;
        }

        private static string ReadEnvKey(string path, string key)
        {
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;

                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                if (!string.Equals(line.Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase)) continue;

                var value = line.Substring(eq + 1).Trim();
                if (value.Length >= 2 &&
                    ((value[0] == '"' && value[value.Length - 1] == '"') ||
                     (value[0] == '\'' && value[value.Length - 1] == '\'')))
                    value = value.Substring(1, value.Length - 2);
                return value;
            }
            return null;
        }
    }
}
