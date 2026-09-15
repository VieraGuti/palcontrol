import crypto from 'node:crypto';

function b64url(s) { return Buffer.from(s).toString('base64url'); }
function timingSafeEqualString(a,b) { const aa=Buffer.from(a), bb=Buffer.from(b); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }

export class SessionAuth {
  constructor({ password, secret, ttlMs = 12*60*60*1000 }) { this.password=password; this.secret=secret; this.ttlMs=ttlMs; }
  login(password) { if (!timingSafeEqualString(String(password),String(this.password))) return null; return this.sign({exp:Date.now()+this.ttlMs}); }
  sign(data) { const payload=b64url(JSON.stringify(data)); const sig=crypto.createHmac('sha256',this.secret).update(payload).digest('base64url'); return `${payload}.${sig}`; }
  verify(token) { try { const [p,s]=String(token??'').split('.'); if(!p||!s) return false; const expected=crypto.createHmac('sha256',this.secret).update(p).digest('base64url'); if(!timingSafeEqualString(s,expected)) return false; const d=JSON.parse(Buffer.from(p,'base64url').toString('utf8')); return Number(d.exp)>Date.now(); } catch { return false; } }
  cookie(token) { return `palcontrol_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.ttlMs/1000)}`; }
}

export function parseCookies(header='') { return Object.fromEntries(header.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('='); return [v.slice(0,i),decodeURIComponent(v.slice(i+1))];})); }
