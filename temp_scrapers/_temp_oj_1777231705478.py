
import sys, json
sys.path.insert(0, r'C:\Users\acibr\Documents\Jobfinder\jobcopilot-api/scrapers')
from onlinejobs_scraper import scrape_jobs
jobs = scrape_jobs(keyword="Fresh Graduate", max_pages=2, headless=True)
print("ONLINEJOBS_RESULT:" + json.dumps(jobs))
