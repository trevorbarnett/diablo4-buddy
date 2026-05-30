@echo off
set DEST=%USERPROFILE%\D4Hotkey
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "\\wsl.localhost\Ubuntu-24.04\home\tbarnett\projects\diablo4\hotkey-listener.ps1" "%DEST%\hotkey-listener.ps1" >nul
powershell.exe -ExecutionPolicy Bypass -File "%DEST%\hotkey-listener.ps1"
