"""Best-effort email notification via Mailgun for a search run's owner.

Only fires when the frontend flagged the run with notify_email = true AND the
MAILGUN_API_KEY / MAILGUN_DOMAIN repo secrets are set. Until those secrets are
filled in, this quietly does nothing — the scrape itself never depends on
Mailgun being configured. Any failure here is logged and swallowed; a broken
notification must never fail the workflow that already scraped the jobs.
"""
import os

import requests


def maybe_notify(supabase_url: str, service_key: str, run_id: str, status: str, error: str = None) -> None:
    api_key = os.environ.get("MAILGUN_API_KEY")
    domain = os.environ.get("MAILGUN_DOMAIN")
    if not api_key or not domain:
        return  # notifications not configured yet

    try:
        headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}

        resp = requests.get(
            f"{supabase_url}/rest/v1/search_runs"
            f"?id=eq.{run_id}&select=user_id,search_term,location,notify_email",
            headers=headers,
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows or not rows[0].get("notify_email"):
            return
        run = rows[0]

        user_resp = requests.get(
            f"{supabase_url}/auth/v1/admin/users/{run['user_id']}",
            headers=headers,
            timeout=30,
        )
        user_resp.raise_for_status()
        email = user_resp.json().get("email")
        if not email:
            return

        term = run.get("search_term") or "your search"
        loc = run.get("location") or ""
        if status == "completed":
            subject = f'Your search for "{term}" is ready'
            body = f'Your search for "{term}" in {loc} has finished. Sign in to view the results.'
        else:
            subject = f'Your search for "{term}" failed'
            body = f'Your search for "{term}" in {loc} failed: {error or "unknown error"}'

        sender = os.environ.get("MAILGUN_SENDER") or f"JobSpy Search <noreply@{domain}>"
        mg_resp = requests.post(
            f"https://api.mailgun.net/v3/{domain}/messages",
            auth=("api", api_key),
            data={"from": sender, "to": [email], "subject": subject, "text": body},
            timeout=30,
        )
        if not mg_resp.ok:
            print(f"Mailgun notification failed ({mg_resp.status_code}): {mg_resp.text}")
    except requests.RequestException as exc:
        print(f"Mailgun notification skipped due to an error: {exc}")
