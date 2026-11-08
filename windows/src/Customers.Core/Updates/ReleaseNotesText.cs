using System.Text.RegularExpressions;

namespace Customers.Core;

public enum NoteKind
{
    Heading,
    Bullet,
    Paragraph,
}

/// <summary>Одна строка описания релиза без разметки Markdown.</summary>
public sealed record NoteLine(NoteKind Kind, string Text);

/// <summary>
/// Описание релиза с GitHub написано на Markdown. В окнах приложения оно показывается обычным текстом:
/// без «**», «##», «`», ссылок и HTML, с нормальными переносами строк и списками.
/// </summary>
public static partial class ReleaseNotesText
{
    public static IReadOnlyList<NoteLine> Parse(string? markdown)
    {
        var lines = new List<NoteLine>();
        var inFence = false;
        var paragraph = new List<string>();

        void Flush()
        {
            if (paragraph.Count > 0)
            {
                lines.Add(new NoteLine(NoteKind.Paragraph, string.Join(' ', paragraph)));
                paragraph.Clear();
            }
        }

        foreach (var raw in (markdown ?? "").Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n'))
        {
            var line = raw.TrimEnd();
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith("```", StringComparison.Ordinal) || trimmed.StartsWith("~~~", StringComparison.Ordinal))
            {
                Flush();
                inFence = !inFence;
                continue;
            }

            if (inFence)
            {
                // Код внутри блока показываем как есть, построчно.
                if (trimmed.Length > 0)
                {
                    lines.Add(new NoteLine(NoteKind.Paragraph, trimmed));
                }

                continue;
            }

            if (trimmed.Length == 0 || HorizontalRule().IsMatch(trimmed))
            {
                Flush();
                continue;
            }

            if (HtmlComment().IsMatch(trimmed))
            {
                continue;
            }

            while (trimmed.StartsWith('>'))
            {
                trimmed = trimmed[1..].TrimStart();
            }

            if (HeadingMark().Match(trimmed) is { Success: true } h)
            {
                Flush();
                var text = Inline(h.Groups[1].Value);
                if (text.Length > 0)
                {
                    lines.Add(new NoteLine(NoteKind.Heading, text.TrimEnd(':')));
                }

                continue;
            }

            if (BulletMark().Match(trimmed) is { Success: true } b)
            {
                Flush();
                var text = Inline(b.Groups[2].Value);
                if (text.Length > 0)
                {
                    lines.Add(new NoteLine(NoteKind.Bullet, b.Groups[1].Success ? b.Groups[1].Value + " " + text : text));
                }

                continue;
            }

            var plain = Inline(trimmed);
            if (plain.Length > 0)
            {
                paragraph.Add(plain);
            }
        }

        Flush();
        return lines;
    }

    /// <summary>Те же строки одним текстом: заголовки отдельно, пункты с «•», абзацы через пустую строку.</summary>
    public static string Plain(string? markdown)
    {
        var sb = new System.Text.StringBuilder();
        NoteLine? previous = null;
        foreach (var line in Parse(markdown))
        {
            if (previous is not null)
            {
                var tight = previous.Kind == NoteKind.Bullet && line.Kind == NoteKind.Bullet;
                sb.Append(tight ? "\n" : "\n\n");
            }

            sb.Append(line.Kind == NoteKind.Bullet && !NumberedPrefix().IsMatch(line.Text) ? "• " + line.Text : line.Text);
            previous = line;
        }

        return sb.ToString();
    }

    /// <summary>Убирает разметку внутри строки: выделение, код, ссылки, картинки, HTML.</summary>
    public static string Inline(string text)
    {
        var s = text;
        s = Comment().Replace(s, "");
        s = Image().Replace(s, "$1");
        s = Link().Replace(s, "$1");
        s = AutoLink().Replace(s, "$1");
        s = Html().Replace(s, "");
        s = Bold().Replace(s, "$2");
        s = Strike().Replace(s, "$1");
        s = Code().Replace(s, "$1");
        s = Italic().Replace(s, "$1");
        s = s.Replace("\\*", "*", StringComparison.Ordinal).Replace("\\_", "_", StringComparison.Ordinal).Replace("\\#", "#", StringComparison.Ordinal);
        return Spaces().Replace(s, " ").Trim();
    }

    [GeneratedRegex(@"^(?:[-*_]\s*){3,}$")]
    private static partial Regex HorizontalRule();

    [GeneratedRegex(@"<!--.*?-->")]
    private static partial Regex Comment();

    [GeneratedRegex(@"^<!--.*-->$")]
    private static partial Regex HtmlComment();

    [GeneratedRegex(@"^#{1,6}\s+(.*?)\s*#*$")]
    private static partial Regex HeadingMark();

    [GeneratedRegex(@"^(?:[-*+]|(\d{1,3}[.)]))\s+(.*)$")]
    private static partial Regex BulletMark();

    [GeneratedRegex(@"^\d{1,3}[.)]\s")]
    private static partial Regex NumberedPrefix();

    [GeneratedRegex(@"!\[([^\]]*)\]\([^)]*\)")]
    private static partial Regex Image();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)]*\)")]
    private static partial Regex Link();

    [GeneratedRegex(@"<(https?://[^>\s]+)>")]
    private static partial Regex AutoLink();

    [GeneratedRegex(@"</?[A-Za-z][^>]*>")]
    private static partial Regex Html();

    [GeneratedRegex(@"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")]
    private static partial Regex Bold();

    [GeneratedRegex(@"~~(.+?)~~")]
    private static partial Regex Strike();

    [GeneratedRegex(@"`+([^`]+)`+")]
    private static partial Regex Code();

    [GeneratedRegex(@"(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])")]
    private static partial Regex Italic();

    [GeneratedRegex(@"[ \t]{2,}")]
    private static partial Regex Spaces();
}
