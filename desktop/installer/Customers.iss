; Установщик Customers для Windows (Inno Setup 6, бесплатный).
; Сборка: iscc /DAppVersion=1.0.0 /DSourceDir=..\dist-installer /DOutputDir=..\artifacts Customers.iss
; В SourceDir лежит один файл Customers.exe (его собирает tauri build --no-bundle).
;
; Принципы:
;  * ставится для текущего пользователя в %LOCALAPPDATA%\Programs\Customers, права администратора не нужны;
;  * данные пользователя лежат отдельно, в %LOCALAPPDATA%\Customers, поэтому обновление и переустановка их не трогают;
;  * удаляется через «Параметры → Приложения»; данные при этом по умолчанию остаются, а удалить их можно по отдельному вопросу;
;  * тихое обновление поверх: Customers-...-Setup.exe /SILENT /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist-installer"
#endif
#ifndef OutputDir
  #define OutputDir "..\artifacts"
#endif

#define AppName "Customers"
#define AppExe "Customers.exe"
#define AppGuid "{{6B0F7C1E-3A52-4C58-9E41-5B7D2A9C1F30}"
#define UrlScheme "leadgenerator"
#define DataDirName "Customers"
#define OutputName "Customers-v" + AppVersion + "-Windows-x64-Setup"

[Setup]
AppId={#AppGuid}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Customers
AppPublisherURL=https://github.com/xop1tt/Customers-App
AppSupportURL=https://github.com/xop1tt/Customers-App/issues
AppUpdatesURL=https://github.com/xop1tt/Customers-App/releases
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription=Установщик Customers
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=yes
LicenseFile=..\..\LICENSE
UsePreviousAppDir=yes

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; Ссылки leadgenerator://… из писем (подтверждение адреса, восстановление пароля) открывают это приложение.
Root: HKA; Subkey: "Software\Classes\{#UrlScheme}"; ValueType: string; ValueName: ""; ValueData: "URL:{#AppName}"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\{#UrlScheme}"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\{#UrlScheme}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe},0"
Root: HKA; Subkey: "Software\Classes\{#UrlScheme}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
; Обновление из приложения идёт тихо (/SILENT /RELAUNCH=1): приложение закрылось само перед установкой, поэтому после неё его нужно открыть.
Filename: "{app}\{#AppExe}"; Flags: nowait; Check: RelaunchAfterUpdate

[CustomMessages]
russian.NeedWebView2=Для работы Customers нужен компонент Microsoft Edge WebView2. Он не найден на этом компьютере.%n%nОткрыть страницу загрузки? Установите компонент и запустите Customers после установки.
english.NeedWebView2=Customers needs the Microsoft Edge WebView2 component, which was not found on this computer.%n%nOpen the download page? Install it and start Customers after setup.
russian.DeleteDataQuestion=Удалить также данные Customers (лиды, настройки, журналы) с этого компьютера?%n%nПапка: %1%n%nЕсли нажать «Нет», данные останутся, и при повторной установке вы продолжите с того же места. Резервные копии в «Документах» в любом случае не удаляются.
english.DeleteDataQuestion=Also delete Customers data (leads, settings, logs) from this computer?%n%nFolder: %1%n%nIf you choose No, the data stays and you can continue where you left off after reinstalling. Backups in Documents are never deleted.

[Code]
// Интерфейс рисует WebView2 (встроен в Windows 11 и в обновлённую Windows 10). Если его нет, предлагаем установить.
function WebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  Result := Result and (Version <> '') and (Version <> '0.0.0.0');
end;

function InitializeSetup: Boolean;
var
  Code: Integer;
begin
  Result := True;
  if (not WebView2Installed) and (not WizardSilent) then
  begin
    if MsgBox(CustomMessage('NeedWebView2'), mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', '', '', SW_SHOWNORMAL, ewNoWait, Code);
  end;
end;

function RelaunchAfterUpdate: Boolean;
begin
  Result := ExpandConstant('{param:RELAUNCH|0}') = '1';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\{#DataDirName}');
    // Тихое удаление (в том числе при обновлении) данные не трогает.
    if (not UninstallSilent) and DirExists(DataDir) then
    begin
      if MsgBox(FmtMessage(CustomMessage('DeleteDataQuestion'), [DataDir]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
