using System.Reflection;

namespace Customers.Ui;

/// <summary>Адрес и публичный ключ Supabase. Вшиваются при сборке (как у macOS-версии); без них доступны только локальные учётные записи.</summary>
internal static class CloudSettings
{
    public static CloudConfig? Load()
    {
        var assembly = typeof(CloudSettings).Assembly;
        string? Metadata(string key) => assembly.GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == key)?.Value;

        // Для разработки значения можно переопределить переменными окружения.
        var url = Environment.GetEnvironmentVariable("CUSTOMERS_SUPABASE_URL");
        if (string.IsNullOrWhiteSpace(url))
        {
            url = Metadata("SupabaseUrl");
        }

        var key = Environment.GetEnvironmentVariable("CUSTOMERS_SUPABASE_ANON_KEY");
        if (string.IsNullOrWhiteSpace(key))
        {
            key = Metadata("SupabaseAnonKey");
        }

        return CloudConfig.Create(url, key);
    }
}

/// <summary>Ключи OAuth-приложений, вшитые при сборке. Для разработки можно переопределить переменными окружения CUSTOMERS_&lt;ИМЯ_ПЕРЕМЕННОЙ_СБОРКИ&gt;.</summary>
internal static class OAuthBuild
{
    public static OAuthClient? Client(OAuthProvider provider)
    {
        var assembly = typeof(OAuthBuild).Assembly;
        string? Metadata(string key) => assembly.GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == key)?.Value;

        var id = Environment.GetEnvironmentVariable("CUSTOMERS_" + provider.BuildVariable());
        if (string.IsNullOrWhiteSpace(id))
        {
            id = Metadata(provider.MetadataKey());
        }

        var secret = provider.NeedsClientSecret() ? Metadata(provider.SecretMetadataKey()) : null;
        if (provider.NeedsClientSecret() && Environment.GetEnvironmentVariable("CUSTOMERS_GOOGLE_OAUTH_CLIENT_SECRET") is { Length: > 0 } fromEnv)
        {
            secret = fromEnv;
        }

        return OAuthClient.Create(provider, id, secret);
    }
}
