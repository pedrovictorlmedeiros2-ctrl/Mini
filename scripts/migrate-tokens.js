#!/usr/bin/env node
require('dotenv').config({ override: true });

const { db, query, run } = require('../src/database/database');
const { decrypt, encrypt } = require('../src/utils/crypto');

function migrateTokens() {
  const bots = query('SELECT id, token FROM bots WHERE token IS NOT NULL AND token <> ?', ['']);
  let migrated = 0;
  let failed = 0;

  for (const bot of bots) {
    try {
      const plain = decrypt(bot.token);
      if (!plain) {
        failed += 1;
        console.warn(`⚠️ Token não migrado para bot ${bot.id}: não foi possível descriptografar`);
        continue;
      }

      const reencrypted = encrypt(plain);
      run('UPDATE bots SET token = ? WHERE id = ?', [reencrypted, bot.id]);
      migrated += 1;
      console.log(`✅ Bot ${bot.id}: token migrado com sucesso`);
    } catch (err) {
      failed += 1;
      console.error(`❌ Bot ${bot.id}: ${err.message}`);
    }
  }

  console.log(`\nResumo: ${migrated} tokens migrados, ${failed} falhas.`);
}

migrateTokens();
