(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  document.addEventListener('DOMContentLoaded', () => {
    setupBadges();
    setupPasswordHelpers();
    setupTagInput();
    setupGeolocation();
    setupChat();
    setupLightbox();
    setupConfirmForms();
    setupSocket();
    setupAutoDismissFlash();
  });

  // ---------- Top-bar badges ----------
  function setupBadges() {
    $$('[data-badge]').forEach(updateBadge);
  }
  function updateBadge(el, valueOverride) {
    const v = typeof valueOverride === 'number' ? valueOverride : Number(el.textContent || 0);
    el.textContent = v > 99 ? '99+' : String(v);
    el.hidden = v === 0;
    el.dataset.count = String(v);
  }
  function setBadge(name, value) {
    const el = document.querySelector(`[data-badge="${name}"]`);
    if (el) updateBadge(el, Number(value));
  }
  function incBadge(name) {
    const el = document.querySelector(`[data-badge="${name}"]`);
    if (el) updateBadge(el, Number(el.dataset.count || 0) + 1);
  }

  // ---------- Flash auto-dismiss ----------
  function setupAutoDismissFlash() {
    $$('.flash').forEach((flash) => {
      if (flash.classList.contains('error') || flash.classList.contains('warn')) return;
      setTimeout(() => {
        flash.style.transition = 'opacity .4s ease, transform .4s ease';
        flash.style.opacity = '0';
        flash.style.transform = 'translateY(-4px)';
        setTimeout(() => flash.remove(), 400);
      }, 6000);
    });
  }

  // ---------- Password meter & toggle ----------
  const PW_RULES = [
    { id: 'len', label: 'At least 10 characters', test: (p) => p.length >= 10 },
    { id: 'lower', label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
    { id: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
    { id: 'digit', label: 'A digit', test: (p) => /\d/.test(p) },
    { id: 'symbol', label: 'A symbol (e.g. ! @ #)', test: (p) => /[^A-Za-z0-9]/.test(p) }
  ];

  function setupPasswordHelpers() {
    $$('[data-password]').forEach((input) => {
      const wrap = input.closest('.pw-wrapper') || input.parentElement;
      if (!wrap) return;

      // Show / hide toggle
      if (input.type === 'password' && !wrap.querySelector('.pw-toggle')) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'pw-toggle';
        toggle.textContent = 'Show';
        toggle.addEventListener('click', () => {
          input.type = input.type === 'password' ? 'text' : 'password';
          toggle.textContent = input.type === 'password' ? 'Show' : 'Hide';
        });
        wrap.classList.add('pw-wrapper');
        wrap.style.position = 'relative';
        wrap.appendChild(toggle);
      }

      if (input.dataset.password === 'meter') {
        const host = document.createElement('div');
        const meter = document.createElement('div');
        meter.className = 'pw-meter';
        const fill = document.createElement('span');
        meter.appendChild(fill);
        const list = document.createElement('ul');
        list.className = 'pw-rules';
        PW_RULES.forEach((rule) => {
          const li = document.createElement('li');
          li.dataset.rule = rule.id;
          li.textContent = rule.label;
          list.appendChild(li);
        });
        host.appendChild(meter);
        host.appendChild(list);
        wrap.parentElement.insertBefore(host, wrap.nextSibling);

        const refresh = () => {
          const value = input.value;
          let score = 0;
          PW_RULES.forEach((rule) => {
            const ok = rule.test(value);
            if (ok) score += 1;
            const li = list.querySelector(`[data-rule="${rule.id}"]`);
            if (li) li.classList.toggle('ok', ok);
          });
          meter.className = 'pw-meter s' + score;
        };
        input.addEventListener('input', refresh);
        refresh();
      }
    });
  }

  // ---------- Tag chip input ----------
  function setupTagInput() {
    const hidden = $('input[data-tags-input]');
    if (!hidden) return;
    const wrap = document.createElement('div');
    wrap.className = 'tags-input';
    const visible = document.createElement('input');
    visible.type = 'text';
    visible.id = 'tag-input';
    visible.placeholder = 'Add a tag and press Enter';
    visible.setAttribute('aria-label', 'Add interest');
    hidden.type = 'hidden';
    hidden.insertAdjacentElement('afterend', wrap);

    let tags = String(hidden.value || '')
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
      .filter((t) => /^[a-z0-9_-]{2,24}$/.test(t));

    const sync = () => {
      hidden.value = tags.join(', ');
      render();
    };
    const render = () => {
      wrap.querySelectorAll('.chip').forEach((c) => c.remove());
      tags.forEach((t) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `#${t} <button type="button" aria-label="Remove ${t}">×</button>`;
        chip.querySelector('button').addEventListener('click', () => {
          tags = tags.filter((x) => x !== t);
          sync();
        });
        wrap.insertBefore(chip, visible);
      });
    };
    wrap.appendChild(visible);

    const tryAdd = (raw) => {
      const t = String(raw || '').trim().toLowerCase().replace(/^#/, '');
      if (!/^[a-z0-9_-]{2,24}$/.test(t)) return false;
      if (tags.includes(t)) return false;
      if (tags.length >= 15) return false;
      tags.push(t);
      sync();
      return true;
    };

    visible.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
        if (visible.value.trim()) { e.preventDefault(); tryAdd(visible.value); visible.value = ''; }
      } else if (e.key === 'Backspace' && !visible.value && tags.length) {
        tags.pop();
        sync();
      }
    });
    visible.addEventListener('blur', () => { if (visible.value.trim()) { tryAdd(visible.value); visible.value = ''; } });
    sync();
  }

  // ---------- Geolocation button ----------
  function setupGeolocation() {
    const btn = $('[data-geolocate]');
    if (!btn) return;
    const latInput = $('input[name="latitude"]');
    const lngInput = $('input[name="longitude"]');
    const consent = $('input[name="location_consent"]');
    const status = $('[data-geo-status]');

    btn.addEventListener('click', () => {
      if (!('geolocation' in navigator)) {
        if (status) status.textContent = 'Geolocation is not available in this browser.';
        return;
      }
      btn.disabled = true;
      if (status) status.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition((pos) => {
        if (latInput) latInput.value = pos.coords.latitude.toFixed(5);
        if (lngInput) lngInput.value = pos.coords.longitude.toFixed(5);
        if (consent && !consent.checked) consent.checked = true;
        if (status) status.textContent = 'Location captured. Save the profile to keep it.';
        btn.disabled = false;
      }, (err) => {
        btn.disabled = false;
        if (status) status.textContent = `Could not detect location (${err.message}). Enter your city instead.`;
      }, { enableHighAccuracy: false, timeout: 8000 });
    });
  }

  // ---------- Chat ----------
  function setupChat() {
    const messages = $('#messages');
    if (!messages) return;
    decorateBubbleTimes(messages);
    scrollMessages();

    const form = messages.closest('.chat')?.querySelector('form.send');
    if (form) {
      const input = form.querySelector('input[name="body"]');
      // Submit on Enter, blank-message guard
      form.addEventListener('submit', (e) => {
        if (!input.value.trim()) { e.preventDefault(); return; }
      });
      if (input) setTimeout(() => input.focus(), 80);
    }
  }
  function scrollMessages() {
    const messages = $('#messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
  }
  function appendMessage(message, currentUserId) {
    const messages = $('#messages');
    if (!messages) return false;
    const active = messages.dataset.activeId;
    if (!active) return false;
    const involves = message.sender_id === Number(active) || message.receiver_id === Number(active);
    if (!involves) return false;
    const bubble = document.createElement('p');
    bubble.className = 'bubble ' + (message.sender_id === currentUserId ? 'mine' : 'theirs');
    bubble.textContent = message.body;
    const small = document.createElement('small');
    small.textContent = formatTime(message.created_at);
    bubble.appendChild(small);
    messages.appendChild(bubble);
    scrollMessages();
    return true;
  }
  function decorateBubbleTimes(container) {
    container.querySelectorAll('.bubble[data-at]').forEach((el) => {
      const small = el.querySelector('small');
      if (small) small.textContent = formatTime(Number(el.dataset.at));
    });
  }
  function formatTime(unix) {
    if (!unix) return '';
    const d = new Date(Number(unix) * 1000);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function formatRelative(unix) {
    const seconds = Math.floor(Date.now() / 1000) - Number(unix);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86400)} d ago`;
  }

  // ---------- Lightbox ----------
  function setupLightbox() {
    $$('[data-lightbox]').forEach((img) => {
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', () => openLightbox(img.src));
    });
  }
  function openLightbox(src) {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.innerHTML = `<button aria-label="Close">×</button><img src="${src}" alt="">`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.tagName === 'BUTTON') close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
    document.body.appendChild(overlay);
  }

  // ---------- Inline confirm ----------
  function setupConfirmForms() {
    $$('[data-confirm]').forEach((form) => {
      form.addEventListener('submit', (e) => {
        const msg = form.dataset.confirm || 'Are you sure?';
        if (!window.confirm(msg)) e.preventDefault();
      });
    });
  }

  // ---------- Toasts ----------
  function getToastHost() {
    let host = $('#toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      document.body.appendChild(host);
    }
    return host;
  }
  const ICONS = { like: '♥', match: '✨', message: '✉', visit: '👁', unlike: '✕' };
  const TITLES = { like: 'New like', match: 'It’s a match', message: 'New message', visit: 'Profile view', unlike: 'Disconnected' };
  function showToast(notification) {
    const host = getToastHost();
    const toast = document.createElement('div');
    toast.className = 'toast ' + (notification.type || '');
    const icon = ICONS[notification.type] || '🔔';
    const title = TITLES[notification.type] || 'Notification';
    const link = notification.link
      ? `<a href="${notification.link}">View</a>`
      : '';
    toast.innerHTML = `
      <div class="t-icon">${icon}</div>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(notification.body || '')}</small>
        ${link}
      </div>
    `;
    host.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 280);
    }, 5500);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Socket ----------
  function setupSocket() {
    if (typeof io === 'undefined') return;
    if (!document.body.dataset.userId) return;
    const currentUserId = Number(document.body.dataset.userId);
    const socket = io();

    socket.on('notification', (notification) => {
      incBadge('notifications');
      showToast(notification);
    });
    socket.on('unread-count', (count) => setBadge('notifications', count));
    socket.on('message', (message) => {
      const added = appendMessage(message, currentUserId);
      // If we're not on the active conversation, bump the messages badge
      if (!added && message.sender_id !== currentUserId) {
        incBadge('messages');
      }
    });
  }
})();
