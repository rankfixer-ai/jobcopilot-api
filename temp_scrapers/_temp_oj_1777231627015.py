
import sys, json
sys.path.insert(0, r'C:\Users\acibr\Documents\Jobfinder\jobcopilot-api/scrapers')
from onlinejobs_scraper import scrape_jobs
jobs = scrape_jobs(keyword="BPO", max_pages=3, headless=True)
print("ONLINEJOBS_RESULT:" + json.dumps(jobs))
