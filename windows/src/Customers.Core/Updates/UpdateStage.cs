using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Customers.Core;

/// <summary>Скачанное и проверенное обновление, которое ждёт согласия пользователя.</summary>
public sealed record StagedUpdate(string Version, string Title, string Notes, string? Page, string InstallerPath, string Sha256, long Size, DateTimeOffset DownloadedAt)
{
    public AppVersion? ParsedVersion => AppVersion.Parse(Version);
}

/// <summary>Описание только что установленной версии для экрана «Что нового».</summary>
public sealed record InstalledNotes(string Version, string Title, string Notes);

/// <summary>Нехватка места на диске для скачивания обновления.</summary>
public sealed class InsufficientSpaceException(long required, long available) : Exception(
    $"Недостаточно места на диске: для обновления нужно около {Megabytes(required)} МБ, свободно {Megabytes(available)} МБ. Освободите место и повторите.")
{
    public long Required { get; } = required;

    public long Available { get; } = available;

    private static string Megabytes(long bytes) => ((bytes + 1048575) / 1048576).ToString(CultureInfo.InvariantCulture);
}

/// <summary>
/// Папка обновлений в данных приложения: скачанный установщик ждёт там запуска. Установщик не трогает работающую копию,
/// пока пользователь не согласился; недокачанные и устаревшие файлы удаляются.
/// </summary>
public sealed class UpdateStage(string directory)
{
    private const string RecordName = "staged.json";
    private const string NotesName = "installed.json";

    public string Directory { get; } = directory;

    private string RecordPath => Path.Combine(Directory, RecordName);

    private string NotesPath => Path.Combine(Directory, NotesName);

    public string PartialPath(string installerName) => Path.Combine(Directory, installerName + ".part");

    public string FinalPath(string installerName) => Path.Combine(Directory, installerName);

    /// <summary>Скачанное обновление, если оно ещё нужно (новее установленной версии) и файл цел по размеру. Иначе стирает следы.</summary>
    public StagedUpdate? Load(AppVersion current)
    {
        try
        {
            if (!File.Exists(RecordPath) || JsonNode.Parse(File.ReadAllText(RecordPath)) is not JsonObject o)
            {
                return null;
            }

            var staged = new StagedUpdate(
                o["version"]?.GetValue<string>() ?? "",
                o["title"]?.GetValue<string>() ?? "",
                o["notes"]?.GetValue<string>() ?? "",
                o["page"]?.GetValue<string>(),
                o["installer"]?.GetValue<string>() ?? "",
                o["sha256"]?.GetValue<string>() ?? "",
                o["size"]?.GetValue<long>() ?? -1,
                o["downloadedAt"] is { } d && DateTimeOffset.TryParse(d.GetValue<string>(), CultureInfo.InvariantCulture, DateTimeStyles.None, out var at) ? at : DateTimeOffset.MinValue);
            if (staged.ParsedVersion is not { } v || v <= current || !IsInside(staged.InstallerPath)
                || !File.Exists(staged.InstallerPath) || new FileInfo(staged.InstallerPath).Length != staged.Size)
            {
                Clear();
                return null;
            }

            return staged;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException)
        {
            Clear();
            return null;
        }
    }

    public void Save(StagedUpdate staged)
    {
        System.IO.Directory.CreateDirectory(Directory);
        var o = new JsonObject {
            ["version"] = staged.Version,
            ["title"] = staged.Title,
            ["notes"] = staged.Notes,
            ["page"] = staged.Page,
            ["installer"] = staged.InstallerPath,
            ["sha256"] = staged.Sha256,
            ["size"] = staged.Size,
            ["downloadedAt"] = staged.DownloadedAt.ToString("o", CultureInfo.InvariantCulture),
        };
        WriteAtomically(RecordPath, o.ToJsonString());
    }

    /// <summary>Удаляет всё, что скачано для обновления (кроме записи о только что установленной версии).</summary>
    public void Clear()
    {
        try
        {
            if (!System.IO.Directory.Exists(Directory))
            {
                return;
            }

            foreach (var file in System.IO.Directory.EnumerateFiles(Directory))
            {
                if (!string.Equals(Path.GetFileName(file), NotesName, StringComparison.Ordinal))
                {
                    File.Delete(file);
                }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Файл занят (например, установщик ещё работает): уберём при следующем запуске.
        }
    }

    /// <summary>Установщик нельзя запускать, если после скачивания его подменили или он повреждён.</summary>
    public static bool VerifyFile(StagedUpdate staged)
    {
        try
        {
            if (!File.Exists(staged.InstallerPath) || new FileInfo(staged.InstallerPath).Length != staged.Size)
            {
                return false;
            }

            using var stream = File.OpenRead(staged.InstallerPath);
            return string.Equals(Convert.ToHexStringLower(SHA256.HashData(stream)), staged.Sha256, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    // MARK: Что нового

    /// <summary>Перед установкой запоминает описание версии: после перезапуска оно покажется без сети.</summary>
    public void SaveInstalledNotes(StagedUpdate staged)
    {
        System.IO.Directory.CreateDirectory(Directory);
        var o = new JsonObject { ["version"] = staged.Version, ["title"] = staged.Title, ["notes"] = staged.Notes };
        WriteAtomically(NotesPath, o.ToJsonString());
    }

    public InstalledNotes? LoadInstalledNotes(AppVersion current)
    {
        try
        {
            if (!File.Exists(NotesPath) || JsonNode.Parse(File.ReadAllText(NotesPath)) is not JsonObject o)
            {
                return null;
            }

            var version = o["version"]?.GetValue<string>() ?? "";
            return AppVersion.Parse(version) is { } v && v.Equals(current)
                ? new InstalledNotes(version, o["title"]?.GetValue<string>() ?? "", o["notes"]?.GetValue<string>() ?? "")
                : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    public void ClearInstalledNotes()
    {
        try
        {
            File.Delete(NotesPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private bool IsInside(string path)
    {
        try
        {
            var root = Path.GetFullPath(Directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return Path.GetFullPath(path).StartsWith(root, StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static void WriteAtomically(string path, string text)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, text);
        File.Move(tmp, path, overwrite: true);
    }
}
