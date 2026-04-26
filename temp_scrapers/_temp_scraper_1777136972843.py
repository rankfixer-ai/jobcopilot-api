
import sys
import json
sys.path.insert(0, r'C:\Users\acibr\Documents\Jobfinder\job-aggregator-sync')
from onlinejobs_scraper import scrape_jobs

try:
    jobs = scrape_jobs(keyword="Fresh Graduate", max_pages=2, headless=True)
    print("PYTHON_RESULT:" + json.dumps(jobs))
except Exception as e:
    print("PYTHON_ERROR:" + str(e))
