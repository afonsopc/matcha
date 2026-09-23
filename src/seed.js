const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const { migrate, all, get, run, transaction } = require('./db');

migrate();

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
const horseDir = path.join(__dirname, '..', 'public', 'img', 'horses');
fs.mkdirSync(uploadDir, { recursive: true });

// Every photo is a real horse of a known breed (see public/img/credits.json),
// so a seeded profile's breed always matches its picture.
const { horses } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'credits.json'), 'utf8'));
const photos = horses.flatMap((h) => [`${h.slug}.jpg`, `${h.slug}-b.jpg`].map((file) => ({ file, breed: h.breed })))
  .filter((p) => fs.existsSync(path.join(horseDir, p.file)));

const mareNames = ['Estrela', 'Canela', 'Pérola', 'Safira', 'Açucena', 'Amêndoa', 'Andorinha', 'Aurora', 'Baunilha', 'Boneca', 'Brisa', 'Camélia', 'Carícia', 'Cereja', 'Dália', 'Divina', 'Doçura', 'Esmeralda', 'Faceira', 'Fadista', 'Formosa', 'Gaivota', 'Galega', 'Garça', 'Gazela', 'Graciosa', 'Harmonia', 'Hortênsia', 'Iara', 'Jóia', 'Lavanda', 'Leoa', 'Lua', 'Magnólia', 'Malva', 'Maravilha', 'Margarida', 'Mariposa', 'Melodia', 'Menina', 'Mimosa', 'Morena', 'Neblina', 'Ninfa', 'Orquídea', 'Papoila', 'Paixão', 'Pimenta', 'Princesa', 'Quimera', 'Rainha', 'Ribeira', 'Romã', 'Rosinha', 'Saudade', 'Serena', 'Sereia', 'Sevilhana', 'Tâmara', 'Ternura', 'Tília', 'Tulipa', 'Urze', 'Valsa', 'Ventania', 'Vénus', 'Violeta', 'Xana', 'Zínia', 'Bela', 'Gitana', 'Fantasia', 'Glória', 'Fidalga', 'Alegria', 'Azeitona', 'Bolacha', 'Castanha', 'Chita', 'Condessa', 'Duquesa', 'Fragata', 'Gralha', 'Marquesa', 'Palmira', 'Ribatejana', 'Sombra', 'Travessa'];
const stallionNames = ['Trovão', 'Faísca', 'Relâmpago', 'Bolota', 'Caramelo', 'Sultão', 'Xerife', 'Barão', 'Duque', 'Conde', 'Marquês', 'Tejo', 'Douro', 'Mondego', 'Sado', 'Guadiana', 'Vouga', 'Minho', 'Campino', 'Forcado', 'Toureiro', 'Galante', 'Garboso', 'Guerreiro', 'Herói', 'Ícaro', 'Jaguar', 'Lince', 'Maestro', 'Malhado', 'Moreno', 'Navegante', 'Novilheiro', 'Xaquiro', 'Oxidado', 'Orgulhoso', 'Pimpão', 'Pinhão', 'Príncipe', 'Quixote', 'Rebelde', 'Rouxinol', 'Soberbo', 'Talismã', 'Tornado', 'Urso', 'Valente', 'Vendaval', 'Veludo', 'Viriato', 'Xadrez', 'Zimbro', 'Alvor', 'Bravo', 'Cigano', 'Cristal', 'Destemido', 'Diamante', 'Farrusco', 'Fidalgo', 'Grilo', 'Infante', 'Jacinto', 'Mistério', 'Nobre', 'Ouro', 'Pardal', 'Pólvora', 'Rubi', 'Trigo', 'Castanho', 'Tinto', 'Cadete', 'Capitão', 'Almirante', 'Bandarra', 'Coral', 'Fado', 'Gavião', 'Lusíada', 'Marialva', 'Sultanito', 'Vasco', 'Zé'];
const otherNames = ['Sol', 'Mar', 'Céu', 'Nuvem', 'Vento', 'Rio', 'Serra', 'Luar', 'Orvalho', 'Areia', 'Pinho', 'Salgueiro', 'Horizonte', 'Eclipse', 'Aragem', 'Maré', 'Brasa', 'Lume', 'Seixo', 'Cardo', 'Alecrim', 'Musgo', 'Ribeiro', 'Bruma'];
const stableNames = ['do Vale', 'da Lezíria', 'de Alter', 'da Golegã', 'do Ribatejo', 'da Charneca', 'do Montado', 'da Azinheira', 'da Quinta Velha', 'do Sobreiro', 'da Ribeira', 'dos Arcos', 'do Pinhal', 'da Várzea', 'das Oliveiras', 'do Tojal', 'da Figueira', 'do Freixo', 'da Torre', 'do Castelo', 'da Ponte', 'do Moinho', 'da Fonte', 'do Outeiro', 'da Barroca', 'do Carvalhal', 'da Quintã', 'do Paul', 'da Coutada', 'do Alqueva', 'da Arrábida', 'do Barroso', 'da Estrela', 'do Marvão', 'de Monsaraz', 'da Nazaré', 'do Cartaxo', 'da Chamusca', 'de Coruche', 'de Almeirim'];

