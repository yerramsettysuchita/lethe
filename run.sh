#!/usr/bin/env bash
# Lethe - one command launch (macOS / Linux)
set -euo pipefail
cd "$(dirname "$0")/backend"

echo "Installing dependencies..."
python3 -m pip install -q -r requirements.txt

# Create a local .env from the template on first run so keys can be added.
if [ ! -f ".env" ]; then
  cp "../.env.example" ".env"
  echo "Created backend/.env from template. Add your keys there to enable Cognee Cloud and the LLM judge (optional)."
fi

export PYTHONIOENCODING=utf-8
echo ""
echo "Lethe is running at http://127.0.0.1:8000  (press Ctrl+C to stop)"
echo ""
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
