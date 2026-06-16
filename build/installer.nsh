; Custom installer additions for Metalwave for YouTube.
;
; The assisted installer already provides the install-location page. Here we add a
; small page letting the user choose whether to create a desktop shortcut. (The
; music storage folder is chosen in-app on first run, not here.)
;
; NOTE: this file is prepended to the very top of the generated script, before
; MUI2 / nsDialogs / LogicLib are included. So anything that USES those macros
; must live inside a macro that electron-builder inserts later (customHeader,
; customPageAfterChangeDir, customInstall, …), not at top level. Only the bare
; Var declarations are safe up here.

; These are only used by the installer pages/section — declaring them in the
; uninstaller build would trip NSIS's "unused variable" warning (which
; electron-builder treats as a hard error).
!ifndef BUILD_UNINSTALLER
  Var DesktopShortcutCheckbox
  Var CreateDesktopShortcutState
!endif

; Page functions are emitted via customHeader, which is inserted after the
; includes (so nsDialogs / LogicLib / ${isUpdated} are available).
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function shortcutOptionsPageShow
      ; Skip during silent auto-updates so existing shortcuts are left untouched.
      ${If} ${isUpdated}
        Abort
      ${EndIf}

      !insertmacro MUI_HEADER_TEXT "바로가기" "생성할 바로가기를 선택하세요."

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateCheckbox} 0 20u 100% 12u "바탕화면에 바로가기 만들기"
      Pop $DesktopShortcutCheckbox
      ${NSD_SetState} $DesktopShortcutCheckbox ${BST_CHECKED}

      nsDialogs::Show
    FunctionEnd

    Function shortcutOptionsPageLeave
      ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcutState
    FunctionEnd
  !endif
!macroend

; Declare the custom page (inserted after the directory page, before install).
!macro customPageAfterChangeDir
  Page custom shortcutOptionsPageShow shortcutOptionsPageLeave
!macroend

; Create the desktop shortcut only on a fresh (non-update) install when checked.
!macro customInstall
  ${IfNot} ${isUpdated}
    ${If} $CreateDesktopShortcutState == ${BST_CHECKED}
      CreateShortcut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${EndIf}
  ${EndIf}
!macroend

; Remove our desktop shortcut on uninstall.
!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
!macroend
