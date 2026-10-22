/* UPI Verify — progressively enhanced UI. No frameworks, no inline scripts. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- copy
  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-copy]');
    if (!target) return;
    event.preventDefault();
    var value = target.getAttribute('data-copy') || '';
    var done = function (ok) {
      var original = target.getAttribute('data-label') || target.textContent;
      target.setAttribute('data-label', original);
      target.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () { target.textContent = original; }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(function () { done(true); }, function () { done(false); });
    } else {
      var input = document.createElement('textarea');
      input.value = value;
      input.setAttribute('readonly', '');
      input.style.position = 'absolute';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.select();
      try { done(document.execCommand('copy')); } catch (err) { done(false); }
      document.body.removeChild(input);
    }
  });

  // ---------------------------------------------------------------- countdown
  var timer = document.querySelector('[data-expires]');
  if (timer) {
    var expiresAt = new Date(timer.getAttribute('data-expires')).getTime();
    var tick = function () {
      var remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        timer.textContent = 'Expired';
        timer.classList.add('muted');
        var box = document.querySelector('[data-status-box]');
        if (box) box.setAttribute('data-expired', 'true');
        clearInterval(handle);
        return;
      }
      var total = Math.floor(remaining / 1000);
      var m = Math.floor(total / 60);
      var s = total % 60;
      timer.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    };
    var handle = setInterval(tick, 1000);
    tick();
  }

  // ---------------------------------------------------------------- status
  var statusRoot = document.querySelector('[data-pay-status]');
  if (statusRoot) {
    var stateUrl = statusRoot.getAttribute('data-status-url');
    var checkUrl = statusRoot.getAttribute('data-check-url');
    var pill = statusRoot.querySelector('[data-status-pill]');
    var note = document.getElementById('status-note');
    var button = document.getElementById('check-status');
    var terminal = ['PAID', 'LATE_PAYMENT', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED'];

    var paint = function (data) {
      if (!data) return;
      if (pill) {
        pill.textContent = data.label || data.status;
        pill.className = 'pill pill-' + (data.tone || 'neutral');
      }
      if (note && data.note) { note.textContent = data.note; note.classList.remove('hide'); }
      if (data.status === 'PAID' || data.status === 'LATE_PAYMENT') {
        var banner = document.getElementById('paid-banner');
        if (banner) banner.classList.remove('hide');
        if (button) button.disabled = true;
        var qr = document.getElementById('qr-block');
        if (qr) qr.classList.add('hide');
      }
      if (data.status === 'REVIEW_REQUIRED') {
        var review = document.getElementById('review-banner');
        if (review) review.classList.remove('hide');
      }
      if (terminal.indexOf(data.status) !== -1 && button) button.disabled = true;
    };

    var poll = function () {
      if (!stateUrl) return;
      fetch(stateUrl, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          paint(data);
          var done = data && (['PAID', 'LATE_PAYMENT', 'REVIEW_REQUIRED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED'].indexOf(data.status) !== -1);
          if (!done) setTimeout(poll, 8000);
        })
        .catch(function () { setTimeout(poll, 12000); });
    };

    if (button && checkUrl) {
      button.addEventListener('click', function () {
        button.disabled = true;
        var label = button.textContent;
        button.textContent = 'Checking with the provider…';
        fetch(checkUrl, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            paint(data);
            if (data && data.checkedProvider === false) {
              button.disabled = false;
            }
          })
          .catch(function () {
            if (note) { note.textContent = 'Could not reach the server. Your payment is not affected.'; note.classList.remove('hide'); }
            button.disabled = false;
          })
          .then(function () { button.textContent = label; });
      });
    }
    setTimeout(poll, 6000);
  }

  // ---------------------------------------------------------------- confirms
  document.addEventListener('submit', function (event) {
    var form = event.target.closest('form[data-confirm]');
    if (!form) return;
    if (!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
  });

  // ---------------------------------------------------------------- nav toggle (mobile)
  var toggle = document.querySelector('[data-nav-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var nav = document.getElementById('primary-nav');
      if (nav) nav.classList.toggle('hide');
    });
  }
})();
