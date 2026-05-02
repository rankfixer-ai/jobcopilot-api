require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Dual Clients
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(compression());
app.use(express.json());

// --- MIDDLEWARE ---

const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, error: 'Authorization header missing' });
  
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  
  if (error || !user) return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  
  const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
  user.role = profile ? profile.role : 'job_seeker';
  req.user = user;
  next();
};

const requireRole = (role) => (req, res, next) => {
  if (req.user.role !== role && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions' });
  }
  next();
};

// --- PUBLIC ENDPOINTS ---

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Server is healthy' });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, role = 'job_seeker' } = req.body;
  const { data, error } = await supabaseAuth.auth.signUp({ email, password });
  if (error) return res.status(400).json({ success: false, error: error.message });
  
  const { error: pErr } = await supabaseAdmin.from('profiles').insert([{ 
  id: data.user.id, 
  full_name: full_name, 
  role: role 
}]);
  if (pErr) return res.status(500).json({ success: false, error: 'Profile creation failed' });
  
  res.json({ success: true, data: data });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.get('/api/jobs', async (req, res) => {
  const { keyword, city, remote, page = 1, limit = 15 } = req.query;
  let query = supabaseAdmin.from('jobs_clean').select('*', { count: 'exact' }).eq('is_active', true);
  
  if (keyword) query = query.ilike('title', '%' + keyword + '%');
  if (city) query = query.ilike('city', '%' + city + '%');
  if (remote === 'true') query = query.eq('remote_type', 'remote');
  
  const start = (parseInt(page) - 1) * parseInt(limit);
  const end = start + parseInt(limit) - 1;
  
  const { data, count, error } = await query.range(start, end).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  
  res.json({ success: true, data: data, pagination: { total: count, page: parseInt(page), limit: parseInt(limit) } });
});

app.get('/api/jobs/featured', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('jobs_clean').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(6);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.get('/api/jobs/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('jobs_clean').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: data });
});

app.get('/api/stats', async (req, res) => {
  const { count: total } = await supabaseAdmin.from('jobs_clean').select('*', { count: 'exact', head: true }).eq('is_active', true);
  const { count: remote } = await supabaseAdmin.from('jobs_clean').select('*', { count: 'exact', head: true }).eq('is_active', true).eq('remote_type', 'remote');
  res.json({ success: true, data: { totalJobs: total, remoteJobs: remote } });
});

app.get('/api/categories', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('categories').select('*').order('name', { ascending: true });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.get('/api/search/suggest', async (req, res) => {
  const { q } = req.query;
  const { data, error } = await supabaseAdmin.from('jobs_clean').select('title').ilike('title', '%' + q + '%').limit(5);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.get('/api/trending', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('search_terms').select('*').order('count', { ascending: false }).limit(5);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

// --- NEW: PUBLIC JOB SEEKER PROFILE ENDPOINTS ---

app.get('/api/profile/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('profiles').select('full_name, headline, bio, city, job_title').eq('id', req.params.id).eq('role', 'job_seeker').single();
  if (error) return res.status(404).json({ success: false, error: 'Profile not found' });
  res.json({ success: true, data: data });
});

app.get('/api/profiles/search', async (req, res) => {
  const { q } = req.query;
  const { data, error } = await supabaseAdmin.from('profiles')
    .select('id, full_name, headline, city, job_title')
    .eq('role', 'job_seeker')
    .or('full_name.ilike.%' + q + '%,headline.ilike.%' + q + '%');
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

// --- NEW: FIND CLIENTS (EMPLOYER DIRECTORY) ENDPOINTS ---

app.get('/api/employers', async (req, res) => {
  const { q, city } = req.query;
  let query = supabaseAdmin.from('companies').select('*');
  if (q) query = query.ilike('name', '%' + q + '%');
  if (city) query = query.ilike('city', '%' + city + '%');
  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.get('/api/employers/:id', async (req, res) => {
  const { data: company, error: cErr } = await supabaseAdmin.from('companies').select('*').eq('id', req.params.id).single();
  if (cErr) return res.status(404).json({ success: false, error: 'Employer not found' });
  const { data: jobs } = await supabaseAdmin.from('jobs_clean').select('*').eq('employer_id', req.params.id).eq('is_active', true);
  res.json({ success: true, data: { company: company, jobs: jobs } });
});

// --- AUTHENTICATED SEEKER ENDPOINTS ---

app.get('/api/saved', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('saved_jobs').select('job_id, jobs_clean(*)').eq('user_id', req.user.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.post('/api/saved/:jobId', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('saved_jobs').insert([{ user_id: req.user.id, job_id: req.params.jobId }]);
  if (error) return res.status(400).json({ success: false, error: 'Already saved or invalid ID' });
  res.json({ success: true });
});

app.delete('/api/saved/:jobId', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('saved_jobs').delete().eq('user_id', req.user.id).eq('job_id', req.params.jobId);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.get('/api/applications', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('applications').select('*, jobs_clean(title, company)').eq('user_id', req.user.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.post('/api/applications', requireAuth, async (req, res) => {
  const { job_id, resume_url, cover_letter } = req.body;
  const { data, error } = await supabaseAdmin.from('applications').insert([{ user_id: req.user.id, job_id, resume_url, cover_letter, status: 'pending' }]);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.put('/api/applications/:id', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('applications').update(req.body).eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.delete('/api/applications/:id', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('applications').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.get('/api/profile', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', req.user.id).single();
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.put('/api/profile', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('profiles').update(req.body).eq('id', req.user.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

// --- EMPLOYER ENDPOINTS ---

app.get('/api/employer/jobs', requireAuth, requireRole('employer'), async (req, res) => {
  const { data, error } = await supabaseAdmin.from('jobs_clean').select('*, applications(count)').eq('employer_id', req.user.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.post('/api/employer/jobs', requireAuth, requireRole('employer'), async (req, res) => {
  const { error } = await supabaseAdmin.from('jobs_clean').insert([{ ...req.body, employer_id: req.user.id }]);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.get('/api/employer/jobs/:id/applicants', requireAuth, requireRole('employer'), async (req, res) => {
  const { data, error } = await supabaseAdmin.from('applications').select('*, profiles(full_name, email)').eq('job_id', req.params.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.put('/api/employer/applications/:id', requireAuth, requireRole('employer'), async (req, res) => {
  const { status } = req.body;
  const { error } = await supabaseAdmin.from('applications').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

// --- ADMIN ENDPOINTS ---

app.get('/api/admin/stats', requireAuth, requireRole('admin'), async (req, res) => {
  const { count: users } = await supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true });
  const { count: jobs } = await supabaseAdmin.from('jobs_clean').select('*', { count: 'exact', head: true });
  const { count: apps } = await supabaseAdmin.from('applications').select('*', { count: 'exact', head: true });
  res.json({ success: true, data: { users, jobs, applications: apps } });
});

app.get('/api/admin/companies', requireAuth, requireRole('admin'), async (req, res) => {
  const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('role', 'employer');
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data });
});

app.put('/api/admin/companies/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { error } = await supabaseAdmin.from('profiles').update(req.body).eq('id', req.params.id).eq('role', 'employer');
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.listen(PORT, () => console.log('Server is running on port ' + PORT));