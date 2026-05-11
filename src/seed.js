require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { migrate, get, run, transaction } = require('./db');

migrate();

const uploadDir = path.join(process.cwd(), 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const firstNames = ['Alice','Bruno','Carla','Diego','Eva','Felix','Grace','Hugo','Iris','Jonas','Kiara','Leo','Marta','Nuno','Olivia','Pedro','Quinn','Rita','Sara','Tiago','Uma','Vasco','Wendy','Xavier','Yara','Zoe'];
const lastNames = ['Silva','Costa','Pereira','Santos','Ferreira','Oliveira','Rodrigues','Martins','Sousa','Gomes'];
const cities = [
  ['Lisbon', 'Alvalade', 38.7537, -9.1433],
  ['Lisbon', 'Arroios', 38.7310, -9.1350],
  ['Porto', 'Cedofeita', 41.1579, -8.6291],
  ['Porto', 'Bonfim', 41.1512, -8.5985],
  ['Coimbra', 'Baixa', 40.2033, -8.4103],
  ['Braga', 'Centro', 41.5454, -8.4265],
  ['Faro', 'Se', 37.0194, -7.9304]
];
const tags = ['music','coffee','travel','hiking','fitness','books','cinema','tech','art','cooking','gaming','surf','climbing','jazz','dogs','cats','vegan','wine','football','running','photography','yoga','design','science'];
const bios = [
  'Always looking for good conversation and better coffee.',
  'Weekend walks, live music, and spontaneous dinners.',
  'Curious, direct, and usually planning the next trip.',
  'I like people who are kind, funny, and a little ambitious.',
  'Here for real connections, not endless small talk.'
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sample(list, count) {
  return [...list].sort(() => Math.random() - 0.5).slice(0, count);
}

function birthdate(age) {
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  return `${new Date().getFullYear() - age}-${month}-${day}`;
}

function svgPhoto(name, color) {
  const initials = name.split(' ').map((p) => p[0]).join('').slice(0, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="${color}"/><circle cx="300" cy="235" r="105" fill="#fff8"/><rect x="150" y="370" width="300" height="150" rx="75" fill="#fff8"/><text x="300" y="330" text-anchor="middle" font-family="Arial" font-size="92" font-weight="700" fill="#221">${initials}</text></svg>`;
}

const passwordHash = bcrypt.hashSync('Password123!', 12);
const fixed = [
  ['alice', 'Alice', 'Silva', 'woman', 'men'],
  ['bruno', 'Bruno', 'Costa', 'man', 'women'],
  ['carla', 'Carla', 'Pereira', 'woman', 'bisexual'],
  ['diego', 'Diego', 'Santos', 'man', 'bisexual']
];

transaction(() => {
  for (const name of tags) run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [name]);

  for (let i = 0; i < 500; i += 1) {
    const fixedUser = fixed[i];
    const first = fixedUser ? fixedUser[1] : pick(firstNames);
    const last = fixedUser ? fixedUser[2] : pick(lastNames);
    const username = fixedUser ? fixedUser[0] : `${first.toLowerCase()}_${last.toLowerCase()}_${i}`;
    if (get('SELECT 1 FROM users WHERE username = ?', [username])) continue;

    const gender = fixedUser ? fixedUser[3] : pick(['man', 'woman']);
    const preference = fixedUser ? fixedUser[4] : pick(['men', 'women', 'bisexual']);
    const [city, neighborhood, lat, lng] = pick(cities);
    const jitter = () => (Math.random() - 0.5) / 30;
    const info = run(
      `INSERT INTO users (email, username, first_name, last_name, password_hash, verified, gender, preference, birthdate, bio, city, neighborhood, latitude, longitude, location_consent, fame, online, last_seen)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, strftime('%s','now'))`,
      [
        `${username}@matcha.local`, username, first, last, passwordHash, gender, preference,
        birthdate(18 + Math.floor(Math.random() * 35)), pick(bios), city, neighborhood,
        lat + jitter(), lng + jitter(), Math.floor(Math.random() * 80)
      ]
    );

    const userId = info.lastInsertRowid;
    for (const tagName of sample(tags, 3 + Math.floor(Math.random() * 5))) {
      const tag = get('SELECT id FROM tags WHERE name = ?', [tagName]);
      run('INSERT OR IGNORE INTO user_tags (user_id, tag_id) VALUES (?, ?)', [userId, tag.id]);
    }

    const filename = `${username}.svg`;
    fs.writeFileSync(path.join(uploadDir, filename), svgPhoto(`${first} ${last}`, pick(['#e2b8a7','#b8d8c7','#c6d6e8','#e5d28a','#c9b8e2'])));
    run('INSERT INTO photos (user_id, filename, is_profile) VALUES (?, ?, 1)', [userId, filename]);
  }

  const alice = get('SELECT id FROM users WHERE username = ?', ['alice']);
  const bruno = get('SELECT id FROM users WHERE username = ?', ['bruno']);
  if (alice && bruno) {
    run('INSERT OR IGNORE INTO likes (liker_id, liked_id) VALUES (?, ?)', [alice.id, bruno.id]);
    run('INSERT OR IGNORE INTO likes (liker_id, liked_id) VALUES (?, ?)', [bruno.id, alice.id]);
  }
});

console.log('Seed complete. Login with alice / Password123!');