const places = [
  ['Lisboa', 'Belém', 38.6979, -9.2064],
  ['Lisboa', 'Alvalade', 38.7537, -9.1433],
  ['Porto', 'Foz do Douro', 41.1496, -8.6760],
  ['Golegã', 'Largo do Arneiro', 39.4036, -8.4862],
  ['Alter do Chão', 'Coudelaria', 39.2003, -7.6589],
  ['Comporta', 'Carvalhal', 38.3806, -8.7864],
  ['Sintra', 'Quinta da Regaleira', 38.7964, -9.3964],
  ['Évora', 'Centro Histórico', 38.5714, -7.9135],
  ['Coimbra', 'Baixa', 40.2033, -8.4103],
  ['Braga', 'Bom Jesus', 41.5546, -8.3771],
  ['Faro', 'Ria Formosa', 37.0194, -7.9304],
  ['Ponte de Lima', 'Expolima', 41.7672, -8.5838]
];

const tags = ['carrots', 'apples', 'sugar-cubes', 'hay', 'oats', 'dressage', 'show-jumping', 'eventing', 'trail-rides', 'beach-gallops', 'mud-rolling', 'grazing', 'naps-standing-up', 'polo', 'western', 'barrel-racing', 'hoof-care', 'grooming', 'long-manes', 'fly-masks', 'pasture-life', 'cart-pulling', 'horse-shows', 'winter-coat', 'sunsets', 'swimming', 'mountain-trails', 'feathers', 'braids', 'haflinger-fan-club'];

