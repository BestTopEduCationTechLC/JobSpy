"""Shared location/country defaults for every place jobspy.scrape_jobs() is
actually called (JOBSCRAPPER.ipynb and run_scheduled_searches.py), so a
blank field is treated the same way everywhere the scraper runs.
"""

DEFAULT_LOCATION = "Singapore"
DEFAULT_COUNTRY_INDEED = "singapore"

# The widest radius accepted across the sites that use jobspy's `distance`
# param (Indeed, LinkedIn, ZipRecruiter each treat it as a search-radius
# filter in miles) — used whenever the caller doesn't specify one, so every
# scrape casts the widest possible net by default instead of an arbitrary
# 50-mile default.
DEFAULT_DISTANCE = 100

# Of all the sites JobSpy supports, only Indeed and Glassdoor actually build
# their request around scraper_input.country: Indeed uses it to pick a
# country-specific subdomain, and Glassdoor uses it to pick a
# country-specific glassdoor.<tld> domain. LinkedIn/Google/ZipRecruiter/Bayt
# ignore it entirely. jobspy.model.Country.from_string() still needs SOME
# real, valid country string no matter what (it unconditionally calls
# .strip() on it, and rejects "" or an unrecognized name) — so this decides
# what to hand it: a real, geography-specific default only when Indeed or
# Glassdoor is actually in play, and the country-agnostic "worldwide" value
# otherwise so a LinkedIn/Google-only search never gets a region forced on it
# that it didn't ask for. Note "worldwide" itself would break Glassdoor
# (jobspy.model.Country.glassdoor_domain_value raises for it) — which is
# exactly why the check below only lets it through when neither of those two
# sites is selected.
SITES_REQUIRING_COUNTRY = {"indeed", "glassdoor"}


def resolve_location(location) -> str:
    """A blank location always becomes Singapore — the one default used
    everywhere in this app, regardless of which entry point is scraping."""
    return str(location or "").strip() or DEFAULT_LOCATION


def resolve_country_indeed(country_indeed, site_names) -> str:
    country_indeed = str(country_indeed or "").strip()
    sites = {str(s).strip().lower() for s in site_names}
    if sites & SITES_REQUIRING_COUNTRY:
        return country_indeed or DEFAULT_COUNTRY_INDEED
    return country_indeed or "worldwide"


def resolve_distance(distance) -> int:
    """A blank/zero distance always becomes the maximum radius — there's no
    distance box in the UI anymore, so this is the only place it's set."""
    try:
        value = int(distance)
    except (TypeError, ValueError):
        return DEFAULT_DISTANCE
    return value if value > 0 else DEFAULT_DISTANCE
