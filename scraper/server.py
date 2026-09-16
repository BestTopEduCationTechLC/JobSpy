"""HTTP service for on-demand, per-user scrapes — the Railway-hosted
replacement for GitHub Actions workflow_dispatch in scrape-jobs.yml's
private-run path (triggered by docs/index.html's "Run New Search").

Flow: docs/index.html -> App.dispatchScrape() -> trigger-scrape Supabase
Edge Function -> POST /scrape here. This service runs the scrape itself
(no CSV/notebook round-trip — it calls jobspy.scrape_jobs() directly, the
same way scraper/run_scheduled_searches.py does) and writes straight into
search_results / search_runs, exactly like scraper/upload_results.py and
scraper/mark_run_failed.py used to do from inside the GitHub Actions job.

The weekly shared-dataset scrape (docs/data/jobs.json, committed to the
repo) and the recurring per-user schedules are NOT handled here — they
still run on GitHub Actions (.github/workflows/scrape-jobs.yml's schedule
trigger, and scheduled-scrapes.yml). scrape-jobs.yml's workflow_dispatch
trigger is kept as a manual fallback for this same private-run path in
case this Railway service ever needs to be bypassed.

Required environment variables (set in Railway's dashboard):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — same as the GitHub Actions
    secrets of the same name.
  SCRAPER_WEBHOOK_SECRET — shared secret the trigger-scrape Edge Function
    sends as the X-Webhook-Secret header; requests without a match are
    rejected before anything runs.
"""
import json
import os
import sys
import threading
from datetime import datetime, timezone

import requests
from flask import Flask, jsonify, request
from jobspy import scrape_jobs

# Make sure scrape_defaults resolves regardless of how this module is
# loaded (plain `python server.py`, or gunicorn with/without --chdir).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrape_defaults import resolve_country_indeed, resolve_distance, resolve_location  # noqa: E402

FIELDS = [
    "id", "site", "title", "company", "location", "job_url",
    "job_type", "date_posted", "description",
]

app = Flask(__name__)


def rest_headers(service_key: str) -> dict:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


def mark_run(supabase_url: str, headers: dict, run_id: str, patch: dict) -> None:
    resp = requests.patch(
        f"{supabase_url}/rest/v1/search_runs?id=eq.{run_id}",
        headers={**headers, "Prefer": "return=minimal"},
        data=json.dumps(patch),
        timeout=30,
    )
    resp.raise_for_status()


def run_scrape(run_id: str, inputs: dict) -> None:
    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = rest_headers(service_key)

    try:
        site_names = (inputs.get("site_names") or "indeed,linkedin,google").split(",")
        hours_old_raw = inputs.get("hours_old")
        distance = resolve_distance(inputs.get("distance"))
        location = resolve_location(inputs.get("location"))
        country_indeed = resolve_country_indeed(inputs.get("country_indeed"), site_names)
        search_term = inputs.get("search_term") or "jobs"

        jobs = scrape_jobs(
            site_name=site_names,
            search_term=search_term,
            google_search_term=f"{search_term} jobs near {location}",
            location=location,
            results_wanted=int(inputs.get("results_wanted") or 100),
            hours_old=int(hours_old_raw) if hours_old_raw else None,
            country_indeed=country_indeed,
            job_type=inputs.get("job_type") or None,
            is_remote=str(inputs.get("is_remote")).lower() == "true",
            easy_apply=True if str(inputs.get("easy_apply")).lower() == "true" else None,
            distance=distance,
        )

        df = jobs
        for col in FIELDS:
            if col not in df.columns:
                df[col] = None
        df = df[FIELDS].astype(object)
        df = df.where(df.notnull(), None)

        rows = [
            {
                "run_id": run_id,
                "job_id": record["id"],
                "title": record["title"],
                "company": record["company"],
                "location": record["location"],
                "job_url": record["job_url"],
                "job_type": record["job_type"],
                "site": record["site"],
                "date_posted": str(record["date_posted"]) if record["date_posted"] else None,
                "description": record["description"],
            }
            for record in df.to_dict(orient="records")
        ]

        if rows:
            resp = requests.post(
                f"{supabase_url}/rest/v1/search_results",
                headers={**headers, "Prefer": "resolution=merge-duplicates"},
                data=json.dumps(rows),
                timeout=60,
            )
            resp.raise_for_status()

        mark_run(supabase_url, headers, run_id, {
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        print(f"[{run_id}] completed — uploaded {len(rows)} results")
    except Exception as exc:  # noqa: BLE001 — this runs off-request, on a thread
        print(f"[{run_id}] failed: {exc}")
        try:
            mark_run(supabase_url, headers, run_id, {
                "status": "failed",
                "error": str(exc)[:2000],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as mark_exc:  # noqa: BLE001
            print(f"[{run_id}] also failed to record the failure: {mark_exc}")


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})


@app.post("/scrape")
def scrape():
    expected_secret = os.environ.get("SCRAPER_WEBHOOK_SECRET")
    if not expected_secret:
        return jsonify({"error": "Server misconfigured: SCRAPER_WEBHOOK_SECRET not set"}), 500
    if request.headers.get("X-Webhook-Secret") != expected_secret:
        return jsonify({"error": "Not authorized"}), 401

    body = request.get_json(silent=True) or {}
    run_id = body.get("run_id")
    inputs = body.get("inputs") or {}
    if not run_id:
        return jsonify({"error": "Missing run_id"}), 400

    # Respond immediately — the frontend already polls search_runs in
    # Supabase for status, it never waits on this HTTP call itself.
    threading.Thread(target=run_scrape, args=(run_id, inputs), daemon=True).start()
    return jsonify({"ok": True}), 202


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
