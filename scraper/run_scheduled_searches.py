"""Run every due recurring (daily/weekly) scrape and store its results.

Invoked hourly by .github/workflows/scheduled-scrapes.yml. Entirely separate
from the one-off search_runs/search_results path (triggered by "Run New
Search" on the frontend) and from saved_jobs — a scheduled search's results
land only in scheduled_search_results, tied to the scheduled_searches row
that produced them.

One schedule failing (a bad site, a network hiccup) must never stop the
others from running, so each is wrapped in its own try/except.
"""
import json
import os
from datetime import datetime, timedelta, timezone

import requests
from jobspy import scrape_jobs

FIELDS = [
    "id", "site", "title", "company", "location", "job_url",
    "job_type", "date_posted", "description",
]

FREQUENCY_DELTA = {
    "daily": timedelta(days=1),
    "weekly": timedelta(days=7),
}


def rest_headers(service_key: str) -> dict:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


def fetch_due_schedules(supabase_url: str, headers: dict) -> list:
    # Use "Z" instead of "+00:00" — a literal "+" in an unescaped query string
    # value is read by some servers as a space, which would break this filter.
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    resp = requests.get(
        f"{supabase_url}/rest/v1/scheduled_searches",
        headers=headers,
        params={"is_active": "eq.true", "next_run_at": f"lte.{now}", "select": "*"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def mark_status(supabase_url: str, headers: dict, schedule_id: str, patch: dict) -> None:
    resp = requests.patch(
        f"{supabase_url}/rest/v1/scheduled_searches?id=eq.{schedule_id}",
        headers={**headers, "Prefer": "return=minimal"},
        data=json.dumps(patch),
        timeout=30,
    )
    resp.raise_for_status()


def run_one(supabase_url: str, headers: dict, schedule: dict) -> None:
    schedule_id = schedule["id"]
    params = schedule.get("params") or {}
    run_at = datetime.now(timezone.utc)

    mark_status(supabase_url, headers, schedule_id, {"last_status": "running"})

    site_names = (params.get("site_names") or "indeed,linkedin,google").split(",")
    hours_old_raw = params.get("hours_old")
    distance_raw = params.get("distance")

    jobs = scrape_jobs(
        site_name=site_names,
        search_term=schedule.get("search_term") or "jobs",
        google_search_term=f"{schedule.get('search_term') or 'jobs'} jobs near {schedule.get('location') or ''}",
        location=schedule.get("location") or "",
        results_wanted=int(params.get("results_wanted") or 50),
        hours_old=int(hours_old_raw) if hours_old_raw else None,
        # JobSpy validates country_indeed against a fixed list and rejects ""
        # (unlike location/search_term, which tolerate an empty string) — it
        # must be None when the user leaves the field blank.
        country_indeed=params.get("country_indeed") or None,
        job_type=params.get("job_type") or None,
        is_remote=str(params.get("is_remote")).lower() == "true",
        easy_apply=True if str(params.get("easy_apply")).lower() == "true" else None,
        distance=int(distance_raw) if distance_raw else None,
    )

    df = jobs
    for col in FIELDS:
        if col not in df.columns:
            df[col] = None
    df = df[FIELDS].astype(object)
    df = df.where(df.notnull(), None)

    rows = [
        {
            "schedule_id": schedule_id,
            "user_id": schedule["user_id"],
            "run_at": run_at.isoformat(),
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
            f"{supabase_url}/rest/v1/scheduled_search_results",
            headers={**headers, "Prefer": "resolution=merge-duplicates"},
            data=json.dumps(rows),
            timeout=60,
        )
        resp.raise_for_status()

    delta = FREQUENCY_DELTA.get(schedule.get("frequency"), FREQUENCY_DELTA["daily"])
    mark_status(supabase_url, headers, schedule_id, {
        "last_status": "completed",
        "last_error": None,
        "last_run_at": run_at.isoformat(),
        "next_run_at": (run_at + delta).isoformat(),
    })
    print(f"Schedule {schedule_id}: uploaded {len(rows)} results")


def main() -> None:
    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = rest_headers(service_key)

    schedules = fetch_due_schedules(supabase_url, headers)
    print(f"Found {len(schedules)} due schedule(s)")

    for schedule in schedules:
        schedule_id = schedule["id"]
        try:
            run_one(supabase_url, headers, schedule)
        except Exception as exc:  # noqa: BLE001 - one bad schedule must not stop the rest
            print(f"Schedule {schedule_id} failed: {exc}")
            delta = FREQUENCY_DELTA.get(schedule.get("frequency"), FREQUENCY_DELTA["daily"])
            next_run_at = datetime.now(timezone.utc) + delta
            try:
                mark_status(supabase_url, headers, schedule_id, {
                    "last_status": "failed",
                    "last_error": str(exc)[:2000],
                    "last_run_at": datetime.now(timezone.utc).isoformat(),
                    "next_run_at": next_run_at.isoformat(),
                })
            except Exception as mark_exc:  # noqa: BLE001
                print(f"Schedule {schedule_id}: also failed to record the failure: {mark_exc}")


if __name__ == "__main__":
    main()
