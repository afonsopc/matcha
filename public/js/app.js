document.addEventListener('DOMContentLoaded', () => {
  if (typeof io === 'undefined') return;
  const socket = io();
  const badge = document.querySelector('#badge');
  const messages = document.querySelector('#messages');

  socket.on('notification', (notification) => {
    if (badge) badge.textContent = String(Number(badge.textContent || 0) + 1);
    console.info(notification.body);
  });

  socket.on('message', (message) => {
    if (!messages) return;
    const item = document.createElement('p');
    item.className = 'theirs';
    item.textContent = message.body;
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
  });
});
