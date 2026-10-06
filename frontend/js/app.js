/* ---------- Data ---------- */
const PRODUCTS = [
  { id: 'cassava', name: 'Cassava', icon: '🍠', pkg: 'Cassava Starch Packaging',
    desc: 'Compostable packaging made from cassava peels and starch residue.',
    uses: ['Food takeaway containers', 'Produce wrapping', 'Seedling bags'] },
  { id: 'maize', name: 'Maize', icon: '🌽', pkg: 'Maize Husk Packaging',
    desc: 'Moulded trays and fillers made from maize husks and cobs.',
    uses: ['Egg trays', 'Protective shipping filler', 'Disposable plates'] },
  { id: 'banana', name: 'Banana Peels', icon: '🍌', pkg: 'Banana Fibre Packaging',
    desc: 'Strong fibre sheets and bags from banana peels and stems.',
    uses: ['Shopping bags', 'Gift wrap', 'Fruit cushioning'] },
  { id: 'sugarcane', name: 'Sugar Cane', icon: '🎋', pkg: 'Bagasse Packaging',
    desc: 'Bagasse (sugar cane pulp) bowls, cups and clamshells.',
    uses: ['Hot food bowls', 'Cups and lids', 'Bakery clamshells'] }
];
const IMGS = { cassava: 'images/cassava.jpg', maize: 'images/maize.jpg', banana: 'images/banana.jpg', sugarcane: 'images/sugarcane.jpg' };
PRODUCTS.forEach(p => p.img = IMGS[p.id]);

const FARMER_STEPS = [
  { i: '🌾', t: 'Do you have biodegradable or recyclable waste?', p: 'Cassava peels, maize husks, banana peels, sugar cane residue... what you throw away has value.' },
  { i: '🤝', t: 'Are you interested in joining us?', p: 'We collect your farm waste and turn it into eco-friendly packaging, and you get paid for it.' },
  { i: '📝', t: 'We require a few details', p: 'Tell us who you are and where we can find you.', form: true }
];
const CUSTOMER_STEPS = [
  { i: '🌍', t: 'Join us in reducing our carbon footprint', p: 'Our packaging is made from farm waste instead of plastic.' },
  { i: '📦', t: 'Are you interested in using our carbon-friendly product?', p: 'Browse the packages, see what each is made of and how to use it.' },
  { i: '🔐', t: 'Create your account', p: 'Just a few details.', form: true }
];

