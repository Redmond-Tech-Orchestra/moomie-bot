#!/bin/bash
# Daily SQLite backup with tiered retention — called by cron: 0 11 * * *
# Retention policy:
#   - Daily backups for the last 7 days
#   - Weekly backups for the prior 4 weeks (one per ISO week)
#   - Monthly backups for the prior 12 months (one per calendar month)
#   - Anything older is deleted
docker exec moomie-bot node -e "
(async () => {
  const fs = require('fs');
  const path = require('path');
  const Database = require('better-sqlite3');
  const dir = '/app/data';

  // 1. Take today's backup (UTC date)
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dst = path.join(dir, 'backup-' + today + '.db');
  const db = new Database(path.join(dir, 'moomie.db'), { readonly: true });
  await db.backup(dst);
  db.close();
  console.log('Wrote', dst);

  // 2. Apply tiered retention
  const now = new Date();
  const dayMs = 86400000;
  const files = fs.readdirSync(dir)
    .filter(f => /^backup-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .map(f => ({ name: f, date: new Date(f.slice(7, 17) + 'T00:00:00Z') }))
    .sort((a, b) => b.date - a.date); // newest first

  const keep = new Set();
  const seenWeek = new Set();
  const seenMonth = new Set();

  for (const { name, date } of files) {
    const ageDays = (now - date) / dayMs;
    if (ageDays < 7) {
      keep.add(name); // daily
    } else if (ageDays < 35) {
      // weekly: keep one (the newest in each ISO week) for ~5 weeks back
      const onejan = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const week = date.getUTCFullYear() + '-W' + Math.ceil(((date - onejan) / dayMs + onejan.getUTCDay() + 1) / 7);
      if (!seenWeek.has(week)) { seenWeek.add(week); keep.add(name); }
    } else if (ageDays < 365) {
      // monthly: keep one (the newest in each calendar month)
      const month = date.getUTCFullYear() + '-' + (date.getUTCMonth() + 1);
      if (!seenMonth.has(month)) { seenMonth.add(month); keep.add(name); }
    }
    // else: drop (older than 1 year)
  }

  for (const { name } of files) {
    if (!keep.has(name)) {
      fs.unlinkSync(path.join(dir, name));
      console.log('Pruned', name);
    }
  }
  console.log('Kept', keep.size, 'backups');
})().catch(e => { console.error(e); process.exit(1); });
"

# Clean up the old day-of-week backups from the previous scheme
docker exec moomie-bot bash -c 'rm -f /app/data/backup-Monday.db /app/data/backup-Tuesday.db /app/data/backup-Wednesday.db /app/data/backup-Thursday.db /app/data/backup-Friday.db /app/data/backup-Saturday.db /app/data/backup-Sunday.db'
