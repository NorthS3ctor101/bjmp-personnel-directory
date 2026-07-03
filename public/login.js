'use strict';

if (window.lucide) lucide.createIcons();

(function startTotpCountdown() {
  const display = document.getElementById('totpTimer');
  const progressFill = document.querySelector('.progress-bar-fill');
  if (!display) return;

  function update() {
    const now = Date.now();
    const secondsLeft = 30 - Math.floor((now / 1000) % 30);
    display.textContent = secondsLeft + 's';
    display.className = secondsLeft <= 10 ? 'urgent' : '';

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
  const loginBtn = document.getElementById('loginBtn');
  const errorEl = document.getElementById('loginErrorMessage');

  if (!/^\d{6}$/.test(totpInput)) {
    showError(errorEl, 'Please enter a valid 6-digit code.');
    return;
  }

  errorEl.style.display = 'none';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Verifying…';

  const platform = (navigator.userAgentData?.platform ?? navigator.platform ?? 'Unknown').slice(0, 50);
  const browserHint = navigator.userAgent.split(' ').pop().slice(0, 80);
  const machineInfo = `OS: ${platform} | UA: ${browserHint}`;

  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totpCode: totpInput, machineInfo }),
      credentials: 'same-origin',
    });

    const result = await response.json();

    if (response.ok && result.success && result.sessionToken) {
      localStorage.setItem('x-session-token', result.sessionToken);
      window.location.replace('/');
    } else {
      showError(errorEl, result.message || 'Access denied.');
      resetButton(loginBtn);
    }
  } catch (err) {
    showError(errorEl, 'Network error. Please try again.');
    resetButton(loginBtn);
  }
});

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

function resetButton(btn) {
  btn.disabled = false;
  btn.textContent = 'Authenticate';
}
