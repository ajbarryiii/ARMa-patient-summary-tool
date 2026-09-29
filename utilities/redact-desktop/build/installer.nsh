!macro customInstall
  Delete "$SMPROGRAMS\ARMa - Sign in to Claude.lnk"
  Delete "$INSTDIR\Sign in to Claude.cmd"
  CreateShortCut "$SMPROGRAMS\ARMa - Windows test guide.lnk" "$INSTDIR\Windows test guide.txt"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\ARMa - Sign in to Claude.lnk"
  Delete "$SMPROGRAMS\ARMa - Windows test guide.lnk"
!macroend
