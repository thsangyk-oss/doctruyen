@echo off
REM Khoi dong lai he thong TTS sau khi may restart.
REM - TTS :8002 = listener cua AI Gateway (C:\Users\ADMIN\Documents\ailocal\aigw.py)
REM   gateway tu quan ly VieNeu noi bo (:18002) + watchdog tu bat lai khi crash.
REM   KHONG chay VieNeu thang tren :8002 nua (se gianh cong cua gateway).
REM - reader app node server.js tren :1345
REM Ca hai deu check port truoc -> chay lai nhieu lan cung khong bi dup.
REM server.js cung tu goi file nay khi /api/tts upstream chet.

netstat -ano | findstr ":8002 " | findstr LISTENING >nul 2>&1
if errorlevel 1 (
  echo [TTS] :8002 down - starting AI Gateway ...
  wscript.exe "C:\Users\ADMIN\Documents\ailocal\start_all.vbs"
) else (
  echo [TTS] already listening on :8002
)

netstat -ano | findstr ":1345 " | findstr LISTENING >nul 2>&1
if errorlevel 1 (
  echo [APP] starting reader server on :1345 ...
  start "DocTruyen" /min cmd /c "cd /d C:\Users\ADMIN\Documents\Doctruyen && node server.js > server.out 2>&1"
) else (
  echo [APP] already listening on :1345
)
