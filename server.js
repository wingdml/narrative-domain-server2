const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FILE_PATH_PRIMARY = path.join(__dirname, 'World_Setting.txt');
const FILE_PATH_FALLBACK = path.join(__dirname, 'world_setting.txt');
const FILE_PATH = fs.existsSync(FILE_PATH_PRIMARY) ? FILE_PATH_PRIMARY : FILE_PATH_FALLBACK;

const MULTIPLAYER_API_PATH = '/api/multiplayer';
const PLAYER_STALE_SECONDS = 90;

// session_id -> Map(player_name -> playerState)
const multiplayerSessions = new Map();

function nowSeconds() {
  return Date.now() / 1000;
}

function getSessionMap(sessionId) {
  let session = multiplayerSessions.get(sessionId);
  if (!session) {
    session = new Map();
    multiplayerSessions.set(sessionId, session);
  }
  return session;
}

function cleanupStalePlayers(sessionId) {
  const session = multiplayerSessions.get(sessionId);
  if (!session) {
    return;
  }

  const cutoff = nowSeconds() - PLAYER_STALE_SECONDS;
  for (const [name, state] of session.entries()) {
    const ts = Number(state.timestamp || 0);
    if (!Number.isFinite(ts) || ts < cutoff) {
      session.delete(name);
    }
  }

  if (session.size === 0) {
    multiplayerSessions.delete(sessionId);
  }
}

// GET endpoint for the world setting
app.get('/api/world_setting', (req, res) => {
  fs.readFile(FILE_PATH, 'utf8', (err, txt) => {
    if (err) {
      res.status(500).json({error: 'Could not read world setting file'});
    } else {
      res.json({ content: txt });
    }
  });
});

// Legacy alias used by older tooling/UI.
app.get('/api/settings', (req, res) => {
  fs.readFile(FILE_PATH, 'utf8', (err, txt) => {
    if (err) {
      res.status(500).json({ error: 'Could not read world setting file' });
    } else {
      res.json({ content: txt });
    }
  });
});

// POST endpoint to update the world setting
app.post('/api/world_setting', (req, res) => {
  const newTxt = req.body.content;
  if (typeof newTxt !== 'string') return res.status(400).json({ error: 'No content' });
  fs.writeFile(FILE_PATH, newTxt, 'utf8', err => {
    if (err) {
      res.status(500).json({ error: 'Failed to write world setting file' });
    } else {
      res.json({ status: 'ok' });
    }
  });
});

// Legacy alias used by older tooling/UI.
app.post('/api/settings', (req, res) => {
  const newTxt = req.body.content;
  if (typeof newTxt !== 'string') return res.status(400).json({ error: 'No content' });
  fs.writeFile(FILE_PATH, newTxt, 'utf8', err => {
    if (err) {
      res.status(500).json({ error: 'Failed to write world setting file' });
    } else {
      res.json({ status: 'ok' });
    }
  });
});

// Register/refresh a player in a session.
app.post(`${MULTIPLAYER_API_PATH}/register`, (req, res) => {
  const { player_name: playerName, session_id: sessionId, is_npc: isNpc = false, timestamp } = req.body || {};
  if (!playerName || !sessionId) {
    return res.status(400).json({ error: 'player_name and session_id are required' });
  }

  cleanupStalePlayers(sessionId);
  const session = getSessionMap(sessionId);
  const prev = session.get(playerName) || {};
  session.set(playerName, {
    player_name: playerName,
    session_id: sessionId,
    is_npc: Boolean(isNpc),
    location: prev.location || 'HALL',
    location_detail: prev.location_detail || 'Central Hall',
    timestamp: Number.isFinite(Number(timestamp)) ? Number(timestamp) : nowSeconds(),
  });

  return res.json({ status: 'ok' });
});

// Update a player's current location.
app.post(`${MULTIPLAYER_API_PATH}/update_location`, (req, res) => {
  const {
    player_name: playerName,
    session_id: sessionId,
    location,
    location_detail: locationDetail = '',
    timestamp,
  } = req.body || {};

  if (!playerName || !sessionId || !location) {
    return res.status(400).json({ error: 'player_name, session_id and location are required' });
  }

  cleanupStalePlayers(sessionId);
  const session = getSessionMap(sessionId);
  const prev = session.get(playerName) || {};
  session.set(playerName, {
    player_name: playerName,
    session_id: sessionId,
    is_npc: Boolean(prev.is_npc),
    location,
    location_detail: locationDetail,
    timestamp: Number.isFinite(Number(timestamp)) ? Number(timestamp) : nowSeconds(),
  });

  return res.json({ status: 'ok' });
});

// List players in a session, optionally excluding one player.
app.get(`${MULTIPLAYER_API_PATH}/get_players`, (req, res) => {
  const { session_id: sessionId, exclude } = req.query || {};
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  cleanupStalePlayers(sessionId);
  const session = multiplayerSessions.get(sessionId);
  if (!session) {
    return res.json({ players: [] });
  }

  const players = [];
  for (const [name, state] of session.entries()) {
    if (exclude && name === exclude) {
      continue;
    }
    players.push({
      player_name: state.player_name,
      is_npc: Boolean(state.is_npc),
      location: state.location || 'HALL',
      location_detail: state.location_detail || '',
      timestamp: Number.isFinite(Number(state.timestamp)) ? Number(state.timestamp) : nowSeconds(),
    });
  }

  return res.json({ players });
});

// Remove player from session when exiting game.
app.post(`${MULTIPLAYER_API_PATH}/unregister`, (req, res) => {
  const { player_name: playerName, session_id: sessionId } = req.body || {};
  if (!playerName || !sessionId) {
    return res.status(400).json({ error: 'player_name and session_id are required' });
  }

  const session = multiplayerSessions.get(sessionId);
  if (session) {
    session.delete(playerName);
    if (session.size === 0) {
      multiplayerSessions.delete(sessionId);
    }
  }

  return res.json({ status: 'ok' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Narrative server listening on port ${PORT}`);
});