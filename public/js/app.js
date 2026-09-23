(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  document.addEventListener('DOMContentLoaded', () => {
    setupBadges();
    setupPasswordHelpers();
    setupTagInput();
    setupTagDatalist();
    setupGeolocation();
    setupChat();
    setupLightbox();
    setupConfirmForms();
    setupSocket();
    setupAutoDismissFlash();
    setupPhotoInput();
    setupFilters();
  });

  // Filters start folded on phones unless some are already applied.
  function setupFilters() {
    const box = $('[data-filters]');
    if (box && !box.hasAttribute('data-active') && window.matchMedia('(max-width: 860px)').matches) box.open = false;
  }

  // ---------- Photo picker feedback ----------
  function setupPhotoInput() {
    const input = $('[data-photo-input]');
    const hint = $('[data-photo-hint]');
    if (!input || !hint) return;
    const initial = hint.textContent;
    input.addEventListener('change', () => {
      const names = Array.from(input.files || []).map((f) => f.name);
      hint.textContent = names.length ? `${names.length} selected: ${names.join(', ')}. Save to upload.` : initial;
    });
  }

  // ---------- Top-bar badges ----------
  function setupBadges() {
    $$('[data-badge]').forEach((el) => updateBadge(el));
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

  // ---------- Shared tag vocabulary ----------
  let tagVocabulary = null;
  function loadTags() {
    if (tagVocabulary) return tagVocabulary;
    tagVocabulary = fetch('/tags', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    return tagVocabulary;
  }

  // Populates the browse/search filter datalist with tags already in use.
  function setupTagDatalist() {
    const list = document.getElementById('tag-options');
    if (!list) return;
    loadTags().then((tags) => {
      tags.forEach((tag) => {
        const option = document.createElement('option');
        option.value = tag.name;
        option.label = `${tag.name} · ${tag.uses} member${tag.uses === 1 ? '' : 's'}`;
        list.appendChild(option);
      });
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
    visible.setAttribute('autocomplete', 'off');
    hidden.type = 'hidden';
    hidden.insertAdjacentElement('afterend', wrap);

    let tags = String(hidden.value || '')
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
      .filter((t) => /^[a-z0-9_-]{2,24}$/.test(t));

    let refreshSuggestions = () => {};
    const sync = () => {
      hidden.value = tags.join(', ');
      render();
      refreshSuggestions();
    };
    const render = () => {
      wrap.querySelectorAll('.chip').forEach((c) => c.remove());
      tags.forEach((t) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `#${t} <button type="button" aria-label="Remove ${t}"><svg class="ico"><use href="#i-close"/></svg></button>`;
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
        // Enter here adds a tag; it must never submit the whole profile form.
        if (e.key === 'Enter' || visible.value.trim()) e.preventDefault();
        if (visible.value.trim()) { tryAdd(visible.value); visible.value = ''; }
      } else if (e.key === 'Backspace' && !visible.value && tags.length) {
        tags.pop();
        sync();
      }
    });
    visible.addEventListener('blur', () => { if (visible.value.trim()) { tryAdd(visible.value); visible.value = ''; } });

    // Suggestions drawn from the tags other members already use, so the same
    // tag gets reused instead of re-invented.
    const suggestions = document.createElement('ul');
    suggestions.className = 'tag-suggestions';
    suggestions.hidden = true;
    wrap.insertAdjacentElement('afterend', suggestions);

    const renderSuggestions = (vocabulary) => {
      const typed = visible.value.trim().toLowerCase().replace(/^#/, '');
      const matches = vocabulary
        .filter((tag) => !tags.includes(tag.name))
        .filter((tag) => (typed ? tag.name.startsWith(typed) : true))
        .slice(0, 8);
      suggestions.textContent = '';
      matches.forEach((tag) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `#${tag.name}`;
        const uses = document.createElement('small');
        uses.textContent = `${tag.uses}`;
        button.appendChild(uses);
        // mousedown, not click: blur would otherwise swallow the selection.
        button.addEventListener('mousedown', (e) => {
          e.preventDefault();
          tryAdd(tag.name);
          visible.value = '';
          renderSuggestions(vocabulary);
        });
        item.appendChild(button);
        suggestions.appendChild(item);
      });
      suggestions.hidden = matches.length === 0;
    };

    loadTags().then((vocabulary) => {
      if (!vocabulary.length) return;
      refreshSuggestions = () => renderSuggestions(vocabulary);
      refreshSuggestions();
      visible.addEventListener('input', refreshSuggestions);
      visible.addEventListener('focus', refreshSuggestions);
    });

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
      if (status) status.textContent = 'Locating';
      navigator.geolocation.getCurrentPosition((pos) => {
        const lat = pos.coords.latitude.toFixed(5);
        const lon = pos.coords.longitude.toFixed(5);
        if (latInput) latInput.value = lat;
        if (lngInput) lngInput.value = lon;
        if (consent && !consent.checked) consent.checked = true;
        if (status) status.textContent = 'Finding your town…';
        // The server turns the coordinates into a town and neighbourhood.
        fetch(`/geo/reverse?lat=${lat}&lon=${lon}`, { headers: { Accept: 'application/json' } })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) throw new Error(data.error || 'lookup failed');
            const city = $('input[name="city"]');
            const hood = $('input[name="neighborhood"]');
            if (city) city.value = data.city || '';
            if (hood) hood.value = data.neighborhood || '';
            if (status) status.textContent = `Found ${[data.neighborhood, data.city].filter(Boolean).join(', ')}. Save the profile to keep it.`;
          })
          .catch(() => { if (status) status.textContent = 'Coordinates filled in, but the town could not be looked up. Type it in, then save.'; })
          .finally(() => { btn.disabled = false; });
      }, (err) => {
        btn.disabled = false;
        if (status) status.textContent = `Could not get your position (${err.message}). Enter your city instead.`;
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
    if (!form) return;
    const input = form.querySelector('input[name="body"]');
    const button = form.querySelector('button');
    // Sent over fetch so the page never reloads: the server echoes the message
    // back through the socket, which is what actually draws the bubble.
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      button.disabled = true;
      fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
        body: new URLSearchParams({ body }).toString()
      }).then((res) => {
        if (res.ok) {
          input.value = '';
          // Without a live socket the echo never comes, so reload instead.
          if (!liveSocket || !liveSocket.connected) window.location.reload();
        } else {
          return res.json().catch(() => ({})).then((data) => showToast({ type: 'unlike', body: data.error || 'Message not sent.' }));
        }
      }).catch(() => form.submit())
        .finally(() => { button.disabled = false; input.focus(); });
    });
    setTimeout(() => input.focus(), 80);
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
    const placeholder = messages.querySelector('[data-chat-empty]');
    if (placeholder) placeholder.remove();
    const bubble = document.createElement('p');
    bubble.className = 'bubble ' + (message.sender_id === currentUserId ? 'mine' : 'theirs');
    const text = document.createElement('span');
    text.textContent = message.body;
    const small = document.createElement('small');
    small.textContent = formatTime(message.created_at);
    bubble.append(text, small);
    messages.appendChild(bubble);
    scrollMessages();
    if (message.sender_id !== currentUserId) {
      fetch(`/chat/${message.sender_id}/read`, { method: 'POST', headers: { 'X-Requested-With': 'fetch' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { if (data) setBadge('messages', data.unread); })
        .catch(() => {});
    }
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
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    if (sameDay) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + time;
  }
  // Keeps the conversation list preview in sync with live messages.
  function updateChatRow(message, currentUserId) {
    const otherId = message.sender_id === currentUserId ? message.receiver_id : message.sender_id;
    const row = document.querySelector(`[data-chat-row="${otherId}"]`);
    if (!row) return;
    const preview = row.querySelector('.chat-preview');
    if (preview) preview.textContent = message.body;
    row.parentElement.insertBefore(row, row.parentElement.querySelector('.chat-row'));
  }
  function activeChatId() {
    const messages = $('#messages');
    return messages ? Number(messages.dataset.activeId) : null;
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
    overlay.innerHTML = `<button aria-label="Close"><svg class="ico"><use href="#i-close"/></svg></button><img src="${src}" alt="">`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('button')) close(); });
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
  const TITLES = { like: 'Somebody likes you', match: "It's a match", message: 'New message', visit: 'Profile visit', unlike: 'Heads up' };
  const ICONS = { like: 'i-heart', match: 'i-heart', message: 'i-chat', visit: 'i-eye', unlike: 'i-split' };
  function showToast(notification) {
    const host = getToastHost();
    const toast = document.createElement('div');
    toast.className = 'toast ' + (notification.type || '');
    const title = TITLES[notification.type] || 'Notification';
    toast.innerHTML = `
      <span class="t-ico"><svg class="ico"><use href="#${ICONS[notification.type] || 'i-bell'}"/></svg></span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(notification.body || '')}</small>
      </div>
    `;
    // Built as a node with a same-origin-only href: never interpolated as HTML.
    if (notification.link && /^\/[^/\\]/.test(notification.link)) {
      const link = document.createElement('a');
      link.href = notification.link;
      link.textContent = 'View';
      toast.lastElementChild.appendChild(link);
    }
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
  let liveSocket = null;
  function setupSocket() {
    if (typeof io === 'undefined') return;
    if (!document.body.dataset.userId) return;
    const currentUserId = Number(document.body.dataset.userId);
    const socket = io();
    liveSocket = socket;

    socket.on('notification', (notification) => {
      // The open conversation already shows the message, no need to shout.
      if (notification.type === 'message' && notification.actor_id === activeChatId()) return;
      showToast(notification);
    });
    socket.on('unread-count', (count) => setBadge('notifications', count));
    socket.on('message', (message) => {
      const added = appendMessage(message, currentUserId);
      updateChatRow(message, currentUserId);
      if (!added && message.sender_id !== currentUserId) incBadge('messages');
    });
  }
})();
