'use strict';

let masterData      = [];
let filteredData    = [];
let isDatabaseReady = false;
let currentPage     = 1;
let pageSize        = 10;

let sessionToken        = null;
let sessionExpiryTimer  = null;
let sessionWarningTimer = null;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function formatSheetDate(dateStr) {
  if (!dateStr || dateStr === '-' || dateStr === 'undefined') return '-';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return escapeHtml(dateStr);
    const day    = String(date.getDate()).padStart(2, '0');
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return `${day}-${months[date.getMonth()]}-${date.getFullYear()}`;
  } catch { return escapeHtml(dateStr); }
}

if (window.lucide) lucide.createIcons();

(function startTotpCountdown() {
  const display = document.getElementById('totpTimer');
  const progressFill = document.querySelector('.progress-bar-fill');
  if (!display) return;

  function update() {
    const now = Date.now();
    
    const secondsLeft = 30 - Math.floor((now / 1000) % 30);
    display.textContent = secondsLeft + 's';
    display.className   = secondsLeft <= 10 ? 'urgent' : '';

    if (progressFill) {
      const msElapsedInCycle = (now % 30000);
      const msLeftInCycle = 30000 - msElapsedInCycle;
      const percentageLeft = (msLeftInCycle / 30000) * 100;
      
      progressFill.style.width = `${percentageLeft}%`;
    }
  }
  update();
  setInterval(update, 1000);
})();

document.getElementById('totpCode').addEventListener('input', function () {
  this.value = this.value.replace(/\D/g, '').slice(0, 6);
});

document.getElementById('loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  const totpInput = document.getElementById('totpCode').value.trim();
  const loginBtn  = document.getElementById('loginBtn');
  const errorEl   = document.getElementById('loginErrorMessage');

  if (!/^\d{6}$/.test(totpInput)) {
    showError(errorEl, 'Please enter a valid 6-digit code.');
    return;
  }

  errorEl.style.display = 'none';
  loginBtn.disabled     = true;
  loginBtn.textContent  = 'Verifying…';

  const platform    = (navigator.userAgentData?.platform ?? navigator.platform ?? 'Unknown').slice(0, 50);
  const browserHint = navigator.userAgent.split(' ').pop().slice(0, 80);
  const machineInfo = `OS: ${platform} | UA: ${browserHint}`;

  try {
    const response = await fetch('/api/verify', {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ totpCode: totpInput, machineInfo }),
      credentials: 'same-origin',
    });

    const result = await response.json();

    if (response.ok && result.success && result.sessionToken) {
      sessionToken = result.sessionToken;
      startSessionTimeout(result.expiresIn ?? 1800);
      unlockApp();
      preloadData();
    } else {
      showError(errorEl, result.message || 'Access denied.');
      loginBtn.disabled    = false;
      loginBtn.innerHTML   = '<i data-lucide="lock" class="icon-sm"></i> Authenticate';
      if (window.lucide) lucide.createIcons();
    }
  } catch (err) {
    console.error('Login error:', err);
    showError(errorEl, 'Network error. Please try again.');
    loginBtn.disabled    = false;
    loginBtn.innerHTML   = '<i data-lucide="lock" class="icon-sm"></i> Authenticate';
    if (window.lucide) lucide.createIcons();
  }
});

function showError(el, msg) {
  el.textContent    = msg;
  el.style.display  = 'block';
}

function unlockApp() {
  document.getElementById('loginModal').style.display = 'none';
  document.getElementById('mainApp').classList.remove('locked');
  if (window.lucide) lucide.createIcons();
}

function startSessionTimeout(expiresInSeconds) {
  clearTimeout(sessionExpiryTimer);
  clearTimeout(sessionWarningTimer);

  sessionExpiryTimer = setTimeout(() => {
    alert('Session Expired: Your session has been automatically terminated after 30 minutes.');
    triggerSessionLogout();
  }, expiresInSeconds * 1000);
}

