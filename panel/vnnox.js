// Cliente de la OpenAPI de VNNOX (NovaCloud) para publicar programas a la pantalla DOOH.
// Auth: headers AppKey/Nonce/CurTime/CheckSum, con CheckSum = SHA256(AppSecret + Nonce + CurTime) (hex).
// Credenciales en plataforma.env (VNNOX_API_BASE / VNNOX_AK / VNNOX_AS / VNNOX_PLAYER_IDS).
const crypto = require('crypto');

const BASE = (process.env.VNNOX_API_BASE || '').replace(/\/$/, '');
const AK = process.env.VNNOX_AK || '';
const AS = process.env.VNNOX_AS || '';
const PLAYER_IDS = (process.env.VNNOX_PLAYER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const configured = () => !!(BASE && AK && AS && PLAYER_IDS.length);

function authHeaders(isPost) {
  const nonce = crypto.randomBytes(8).toString('hex');                 // 16 chars alfanum (8-64 ok)
  const curtime = String(Math.floor(Date.now() / 1000));               // segundos UTC
  const checksum = crypto.createHash('sha256').update(AS + nonce + curtime).digest('hex');
  return {
    AppKey: AK, Nonce: nonce, CurTime: curtime, CheckSum: checksum,
    'Content-Type': isPost ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
  };
}

async function api(method, pathq, body) {
  const r = await fetch(BASE + pathq, {
    method, headers: authHeaders(method !== 'GET'),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

// Lista de players (lectura, para validar credenciales/estado).
const listPlayers = () => api('GET', '/v2/player/list?count=50');

// Publica un programa = secuencia de videos a pantalla completa (una página por video; loopea).
// items: [{ url, md5, size, durMs, label }]
async function publishProgram(items, playerIds, name) {
  const pages = items.map((it, i) => ({
    name: it.label || ('p' + (i + 1)),
    repeatCount: 1,
    widgets: [{
      type: 'VIDEO', zIndex: 1, url: it.url, md5: it.md5, size: it.size, duration: it.durMs,
      layout: { x: '0%', y: '0%', width: '100%', height: '100%' },
    }],
  }));
  // Sin "schedule" => reproducción 24 h (default de la API).
  const body = { playerIds: (playerIds && playerIds.length) ? playerIds : PLAYER_IDS, pages };
  if (name) body.name = name;
  return api('POST', '/v2/player/program/normal', body);
}

module.exports = { configured, listPlayers, publishProgram, PLAYER_IDS, BASE };
