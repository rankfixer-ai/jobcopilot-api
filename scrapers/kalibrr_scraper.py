# ==========================================================
# scrapers/kalibrr_scraper.py
# Kalibrr Scraper V3 FINAL PRODUCTION
# Job Copilot
#
# Requirements:
#   pip install playwright
#   playwright install chromium
#
# Usage:
#   python scrapers/kalibrr_scraper.py
#   python scrapers/kalibrr_scraper.py customer-service 2
#
# Output:
#   KALIBRR_RESULT:[...json jobs...]
# ==========================================================

import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from urllib.parse import quote
from playwright.async_api import async_playwright

# ==========================================================
# CONFIG
# ==========================================================

SEARCH = sys.argv[1] if len(sys.argv) > 1 else "customer-service"
PAGES = int(sys.argv[2]) if len(sys.argv) > 2 else 2
HEADLESS = True
MAX_PER_PAGE = 20

BASE_URL = "https://www.kalibrr.com/job-board/te/{search}?page={page}"

KNOWN_CITIES = [
    "Makati",
    "Taguig",
    "Pasig",
    "Quezon City",
    "Manila",
    "Parañaque",
    "Paranaque",
    "Muntinlupa",
    "Cebu",
    "Cebu City",
    "Davao",
    "Pasay",
    "Mandaluyong",
    "BGC",
    "Ortigas",
]

# ==========================================================
# HELPERS
# ==========================================================

def log(msg):
    print(msg, file=sys.stderr)


def clean(text):
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def slug_to_name(slug):
    slug = slug.replace("-", " ").strip()
    return " ".join(w.capitalize() for w in slug.split())


def company_from_url(url):
    """
    https://www.kalibrr.com/c/ztek-consulting-inc/jobs/123/title
    """
    m = re.search(r"/c/([^/]+)/jobs/", url)
    if not m:
        return "Unknown"

    slug = m.group(1)
    return slug_to_name(slug)


def extract_city(text):
    lower = text.lower()

    for city in KNOWN_CITIES:
        if city.lower() in lower:
            return city

    return "Philippines"


def detect_remote(text):
    t = text.lower()

    if "hybrid" in t:
        return "hybrid"

    if (
        "remote" in t
        or "work from home" in t
        or "home based" in t
        or "telecommute" in t
        or "wfh" in t
    ):
        return "remote"

    return "onsite"


def detect_employment(text):
    t = text.lower()

    checks = [
        "full time",
        "part time",
        "contract",
        "freelance",
        "internship",
        "temporary",
    ]

    for item in checks:
        if item in t:
            return item

    return ""


def parse_salary(text):
    """
    Strict PHP salary parser only.
    Avoids grabbing years / IDs / addresses.
    """

    # ₱30,000 - ₱45,000
    range_match = re.search(
        r"₱\s?([\d,]{4,})\s*(?:-|to)\s*₱?\s?([\d,]{4,})",
        text,
        re.I,
    )

    if range_match:
        return (
            int(range_match.group(1).replace(",", "")),
            int(range_match.group(2).replace(",", "")),
        )

    # ₱35,000
    single = re.search(r"₱\s?([\d,]{4,})", text, re.I)

    if single:
        val = int(single.group(1).replace(",", ""))
        return val, val

    return None, None


def extract_description(text):
    patterns = [
        r"Job Description(.*?)(Minimum Qualifications|About|Jobs Summary|Benefits|Requirements)",
        r"Responsibilities(.*?)(Qualifications|Requirements|About)",
        r"About the role(.*?)(Requirements|Qualifications|Benefits)",
    ]

    for pattern in patterns:
        m = re.search(pattern, text, re.I)
        if m:
            return clean(m.group(1))[:6000]

    return clean(text)[:4000]


# ==========================================================
# SCRAPE DETAIL PAGE
# ==========================================================

async def scrape_detail(context, url):
    page = await context.new_page()

    try:
        await page.goto(url, timeout=60000)
        await page.wait_for_timeout(1800)

        body_text = clean(
            await page.locator("body").text_content()
        )

        # Title
        title = ""
        if await page.locator("h1").count() > 0:
            title = clean(
                await page.locator("h1").first.text_content()
            )

        if not title:
            return None

        # Company
        company = company_from_url(url)

        # Location / City
        city = extract_city(body_text)
        location = f"{city}, Philippines"

        # Salary
        salary_min, salary_max = parse_salary(body_text)

        # Description
        description = extract_description(body_text)
        snippet = description[:280]

        # Types
        remote_type = detect_remote(body_text)
        employment_type = detect_employment(body_text)

        # External ID
        external_id = url.rstrip("/").split("/")[-2]

        return {
            "source_name": "Kalibrr",
            "external_id": external_id,
            "title": title,
            "company": company,
            "location": location,
            "city": city,
            "country": "Philippines",
            "salary_min": salary_min,
            "salary_max": salary_max,
            "salary_currency": "PHP",
            "salary_visible": salary_min is not None,
            "remote_type": remote_type,
            "employment_type": employment_type,
            "snippet": snippet,
            "description": description,
            "job_url": url,
            "posted_at": now_iso(),
            "is_active": True,
            "last_seen_at": now_iso(),
        }

    except Exception as e:
        log(f"DETAIL ERROR {url}: {e}")
        return None

    finally:
        await page.close()


# ==========================================================
# SCRAPE LIST PAGE
# ==========================================================

async def scrape_page(context, page_num):
    url = BASE_URL.format(
        search=quote(SEARCH),
        page=page_num
    )

    page = await context.new_page()

    try:
        log(f"Opening {url}")

        await page.goto(url, timeout=60000)
        await page.wait_for_timeout(3000)

        # trigger lazy load
        await page.mouse.wheel(0, 4000)
        await page.wait_for_timeout(1500)

        links = await page.locator(
            "a[href*='/jobs/']"
        ).evaluate_all(
            "els => els.map(e => e.href)"
        )

        # unique only
        links = list(dict.fromkeys(links))

        # keep valid Kalibrr jobs only
        links = [
            x for x in links
            if "/jobs/" in x and "/c/" in x
        ][:MAX_PER_PAGE]

        jobs = []

        for link in links:
            item = await scrape_detail(
                context,
                link
            )

            if item:
                jobs.append(item)

        return jobs

    except Exception as e:
        log(f"PAGE ERROR {page_num}: {e}")
        return []

    finally:
        await page.close()


# ==========================================================
# MAIN
# ==========================================================

async def main():
    results = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=HEADLESS
        )

        context = await browser.new_context(
            viewport={
                "width": 1440,
                "height": 900,
            },
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        )

        for page_num in range(1, PAGES + 1):
            rows = await scrape_page(
                context,
                page_num
            )

            results.extend(rows)

        await browser.close()

    # dedupe by external_id
    unique = {}
    for row in results:
        unique[row["external_id"]] = row

    final_rows = list(unique.values())

    print(
        "KALIBRR_RESULT:"
        + json.dumps(
            final_rows,
            ensure_ascii=False
        )
    )


if __name__ == "__main__":
    asyncio.run(main())