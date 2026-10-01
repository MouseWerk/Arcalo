; Installer hooks (bundle.windows.nsis.installerHooks): the rename from Annalo to Arcalo in 1.7.
;
; The product name decides the uninstall entry, the shortcuts and the default install folder, so
; without these hooks an update from Annalo 1.6 would put a second copy into
; %LOCALAPPDATA%\Arcalo and leave the old entry and shortcuts behind. Instead:
;
; - An existing Annalo installation is updated in place: its folder (usually
;   %LOCALAPPDATA%\Annalo) and its program file (annalo.exe) stay, so taskbar pins, the
;   autostart entry and firewall rules keep pointing at the right file. Only when the user picked
;   another folder in the setup does Arcalo go there; the old program files are then removed
;   (never anything else: the data lives in %APPDATA%\app.annalo.desktop, keyed by the unchanged
;   identifier, and is not touched).
; - The old uninstall entry ("Annalo" in Apps & features) and its registry key go; the new
;   installer has written its own ("Arcalo").
; - The old Start menu shortcut is replaced by the new one; a desktop shortcut is renamed.
; - The autostart entry is renamed by the app at its first start (it keeps a "disabled in Task
;   Manager" state, which the installer cannot read); the installer only keeps its path valid.
;
; Running these steps again finds nothing left to do (the old keys are gone after the first run).

!define ANNALO_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Annalo"
; 1.6 had no publisher: the manufacturer came from the identifier (app.annalo.desktop).
!define ANNALO_MANUKEY "Software\annalo"
!define ANNALO_MANUPRODUCTKEY "Software\annalo\Annalo"
!define ANNALO_RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

; Folder and program file of the Annalo installation found ("" when there is none).
Var AnnaloDir
Var AnnaloExe
; 1 when an Annalo uninstall entry or registry key was found.
Var AnnaloFound

!macro NSIS_HOOK_PREINSTALL
  StrCpy $AnnaloFound 0
  StrCpy $AnnaloDir ""
  ReadRegStr $AnnaloExe SHCTX "${ANNALO_UNINSTKEY}" "MainBinaryName"
  ${If} $AnnaloExe == ""
    StrCpy $AnnaloExe "${MAINBINARYNAME}.exe"
  ${EndIf}
  ReadRegStr $R0 SHCTX "${ANNALO_UNINSTKEY}" "UninstallString"
  ${If} $R0 != ""
    StrCpy $AnnaloFound 1
  ${EndIf}
  ReadRegStr $R0 SHCTX "${ANNALO_MANUPRODUCTKEY}" ""
  ${If} $R0 == ""
    ; InstallLocation is written in quotes.
    ReadRegStr $R0 SHCTX "${ANNALO_UNINSTKEY}" "InstallLocation"
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
    DetailPrint "Annalo found in $AnnaloDir: updating it in place"
    SetOutPath $AnnaloDir
    ; Created empty by the section before this hook; removed only while it is empty.
    RMDir $INSTDIR
    StrCpy $INSTDIR $AnnaloDir
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $AnnaloFound = 1
    DetailPrint "Removing the entries of Annalo"

    ; Annalo stayed in a folder of its own: its program files go (the data is elsewhere), and
    ; the autostart entry follows the program file until the app renames it.
    ${If} $AnnaloDir != ""
    ${AndIf} $AnnaloDir != $INSTDIR
      ReadRegStr $R0 HKCU "${ANNALO_RUNKEY}" "Annalo"
      ${If} $R0 != ""
        ${WordReplace} $R0 "$AnnaloDir\$AnnaloExe" "$INSTDIR\${MAINBINARYNAME}.exe" "+" $R1
        WriteRegStr HKCU "${ANNALO_RUNKEY}" "Annalo" $R1
      ${EndIf}
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
          ${If} $AnnaloDir != $INSTDIR
            !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
          ${EndIf}
          !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
        ${EndIf}
      ${EndIf}
    ${EndIf}

    DeleteRegKey SHCTX "${ANNALO_UNINSTKEY}"
    DeleteRegKey SHCTX "${ANNALO_MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${ANNALO_MANUKEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; An autostart entry of Annalo that the app never renamed (not when updating).
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${ANNALO_RUNKEY}" "Annalo"
  ${EndIf}
!macroend
