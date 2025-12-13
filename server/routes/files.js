// server/routes/files.js
import express from 'express';
import path from 'path';
import fs from 'fs';

const router = express.Router();

// Akan jadi: C:\...\chatbotTelkom\data
const DATA_DIR = path.resolve(process.cwd(), '..', 'data');

function safeBasename(name) {
  const base = path.basename(String(name || ''));
  return base.replace(/[^\w.\- ]/g, '');
}

router.get('/files/:filename', (req, res) => {
  const filename = safeBasename(req.params.filename);

  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  const isDownload = String(req.query.download || '') === '1';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    isDownload
      ? `attachment; filename="${filename}"`
      : `inline; filename="${filename}"`
  );
  res.setHeader('Accept-Ranges', 'bytes');

  return res.sendFile(filePath);
});

export default router;

