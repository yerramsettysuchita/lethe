#!/usr/bin/env bash
# Lethe - run the test suite (macOS / Linux)
set -euo pipefail
cd "$(dirname "$0")/backend"
python3 -m pip install -q -r requirements.txt
export PYTHONIOENCODING=utf-8
python3 -m pytest -q
