const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const FILE_PATH_PRIMARY = path.join(__dirname, 'World_Setting.txt');
const FILE_PATH_FALLBACK = path.join(__dirname, 'world_setting.txt');

function resolveDataDir() {
  const envDir = process.env.DATA_DIR || process.env.NARRATIVIUM_DATA_DIR;
  if (envDir && envDir.trim()) {
    return path.resolve(envDir.trim());
  }
  const renderDisk = '/data';
  if (fs.existsSync(renderDisk)) {
    return renderDisk;
  }
  return __dirname;
}

const DATA_DIR = resolveDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

const FILE_PATH = path.join(DATA_DIR, 'world_setting.txt');
const WORLD_SETTING_HISTORY_FILE = path.join(DATA_DIR, 'world_setting_history.json');

const MULTIPLAYER_API_PATH = '/api/multiplayer';
const PLAYER_STALE_SECONDS = 90;
const PLAYER_COUNTER_FILE = path.join(DATA_DIR, 'player_counter.json');

// session_id -> Map(player_name -> playerState)
const multiplayerSessions = new Map();

function writeJsonAtomic(filePath, payload) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function writeTextAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function ensureWorldSettingSeeded() {
  if (fs.existsSync(FILE_PATH)) {
    return;
  }
  let seed = null;
  for (const src of [FILE_PATH_PRIMARY, FILE_PATH_FALLBACK]) {
    try {
      if (fs.existsSync(src)) {
        seed = fs.readFileSync(src, 'utf8');
        break;
      }
    } catch (_err) {
      // ignore and continue fallback chain
    }
  }
  if (!seed) {
    seed = [
      'Geography: Yarn',
      'Species: Cat',
      'Religion: Apple',
      'Military: Cake',
      'Villain: Masked Dog',
      '',
    ].join('\n');
  }
  writeTextAtomic(FILE_PATH, seed);
}

ensureWorldSettingSeeded();

