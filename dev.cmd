@echo off
rem Riposte dev session — starts backend server + editor, each in its own window.
rem Server: http://localhost:5720 (API + virtual CasparCG on 6250/6251)
rem Editor: http://localhost:5719 (vite, proxies /api to the server)
setlocal
cd /d "%~dp0"

rem Skip anything already listening (leftover from a previous session).
rem /c: is required - without it findstr treats the space as OR and
rem ".*LISTENING" matches ANY listening socket, skipping the start.
netstat -ano | findstr /r /c:":5720 .*LISTENING" >nul
if %errorlevel%==0 (
    echo [dev] server already running on 5720 - skipping
) else (
    start "riposte server :5720" cmd /k npm run server
)

netstat -ano | findstr /r /c:":5719 .*LISTENING" >nul
if %errorlevel%==0 (
    echo [dev] editor already running on 5719 - skipping
) else (
    start "riposte editor :5719" cmd /k npm run dev
)

rem Wait for the editor before opening the browser (cold start takes a moment).
set tries=0
:wait
netstat -ano | findstr /r /c:":5719 .*LISTENING" >nul
if %errorlevel%==0 goto ready
set /a tries+=1
if %tries% geq 20 goto ready
timeout /t 1 /nobreak >nul
goto wait
:ready
echo [dev] editor: http://localhost:5719/?set=FIE_2026
start "" "http://localhost:5719/?set=FIE_2026"