const bios = [
  'Will share my hay. Will not share my salt lick. Know the difference and we will get along.',
  'Retired from show jumping, not from jumping to conclusions. Looking for someone to graze with at golden hour.',
  'I have been told my canter is "a lot". Swipe accordingly.',
  'Farrier says I have great hooves. My mother says I should settle down. Both are right.',
  'Early riser. I will be at the fence at 6 am yelling about breakfast, every day, forever.',
  'Seeking a pasture partner who will not spook at plastic bags. I am working on it myself.',
  'Two things I take seriously: carrots and personal space. Everything else is negotiable.',
  'Former cart horse, current philosopher. Ask me about the meaning of hay.',
  'I roll in mud right after being groomed. If that is a dealbreaker, keep trotting.',
  'Fluent in snorts, nickers and the occasional dramatic sigh.',
  'Looking for the one who scratches the itchy spot on my withers without being asked.',
  'Short legs, big opinions. Pony energy, full-size heart.',
  'Beach gallops at sunrise, long naps at noon, standing up because I am classy like that.',
  'My last relationship ended because they would not share the shade. Learning to let go.',
  'Braided mane on Saturdays, wild mane on Sundays. Keep up.',
  'I will pretend I do not want the apple. Offer it anyway.',
  'Six-time winner of "Most Likely To Escape The Paddock". Still undefeated.',
  'Winter coat enthusiast. I will look like a sofa from November to March and I am at peace with it.',
  'Looking for somebody steady. I spook at puddles, you do not. Balance.',
  'Here for a real connection, not just someone to stand next to at the water trough.',
  'Grew up in Golegã, went to every fair, danced with a lot of Lusitanos. Ready for something quieter.',
  'I like my trails long, my grass green and my humans on time.',
  'Tell me your favourite fence line and I will tell you mine.',
  'Recovering sugar cube addict. One day at a time.'
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sample(list, count) {
  return [...list].sort(() => Math.random() - 0.5).slice(0, count);
}

// Deals names from a shuffled deck, reshuffling only when it runs out, so a
// name only comes back after every other one has been used.
function dealer(list) {
  let deck = [];
  return () => {
    if (!deck.length) deck = sample(list, list.length);
    return deck.pop();
  };
}

function birthdate(age) {
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  return `${new Date().getFullYear() - age}-${month}-${day}`;
}

function slug(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function copyPhoto(source, username, index) {
  const filename = `seed-${username}-${index}.jpg`;
  const target = path.join(uploadDir, filename);
  fs.copyFileSync(path.join(horseDir, source), target);
  return filename;
}

if (!photos.length) {
  console.error('No horse photos found in public/img/horses. Nothing to seed.');
  process.exit(1);
}

const passwordHash = bcrypt.hashSync('Password123!', 12);
const fixed = [
  { username: 'trovao', first: 'Trovão', last: 'da Golegã', gender: 'man', preference: 'women' },
  { username: 'estrela', first: 'Estrela', last: 'do Vale', gender: 'woman', preference: 'men' },
  { username: 'canela', first: 'Canela', last: 'da Lezíria', gender: 'woman', preference: 'bisexual' },
  { username: 'faisca', first: 'Faísca', last: 'de Alter', gender: 'man', preference: 'bisexual' }
];

// Suggestions rank horses from the same town together, so names and photos
// are dealt per town: neighbours on the page never share either one.
// One card per breed, in a random orientation: a mirrored copy of the same
// photo still reads as the same horse, so the deck never holds both.
const breedsDeck = horses.map((h) => ({ slug: h.slug, breed: h.breed }));
// Towns are dealt evenly (about 45 horses each), which stays under the 51
// breeds, so no town ever needs the same photo twice.
const nextTown = dealer([...new Set(places.map((p) => p[0]))]);
const towns = new Map();
function townDeck(city) {
  if (!towns.has(city)) {
    towns.set(city, {
      name: { man: dealer(stallionNames), woman: dealer(mareNames), other: dealer(otherNames) },
      stable: dealer(stableNames),
      photo: dealer(breedsDeck)
    });
  }
  return towns.get(city);
}

transaction(() => {
  for (const name of tags) run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [name]);

  for (let i = 0; i < 500; i += 1) {
    const preset = fixed[i];
    const gender = preset ? preset.gender : pick(['man', 'man', 'woman', 'woman', 'woman', 'other']);
    const town = nextTown();
    const place = pick(places.filter((p) => p[0] === town));
    const deck = townDeck(place[0]);
    const first = preset ? preset.first : deck.name[gender]();
    const last = preset ? preset.last : deck.stable();
    const username = preset ? preset.username : `${slug(first)}_${slug(last)}_${i}`;
    if (get('SELECT 1 FROM users WHERE username = ?', [username])) continue;

    const preference = preset ? preset.preference : pick(['men', 'women', 'bisexual', 'bisexual']);
    const [city, neighborhood, lat, lng] = place;
    const jitter = () => (Math.random() - 0.5) / 30;
    const dealt = deck.photo();
    const mainPhoto = { breed: dealt.breed, file: Math.random() < 0.5 ? `${dealt.slug}.jpg` : `${dealt.slug}-b.jpg` };
    const info = run(
      `INSERT INTO users (email, username, first_name, last_name, password_hash, verified, gender, preference, birthdate, bio, breed, city, neighborhood, latitude, longitude, location_consent, fame, online, last_seen)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`,
      [
        `${username}@matcha.local`, username, first, last, passwordHash, gender, preference,
        birthdate(18 + Math.floor(Math.random() * 30)), pick(bios), mainPhoto.breed, city, neighborhood,
        lat + jitter(), lng + jitter(),
        Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 20 * 86400)
      ]
    );

    const userId = info.lastInsertRowid;
    for (const tagName of sample(tags, 3 + Math.floor(Math.random() * 5))) {
      const tag = get('SELECT id FROM tags WHERE name = ?', [tagName]);
      run('INSERT OR IGNORE INTO user_tags (user_id, tag_id) VALUES (?, ?)', [userId, tag.id]);
    }

    run('INSERT INTO photos (user_id, filename, is_profile) VALUES (?, ?, 1)', [userId, copyPhoto(mainPhoto.file, username, 0)]);
  }

  const trovao = get('SELECT id FROM users WHERE username = ?', ['trovao']);
  const estrela = get('SELECT id FROM users WHERE username = ?', ['estrela']);
  if (trovao && estrela) {
    run('INSERT OR IGNORE INTO likes (liker_id, liked_id) VALUES (?, ?)', [trovao.id, estrela.id]);
    run('INSERT OR IGNORE INTO likes (liker_id, liked_id) VALUES (?, ?)', [estrela.id, trovao.id]);
    if (!get('SELECT 1 FROM messages WHERE sender_id IN (?, ?) AND receiver_id IN (?, ?)', [trovao.id, estrela.id, trovao.id, estrela.id])) {
      const now = Math.floor(Date.now() / 1000);
      run('INSERT INTO messages (sender_id, receiver_id, body, read_at, created_at) VALUES (?, ?, ?, ?, ?)', [estrela.id, trovao.id, 'Saw you at the Golegã fair. Nice braids.', now - 3000, now - 3600]);
      run('INSERT INTO messages (sender_id, receiver_id, body, read_at, created_at) VALUES (?, ?, ?, ?, ?)', [trovao.id, estrela.id, 'Took me two hours. Worth it if you noticed.', now - 3000, now - 3200]);
      run('INSERT INTO messages (sender_id, receiver_id, body, created_at) VALUES (?, ?, ?, ?)', [estrela.id, trovao.id, 'Carrots by the river on Saturday?', now - 600]);
    }
  }

  // Give every profile some history, then derive fame from it with the very
  // same formula the app uses at runtime, so a seeded score can never contradict
  // what recalcFame() would produce.
  const ids = all('SELECT id FROM users').map((row) => row.id);
  for (const id of ids) {
    const admirers = sample(ids.filter((other) => other !== id), Math.floor(Math.random() * 9));
    for (const admirer of admirers) run('INSERT OR IGNORE INTO likes (liker_id, liked_id) VALUES (?, ?)', [admirer, id]);
    const visitors = sample(ids.filter((other) => other !== id), Math.floor(Math.random() * 16));
    for (const visitor of visitors) {
      run('INSERT INTO visits (visitor_id, visited_id, created_at) VALUES (?, ?, ?)', [
        visitor, id, Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 30 * 86400)
      ]);
    }
  }
  run(`
    UPDATE users SET fame = MAX(0, MIN(100,
      (SELECT COUNT(DISTINCT liker_id) FROM likes WHERE liked_id = users.id) * 8 +
      (SELECT COUNT(DISTINCT visitor_id) FROM visits WHERE visited_id = users.id) * 2 -
      (SELECT COUNT(DISTINCT reporter_id) FROM reports WHERE reported_id = users.id) * 12
    ))
  `);
});

const total = get('SELECT COUNT(*) AS c FROM users').c;
console.log(`Seed complete: ${total} horses in the stable. Sign in as trovao / Password123!`);
