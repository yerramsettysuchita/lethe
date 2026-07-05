# Lethe - run the test suite (Windows PowerShell)
# Usage:  ./test.ps1
$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot/backend"
python -m pip install -q -r requirements.txt
$env:PYTHONIOENCODING = "utf-8"
python -m pytest -q
