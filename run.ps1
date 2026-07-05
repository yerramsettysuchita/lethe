# Lethe - one command launch (Windows PowerShell)
# Usage:  ./run.ps1
$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot/backend"

Write-Host "Installing dependencies..." -ForegroundColor Cyan
python -m pip install -q -r requirements.txt

# Create a local .env from the template on first run so keys can be added.
if (-not (Test-Path ".env")) {
    Copy-Item "../.env.example" ".env"
    Write-Host "Created backend/.env from template. Add your keys there to enable Cognee Cloud and the LLM judge (optional)." -ForegroundColor Yellow
}

$env:PYTHONIOENCODING = "utf-8"
Write-Host ""
Write-Host "Lethe is running at http://127.0.0.1:8000  (press Ctrl+C to stop)" -ForegroundColor Green
Write-Host ""
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