async function triggerSessionLogout() {
  clearTimeout(sessionExpiryTimer);
  clearTimeout(sessionWarningTimer);

  if (sessionToken) {
    try {
      await fetch('/api/logout', {
        method:      'POST',
        headers:     { 'x-session-token': sessionToken },
        credentials: 'same-origin',
      });
    } catch { /* best-effort */ }
  }

  sessionToken    = null;
  masterData      = [];
  filteredData    = [];
  isDatabaseReady = false;
  currentPage     = 1;

  // Reset UI
  document.getElementById('loginModal').style.display = 'flex';
  document.getElementById('mainApp').classList.add('locked');
  document.getElementById('totpCode').value    = '';
  document.getElementById('searchQuery').value = '';
  document.getElementById('loginErrorMessage').style.display = 'none';
  document.getElementById('tableFooter').classList.remove('visible');

  const loginBtn = document.getElementById('loginBtn');
  loginBtn.disabled   = false;
  loginBtn.innerHTML  = '<i data-lucide="lock" class="icon-sm"></i> Authenticate';

  const placeholderHtml = `
    <div class="spinner-wrap">
      <i data-lucide="database" class="icon-lg icon-slate"></i>
      <div style="color:var(--slate-400);font-size:.8rem">Awaiting validation token...</div>
    </div>`;

  document.getElementById('tableBody').innerHTML =
    `<tr><td colspan="10" class="placeholder-cell">${placeholderHtml}</td></tr>`;
  document.getElementById('mobileCardsContainer').innerHTML = placeholderHtml;

  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('totpCode').focus(), 100);
}

document.getElementById('logoutBtn').addEventListener('click', triggerSessionLogout);

async function authFetch(url, options = {}) {
  if (!sessionToken) throw new Error('No active session.');
  return fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: { ...(options.headers || {}), 'x-session-token': sessionToken },
  });
}

async function preloadData() {
  const tableBody   = document.getElementById('tableBody');
  const mobileCards = document.getElementById('mobileCardsContainer');
  const searchBtn   = document.querySelector('#searchForm button[type="submit"]');

  const loadingHtml = `
    <div class="spinner-wrap">
      <div class="spinner"></div>
      <div class="spinner-text">Connecting to server…</div>
    </div>`;

  tableBody.innerHTML   = `<tr><td colspan="10" class="placeholder-cell">${loadingHtml}</td></tr>`;
  mobileCards.innerHTML = loadingHtml;

  if (searchBtn) { searchBtn.disabled = true; searchBtn.style.opacity = '.5'; }

  try {
    const response = await authFetch('/api/records');

    if (response.status === 401) {
      alert('Your session is no longer valid. Please log in again.');
      triggerSessionLogout();
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = await response.json();
    masterData  = Array.isArray(json.ranks) ? json.ranks : [];

    if (masterData.length > 0) {
      isDatabaseReady = true;
      if (searchBtn) { searchBtn.disabled = false; searchBtn.style.opacity = ''; }

      const okHtml = `
        <div class="spinner-wrap" style="color:var(--emerald-600)">
          <i data-lucide="check-circle" class="icon-lg icon-emerald"></i>
          <div style="font-size:.8rem;font-weight:500">Connection successful. You may now search records.</div>
        </div>`;

      tableBody.innerHTML   = `<tr><td colspan="10" class="placeholder-cell">${okHtml}</td></tr>`;
      mobileCards.innerHTML = okHtml;
      if (window.lucide) lucide.createIcons();
    } else {
      tableBody.innerHTML   = `<tr><td colspan="10" class="placeholder-cell">No records found in data source.</td></tr>`;
      mobileCards.innerHTML = `<div class="spinner-wrap" style="color:var(--slate-400)">No records found.</div>`;
    }
  } catch (err) {
    console.error('Data load error:', err);
    const errHtml = `<div style="color:var(--red-500);font-size:.8rem;font-weight:500">Error loading records. Please try again.</div>`;
    tableBody.innerHTML   = `<tr><td colspan="10" class="placeholder-cell">${errHtml}</td></tr>`;
    mobileCards.innerHTML = `<div class="spinner-wrap">${errHtml}</div>`;
  }
}

document.getElementById('searchForm').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!isDatabaseReady) return;

  const colIndex = parseInt(document.getElementById('searchType').value, 10);
  const query    = document.getElementById('searchQuery').value.trim().toLowerCase();
  pageSize       = parseInt(document.getElementById('pageSize').value, 10);

  if (!query) {
    const msg = 'Please enter a search keyword.';
    document.getElementById('tableBody').innerHTML =
      `<tr><td colspan="10" class="placeholder-cell">${msg}</td></tr>`;
    document.getElementById('mobileCardsContainer').innerHTML =
      `<div class="spinner-wrap" style="color:var(--slate-400)">${msg}</div>`;
    document.getElementById('tableFooter').classList.remove('visible');
    return;
  }

  filteredData = masterData.filter(row => {
    if (!row || row[colIndex] == null) return false;
    return String(row[colIndex]).trim().toLowerCase().includes(query);
  });

  currentPage = 1;
  displayPageData();
});

