// test-adzuna.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');

const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;

async function testEndpoints() {
  const tests = [
    // Test 1: UK jobs (most reliable, always works if credentials valid)
    {
      name: 'UK test',
      url: 'https://api.adzuna.com/v1/api/jobs/gb/search/1',
      params: {
        app_id: APP_ID,
        app_key: APP_KEY,
        what: 'python',
        where: 'london',
        results_per_page: 1
      }
    },
    // Test 2: PH with different format
    {
      name: 'PH test (lowercase)',
      url: 'https://api.adzuna.com/v1/api/jobs/ph/search/1',
      params: {
        app_id: APP_ID,
        app_key: APP_KEY,
        what: 'BPO',
        where: 'manila',
        results_per_page: 1
      }
    },
    // Test 3: Check if country code matters
    {
      name: 'PH (uppercase)',
      url: 'https://api.adzuna.com/v1/api/jobs/PH/search/1',
      params: {
        app_id: APP_ID,
        app_key: APP_KEY,
        what: 'BPO',
        where: 'manila',
        results_per_page: 1
      }
    },
    // Test 4: Try without where parameter
    {
      name: 'PH no location',
      url: 'https://api.adzuna.com/v1/api/jobs/ph/search/1',
      params: {
        app_id: APP_ID,
        app_key: APP_KEY,
        what: 'BPO',
        results_per_page: 1
      }
    },
    // Test 5: Check available countries
    {
      name: 'Available countries',
      url: 'https://api.adzuna.com/v1/api/jobs/ph/search/1',
      params: {
        app_id: APP_ID,
        app_key: APP_KEY,
        what: 'and',
        results_per_page: 1
      }
    }
  ];

  console.log('🔍 Testing Adzuna API endpoints...\n');
  console.log('App ID:', APP_ID?.substring(0, 6) + '...');
  console.log('App Key exists:', !!APP_KEY);
  console.log('');

  for (const test of tests) {
    try {
      const response = await axios.get(test.url, { params: test.params });
      const count = response.data?.count || 0;
      console.log(`✅ ${test.name}: ${count} results found`);
      console.log(`   First job: ${response.data?.results?.[0]?.title || 'N/A'}`);
    } catch (error) {
      if (error.response) {
        console.log(`❌ ${test.name}: HTTP ${error.response.status} - ${error.response.statusText}`);
        // Show the actual URL (hide key)
        const fullUrl = `${test.url}?${new URLSearchParams({...test.params, app_key: 'HIDDEN'}).toString()}`;
        console.log(`   URL: ${fullUrl}`);
      } else {
        console.log(`❌ ${test.name}: ${error.message}`);
      }
    }
    console.log('');
  }
}

testEndpoints();