; Установщик Customers для Windows (Inno Setup 6, бесплатный).
; Сборка: iscc /DAppVersion=1.0.0 /DSourceDir=..\artifacts\publish /DOutputDir=..\artifacts Customers.iss
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
  #define SourceDir "..\artifacts\publish"
#endif
#ifndef OutputDir
  #define OutputDir "..\artifacts"
#endif

#define AppName "Customers"
#define AppExe "Customers.exe"

[Setup]
AppId={{6B0F7C1E-3A52-4C58-9E41-5B7D2A9C1F30}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Customers
AppPublisherURL=https://github.com/xop1tt/CLIENTS
AppSupportURL=https://github.com/xop1tt/CLIENTS/issues
AppUpdatesURL=https://github.com/xop1tt/CLIENTS/releases
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
OutputBaseFilename=Customers-v{#AppVersion}-Windows-x64-Setup
SetupIconFile=..\src\Customers.App\Assets\AppIcon.ico
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
Root: HKA; Subkey: "Software\Classes\leadgenerator"; ValueType: string; ValueName: ""; ValueData: "URL:Customers"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\leadgenerator"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\leadgenerator\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe},0"
Root: HKA; Subkey: "Software\Classes\leadgenerator\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[CustomMessages]
russian.DeleteDataQuestion=Удалить также данные Customers (лиды, настройки, журналы) с этого компьютера?%n%nПапка: %1%n%nЕсли нажать «Нет», данные останутся, и при повторной установке вы продолжите с того же места. Резервные копии в «Документах» в любом случае не удаляются.
english.DeleteDataQuestion=Also delete Customers data (leads, settings, logs) from this computer?%n%nFolder: %1%n%nIf you choose No, the data stays and you can continue where you left off after reinstalling. Backups in Documents are never deleted.

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\Customers');
    // Тихое удаление (в том числе при обновлении) данные не трогает.
    if (not UninstallSilent) and DirExists(DataDir) then
    begin
      if MsgBox(FmtMessage(CustomMessage('DeleteDataQuestion'), [DataDir]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