document.getElementById('pageSize').addEventListener('change', function () {
  pageSize = parseInt(this.value, 10); currentPage = 1;
  if (filteredData.length > 0) displayPageData();
});

document.getElementById('prevPageBtn').addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; displayPageData(); }
});
document.getElementById('nextPageBtn').addEventListener('click', () => {
  if (currentPage < Math.ceil(filteredData.length / pageSize)) { currentPage++; displayPageData(); }
});

function displayPageData() {
  const tableBody   = document.getElementById('tableBody');
  const mobileCards = document.getElementById('mobileCardsContainer');
  const footer      = document.getElementById('tableFooter');

  tableBody.innerHTML   = '';
  mobileCards.innerHTML = '';

  const total      = filteredData.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  currentPage      = Math.min(Math.max(1, currentPage), totalPages);

  const start     = (currentPage - 1) * pageSize;
  const end       = Math.min(start + pageSize, total);
  const pageSlice = filteredData.slice(start, end);

  if (pageSlice.length === 0) {
    const msg = 'No matching records found.';
    tableBody.innerHTML   = `<tr><td colspan="10" class="placeholder-cell">${msg}</td></tr>`;
    mobileCards.innerHTML = `<div class="spinner-wrap" style="color:var(--slate-400)">${msg}</div>`;
    footer.classList.remove('visible');
    return;
  }

  const tFrag = document.createDocumentFragment();
  const mFrag = document.createDocumentFragment();

  pageSlice.forEach(row => {
    const ecode      = escapeHtml(row[0]);
    const rank       = escapeHtml(row[1]);
    const lastName   = escapeHtml(row[2]);
    const firstName  = escapeHtml(row[3]);
    const middleName = escapeHtml(row[4]);
    const suffix     = escapeHtml(row[5]);
    const dateEntry  = formatSheetDate(row[6]);
    const region     = escapeHtml(row[7]);
    const status     = escapeHtml(row[8] ? String(row[8]).trim() : 'N/A');
    const dateSep    = formatSheetDate(row[9]);
    const isActive   = ['active','trainee'].includes(status.toLowerCase());
    const badgeCls   = isActive ? 'badge badge-active' : 'badge badge-inactive';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ecode || '-'}</td><td>${rank || '-'}</td>
      <td>${lastName || '-'}</td><td>${firstName || '-'}</td>
      <td>${middleName || '-'}</td><td>${suffix || '-'}</td>
      <td>${dateEntry}</td><td>${region || '-'}</td>
      <td><span class="${badgeCls}">${status}</span></td>
      <td>${dateSep}</td>`;
    tFrag.appendChild(tr);

    // Mobile card
    const card = document.createElement('div');
    card.className = 'mobile-card';
    card.innerHTML = `
      <div class="card-row"><span class="card-label">ECODE</span><span class="card-value">${ecode || '-'}</span></div>
      <div class="card-row"><span class="card-label">RANK</span><span class="card-value">${rank || '-'}</span></div>
      <div class="card-row"><span class="card-label">LAST NAME</span><span class="card-value">${lastName || '-'}</span></div>
      <div class="card-row"><span class="card-label">FIRST NAME</span><span class="card-value">${firstName || '-'}</span></div>
      <div class="card-row"><span class="card-label">MIDDLE NAME</span><span class="card-value">${middleName || '-'}</span></div>
      <div class="card-row"><span class="card-label">SUFFIX</span><span class="card-value">${suffix || '-'}</span></div>
      <div class="card-row"><span class="card-label">DATE OF ENTRY</span><span class="card-value">${dateEntry}</span></div>
      <div class="card-row"><span class="card-label">REGION</span><span class="card-value">${region || '-'}</span></div>
      <div class="card-row"><span class="card-label">STATUS</span><span class="${badgeCls}">${status}</span></div>
      <div class="card-row"><span class="card-label">SEPARATION DATE</span><span class="card-value">${dateSep}</span></div>`;
    mFrag.appendChild(card);
  });

  tableBody.appendChild(tFrag);
  mobileCards.appendChild(mFrag);

  document.getElementById('showingStart').textContent   = total === 0 ? 0 : (start + 1).toLocaleString();
  document.getElementById('showingEnd').textContent     = end.toLocaleString();
  document.getElementById('recordCount').textContent    = total.toLocaleString();
  document.getElementById('currentPageNum').textContent = currentPage;
  document.getElementById('totalPagesNum').textContent  = totalPages;
  document.getElementById('prevPageBtn').disabled       = currentPage === 1;
  document.getElementById('nextPageBtn').disabled       = currentPage === totalPages;
  footer.classList.add('visible');
}