function loadTotalPlayersEver() {
  try {
    if (!fs.existsSync(PLAYER_COUNTER_FILE)) {
      return 0;
    }
    const raw = fs.readFileSync(PLAYER_COUNTER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const n = Number(parsed && parsed.total_players_ever);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch (_err) {
    return 0;
  }
}

function saveTotalPlayersEver(value) {
  const safe = Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
  const payload = {
    total_players_ever: safe,
    updated_at_unix: nowSeconds(),
  };
  writeJsonAtomic(PLAYER_COUNTER_FILE, payload);
}

let totalPlayersEver = loadTotalPlayersEver();

function nowSeconds() {
  return Date.now() / 1000;
}

function loadWorldSettingHistory() {
  try {
    if (!fs.existsSync(WORLD_SETTING_HISTORY_FILE)) {
      return { updates: [] };
    }
    const raw = fs.readFileSync(WORLD_SETTING_HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed || { updates: [] };
  } catch (_err) {
    return { updates: [] };
  }
}

function saveWorldSettingHistory(history) {
  const payload = {
    updates: Array.isArray(history.updates) ? history.updates : [],
  };
  writeJsonAtomic(WORLD_SETTING_HISTORY_FILE, payload);
}

function recordWorldSettingUpdate(playerName, oldContent, newContent) {
  const history = loadWorldSettingHistory();
  const entry = {
    player_name: playerName || 'unknown',
    timestamp_unix: nowSeconds(),
    timestamp_iso: new Date().toISOString(),
    old_content_lines: (oldContent || '').split('\n').length,
    new_content_lines: (newContent || '').split('\n').length,
  };
  if (!history.updates) {
    history.updates = [];
  }
  history.updates.push(entry);
  // Keep only last 50 updates
  if (history.updates.length > 50) {
    history.updates = history.updates.slice(-50);
  }
  saveWorldSettingHistory(history);
}

function getWorldSettingLastUpdatedBy() {
  const history = loadWorldSettingHistory();
  if (history.updates && history.updates.length > 0) {
    return history.updates[history.updates.length - 1];
  }
  return null;
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

function cleanupAllStalePlayers() {
  for (const sessionId of Array.from(multiplayerSessions.keys())) {
    cleanupStalePlayers(sessionId);
  }
}

function getMultiplayerStats() {
  cleanupAllStalePlayers();

  const sessions = [];
  let activePlayers = 0;
  for (const [sessionId, session] of multiplayerSessions.entries()) {
    const players = [];
    for (const state of session.values()) {
      players.push({
        player_name: state.player_name,
        is_npc: Boolean(state.is_npc),
        location: state.location || 'HALL',
        location_detail: state.location_detail || '',
        timestamp: Number.isFinite(Number(state.timestamp)) ? Number(state.timestamp) : nowSeconds(),
      });
    }
    activePlayers += players.length;
    sessions.push({
      session_id: sessionId,
      player_count: players.length,
      players,
    });
  }

  return {
    active_sessions: sessions.length,
    active_players: activePlayers,
    sessions,
  };
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// GET endpoint for the world setting
app.get('/api/world_setting', (req, res) => {
  fs.readFile(FILE_PATH, 'utf8', (err, txt) => {
    if (err) {
      res.status(500).json({error: 'Could not read world setting file'});
    } else {
      const lastUpdate = getWorldSettingLastUpdatedBy();
      res.json({ 
        content: txt,
        last_updated_by: lastUpdate 
      });
    }
  });
});

// Legacy alias used by older tooling/UI.
app.get('/api/settings', (req, res) => {
  fs.readFile(FILE_PATH, 'utf8', (err, txt) => {
    if (err) {
      res.status(500).json({ error: 'Could not read world setting file' });
    } else {
      const lastUpdate = getWorldSettingLastUpdatedBy();
      res.json({ 
        content: txt,
        last_updated_by: lastUpdate 
      });
    }
  });
});

app.get('/api/status', (req, res) => {
  fs.readFile(FILE_PATH, 'utf8', (err, txt) => {
    const worldContent = err ? '' : txt;
    const lastUpdate = getWorldSettingLastUpdatedBy();
    res.json({
      status: 'ok',
      server_time_unix: nowSeconds(),
      uptime_seconds: process.uptime(),
      data_dir: DATA_DIR,
      world_setting_file: path.basename(FILE_PATH),
      world_content: worldContent,
      world_setting_last_updated_by: lastUpdate,
      total_players_ever: totalPlayersEver,
      multiplayer: getMultiplayerStats(),
    });
  });
});

app.get('/api/player_counter', (_req, res) => {
  return res.json({ total_players_ever: totalPlayersEver });
});

app.post('/api/player_counter/increment', (_req, res) => {
  totalPlayersEver += 1;
  try {
    saveTotalPlayersEver(totalPlayersEver);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to persist player counter' });
  }
  return res.json({ status: 'ok', total_players_ever: totalPlayersEver });
});

app.post('/api/player_counter/reset', (_req, res) => {
  totalPlayersEver = 0;
  try {
    saveTotalPlayersEver(totalPlayersEver);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset player counter' });
  }
  return res.json({ status: 'ok', total_players_ever: totalPlayersEver });
});

// GET world setting change history
app.get('/api/world_setting/history', (_req, res) => {
  const history = loadWorldSettingHistory();
  return res.json(history);
});

// POST endpoint to update the world setting
app.post('/api/world_setting', (req, res) => {
  const newTxt = req.body.content;
  const playerName = req.body.player_name || 'unknown';
  if (typeof newTxt !== 'string') return res.status(400).json({ error: 'No content' });
  try {
    // Read old content before writing
    let oldTxt = '';
    try {
      oldTxt = fs.readFileSync(FILE_PATH, 'utf8');
    } catch (_err) {
      oldTxt = '';
    }
    // Write new content
    writeTextAtomic(FILE_PATH, newTxt);
    // Record the update
    recordWorldSettingUpdate(playerName, oldTxt, newTxt);
    const lastUpdate = getWorldSettingLastUpdatedBy();
    res.json({ status: 'ok', last_updated_by: lastUpdate });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write world setting file' });
  }
});

// Legacy alias used by older tooling/UI.
app.post('/api/settings', (req, res) => {
  const newTxt = req.body.content;
  const playerName = req.body.player_name || 'unknown';
  if (typeof newTxt !== 'string') return res.status(400).json({ error: 'No content' });
  try {
    // Read old content before writing
    let oldTxt = '';
    try {
      oldTxt = fs.readFileSync(FILE_PATH, 'utf8');
    } catch (_err) {
      oldTxt = '';
    }
    // Write new content
    writeTextAtomic(FILE_PATH, newTxt);
    // Record the update
    recordWorldSettingUpdate(playerName, oldTxt, newTxt);
    const lastUpdate = getWorldSettingLastUpdatedBy();
    res.json({ status: 'ok', last_updated_by: lastUpdate });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write world setting file' });
  }
});

// Register/refresh a player in a session.
app.post(`${MULTIPLAYER_API_PATH}/register`, (req, res) => {
  const {
    player_name: playerName,
    session_id: sessionId,
    client_id: clientId,
    is_npc: isNpc = false,
    timestamp,
  } = req.body || {};
  if (!playerName || !sessionId) {
    return res.status(400).json({ error: 'player_name and session_id are required' });
  }

  cleanupStalePlayers(sessionId);
  const session = getSessionMap(sessionId);
  const playerKey = (typeof clientId === 'string' && clientId.trim()) ? clientId.trim() : playerName;
  const prev = session.get(playerKey) || {};
  session.set(playerKey, {
    player_name: playerName,
    client_id: playerKey,
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
    client_id: clientId,
    location,
    location_detail: locationDetail = '',
    timestamp,
  } = req.body || {};

  if (!playerName || !sessionId || !location) {
    return res.status(400).json({ error: 'player_name, session_id and location are required' });
  }

  cleanupStalePlayers(sessionId);
  const session = getSessionMap(sessionId);
  const playerKey = (typeof clientId === 'string' && clientId.trim()) ? clientId.trim() : playerName;
  const prev = session.get(playerKey) || {};
  session.set(playerKey, {
    player_name: playerName,
    client_id: playerKey,
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
  const { session_id: sessionId, exclude, exclude_client_id: excludeClientId } = req.query || {};
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  cleanupStalePlayers(sessionId);
  const session = multiplayerSessions.get(sessionId);
  if (!session) {
    return res.json({ players: [] });
  }

  const players = [];
  for (const [key, state] of session.entries()) {
    if (excludeClientId && key === excludeClientId) {
      continue;
    }
    if (exclude && state.player_name === exclude) {
      continue;
    }
    players.push({
      player_name: state.player_name,
      client_id: state.client_id || key,
      is_npc: Boolean(state.is_npc),
      location: state.location || 'HALL',
      location_detail: state.location_detail || '',
      timestamp: Number.isFinite(Number(state.timestamp)) ? Number(state.timestamp) : nowSeconds(),
    });
  }

  return res.json({ players });
});

app.get(`${MULTIPLAYER_API_PATH}/stats`, (_req, res) => {
  return res.json(getMultiplayerStats());
});

// Remove player from session when exiting game.
app.post(`${MULTIPLAYER_API_PATH}/unregister`, (req, res) => {
  const { player_name: playerName, session_id: sessionId, client_id: clientId } = req.body || {};
  if (!playerName || !sessionId) {
    return res.status(400).json({ error: 'player_name and session_id are required' });
  }

  const session = multiplayerSessions.get(sessionId);
  if (session) {
    const playerKey = (typeof clientId === 'string' && clientId.trim()) ? clientId.trim() : playerName;
    session.delete(playerKey);
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