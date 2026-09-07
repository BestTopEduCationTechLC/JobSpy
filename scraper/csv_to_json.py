"""Convert the CSV produced by JOBSCRAPPER.ipynb into the JSON the docs/ frontend loads."""
import json
import sys
from datetime import datetime, timezone

import pandas as pd

FIELDS = [
    "id",
    "site",
    "title",
    "company",
    "location",
    "job_url",
    "job_type",
    "date_posted",
    "min_amount",
    "max_amount",
    "currency",
    "interval",
    "description",
]


def main(csv_path: str, config_path: str, out_path: str) -> None:
    df = pd.read_csv(csv_path)
    for col in FIELDS:
        if col not in df.columns:
            df[col] = None
    df = df[FIELDS].astype(object)
    df = df.where(pd.notnull(df), None)

    with open(config_path) as f:
        config = json.load(f)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "search_term": config.get("search_term"),
        "location": config.get("location"),
        "count": len(df),
        "jobs": df.to_dict(orient="records"),
    }

    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2, default=str, allow_nan=False)

    print(f"Wrote {len(df)} jobs to {out_path}")


if __name__ == "__main__":
    csv_path, config_path, out_path = sys.argv[1:4]
    main(csv_path, config_path, out_path)
