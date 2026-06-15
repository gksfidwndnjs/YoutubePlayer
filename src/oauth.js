'use strict';
// Google OAuth 2.0 for installed/desktop apps: loopback redirect + PKCE.
// The consent screen opens in the user's real browser (Google blocks embedded
// webviews); a temporary localhost server catches the redirected auth code.
//
// Credentials come from ./google-config.js, which is gitignored — they are baked
// into distributed builds but never committed to the public repo. PKCE (not the
// client secret) is what actually protects the exchange; per Google, an installed
// app's client secret is not treated as confidential.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { shell } = require('electron');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

let creds = { clientId: '', clientSecret: '' };
try { creds = { ...creds, ...require('./google-config') }; } catch {}

let tokenPath = null;
const init = (p) => { tokenPath = p; };

const load = () => { try { return JSON.parse(fs.readFileSync(tokenPath, 'utf8')); } catch { return {}; } };
const save = (d) => fs.writeFileSync(tokenPath, JSON.stringify(d, null, 2), 'utf8');

const isConfigured = () => !!creds.clientId && !!creds.clientSecret;
const isSignedIn = () => !!load().refresh_token;
const getAccount = () => load().account || null;
const setAccount = (account) => save({ ...load(), account });
const signOut = () => { try { fs.unlinkSync(tokenPath); } catch {} };

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const RESULT_PAGE = (msg) =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;font-family:system-ui,sans-serif;background:#0c120e;color:#00e857;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center"><div><h2>${msg}</h2><p style="color:#7aa">이 창을 닫고 앱으로 돌아가세요.</p></div></body>`;

// Opens consent in the browser, resolves the one-time auth code via loopback.
function getAuthCode(challenge) {
  return new Promise((resolve, reject) => {
    let redirectUri;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (!code && !error) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(RESULT_PAGE(error ? '로그인 실패' : '로그인 완료'));
      server.close();
      if (error) reject(new Error(error));
      else resolve({ code, redirectUri });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const params = new URLSearchParams({
        client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: SCOPE, access_type: 'offline', prompt: 'consent',
        code_challenge: challenge, code_challenge_method: 'S256',
      });
      shell.openExternal(`${AUTH_URL}?${params}`);
    });
    setTimeout(() => { try { server.close(); } catch {} reject(new Error('로그인 시간이 초과되었습니다')); }, SIGN_IN_TIMEOUT_MS);
  });
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`토큰 요청 실패 (${res.status}): ${await res.text()}`);
  return res.json();
}

async function signIn() {
  if (!isConfigured()) throw new Error('이 빌드에 Google 클라이언트가 설정되어 있지 않습니다');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const { code, redirectUri } = await getAuthCode(challenge);
  const t = await postToken({
    code, client_id: creds.clientId, client_secret: creds.clientSecret,
    code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
  });
  if (!t.refresh_token) throw new Error('refresh token을 받지 못했습니다 (앱 권한을 해제 후 다시 시도하세요)');
  save({
    refresh_token: t.refresh_token,
    access_token: t.access_token,
    expiry: Date.now() + (t.expires_in - 60) * 1000,
  });
}

// Returns a valid access token, refreshing it if expired.
async function getAccessToken() {
  const d = load();
  if (!d.refresh_token) throw new Error('Google 로그인이 필요합니다');
  if (d.access_token && d.expiry && Date.now() < d.expiry) return d.access_token;
  const t = await postToken({
    client_id: creds.clientId, client_secret: creds.clientSecret,
    refresh_token: d.refresh_token, grant_type: 'refresh_token',
  });
  d.access_token = t.access_token;
  d.expiry = Date.now() + (t.expires_in - 60) * 1000;
  save(d);
  return d.access_token;
}

module.exports = { init, signIn, signOut, isConfigured, isSignedIn, getAccount, setAccount, getAccessToken };
