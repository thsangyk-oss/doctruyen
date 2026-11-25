@echo off
REM Khoi dong lai he thong TTS sau khi may restart.
REM - TTS :8000 = VieNeu openai_speech, bind IP Tailscale cua may nay
REM   (serve-tailscale.ps1 tu cho tailscale co IP, tu restart khi crash).
REM - reader app node server.js tren :1345
REM Ca hai deu check port truoc -> chay lai nhieu lan cung khong bi dup.
REM server.js cung tu goi file nay khi /api/tts upstream chet.

netstat -ano | findstr ":8000 " | findstr LISTENING >nul 2>&1
if errorlevel 1 (
  echo [TTS] :8000 down - starting VieNeu ...
  start "VieNeu-TTS" /min powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\User\VieNeu-TTS\serve-tailscale.ps1"
) else (
  echo [TTS] already listening on :8000
)

netstat -ano | findstr ":1345 " | findstr LISTENING >nul 2>&1
if errorlevel 1 (
  echo [APP] starting reader server on :1345 ...
  start "DocTruyen" /min cmd /c "cd /d C:\Users\User\Documents\doctruyen && node server.js > server.out 2>&1"
) else (
  echo [APP] already listening on :1345
)
