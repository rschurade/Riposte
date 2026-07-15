@echo off
rem Riposte dev session — starts backend server + editor, each in its own window.
rem Server: http://localhost:5720 (API + virtual CasparCG on 6250/6251)
rem Editor: http://localhost:5719 (vite, proxies /api to the server)
setlocal
cd /d "%~dp0"

rem Skip anything already listening (leftover from a previous session).
netstat -ano | findstr /r ":5720 .*LISTENING" >nul
if %errorlevel%==0 (
    echo [dev] server already running on 5720 - skipping
) else (
    start "riposte server :5720" cmd /k npm run server
)

netstat -ano | findstr /r ":5719 .*LISTENING" >nul
if %errorlevel%==0 (
    echo [dev] editor already running on 5719 - skipping
) else (
    start "riposte editor :5719" cmd /k npm run dev
)

echo [dev] editor: http://localhost:5719/?set=FIE_2026
start "" "http://localhost:5719/?set=FIE_2026"
