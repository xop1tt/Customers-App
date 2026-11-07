using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;

namespace Customers.Ui;

/// <summary>Панель, переносящая элементы на следующую строку, когда им не хватает ширины (на узких окнах и при крупном масштабе).</summary>
public sealed class WrapPanel : Panel
{
    public double HorizontalSpacing { get; set; }

    public double VerticalSpacing { get; set; }

    protected override Size MeasureOverride(Size availableSize)
    {
        var rows = Layout(availableSize.Width, measure: true);
        return new Size(double.IsInfinity(availableSize.Width) ? rows.Width : Math.Min(rows.Width, availableSize.Width), rows.Height);
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        Layout(finalSize.Width, measure: false);
        return finalSize;
    }

    private Size Layout(double width, bool measure)
    {
        double x = 0, y = 0, rowHeight = 0, maxWidth = 0;
        var limit = double.IsInfinity(width) ? double.MaxValue : width;
        foreach (var child in Children)
        {
            if (child.Visibility == Visibility.Collapsed)
            {
                continue;
            }

            if (measure)
            {
                child.Measure(new Size(limit, double.PositiveInfinity));
            }

            var size = child.DesiredSize;
            if (x > 0 && x + size.Width > limit)
            {
                x = 0;
                y += rowHeight + VerticalSpacing;
                rowHeight = 0;
            }

            if (!measure)
            {
                child.Arrange(new Rect(x, y, Math.Min(size.Width, limit), size.Height));
            }

            x += size.Width + HorizontalSpacing;
            maxWidth = Math.Max(maxWidth, x - HorizontalSpacing);
            rowHeight = Math.Max(rowHeight, size.Height);
        }

        return new Size(maxWidth, y + rowHeight);
    }
}
