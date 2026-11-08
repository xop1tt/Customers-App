using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Collections.Specialized;

namespace Customers.Presentation;

/// <summary>
/// Коллекция, которую можно заменить целиком за одно уведомление. Обычные Clear и Add на списке из тысяч лидов
/// посылают интерфейсу тысячи уведомлений, и окно зависает; здесь он получает одно.
/// </summary>
public sealed class BulkObservableCollection<T> : ObservableCollection<T>
{
    public void ReplaceAll(IReadOnlyList<T> items)
    {
        CheckReentrancy();
        Items.Clear();
        foreach (var item in items)
        {
            Items.Add(item);
        }

        OnPropertyChanged(new PropertyChangedEventArgs(nameof(Count)));
        OnPropertyChanged(new PropertyChangedEventArgs("Item[]"));
        OnCollectionChanged(new NotifyCollectionChangedEventArgs(NotifyCollectionChangedAction.Reset));
    }
}
