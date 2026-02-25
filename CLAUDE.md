# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Group accountability app backend — FastAPI + asyncpg + Render.

## Architecture

- **models.py** — Pydantic request/response models
- **database.py** — asyncpg pool, SQL queries, single `groups` table
- **game_logic.py** — pure game logic (end-of-day processing, asteroid, building placement)
- **main.py** — FastAPI app, all endpoints + WebSocket
- **render.yaml** — Render deployment blueprint (web service + free Postgres)

## Environment Setup

- Python 3.11.3 virtual environment
- Activate: `Scripts/activate` (Windows) or `source Scripts/activate` (Git Bash)
- Install dependencies: `pip install -r requirements.txt`
- Requires `DATABASE_URL` env var pointing to PostgreSQL
- Run locally: `uvicorn main:app --reload --port 8000`
