"""Upload one search run's results into Supabase and mark it completed.

Used only for user-triggered runs (a run_id came from the frontend via the
trigger-scrape Edge Function). The scheduled weekly run has no run_id and
instead writes the shared docs/data/jobs.json via csv_to_json.py — private
per-user runs never touch that shared file.
"""
import json
import os
import sys
from datetime import datetime, timezone

import pandas as pd
import requests

from notify import maybe_notify

FIELDS = [
    "id", "site", "title", "company", "location", "job_url",
    "job_type", "date_posted", "description",
]


def main(csv_path: str, run_id: str) -> None:
    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }

    df = pd.read_csv(csv_path)
    for col in FIELDS:
        if col not in df.columns:
            df[col] = None
    df = df[FIELDS].astype(object)
    df = df.where(pd.notnull(df), None)

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

    resp = requests.patch(
        f"{supabase_url}/rest/v1/search_runs?id=eq.{run_id}",
        headers={**headers, "Prefer": "return=minimal"},
        data=json.dumps({
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }),
        timeout=30,
    )
    resp.raise_for_status()

    print(f"Uploaded {len(rows)} results for run {run_id}")
    maybe_notify(supabase_url, service_key, run_id, "completed")


if __name__ == "__main__":
    csv_path, run_id = sys.argv[1:3]
    main(csv_path, run_id)
