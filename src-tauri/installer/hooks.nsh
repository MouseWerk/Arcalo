; Installer hooks (bundle.windows.nsis.installerHooks): installs of earlier versions are updated
; in place.
;
; 1.15: the program file is arcalo.exe (it was annalo.exe up to 1.14) and the app identifier is
; de.mousewerk.arcalo (was app.annalo.desktop). The template already removes the old program file
; (the uninstall entry names it in MainBinaryName) and points Start menu and desktop shortcuts at
; the new one. These hooks add:
;
; - The running old program (annalo.exe) is closed first, like the template does for arcalo.exe.
; - The autostart entry (Run value) points at arcalo.exe right away, not only after the app's
;   first start; the app writes it again with its own state at start.
; - Start menu, desktop and taskbar shortcuts carry the new identifier as their AppUserModelID
;   (taskbar grouping, toasts, jump list) and point at arcalo.exe. A pinned taskbar shortcut is
;   updated where Windows lets the installer (it may still have to be pinned again once).
; - The old program file goes (also when the template did not remove it).
; - Uninstalling with "delete app data" also removes the folders of the old identifier, which
;   1.15 kept next to the new ones (it copies them, see crates/arcalo-core/src/identity.rs).
;
; 1.7: the product was renamed from Annalo to Arcalo. The product name decides the uninstall
; entry, the shortcuts and the default install folder, so without these hooks an update from
; Annalo 1.6 would put a second copy into %LOCALAPPDATA%\Arcalo and leave the old entry and
; shortcuts behind. Instead:
;
; - An existing Annalo installation is updated in place: its folder (usually
;   %LOCALAPPDATA%\Annalo) stays, so the autostart entry and firewall rules keep pointing at the
;   right folder. Only when the user picked another folder in the setup does Arcalo go there; the
;   old program files are then removed (never anything else: the data lives in the app data
;   folders of the identifier and is not touched).
; - The old uninstall entry ("Annalo" in Apps & features) and its registry key go; the new
;   installer has written its own ("Arcalo").
; - The old Start menu shortcut is replaced by the new one; a desktop shortcut is renamed.
; - The autostart entry is renamed by the app at its first start (it keeps a "disabled in Task
;   Manager" state, which the installer cannot read); the installer only keeps its path valid.
;
; Running these steps again finds nothing left to do (the old keys and files are gone after the
; first run).

; The program file and identifier of 1.14 and earlier.
!define OLD_EXE "annalo.exe"
!define OLD_BUNDLEID "app.annalo.desktop"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define PINNED "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

; Annalo 1.6 (product name Annalo).
!define V16_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Annalo"
; 1.6 had no publisher: the manufacturer came from the identifier (app.annalo.desktop).
!define V16_MANUKEY "Software\annalo"
!define V16_MANUPRODUCTKEY "Software\annalo\Annalo"

; Folder and program file of the Annalo 1.6 installation found ("" when there is none).
Var AnnaloDir
Var AnnaloExe
; 1 when an Annalo 1.6 uninstall entry or registry key was found.
Var AnnaloFound

; Points `shortcut` at the new program file when it names `old` and stamps the new
; AppUserModelID on it when it points at the new program file.
!macro RestampShortcut shortcut old
  ${If} ${FileExists} "${shortcut}"
    !insertmacro IsShortcutTarget "${shortcut}" "${old}"
    Pop $R0
    ${If} $R0 = 1
      !insertmacro SetShortcutTarget "${shortcut}" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
    !insertmacro IsShortcutTarget "${shortcut}" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R0
    ${If} $R0 = 1
      !insertmacro SetLnkAppUserModelId "${shortcut}"
    ${EndIf}
  ${EndIf}
!macroend

; The Run value `name` (autostart) at the new program file when it names `old`.
!macro RetargetRunValue name old
  ReadRegStr $R0 HKCU "${RUNKEY}" "${name}"
  ${If} $R0 != ""
    ${WordReplace} $R0 "${old}" "$INSTDIR\${MAINBINARYNAME}.exe" "+" $R1
    ${If} $R1 != $R0
      WriteRegStr HKCU "${RUNKEY}" "${name}" $R1
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $AnnaloFound 0
  StrCpy $AnnaloDir ""
  ReadRegStr $AnnaloExe SHCTX "${V16_UNINSTKEY}" "MainBinaryName"
  ${If} $AnnaloExe == ""
    StrCpy $AnnaloExe "${OLD_EXE}"
  ${EndIf}
  ReadRegStr $R0 SHCTX "${V16_UNINSTKEY}" "UninstallString"
  ${If} $R0 != ""
    StrCpy $AnnaloFound 1
  ${EndIf}
  ReadRegStr $R0 SHCTX "${V16_MANUPRODUCTKEY}" ""
  ${If} $R0 == ""
    ; InstallLocation is written in quotes.
    ReadRegStr $R0 SHCTX "${V16_UNINSTKEY}" "InstallLocation"
    StrCpy $R1 $R0 1
    ${If} $R1 == '"'
      StrCpy $R0 $R0 "" 1
      StrCpy $R0 $R0 -1
    ${EndIf}
  ${EndIf}
  ${If} $R0 != ""
    StrCpy $AnnaloFound 1
    ${If} ${FileExists} "$R0\$AnnaloExe"
      StrCpy $AnnaloDir $R0
    ${EndIf}
  ${EndIf}

  ; Update in place unless the user chose a folder of their own in the setup: the updater runs
  ; it passive with /UPDATE (no folder page), and in the dialog the folder is still the
  ; default (of this template or of older ones, which used %LOCALAPPDATA%\Programs).
  StrCpy $R2 0
  ${If} $UpdateMode = 1
  ${OrIf} $PassiveMode = 1
  ${OrIf} ${Silent}
  ${OrIf} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
    StrCpy $R2 1
  ${EndIf}
  ${If} $AnnaloDir != ""
  ${AndIf} $INSTDIR != $AnnaloDir
  ${AndIf} $R2 = 1
    DetailPrint "Earlier version found in $AnnaloDir: updating it in place"
    SetOutPath $AnnaloDir
    ; Created empty by the section before this hook; removed only while it is empty.
    RMDir $INSTDIR
    StrCpy $INSTDIR $AnnaloDir
  ${EndIf}

  ; The program of 1.14 and earlier runs under its old file name: closed like the new one.
  !insertmacro CheckIfAppIsRunning "${OLD_EXE}" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; ---- 1.15: the program file arcalo.exe and the identifier de.mousewerk.arcalo
  ${If} ${FileExists} "$INSTDIR\${OLD_EXE}"
    DetailPrint "Removing the program file of the earlier version"
    Delete "$INSTDIR\${OLD_EXE}"
  ${EndIf}
  !insertmacro RetargetRunValue "${PRODUCTNAME}" "$INSTDIR\${OLD_EXE}"
  !insertmacro RestampShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${OLD_EXE}"
  !insertmacro RestampShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${OLD_EXE}"
  !insertmacro RestampShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${OLD_EXE}"
  !insertmacro RestampShortcut "${PINNED}\${PRODUCTNAME}.lnk" "$INSTDIR\${OLD_EXE}"

  ; ---- 1.7: the product name Arcalo (an Annalo 1.6 installation)
  ${If} $AnnaloFound = 1
    DetailPrint "Removing the entries of the earlier version"

    ; The autostart entry follows the program file until the app renames it.
    ${If} $AnnaloDir != ""
      !insertmacro RetargetRunValue "Annalo" "$AnnaloDir\$AnnaloExe"
    ${EndIf}
    ; Annalo stayed in a folder of its own: its program files go (the data is elsewhere).
    ${If} $AnnaloDir != ""
    ${AndIf} $AnnaloDir != $INSTDIR
      Delete "$AnnaloDir\$AnnaloExe"
      Delete "$AnnaloDir\uninstall.exe"
      RMDir $AnnaloDir
    ${EndIf}

    ${If} $AnnaloDir != ""
      ; Start menu: the old shortcut (in its folder, or at the top level) goes, the new one is
      ; created when the update skipped it.
      StrCpy $R5 0
      !insertmacro IsShortcutTarget "$SMPROGRAMS\Annalo\Annalo.lnk" "$AnnaloDir\$AnnaloExe"
      Pop $R0
      ${If} $R0 = 1
        Delete "$SMPROGRAMS\Annalo\Annalo.lnk"
        RMDir "$SMPROGRAMS\Annalo"
        StrCpy $R5 1
      ${EndIf}
      !insertmacro IsShortcutTarget "$SMPROGRAMS\Annalo.lnk" "$AnnaloDir\$AnnaloExe"
      Pop $R0
      ${If} $R0 = 1
        Delete "$SMPROGRAMS\Annalo.lnk"
        StrCpy $R5 1
      ${EndIf}
      ${If} $AppStartMenuFolder == ""
        StrCpy $AppStartMenuFolder "${STARTMENUFOLDER}"
      ${EndIf}
      StrCpy $R1 $AppStartMenuFolder 1
      ${If} $R5 = 1
      ${AndIf} $R1 != ">"
      ${AndIfNot} ${FileExists} "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
        CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
        CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      ${EndIf}

      ; Desktop: the old shortcut is renamed where it is (or dropped when a new one exists).
      !insertmacro IsShortcutTarget "$DESKTOP\Annalo.lnk" "$AnnaloDir\$AnnaloExe"
      Pop $R0
      ${If} $R0 = 1
        ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
          Delete "$DESKTOP\Annalo.lnk"
        ${Else}
          Rename "$DESKTOP\Annalo.lnk" "$DESKTOP\${PRODUCTNAME}.lnk"
          !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
          !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
        ${EndIf}
      ${EndIf}
      ; A taskbar pin of the old name.
      !insertmacro RestampShortcut "${PINNED}\Annalo.lnk" "$AnnaloDir\$AnnaloExe"
    ${EndIf}

    DeleteRegKey SHCTX "${V16_UNINSTKEY}"
    DeleteRegKey SHCTX "${V16_MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${V16_MANUKEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The address the notification buttons start Arcalo with (registered by the app itself).
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\arcalo-notify"
  ${EndIf}
  ; An autostart entry of Annalo that the app never renamed (not when updating).
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${RUNKEY}" "Annalo"
  ${EndIf}
  ; "Delete app data": the folders of the identifier of 1.14 and earlier too.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\${OLD_BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${OLD_BUNDLEID}"
  ${EndIf}
!macroend