/* ---------- Helpers ---------- */
const $app = document.getElementById('app');
const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); };
const prod = id => PRODUCTS.find(p => p.id === id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $v = id => document.getElementById(id).value.trim();
const safe = fn => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
const bg = src => `<img class="bg" src="${src}" alt="" onerror="this.remove()">`;
const pcard = (p, click, title, sub) => `
  <div class="pcard" onclick="${click}">${bg(p.img)}
    <div class="txt"><div class="ico">${p.icon}</div><h3>${title}</h3><p>${sub}</p></div>
  </div>`;

let step = 0, adminTab = 'farmers', loginMode = false, photoBlob = null, seenSubs = null;
let photoPending = false;
const setMsg = (id, text, kind = '') => { const el = document.getElementById(id); if (el) { el.textContent = text; el.className = 'msg ' + kind; } };

/* ---------- Sessions + API ---------- */
const session = {
  get: r => { try { return JSON.parse(localStorage.getItem('session_' + r)); } catch { return null; } },
  set: (r, v) => localStorage.setItem('session_' + r, JSON.stringify(v)),
  clear: r => localStorage.removeItem('session_' + r)
};

async function api(path, { method = 'GET', body, form, role } = {}) {
  const headers = {};
  const s = role && session.get(role);
  if (s) headers.Authorization = 'Bearer ' + s.token;
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
    try { res = await fetch('/api' + path, { method, headers, body: payload, signal: AbortSignal.timeout(30000) }); }
  catch (e) {
    console.error('Request failed:', path, e);
    throw new Error(e.name === 'TimeoutError'
      ? 'The server did not answer within 30 seconds. Check the terminal for errors.'
      : 'Cannot reach the server. Is it running?');
  }
  if (res.status === 401 && role) {
    session.clear(role);
    const target = role === 'admin' ? '#/admin' : '#/' + role;
    if (location.hash === target) route(); else location.hash = target;
    throw new Error('Please sign in again');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Something went wrong');
  return data;
}

/* ---------- Router ---------- */
function nav() {
  const f = session.get('farmer'), c = session.get('customer');
  document.getElementById('nav-links').innerHTML =
    `<a href="#/farmer">Farmers</a><a href="#/customer">Customers</a>` +
    (f ? `<a href="#/farmer/dashboard">My Dashboard</a>` : '') +
    (c ? `<a href="#/customer/dashboard">Packages</a>` : '') +
    (f || c ? `<a href="javascript:void(0)" onclick="logout()">Log out</a>` : '');
}
window.logout = async () => {
  for (const role of ['farmer', 'customer']) {
    if (session.get(role)) {
      try { await api('/logout', { method: 'POST', role }); } catch { /* token may already be invalid */ }
      session.clear(role);
    }
  }
  toast('Logged out');
  if (location.hash === '#/' || location.hash === '') route(); else location.hash = '#/';
};
const run = fn => Promise.resolve().then(fn).catch(e => toast(e.message));

function route() {
  nav();
  const [, a, b, c] = location.hash.split('/');
  if (!a) return run(home);

  if (a === 'farmer') {
    const farmerSession = session.get('farmer');
    if (b === 'dashboard' || farmerSession) {
      return run(farmerDash);
    }
    return run(() => onboarding('farmer'));
  }

  if (a === 'customer') {
    const customerSession = session.get('customer');
    if (b === 'dashboard' || (customerSession && !b)) {
      return run(customerDash);
    }
    if (b === 'product') return run(() => productPage(c));
    return run(() => onboarding('customer'));
  }

  if (a === 'admin') return run(admin);
  run(home);
}

window.addEventListener('hashchange', () => { step = 0; loginMode = false; route(); window.scrollTo(0, 0); });

/* ---------- Home ---------- */
function home() {
  $app.innerHTML = `
  <section class="hero">${bg('images/home-hero.jpg')}
    <div class="hero-inner">
      <span class="eyebrow">Agritech • Circular economy</span>
      <h1>Turn farm waste into value 🌱</h1>
      <p>AgriPack buys agricultural waste from farmers and turns it into compostable packaging for businesses and homes.</p>
      <a class="btn" href="#/farmer">I'm a Farmer</a> <a class="btn ghost" href="#/customer">I'm a Customer</a>
    </div>
  </section>
  <h2 class="section-title">What we turn into packaging</h2>
  <div class="grid">${PRODUCTS.map(p => pcard(p, "location.hash='#/customer'", p.name, p.desc)).join('')}</div>
  <h2 class="section-title" style="margin-top:40px">How it works</h2>
  <div class="steps">
    <div class="step"><b>01</b>Submit<span>Farmers describe their waste, add photos and weight.</span></div>
    <div class="step"><b>02</b>Review<span>Our system checks it and alerts the admin.</span></div>
    <div class="step"><b>03</b>Package<span>Waste becomes eco-friendly packaging.</span></div>
    <div class="step"><b>04</b>Deliver<span>Customers request, pay, and receive.</span></div>
  </div>`;
}

/* ---------- Onboarding (both roles) ---------- */
function onboarding(role) {
  const steps = role === 'farmer' ? FARMER_STEPS : CUSTOMER_STEPS, s = steps[step];
  let form = '', title = s.t, blurb = s.p;
  
  if (role === 'farmer' && loginMode) {
    form = `<label>Username</label><input id="f-user" autocomplete="username" autocapitalize="none">
            <label>Password</label><input id="f-pass" type="password" autocomplete="current-password">`;
  } else if (role === 'farmer') {
    form = `<label>Full name</label><input id="f-name" autocomplete="name">
            <label>Location</label><input id="f-loc" placeholder="e.g. Juja, Kiambu">
            <label>Username</label><input id="f-user" autocomplete="username" autocapitalize="none" placeholder="3-20 letters, numbers or _">
            <label>Password (6+ characters)</label><input id="f-pass" type="password" autocomplete="new-password">
            <label>Confirm password</label><input id="f-pass2" type="password" autocomplete="new-password">`;
  } else if (loginMode) {
    form = `<label>Email</label><input id="f-email" type="email"><label>Password</label><input id="f-pass" type="password">`;
  } else {
    form = `<label>Name</label><input id="f-name"><label>Email</label><input id="f-email" type="email"><label>Password (6+ characters)</label><input id="f-pass" type="password">`;
  }

  if (s.form && loginMode) {
    title = 'Welcome back';
    blurb = role === 'farmer' ? 'Sign in to see your earlier submissions.' : 'Sign in to see your earlier requests.';
  }

  const action = s.form ? (loginMode ? 'Sign in' : 'Get started') : 'Next';

  $app.innerHTML = `
  <section class="hero stage">${bg(role === 'farmer' ? 'images/farmer-hero.jpg' : 'images/customer-hero.jpg')}
    <div class="panel slide"${s.form ? ` onkeydown="if(event.key==='Enter')document.getElementById('f-btn').click()"` : ''}>
      
      <div class="card-header">
        <span class="eyebrow dark">${role === 'farmer' ? 'Farmer' : 'Customer'} ${loginMode && s.form ? 'sign in' : 'onboarding'} · ${step + 1}/${steps.length}</span>
        <button type="button" class="btn-text-sign" onclick="toggleLogin('${role}')">
          ${loginMode ? 'New here? <b>Create account</b>' : 'Already have an account? <b>Sign in</b>'}
        </button>
      </div>

      <div class="big">${s.i}</div>
      <h2>${title}</h2>
      <p>${blurb}</p>

      <div class="dots">${steps.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>

      ${s.form ? form : ''}
      <div id="f-msg" class="msg" role="alert"></div>

      <div class="row">
        <button class="btn ghost sm back ${step === 0 ? 'hide' : ''}" onclick="go(-1)">Back</button>
        <button class="btn" id="f-btn" onclick="${s.form ? `finish('${role}')` : 'go(1)'}">${action}</button>
      </div>
    </div>
  </section>`;
}

window.go = d => { step += d; route(); };
window.toggleLogin = role => {
  loginMode = !loginMode;
  if (loginMode) step = (role === 'farmer' ? FARMER_STEPS : CUSTOMER_STEPS).length - 1; // jump straight to the form
  route();
};

window.finish = async role => {
  const btn = document.getElementById('f-btn'), label = btn ? btn.textContent : '';
  const fail = m => setMsg('f-msg', m, 'bad');
  try {
    let path, body;
    if (role === 'farmer') {
      const username = $v('f-user').toLowerCase(), password = document.getElementById('f-pass').value;
      if (loginMode) {
        if (!username || !password) return fail('Enter your username and password.');
        path = '/farmers/login'; body = { username, password };
      } else {
        const name = $v('f-name'), loc =$v('f-loc');
        if (!name || !loc) return fail('Please enter your name and location.');
        if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail('Username must be 3 to 20 letters, numbers or underscores.');
        if (password.length < 6) return fail('Password must be at least 6 characters.');
        if (password !== document.getElementById('f-pass2').value) return fail("The two passwords don't match.");
        path = '/farmers/register'; body = { name, loc, username, password };
      }
    } else if (loginMode) {
      path = '/customers/login';
      body = { email: $v('f-email'), password: document.getElementById('f-pass').value };
    } else {
      const name = $v('f-name');
      if (!name) return fail('Please enter your name.');
      path = '/customers/register';
      body = { name, email: $v('f-email'), password: document.getElementById('f-pass').value };
    }

    btn.disabled = true; 
    btn.textContent = 'Please wait...'; 
    setMsg('f-msg', '');

    const r = await api(path, { method: 'POST', body });
    session.set(role, r);
    toast((loginMode ? 'Welcome back, ' : 'Welcome aboard, ') + (r.profile ? r.profile.name : ''));

    // Reset login mode state before routing
    loginMode = false;
    step = 0;

    // Trigger navigation
    if (location.hash === `#/${role}/dashboard`) {
      route();
    } else {
      location.hash = `#/${role}/dashboard`;
    }
  } catch (e) {
    console.error('Sign-in failed:', e);
    fail(e.message);
  } finally {
    if (btn && btn.isConnected) { 
      btn.disabled = false; 
      btn.textContent = label; 
    }
  }
};

window.openForm = cat => {
  const p = prod(cat);
  photoBlob = null; photoPending = false;
  document.getElementById('form-area').innerHTML = `
  <div class="panel slide" style="margin-top:24px"><h2>${p.icon} ${p.name} waste</h2>
    <label>Detailed description of what you're giving out</label>
    <textarea id="s-desc" rows="3" placeholder="e.g. Fresh cassava peels from this week's harvest, kept dry in sacks"></textarea>
    <label>Weight (kg)</label><input id="s-weight" type="number" min="1">
    <label>Attach photo</label><input id="s-photo" type="file" accept="image/*" onchange="previewPhoto(this)">
    <img id="s-prev" class="preview" hidden>
    <div id="s-msg" class="msg" role="alert"></div>
    <div class="row"><span></span><button class="btn" id="s-btn" onclick="submitWaste('${cat}')">Submit</button></div></div>`;
  document.getElementById('form-area').scrollIntoView({ behavior: 'smooth' });
};

window.previewPhoto = input => {
  const file = input.files[0];
  photoBlob = null; photoPending = false;
  const pv = document.getElementById('s-prev'); pv.hidden = true;
  setMsg('s-msg', '');
  if (!file) return;
  if (!file.type.startsWith('image/')) return setMsg('s-msg', 'Please choose an image file (JPG or PNG).', 'bad');
  photoPending = true;
  setMsg('s-msg', 'Preparing photo...', 'info');
  const img = new Image(), url = URL.createObjectURL(file);
  img.onerror = () => {
    photoPending = false; URL.revokeObjectURL(url);
    console.error('Could not decode image:', file.type, file.name);
    setMsg('s-msg', "Your browser can't read this photo format (HEIC from an iPhone is a common cause). Choose a JPG or PNG, or take a new photo.", 'bad');
  };
  img.onload = () => { // shrink before upload to save mobile data
    const k = Math.min(1, 1024 / img.width), c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(b => {
      photoPending = false;
      if (!b) return setMsg('s-msg', 'Could not prepare that photo. Try a different one.', 'bad');
      photoBlob = b;
      pv.src = URL.createObjectURL(b); pv.hidden = false;
      setMsg('s-msg', 'Photo ready ✓', 'ok');
    }, 'image/jpeg', .85);
    URL.revokeObjectURL(url);
  };
  img.src = url;
};

window.submitWaste = async cat => {
  const btn = document.getElementById('s-btn');
  try {
    const desc = $v('s-desc'), weight = +document.getElementById('s-weight').value;
    if (!desc) return setMsg('s-msg', 'Please describe what you are giving out.', 'bad');
    if (!(weight > 0)) return setMsg('s-msg', 'Please enter the weight in kg.', 'bad');
    if (photoPending) return setMsg('s-msg', 'Your photo is still being prepared. Try again in a moment.', 'bad');
    btn.disabled = true; btn.textContent = 'Submitting...';
    setMsg('s-msg', 'Uploading...', 'info');
    const form = new FormData();
    form.append('cat', cat); form.append('desc', desc); form.append('weight', weight);
    if (photoBlob) form.append('photo', photoBlob, 'photo.jpg');
    const saved = await api('/submissions', { method: 'POST', form, role: 'farmer' });
    console.log('Submission saved:', saved);
    photoBlob = null;
    toast('Submitted! Our system is reviewing it.');
    await farmerDash();
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); // show "My submissions"
  } catch (e) {
    console.error('Upload failed:', e);
    setMsg('s-msg', e.message, 'bad');
    toast(e.message);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Submit'; }
  }
};

/*--- Farmer dashboard ---*/
async function farmerDash() {
  const f = session.get('farmer');
  if (!f) return (location.hash = '#/farmer');

  try {
    const subs = await api('/submissions/mine', { role: 'farmer' });
    $app.innerHTML = `
      <section class="hero">${bg('images/farmer-hero.jpg')}
        <div class="hero-inner">
          <span class="eyebrow">Farmer Dashboard</span>
          <h1>Welcome back, ${esc(f.profile ? f.profile.name : 'Farmer')} 👋</h1>
          <p>Location: ${esc(f.profile ? f.profile.loc : 'N/A')}</p>
        </div>
      </section>
      <h2 class="section-title">Submit Farm Waste</h2>
      <div class="grid">${PRODUCTS.map(p => pcard(p, `openForm('${p.id}')`, p.name, p.desc)).join('')}</div>
      <div id="form-area"></div>
      <h2 class="section-title" style="margin-top:40px">My Submissions</h2>
      <div class="panel wide">
        ${subs.length ? `
          <table>
            <tr><th>Category</th><th>Weight</th><th>Status</th><th>Date</th></tr>
            ${subs.map(s => `<tr><td>${esc(s.cat)}</td><td>${s.weight} kg</td><td>${esc(s.status)}</td><td>${esc(s.date)}</td></tr>`).join('')}
          </table>` : '<p>No submissions yet.</p>'
        }
      </div>`;
  } catch (e) {
    console.error('Failed to load farmer dashboard:', e);
    toast('Error loading dashboard: ' + e.message);
  }
}

/* ---------- Customer dashboard ---------- */
async function customerDash() {
  if (!session.get('customer')) return (location.hash = '#/customer');
  const reqs = await api('/requests/mine', { role: 'customer' });
  $app.innerHTML = `
  <section class="hero">${bg('images/customer-hero.jpg')}
    <div class="hero-inner">
      <span class="eyebrow">Customer portal</span>
      <h1>Packaging that comes from the farm, not a factory</h1>
      <p>Choose a package to see what it's made of and how to use it.</p>
      <a class="btn" href="javascript:void(0)" onclick="document.getElementById('pick').scrollIntoView({behavior:'smooth'})">Browse packages ↓</a>
    </div>
  </section>
  <h2 class="section-title" id="pick">Our packages</h2>
  <div class="grid">${PRODUCTS.map(p => pcard(p, `location.hash='#/customer/product/${p.id}'`, p.pkg, p.desc)).join('')}</div>
  <h2 class="section-title" style="margin-top:30px">My requests</h2>
  <div class="panel wide">${reqs.length ? `<table><tr><th>Package</th><th>Qty</th><th>Status</th><th></th></tr>${reqs.map(r =>
    `<tr><td>${prod(r.cat).pkg}</td><td>${r.qty}</td><td>${statusBadge(r.status)}</td>
    <td>${r.status === 'payment_requested' ? `<button class="btn sm" onclick="pay('${r.id}')">Pay now</button>` : ''}</td></tr>`).join('')}</table>` : 'No requests yet.'}</div>`;
}
function productPage(id) {
  const p = prod(id); if (!p) return customerDash();
  $app.innerHTML = `
  <section class="hero short">${bg(p.img)}
    <div class="hero-inner">
      <a class="back-link" href="#/customer/dashboard">← All packages</a>
      <h1>${p.icon} ${p.pkg}</h1>
      <p>${p.desc}</p>
      <div class="chips">${p.uses.map(u => `<span>${u}</span>`).join('')}</div>
    </div>
  </section>
  <div class="panel"><h3>Request this package</h3>
    <label>Quantity needed</label><input id="r-qty" type="number" min="1" value="100">
    <div class="row"><span></span><button class="btn" onclick="requestPkg('${p.id}')">Request this package</button></div>
  </div>`;
}
window.requestPkg = safe(async cat => {
  const qty = +document.getElementById('r-qty').value;
  if (!qty) return toast('Enter a quantity');
  await api('/requests', { method: 'POST', body: { cat, qty }, role: 'customer' });
  toast('Request sent to admin');
  location.hash = '#/customer/dashboard';
});
window.pay = safe(async id => {
  await api(`/requests/${id}/pay`, { method: 'POST', role: 'customer' });
  toast('Payment received (demo)');
  await customerDash();
});

/* ---------- Admin ---------- */
function adminLogin() {
  $app.innerHTML = `
  <div class="panel"><h2>Admin sign in</h2>
    <label>Password</label><input id="a-pass" type="password" onkeydown="if(event.key==='Enter')adminSignIn()">
    <div class="row"><span></span><button class="btn" onclick="adminSignIn()">Sign in</button></div></div>`;
}
window.adminSignIn = safe(async () => {
  const r = await api('/admin/login', { method: 'POST', body: { password: document.getElementById('a-pass').value } });
  session.set('admin', r); seenSubs = null;
  await admin();
});
window.adminOut = () => { session.clear('admin'); seenSubs = null; location.hash = '#/'; };

async function admin() {
  if (!session.get('admin')) return adminLogin();
    // Save the current AI chat log (if any) so we can restore it after re-render
  const prevLog = document.getElementById('ai-log');
  const prevLogHTML = prevLog ? prevLog.innerHTML : null;
  const [subs, reqs] = await Promise.all([api('/submissions', { role: 'admin' }), api('/requests', { role: 'admin' })]);
  if (seenSubs !== null && subs.length > seenSubs) toast('🔔 New farmer submission');
  seenSubs = subs.length;
  const flagged = subs.filter(s => s.status === 'flagged').length, review = subs.filter(s => s.status === 'review').length;
    $app.innerHTML = `
  
  <div class="panel wide">
    <div class="row" style="margin:0 0 12px"><h2>Admin dashboard</h2><button class="btn sm" onclick="adminOut()">Log out</button></div>
    ${flagged ? `<div class="alert">🔔 <b>${flagged}</b> farmer submission(s) meet the threshold. A farmer is giving out waste, please act.</div>` : ''}
    ${review ? `<div class="alert" style="background:#e8e8fa;border-color:#5560c0;color:#2b3270">📝 ${review} submission(s) did not meet the threshold and need your review.</div>` : ''}
    <div class="tabs">
      <div class="tab ${adminTab === 'farmers' ? 'on' : ''}" onclick="adminTab='farmers';admin()">Farmer submissions (${subs.length})</div>
      <div class="tab ${adminTab === 'customers' ? 'on' : ''}" onclick="adminTab='customers';admin()">Customer requests (${reqs.length})</div>
    </div>
    ${adminTab === 'farmers' ? farmerTable(subs) : customerTable(reqs)}

    <div class="ai-panel">
      <h3>AI assistant</h3>
      <p class="hint">Ask about submissions, farmers, or orders. Or let the AI re-check everything in the review queue.</p>
      <div id="ai-log" class="ai-chat-log">
        <div class="ai-msg bot">Hi! Ask me things like <em>"how many submissions are in review?"</em> or <em>"which farmer submitted the most?"</em></div>
      </div>
      <div class="ai-input-row">
        <input id="ai-input" placeholder="Ask the AI…" onkeydown="if(event.key==='Enter')askAI()">
        <button class="btn" id="ai-send" onclick="askAI()">Send</button>
      </div>
      <div class="ai-actions">
        <small>Powered by Groq · llama-3.3</small>
        <button class="btn sm" id="ai-review-btn" onclick="aiAutoReview()">🔄 AI auto-review queue</button>
      </div>
    </div>
  </div>`;

  // Restore AI chat history if we had any
  const newLog = document.getElementById('ai-log');
  if (prevLogHTML && newLog) newLog.innerHTML = prevLogHTML;
}
setInterval(() => {
  if (location.hash !== '#/admin' || !session.get('admin')) return;
  const sendBtn = document.getElementById('ai-send');
  const input = document.getElementById('ai-input');
  const busy = (sendBtn && sendBtn.disabled) || (input && input.value.trim().length > 0);
  if (busy) return; // don't clobber an in-progress AI chat
  admin().catch(() => {});
}, 10000);

function farmerTable(subs) {
  if (!subs.length) return 'No submissions yet.';
  return `<table><tr><th>Photo</th><th>Farmer</th><th>Category</th><th>Weight</th><th>Description</th><th>Status</th><th>Action</th></tr>${subs.map(s => `
  <tr><td>${s.photo ? `<img src="${esc(s.photo)}">` : '-'}</td><td>${esc(s.farmer)}<br><small>${esc(s.loc)}</small></td>
  <td>${prod(s.cat).icon} ${prod(s.cat).name}</td><td>${s.weight} kg</td><td>${esc(s.desc)}</td>
  <td>${statusBadge(s.status)}<br><small>${esc(s.aiNote)}</small></td>
  <td>${['flagged', 'review'].includes(s.status) ? `<button class="btn sm" onclick="setSub('${s.id}','approved')">Approve</button> <button class="btn sm bad" onclick="setSub('${s.id}','rejected')">Reject</button>` : ''}</td></tr>`).join('')}</table>`;
}
function customerTable(reqs) {
  if (!reqs.length) return 'No requests yet.';
  return `<table><tr><th>Customer</th><th>Package</th><th>Qty</th><th>Status</th><th>Action</th></tr>${reqs.map(r => `
  <tr><td>${esc(r.customer)}<br><small>${esc(r.email)}</small></td><td>${prod(r.cat).pkg}</td><td>${r.qty}</td><td>${statusBadge(r.status)}</td>
  <td>${r.status === 'requested' ? `<button class="btn sm" onclick="setReq('${r.id}','payment_requested')">Request payment</button>` : ''}
      ${r.status === 'paid' ? `<button class="btn sm" onclick="setReq('${r.id}','delivered')">Mark delivered</button>` : ''}</td></tr>`).join('')}</table>`;
}
window.setSub = safe(async (id, status) => {
  await api('/submissions/' + id, { method: 'PATCH', body: { status }, role: 'admin' });
  toast('Updated'); await admin();
});
window.setReq = safe(async (id, status) => {
  await api('/requests/' + id, { method: 'PATCH', body: { status }, role: 'admin' });
  toast('Updated'); await admin();
});

/* ---------- AI admin chat + auto-review ---------- */
function aiAppend(role, text, extraClass = '') {
  const log = document.getElementById('ai-log');
  if (!log) return null;
  const el = document.createElement('div');
  el.className = `ai-msg ${role} ${extraClass}`.trim();
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function aiAppendAction(action) {
  const log = document.getElementById('ai-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'ai-msg action' + (action.ok ? ' ok' : ' bad');
  const verb = {
    approve_submission: 'approved',
    reject_submission: 'rejected',
    auto_advance: 'advanced',
  }[action.tool] || action.tool;
  const sid = (action.args && (action.args.sid || action.args.rid)) || '?';
  el.textContent = action.ok
    ? `✏️ AI ${verb} ${sid}`
    : `⚠ AI tried to ${verb} ${sid} but failed`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

window.askAI = safe(async () => {
  const input = document.getElementById('ai-input');
  const btn = document.getElementById('ai-send');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  btn.disabled = true;
  aiAppend('user', message);
  const thinking = aiAppend('bot', 'Thinking…', 'thinking');
  try {
    const r = await api('/admin/ai/chat', {
      method: 'POST',
      body: { message },
      role: 'admin'
    });
    thinking.remove();
    aiAppend('bot', r.reply || '(no response)');
    if (Array.isArray(r.actions)) {
      for (const a of r.actions) {
        aiAppendAction(a);
      }
      // Refresh the tables so the admin sees the change immediately
      if (r.actions.some(a => a.ok)) {
        setTimeout(() => { admin().catch(() => {}); }, 400);
      }
    }
  } catch (e) {
    thinking.remove();
    aiAppend('bot', '⚠ ' + e.message);
  } finally {
    btn.disabled = false;
    input.focus();
  }
});

window.aiAutoReview = safe(async () => {
  const btn = document.getElementById('ai-review-btn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'AI is reviewing…';
  try {
    const r = await api('/admin/ai/auto-review', { method: 'POST', role: 'admin' });
    if (r.reviewed === 0) {
      toast('Nothing in the review queue.');
    } else {
      toast(`AI re-checked ${r.reviewed} submission(s), auto-decided ${r.auto_decided}.`);
    }
    await admin();
  } catch (e) {
    toast('AI auto-review failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
});

Object.defineProperty(window, 'adminTab', { get: () => adminTab, set: v => (adminTab = v) });

/* ---------- Shared ---------- */
function statusBadge(s) {
  const map = { flagged: ['flag', 'Meets threshold'], review: ['rev', 'Under review'], approved: ['ok', 'Approved'], rejected: ['bad', 'Rejected'],
    requested: ['rev', 'Requested'], payment_requested: ['flag', 'Payment requested'], paid: ['ok', 'Paid'], delivered: ['ok', 'Delivered'] };
  const [c, t] = map[s] || ['', s]; return `<span class="badge ${c}">${t}</span>`;
}
console.log('EcoLoop app.js loaded from', location.origin);
route();