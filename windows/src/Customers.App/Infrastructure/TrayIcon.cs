using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Customers.Ui;

/// <summary>Пункт меню значка. Id 0 зарезервирован.</summary>
internal sealed record TrayItem(int Id, string Text, bool Enabled = true, bool Separator = false, bool Default = false)
{
    public static TrayItem Line { get; } = new(0, "", Separator: true);
}

/// <summary>
/// Значок в области уведомлений Windows. В WinUI 3 такого элемента нет, поэтому используется системный вызов Shell_NotifyIcon:
/// невидимое окно получает сообщения значка (щелчок, меню, «Windows перезапустила панель задач») и сообщения о выходе из системы.
/// Всё выполняется в потоке интерфейса, обработчики вызываются оттуда же. Меню — обычное меню Windows: его оформление задаёт система.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class TrayIcon : IDisposable
{
    private const string ClassName = "Customers.TrayWindow";
    private const uint CallbackMessage = 0x0401; // WM_USER + 1
    private const uint WmQueryEndSession = 0x0011;
    private const uint WmEndSession = 0x0016;
    private const uint WmContextMenu = 0x007B;
    private const uint WmLButtonDoubleClick = 0x0203;
    private const uint NinSelect = 0x0400;
    private const uint NinKeySelect = 0x0401;
    private const uint NifMessage = 0x1;
    private const uint NifIcon = 0x2;
    private const uint NifTip = 0x4;
    private const uint NifShowTip = 0x80;
    private const uint NimAdd = 0;
    private const uint NimModify = 1;
    private const uint NimDelete = 2;
    private const uint NimSetVersion = 4;
    private const uint MfString = 0;
    private const uint MfGrayed = 1;
    private const uint MfSeparator = 0x800;
    private const uint TpmRightButton = 0x2;
    private const uint TpmBottomAlign = 0x20;
    private const uint TpmNoNotify = 0x80;
    private const uint TpmReturnCommand = 0x100;

    private readonly WndProc _proc;
    private readonly Func<IReadOnlyList<TrayItem>> _items;
    private readonly Action<int> _command;
    private IntPtr _window;
    private IntPtr _icon;
    private bool _ownsIcon;
    private uint _taskbarCreated;
    private string _tip = "Customers";
    private bool _added;
    private bool _disposed;

    public TrayIcon(Func<IReadOnlyList<TrayItem>> items, Action<int> command)
    {
        _items = items;
        _command = command;
        _proc = Handle;
    }

    /// <summary>Пользователь щёлкнул по значку (или нажал на нём Enter): показать окно.</summary>
    public event Action? Activated;

    /// <summary>Windows завершает сеанс или просит закрыть приложение (например, для обновления): выйти по-настоящему.</summary>
    public event Action? SessionEnding;

    public bool IsShown => _added;

    /// <summary>Создаёт значок. Возвращает false, если Windows не дала его добавить (например, нет панели задач).</summary>
    public bool Create(string iconPath, string tip)
    {
        _tip = Trim(tip);
        var module = GetModuleHandle(null);
        var wc = new WndClassEx {
            cbSize = Marshal.SizeOf<WndClassEx>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_proc),
            hInstance = module,
            lpszClassName = ClassName,
        };
        // Повторная регистрация того же класса возвращает 0 с ошибкой «класс уже существует»: это не помеха.
        _ = RegisterClassEx(ref wc);
        _window = CreateWindowEx(0, ClassName, "Customers", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, module, IntPtr.Zero);
        if (_window == IntPtr.Zero)
        {
            return false;
        }

        _taskbarCreated = RegisterWindowMessage("TaskbarCreated");
        LoadIcon(iconPath);
        return Add();
    }

    private void LoadIcon(string path)
    {
        var size = GetSystemMetricsForDpi(49, GetDpiForSystem()); // SM_CXSMICON для масштаба Windows: 16, 20, 24 или 32 пикселя
        _icon = File.Exists(path) ? LoadImage(IntPtr.Zero, path, 1, size, size, 0x10) : IntPtr.Zero;
        _ownsIcon = _icon != IntPtr.Zero;
        if (_icon == IntPtr.Zero)
        {
            _icon = LoadIconW(IntPtr.Zero, new IntPtr(32512)); // стандартный значок приложения
        }
    }

    private NotifyIconData Data(uint flags) => new() {
        cbSize = Marshal.SizeOf<NotifyIconData>(),
        hWnd = _window,
        uID = 1,
        uFlags = flags,
        uCallbackMessage = CallbackMessage,
        hIcon = _icon,
        szTip = _tip,
        szInfo = "",
        szInfoTitle = "",
    };

    private bool Add()
    {
        var data = Data(NifMessage | NifIcon | NifTip | NifShowTip);
        _added = ShellNotifyIcon(NimAdd, ref data);
        if (_added)
        {
            data.uVersion = 4; // NOTIFYICON_VERSION_4: события приходят в младшем слове, есть клавиатурное управление
            _ = ShellNotifyIcon(NimSetVersion, ref data);
        }

        return _added;
    }

    public void SetTip(string tip)
    {
        _tip = Trim(tip);
        if (_added)
        {
            var data = Data(NifTip | NifShowTip);
            _ = ShellNotifyIcon(NimModify, ref data);
        }
    }

    private static string Trim(string tip) => tip.Length <= 127 ? tip : tip[..127];

    private IntPtr Handle(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (message == CallbackMessage)
            {
                var kind = (uint)(lParam.ToInt64() & 0xFFFF);
                if (kind == WmContextMenu)
                {
                    var x = (short)(wParam.ToInt64() & 0xFFFF);
                    var y = (short)((wParam.ToInt64() >> 16) & 0xFFFF);
                    ShowMenu(x, y);
                }
                else if (kind is NinSelect or NinKeySelect or WmLButtonDoubleClick)
                {
                    Activated?.Invoke();
                }

                return IntPtr.Zero;
            }

            if (message == WmQueryEndSession)
            {
                return new IntPtr(1);
            }

            if (message == WmEndSession)
            {
                if (wParam != IntPtr.Zero)
                {
                    SessionEnding?.Invoke();
                }

                return IntPtr.Zero;
            }

            if (_taskbarCreated != 0 && message == _taskbarCreated)
            {
                Add(); // панель задач перезапущена (Проводник завершился и запустился): значок нужно вернуть
                return IntPtr.Zero;
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            // Исключение не должно уйти в системный вызов: это завершило бы процесс.
            App.Instance.Env.Log.Error("Ошибка обработки значка в области уведомлений", e);
        }

        return DefWindowProc(window, message, wParam, lParam);
    }

    private void ShowMenu(int x, int y)
    {
        var menu = CreatePopupMenu();
        if (menu == IntPtr.Zero)
        {
            return;
        }

        try
        {
            foreach (var item in _items())
            {
                if (item.Separator)
                {
                    AppendMenu(menu, MfSeparator, UIntPtr.Zero, null);
                }
                else
                {
                    AppendMenu(menu, MfString | (item.Enabled ? 0u : MfGrayed), new UIntPtr((uint)item.Id), item.Text);
                    if (item.Default)
                    {
                        _ = SetMenuDefaultItem(menu, (uint)item.Id, 0);
                    }
                }
            }

            // Без SetForegroundWindow меню не закроется щелчком в стороне (известная особенность меню значков).
            _ = SetForegroundWindow(_window);
            var chosen = TrackPopupMenu(menu, TpmRightButton | TpmBottomAlign | TpmNoNotify | TpmReturnCommand, x, y, 0, _window, IntPtr.Zero);
            _ = PostMessage(_window, 0, IntPtr.Zero, IntPtr.Zero);
            if (chosen > 0)
            {
                _command(chosen);
            }
        }
        finally
        {
            _ = DestroyMenu(menu);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        if (_added)
        {
            var data = Data(0);
            _ = ShellNotifyIcon(NimDelete, ref data);
            _added = false;
        }

        if (_window != IntPtr.Zero)
        {
            _ = DestroyWindow(_window);
            _window = IntPtr.Zero;
        }

        if (_ownsIcon && _icon != IntPtr.Zero)
        {
            _ = DestroyIcon(_icon);
        }

        _icon = IntPtr.Zero;
    }

    private delegate IntPtr WndProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WndClassEx
    {
        public int cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public int cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szInfo;
        public uint uVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShellNotifyIcon(uint message, ref NotifyIconData data);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetModuleHandleW")]
    private static extern IntPtr GetModuleHandle(string? name);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegisterClassExW", SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WndClassEx wc);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateWindowExW", SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(IntPtr window);

    [DllImport("user32.dll", EntryPoint = "DefWindowProcW")]
    private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegisterWindowMessageW")]
    private static extern uint RegisterWindowMessage(string name);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "LoadImageW", SetLastError = true)]
    private static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr LoadIconW(IntPtr instance, IntPtr name);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForSystem();

    [DllImport("user32.dll")]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "AppendMenuW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AppendMenu(IntPtr menu, uint flags, UIntPtr id, string? text);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetMenuDefaultItem(IntPtr menu, uint item, uint byPosition);

    [DllImport("user32.dll")]
    private static extern int TrackPopupMenu(IntPtr menu, uint flags, int x, int y, int reserved, IntPtr window, IntPtr rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyMenu(IntPtr menu);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll", EntryPoint = "PostMessageW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
