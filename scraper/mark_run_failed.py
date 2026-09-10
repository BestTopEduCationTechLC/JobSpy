"""Mark a search_runs row as failed. Used when the scrape step itself errors
out for a user-triggered run, so the frontend can stop polling and show an
error instead of spinning forever."""
import json
import os
import sys
from datetime import datetime, timezone

import requests

from notify import maybe_notify


def main(run_id: str, error: str) -> None:
    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    resp = requests.patch(
        f"{supabase_url}/rest/v1/search_runs?id=eq.{run_id}",
        headers=headers,
        data=json.dumps({
            "status": "failed",
            "error": error,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }),
        timeout=30,
    )
    resp.raise_for_status()
    maybe_notify(supabase_url, service_key, run_id, "failed", error)


if __name__ == "__main__":
    run_id = sys.argv[1]
    error = sys.argv[2] if len(sys.argv) > 2 else "Scrape failed — check the Actions log."
    main(run_id, error)
