const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FILE_PATH = path.join(__dirname, 'world_setting.txt');

// GET endpoint for the world setting
app.get('/api/world_setting', (req, res) => {
  fs.readFile(FILE_PATH, 'utf8', (err, txt) => {
    if (err) {
      res.status(500).json({error: "Could not read world_setting.txt"});
    } else {
      res.json({content: txt});
    }
  });
});

// POST endpoint to update the world setting
app.post('/api/world_setting', (req, res) => {
  const newTxt = req.body.content;
  if (!newTxt) return res.status(400).json({error: "No content"});
  fs.writeFile(FILE_PATH, newTxt, 'utf8', err => {
    if (err) {
      res.status(500).json({error: "Failed to write world_setting.txt"});
    } else {
      res.json({status: "ok"});
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`World setting server listening on port ${PORT}`);
});