"""
onlinejobs.ph Job Scraper - Selenium version
Used by sync.js for Node.js integration
"""
import json
import logging
import re
import time
import sys
import io

# Fix Windows encoding
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager

# ── Logging to file only (not stdout) ────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    filename="scraper.log",
    filemode="a",
    encoding="utf-8"
)
log = logging.getLogger(__name__)

BASE_URL = "https://www.onlinejobs.ph"
SEARCH_URL = f"{BASE_URL}/jobseekers/jobsearch"

# ── Browser Setup ─────────────────────────────────────────────────────────────
def make_driver(headless=True):
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    opts.add_argument("--window-size=1920,1080")
    opts.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=opts)
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {"source": "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"},
    )
    return driver

def fetch_page(driver, url):
    log.info(f"Loading: {url}")
    driver.get(url)
    try:
        WebDriverWait(driver, 15).until(
            EC.presence_of_all_elements_located(
                (By.CSS_SELECTOR, "div.jobpost-cat-box h4.fs-16")
            )
        )
        time.sleep(2)
    except Exception as e:
        log.warning(f"Wait timeout: {e}")
    return driver.page_source

def parse_jobs(html):
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.find_all("div", class_=lambda c: c and "jobpost-cat-box" in c)
    log.info(f"Job cards found: {len(cards)}")
    
    jobs = []
    for card in cards:
        job = {}
        
        # Find job URL
        job_url = ""
        for a in card.find_all("a", href=True):
            href = a.get("href", "")
            if re.search(r"/job(?:seekers)?/job/", href):
                job_url = href
                break
        
        if not job_url:
            continue
            
        job["url"] = BASE_URL + job_url if job_url.startswith("/") else job_url
        
        # Title and job type
        h4 = card.find("h4", class_="fs-16") or card.find("h4")
        if not h4:
            continue
            
        badge = h4.find("span", class_="badge")
        job["job_type"] = badge.get_text(strip=True) if badge else ""
        if badge:
            badge.extract()
        job["title"] = h4.get_text(strip=True)
        
        # Date posted
        date_elem = card.find("p", class_="fs-13") or card.find("em")
        if date_elem:
            date_text = date_elem.get_text(strip=True)
            job["date_posted"] = date_text.replace("Posted on ", "").strip()
        else:
            job["date_posted"] = ""
        
        # Salary
        salary = ""
        dd_elem = card.find("dd", class_="col")
        if dd_elem:
            salary = dd_elem.get_text(strip=True)
        
        if not salary:
            for elem in card.find_all(["dd", "dt", "p", "span", "div"]):
                text = elem.get_text(strip=True)
                if text and any(s in text.upper() for s in ["$", "USD", "PHP", "₱"]):
                    if "posted" not in text.lower():
                        salary = text
                        break
        
        job["salary"] = salary
        
        # Description
        desc_div = card.find("div", class_=lambda c: c and "desc" in c)
        if desc_div:
            for sm in desc_div.find_all("a", string=re.compile(r"See More", re.I)):
                sm.extract()
            desc_text = desc_div.get_text(" ", strip=True)
            job["description"] = desc_text[:500] if desc_text else ""
        else:
            job["description"] = ""
        
        # Tags
        tag_div = card.find("div", class_="job-tag")
        if tag_div:
            tags = [a.get_text(strip=True) for a in tag_div.find_all("a") if a.get_text(strip=True)]
            job["tags"] = ", ".join(tags)
        else:
            job["tags"] = ""
        
        # Job ID
        job_id_match = re.search(r"/(\d+)(?:/|$)", job_url)
        job["job_id"] = job_id_match.group(1) if job_id_match else ""
        
        jobs.append(job)
    
    log.info(f"Parsed: {len(jobs)} jobs")
    return jobs

def get_last_page(html):
    soup = BeautifulSoup(html, "html.parser")
    page_numbers = []
    for el in soup.select("li.page-item a, .pagination a"):
        try:
            num = int(el.get_text(strip=True))
            page_numbers.append(num)
        except ValueError:
            continue
    return max(page_numbers) if page_numbers else 1

def scrape_jobs(keyword="IT", max_pages=5, headless=True):
    driver = make_driver(headless=headless)
    all_jobs = []
    
    try:
        log.info(f"Starting: keyword='{keyword}', pages={max_pages}")
        
        for page in range(1, max_pages + 1):
            log.info(f"Page {page}/{max_pages}")
            
            url = f"{SEARCH_URL}?q={keyword}&page={page}"
            html = fetch_page(driver, url)
            jobs = parse_jobs(html)
            
            if not jobs:
                log.info("No jobs found - stopping")
                break
            
            all_jobs.extend(jobs)
            log.info(f"Collected {len(jobs)} jobs (total: {len(all_jobs)})")
            
            last_page = get_last_page(html)
            if page >= last_page:
                log.info(f"Reached last page ({last_page})")
                break
            
            if page < max_pages:
                time.sleep(2)
        
    except Exception as e:
        log.error(f"Scraping error: {e}")
    finally:
        driver.quit()
        log.info("Browser closed")
    
    return all_jobs