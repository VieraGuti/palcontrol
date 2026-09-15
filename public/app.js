const $ = (s) => document.querySelector(s);

let state = null;
let eventsConnected = false;
let mapPayload = { actors: [], layer: null };
let mapView = { scale: 1, x: 0, y: 0, fittedScale: 1 };
let mapDrag = null;
let mapArtworkReady = false;
let mapArtworkUrl = '';
let mapResizeFrame = 0;
let heatmapPositions = [];
const MAP_SCENE_SIZE = 8192;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Authentication required');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    showApp();
    await init();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

function fmtDuration(ms) {
  let s = Math.floor((ms || 0) / 1000);
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d ? `${d}d ` : ''}${h}h ${m}m`;
}
function ago(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderState(s) {
  state = s;
  const m = s.metrics || {};
  const serverName = s.info?.servername || 'Palworld Server';
  $('#serverName').textContent = serverName;
  $('#mapServerName').textContent = serverName;
  $('#playersStat').textContent = `${m.currentplayernum ?? s.players?.length ?? 0} / ${m.maxplayernum ?? '?'}`;
  $('#fpsStat').textContent = m.serverfps ?? '—';
  $('#uptimeStat').textContent = fmtDuration((m.uptime ?? 0) * 1000);
  $('#dayStat').textContent = m.days ?? '—';
  $('#connection').textContent = s.online ? '● Server online' : `● Offline${s.lastError ? ` — ${s.lastError}` : ''}`;
  $('#connection').className = `connection ${s.online ? 'online' : 'offline'}`;
  if ($('#providerMini')) $('#providerMini').textContent = s.provider?.type || '—';
  const players = s.players || [];
  $('#onlineBadge').textContent = players.length;
  $('#onlinePlayers').innerHTML = players.length
    ? players.map((x) => `<div class="row"><div class="row-main"><strong>${esc(x.name)}</strong><span class="muted">${esc(x.accountName || '')} · ${esc(x.userId || '')}</span></div><span>Lv.${x.level ?? '?'} · ${Math.round(x.ping ?? 0)}ms</span></div>`).join('')
    : '<p class="muted">Nobody online.</p>';

  renderMapMeta();
  if (location.hash === '#map') switchView('map');
}

async function init() {
  const s = await api('/api/state');
  renderState(s);
  connectEvents();
  loadPlayers();
  loadBackups();
  loadAudit();
  loadMap();
  loadSystem();
  loadGuilds();
  loadAdmin();
  loadEconomy();
}

function connectEvents() {
  if (eventsConnected) return;
  eventsConnected = true;
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => renderState(JSON.parse(e.data)));
  es.onerror = () => {
    $('#connection').textContent = '● Reconnecting…';
    $('#connection').className = 'connection offline';
  };
}

document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => switchView(b.dataset.view);
});

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.body.classList.toggle('map-active', name === 'map');
  location.hash = name === 'dashboard' ? '' : `#${name}`;
  if (name === 'map') {
    loadMap().finally(() => requestAnimationFrame(() => fitMap(true)));
  }
  if (name === 'players') loadPlayers();
  if (name === 'backups') loadBackups();
  if (name === 'guilds') loadGuilds();
  if (name === 'admin') loadAdmin();
  if (name === 'economy') loadEconomy();
  if (name === 'system') loadSystem();
  if (name === 'audit') loadAudit();
}

$('#announceBtn').onclick = async () => {
  try {
    await api('/api/announce', { method: 'POST', body: JSON.stringify({ message: $('#announceInput').value }) });
    $('#opMessage').textContent = 'Announcement sent.';
    $('#announceInput').value = '';
  } catch (e) {
    $('#opMessage').textContent = e.message;
  }
};
$('#saveBtn').onclick = async () => {
  await api('/api/save', { method: 'POST' });
  alert('World save requested successfully.');
};
$('#restartBtn').onclick = async () => {
  if (!confirm('Restart the hosted/local Palworld server now?')) return;
  try { await api('/api/provider/restart', { method: 'POST' }); alert('Restart requested.'); } catch (e) { alert(e.message); }
};
$('#shutdownBtn').onclick = async () => {
  if (!confirm('Shutdown Palworld in 30 seconds?')) return;
  await api('/api/shutdown', { method: 'POST', body: JSON.stringify({ waittime: 30, message: 'Server shutdown requested by administrator.' }) });
  alert('Shutdown scheduled.');
};

function formatPlayerDetails(d){
  const lines=[];const p=d.live;if(p)lines.push(`${p.name} · Lv.${p.level??'?'} · ${p.online?'Online':'Offline'}`,`Playtime: ${fmtDuration(p.playtimeMs)}`,`UserId: ${p.userId}`,`PlayerId: ${p.playerId||'—'}`);
  if(d.link)lines.push(`Discord link: ${d.link.discord_id||'—'} · ${d.link.platform||'platform unknown'}`);
  const pd=d.palDefender;if(pd){const player=pd.player?.ok?pd.player.data:null,items=pd.items?.ok?pd.items.data:null,pals=pd.pals?.ok?pd.pals.data:null;lines.push('',`PalDefender player: ${player?JSON.stringify(player).slice(0,800):pd.player?.error||'unavailable'}`,`Items: ${items?JSON.stringify(items).slice(0,800):pd.items?.error||'unavailable'}`,`Pals: ${pals?JSON.stringify(pals).slice(0,800):pd.pals?.error||'unavailable'}`);}
  if(d.save)lines.push('',`Save reader: ${JSON.stringify(d.save).slice(0,1600)}`);return lines.join('\n');
}

async function loadPlayers() {
  try {
    const d = await api('/api/players');
    $('#playersTable').innerHTML = d.players.map((p) => `<tr><td><span class="status-dot ${p.online ? 'on' : ''}"></span>${p.online ? 'Online' : 'Offline'}</td><td><strong>${esc(p.name)}</strong></td><td>${p.level ?? '—'}</td><td>${fmtDuration(p.playtimeMs)}</td><td>${ago(p.lastSeen)}</td><td><code>${esc(p.userId)}</code></td><td><div class="action-row">${p.online ? `<button class="ghost kick" data-id="${esc(p.userId)}">Kick</button>` : ''}<button class="ghost ban-player" data-id="${esc(p.userId)}">Ban</button><button class="ghost player-details" data-id="${esc(p.userId)}">Details</button><button class="ghost pd-message" data-id="${esc(p.userId)}">Message</button></div></td></tr>`).join('');
    document.querySelectorAll('.kick').forEach((b) => { b.onclick = async () => { if (confirm(`Kick ${b.dataset.id}?`)) await api('/api/kick', { method: 'POST', body: JSON.stringify({ userId: b.dataset.id }) }); }; });
    document.querySelectorAll('.ban-player').forEach((b) => { b.onclick = async () => { const reason=prompt(`Ban ${b.dataset.id}. Reason:`, 'Banned by an administrator.'); if(reason!==null) await api('/api/ban', { method: 'POST', body: JSON.stringify({ userId: b.dataset.id, message: reason }) }); }; });
    document.querySelectorAll('.pd-message').forEach((b) => { b.onclick = async () => { const message=prompt(`Message ${b.dataset.id}:`); if(message) try{await api('/api/paldefender/message',{method:'POST',body:JSON.stringify({userId:b.dataset.id,message,sendType:'PlayerChat'})});}catch(e){alert(e.message);} }; });
    document.querySelectorAll('.player-details').forEach((b)=>{b.onclick=async()=>{try{const d=await api(`/api/player-detail?uid=${encodeURIComponent(b.dataset.id)}`);alert(formatPlayerDetails(d));}catch(e){alert(e.message);}};});
  } catch {}
}
$('#refreshPlayers').onclick = loadPlayers;

async function loadBackups() {
  try {
    const d = await api('/api/backups');
    $('#backupBtn').disabled = !d.enabled;
    $('#backupList').innerHTML = !d.enabled
      ? '<p class="muted">Configure a local save path or a hosted remote save source to enable backups.</p>'
      : d.items.length
        ? d.items.map((b) => `<div class="row"><div><strong>${esc(b.name)}</strong><div class="muted">${new Date(b.createdAt).toLocaleString()}</div></div>${d.restoreEnabled ? `<button class="ghost restore-backup" data-name="${esc(b.name)}">Restore</button>` : ''}</div>`).join('')
        : '<p class="muted">No backups yet.</p>';
    document.querySelectorAll('.restore-backup').forEach((b) => b.onclick = async () => {
      if (!confirm(`Restore ${b.dataset.name}? The server will be stopped/restarted when the provider supports it.`)) return;
      try { await api(`/api/backups/${encodeURIComponent(b.dataset.name)}/restore`, { method: 'POST' }); alert('Restore completed and restart requested.'); } catch (e) { alert(e.message); }
    });
  } catch {}
}
$('#backupBtn').onclick = async () => {
  const b = await api('/api/backups', { method: 'POST' });
  alert(`Backup created: ${b.name}`);
  loadBackups();
};


async function loadGuilds() {
  const target = $('#guildList');
  if (!target) return;
  target.innerHTML = '<p class="muted">Loading guilds…</p>';
  try {
    const doc = await api('/api/guilds');
    const guilds = doc.guilds || [];
    target.innerHTML = guilds.length ? guilds.map((g) => `<article class="guild-card"><div class="card-title"><div><strong>${esc(g.name || 'Unnamed Guild')}</strong><div class="muted">${esc(g.groupId || '')}</div></div><span class="badge">${g.members?.length ?? g.counts?.players ?? 0} players</span></div><div class="guild-metrics"><span><b>${g.bases?.length ?? g.counts?.bases ?? 0}</b>Bases</span><span><b>${g.counts?.workers ?? 0}</b>Workers</span><span><b>${g.baseCampLevel ?? '—'}</b>Base Lv.</span></div><div class="muted">${(g.members || []).slice(0,8).map(m => esc(m.name || m.playerUId)).join(' · ')}</div></article>`).join('') : '<p class="muted">No guilds found in the current save.</p>';
  } catch (e) { target.innerHTML = `<p class="muted">Guild data unavailable: ${esc(e.message)}</p>`; }
}
$('#refreshGuilds').onclick = loadGuilds;

async function loadAdmin() {
  if (!$('#palDefenderStatus')) return;
  try {
    const pd = await api('/api/paldefender');
    $('#palDefenderStatus').innerHTML = [
      diagRow('Configured', pd.enabled ? 'Yes' : 'No', pd.enabled),
      diagRow('API', pd.enabled ? (pd.ready ? 'Ready' : (pd.error || 'Unavailable')) : 'Disabled', pd.enabled ? pd.ready : null),
      diagRow('Version', pd.version ? JSON.stringify(pd.version).slice(0,220) : '—')
    ].join('');
  } catch (e) { $('#palDefenderStatus').innerHTML = diagRow('PalDefender', e.message, false); }
  try { const w=await api('/api/whitelist'); $('#whitelistOutput').textContent=w.raw || JSON.stringify(w.status,null,2); } catch(e) { $('#whitelistOutput').textContent=e.message; }
  await loadBanlist();
}
async function loadBanlist(){if(!$('#banlistOutput'))return;try{$('#banlistOutput').textContent=JSON.stringify(await api('/api/paldefender/banlist'),null,2);}catch(e){$('#banlistOutput').textContent=e.message;}}
$('#refreshAdmin').onclick=loadAdmin; $('#refreshBanlist').onclick=loadBanlist;
$('#pdBroadcastBtn').onclick=async()=>{const message=$('#pdBroadcastInput').value.trim();if(!message)return;try{await api('/api/paldefender/broadcast',{method:'POST',body:JSON.stringify({message})});$('#pdBroadcastInput').value='';alert('Chat broadcast sent.');}catch(e){alert(e.message);}};
$('#whitelistAddBtn').onclick=async()=>{const userId=$('#whitelistUser').value.trim();if(!userId)return;try{await api('/api/whitelist/add',{method:'POST',body:JSON.stringify({userId})});await loadAdmin();}catch(e){alert(e.message);}};
$('#whitelistRemoveBtn').onclick=async()=>{const userId=$('#whitelistUser').value.trim();if(!userId)return;if(!confirm(`Remove ${userId} from whitelist?`))return;try{await api('/api/whitelist/remove',{method:'POST',body:JSON.stringify({userId})});await loadAdmin();}catch(e){alert(e.message);}};

async function loadEconomy(){
  if(!$('#shopStatus'))return;
  try{const shop=await api('/api/shop');$('#shopStatus').innerHTML=[diagRow('Shop',shop.enabled?'Enabled':'Disabled',shop.enabled),diagRow('Delivery',shop.deliveryReady?'Transport configured':'Unavailable',shop.deliveryReady),diagRow('Playtime reward',shop.playtimeCoinsPerHour?`${shop.playtimeCoinsPerHour} points/hour`:'Disabled')].join('');const products=shop.products||[],kits=shop.kits||[];$('#shopCatalog').innerHTML=products.length||kits.length?[...products.map(p=>`<div class="shop-card" data-shop-id="${esc(p.id)}"><strong>[${esc(p.category||'General')}] ${esc(p.name)}</strong><span>${p.price} points</span><p>${esc(p.description||'')}</p><small>${esc(p.type)} · ${p.items?.map(x=>`${x.Count} × ${x.ItemID}`).join(', ')||''}</small><button class="ghost catalog-load" data-kind="product" data-id="${esc(p.id)}">Edit</button></div>`),...kits.map(k=>`<div class="shop-card" data-shop-id="kit:${esc(k.id)}"><strong>Kit: ${esc(k.name)}</strong><span>!kit ${esc(k.id)}</span><p>${esc(k.description||'')}</p><small>${k.role?`Role: ${esc(k.role)} · `:''}Cooldown: ${Math.round(k.cooldownMs/3600000)}h</small><button class="ghost catalog-load" data-kind="kit" data-id="${esc(k.id)}">Edit</button></div>`)].join(''):'<p class="muted">No products or kits configured in the catalog.</p>';setupCatalogEditor(shop);}catch(e){$('#shopStatus').innerHTML=diagRow('Shop',e.message,false);}
  try{const d=await api('/api/shop/purchases?limit=100');$('#purchaseTable').innerHTML=(d.items||[]).map(p=>`<tr><td>${p.id}</td><td><code>${esc(p.discord_id)}</code></td><td>${esc(p.product_id)}</td><td>${p.price}</td><td><span class="purchase-status ${esc(p.status)}">${esc(p.status)}</span></td><td>${new Date(p.ts).toLocaleString()}</td></tr>`).join('');}catch{}
}
function setupCatalogEditor(shop){
  let tools=$('#shopTools');
  if(!tools){tools=document.createElement('div');tools.id='shopTools';tools.className='inline';tools.innerHTML='<input id="shopSearch" placeholder="Search products and kits"><button id="shopFavorites" class="ghost">Favorites only</button>';$('#shopCatalog').before(tools);}
  const favorites=new Set(JSON.parse(localStorage.getItem('palcontrol.shopFavorites')||'[]'));
  document.querySelectorAll('#shopCatalog .shop-card').forEach(card=>{const id=card.dataset.shopId;if(!id)return;let star=card.querySelector('.favorite-shop');if(!star){star=document.createElement('button');star.className='ghost favorite-shop';star.textContent=favorites.has(id)?'★':'☆';card.append(star);}star.onclick=()=>{if(favorites.has(id))favorites.delete(id);else favorites.add(id);localStorage.setItem('palcontrol.shopFavorites',JSON.stringify([...favorites]));star.textContent=favorites.has(id)?'★':'☆';};});
  $('#shopSearch').oninput=()=>{const query=$('#shopSearch').value.toLowerCase();document.querySelectorAll('#shopCatalog .shop-card').forEach(card=>{card.hidden=!card.textContent.toLowerCase().includes(query);});};
  $('#shopFavorites').onclick=()=>{const showing=$('#shopFavorites').dataset.active==='1';$('#shopFavorites').dataset.active=showing?'0':'1';$('#shopFavorites').textContent=showing?'Favorites only':'All products';document.querySelectorAll('#shopCatalog .shop-card').forEach(card=>{card.hidden=!showing&&!favorites.has(card.dataset.shopId);});};
  let editor=$('#catalogEditor');
  if(!editor){editor=document.createElement('div');editor.id='catalogEditor';editor.className='card spaced';editor.innerHTML='<h3>Catalog editor</h3><p class="muted">Edit products and kits using validated JSON. Item IDs must exist in Palworld.</p><textarea id="catalogJson" rows="10" placeholder="Product or kit JSON"></textarea><div class="inline"><button id="saveProductBtn">Save product</button><button id="saveKitBtn">Save kit</button><button id="deleteProductBtn" class="danger ghost">Delete product</button><button id="deleteKitBtn" class="danger ghost">Delete kit</button></div><div id="catalogResult" class="muted"></div>';$('#view-economy').append(editor);}
  editor.querySelectorAll('.catalog-load').forEach(()=>{});
  document.querySelectorAll('.catalog-load').forEach(button=>button.onclick=()=>{const list=button.dataset.kind==='product'?shop.products:shop.kits;const value=list.find(entry=>entry.id===button.dataset.id);$('#catalogJson').value=JSON.stringify(value,null,2);});
  const save=async(kind)=>{try{const value=JSON.parse($('#catalogJson').value);const out=await api(`/api/shop/${kind==='product'?'products':'kits'}`,{method:'PUT',body:JSON.stringify(value)});$('#catalogResult').textContent=`Saved ${kind} ${value.id}.`;await loadEconomy();}catch(error){$('#catalogResult').textContent=error.message;}};
  const remove=async(kind)=>{try{const value=JSON.parse($('#catalogJson').value);if(!confirm(`Delete ${kind} ${value.id}?`))return;await api(`/api/shop/${kind==='product'?'products':'kits'}/${encodeURIComponent(value.id)}`,{method:'DELETE'});$('#catalogResult').textContent=`Deleted ${kind} ${value.id}.`;$('#catalogJson').value='';await loadEconomy();}catch(error){$('#catalogResult').textContent=error.message;}};
  $('#saveProductBtn').onclick=()=>save('product');$('#saveKitBtn').onclick=()=>save('kit');$('#deleteProductBtn').onclick=()=>remove('product');$('#deleteKitBtn').onclick=()=>remove('kit');
}
$('#refreshEconomy').onclick=loadEconomy;
async function adjustWallet(mode){const discordId=$('#walletDiscordId').value.trim(),amount=Number($('#walletAmount').value),reason=$('#walletReason').value.trim();if(!discordId||!Number.isInteger(amount)||amount<=0){$('#walletResult').textContent='Enter a Discord ID and positive integer amount.';return;}try{const out=await api(`/api/shop/${mode}`,{method:'POST',body:JSON.stringify({discordId,amount,reason})});$('#walletResult').textContent=`Balance: ${out.balance} coins`;await loadEconomy();}catch(e){$('#walletResult').textContent=e.message;}}
$('#walletCreditBtn').onclick=()=>adjustWallet('credit'); $('#walletDebitBtn').onclick=()=>adjustWallet('debit');

function diagRow(label, value, ok = null) {
  return `<div class="diag-row"><span>${esc(label)}</span><strong class="${ok === true ? 'good' : ok === false ? 'bad' : ''}">${esc(value)}</strong></div>`;
}
async function loadSystem() {
  if (!$('#diagnostics')) return;
  try {
    const d = await api('/api/diagnostics');
    $('#saveReaderMini').textContent = d.saveReader?.ready ? 'Ready' : 'Unavailable';
    const caps = d.provider?.capabilities || {};
    $('#diagnostics').innerHTML = [
      diagRow('Palworld REST', d.palworld.online ? 'Online' : (d.palworld.error || 'Offline'), d.palworld.online),
      diagRow('Provider', d.provider?.provider || 'unknown'),
      diagRow('Provider restart', caps.restart ? 'Supported' : 'Unsupported', caps.restart),
      diagRow('Save source', d.saveSource?.enabled ? (d.saveSource.remote ? 'Remote synced' : 'Local') : 'Disabled', d.saveSource?.enabled),
      diagRow('Save reader', d.saveReader?.ready ? d.saveReader.version || 'Ready' : d.saveReader?.reason || d.saveReader?.error || 'Unavailable', d.saveReader?.ready),
      diagRow('PalDefender REST', d.palDefender?.enabled ? (d.palDefender.ready ? 'Ready' : d.palDefender.error || 'Unavailable') : 'Disabled', d.palDefender?.enabled ? d.palDefender.ready : null),
      diagRow('Whitelist', d.whitelist?.enabled ? 'Ready (RCON compatibility)' : (d.whitelist?.configured ? 'Configured / unavailable' : 'Disabled'), d.whitelist?.configured ? d.whitelist?.enabled : null),
      diagRow('Shop delivery', d.shop?.enabled ? (d.shop.deliveryReady ? `Ready · ${d.shop.products} product(s)` : 'Enabled / delivery unavailable') : 'Disabled', d.shop?.enabled ? d.shop.deliveryReady : null),
      diagRow('Backups', d.backups?.enabled ? 'Enabled' : 'Disabled', d.backups?.enabled),
      diagRow('Discord', d.discord?.enabled ? 'Connected/configured' : 'Disabled', d.discord?.enabled),
      diagRow('Watchdog', d.watchdog?.enabled ? 'Enabled' : 'Disabled', d.watchdog?.enabled)
    ].join('');
    const settings = d.palworld.settings || {};
    $('#settingsList').innerHTML = settings.error ? `<p class="muted">${esc(settings.error)}</p>` : [
      diagRow('REST API', String(settings.RESTAPIEnabled ?? '—')),
      diagRow('REST port', String(settings.RESTAPIPort ?? '—')),
      diagRow('RCON', `${settings.RCONEnabled ?? '—'}${settings.RCONPort ? ` · ${settings.RCONPort}` : ''}`),
      diagRow('PvP', String(settings.bIsPvP ?? '—')),
      diagRow('Player max', String(settings.ServerPlayerMaxNum ?? '—')),
      diagRow('Platform', String(settings.AllowConnectPlatform ?? '—'))
    ].join('');
    const metrics=await api('/api/metrics?limit=48');let metricsPanel=$('#metricsPanel');
    if(!metricsPanel){metricsPanel=document.createElement('article');metricsPanel.id='metricsPanel';metricsPanel.className='card spaced';$('#view-system').append(metricsPanel);}
    const summary=metrics.summary||{};metricsPanel.innerHTML=`<div class="card-title"><h3>Runtime history</h3><button id="refreshMetrics" class="ghost">Refresh</button></div><div class="stats"><article><span>Peak players</span><strong>${esc(summary.peakPlayers??0)}</strong></article><article><span>Average FPS</span><strong>${Number(summary.averageFps??0).toFixed(1)}</strong></article><article><span>Minimum FPS</span><strong>${Number(summary.minimumFps??0).toFixed(1)}</strong></article><article><span>Samples</span><strong>${esc(summary.samples??0)}</strong></article></div><div class="rows">${(metrics.samples||[]).slice(0,12).map(sample=>`<div class="row"><div class="row-main"><strong>${new Date(sample.ts).toLocaleString()}</strong><span class="muted">FPS ${sample.server_fps??'—'} · uptime ${sample.uptime??'—'}s</span></div><span>${sample.current_players??0}/${sample.max_players??'?'}</span></div>`).join('')}</div>`;$('#refreshMetrics').onclick=loadSystem;
    $('#restartBtn').disabled = !caps.restart;
    $('#restartBtn').title = caps.restart ? '' : 'The configured hosting provider does not expose a restart action to PalControl.';
    await loadSchedules();
  } catch (e) { $('#diagnostics').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
$('#refreshSystem').onclick = loadSystem;

async function loadSchedules(){
  const view=$('#view-system');if(!view)return;
  let panel=$('#schedulePanel');
  if(!panel){panel=document.createElement('article');panel.id='schedulePanel';panel.className='card spaced';view.append(panel);}
  try{
    const data=await api('/api/schedule');
    const items=data.items||[];
    panel.innerHTML=`<div class="card-title"><div><h3>Scheduled messages</h3><p class="muted">Create, edit, pause or remove recurring server announcements.</p></div><button id="newScheduleBtn" class="ghost">New</button></div><div id="scheduleRows" class="rows">${items.length?items.map(item=>`<div class="row schedule-row"><div class="row-main"><strong>${esc(item.message)}</strong><span class="muted">Every ${item.interval_minutes} minutes · next ${item.next_run_at?new Date(item.next_run_at).toLocaleString():'—'}${item.error?` · Error: ${esc(item.error)}`:''}</span></div><button class="ghost schedule-edit" data-id="${item.id}">Edit</button><button class="ghost schedule-toggle" data-id="${item.id}" data-enabled="${item.enabled}">${item.enabled?'Pause':'Enable'}</button><button class="danger ghost schedule-delete" data-id="${item.id}">Delete</button></div>`).join(''):'<p class="muted">No scheduled messages.</p>'}</div><div id="scheduleEditor" class="hidden"><textarea id="scheduleMessage" rows="3" placeholder="Message to repeat"></textarea><input id="scheduleMinutes" type="number" min="5" max="10080" value="15" placeholder="Minutes"><input id="scheduleId" type="hidden"><div class="inline"><button id="scheduleSaveBtn">Save</button><button id="scheduleCancelBtn" class="ghost">Cancel</button></div><div id="scheduleResult" class="muted"></div></div>`;
    $('#newScheduleBtn').onclick=()=>{ $('#scheduleId').value='';$('#scheduleMessage').value='';$('#scheduleMinutes').value='15';$('#scheduleEditor').classList.remove('hidden'); };
    $('#scheduleCancelBtn').onclick=()=>$('#scheduleEditor').classList.add('hidden');
    document.querySelectorAll('.schedule-edit').forEach(btn=>btn.onclick=()=>{const item=items.find(x=>String(x.id)===btn.dataset.id);$('#scheduleId').value=item.id;$('#scheduleMessage').value=item.message;$('#scheduleMinutes').value=item.interval_minutes;$('#scheduleEditor').classList.remove('hidden');});
    document.querySelectorAll('.schedule-toggle').forEach(btn=>btn.onclick=async()=>{await api(`/api/schedule/${btn.dataset.id}`,{method:'PUT',body:JSON.stringify({enabled:btn.dataset.enabled!=='1'})});await loadSchedules();});
    document.querySelectorAll('.schedule-delete').forEach(btn=>btn.onclick=async()=>{if(confirm('Delete this scheduled message?')){await api(`/api/schedule/${btn.dataset.id}`,{method:'DELETE'});await loadSchedules();}});
    $('#scheduleSaveBtn').onclick=async()=>{const id=$('#scheduleId').value,message=$('#scheduleMessage').value.trim(),intervalMinutes=Number($('#scheduleMinutes').value);try{const options={method:id?'PUT':'POST',body:JSON.stringify({message,intervalMinutes})};await api(id?`/api/schedule/${id}`:'/api/schedule',options);$('#scheduleResult').textContent='Saved.';await loadSchedules();}catch(error){$('#scheduleResult').textContent=error.message;}};
  }catch(error){panel.innerHTML=`<p class="muted">${esc(error.message)}</p>`;}
}

async function loadAudit() {
  try {
    const d = await api('/api/audit?limit=100');
    $('#auditList').innerHTML = d.items.map((a) => `<div class="row"><div class="row-main"><strong>${esc(a.action)}</strong><span class="muted">${esc(a.actor)}${a.target ? ` → ${esc(a.target)}` : ''}</span></div><span class="muted">${new Date(a.ts).toLocaleString()}</span></div>`).join('') || '<p class="muted">No audit entries.</p>';
  } catch {}
}
$('#refreshAudit').onclick = loadAudit;

function actorKind(a) {
  const type = String(a.type || '').trim().toLowerCase();
  const unit = String(a.unitType || '').trim().toLowerCase();
  if (type === 'palbox') return 'bases';
  if (unit === 'player') return 'players';
  if (unit === 'basecamppal') return 'workers';
  if (unit === 'otomopal') return 'companions';
  if (unit === 'wildpal') return 'wild-pals';
  if (type === 'character') return 'npcs';
  return 'npcs';
}

function actorName(a, kind) {
  if (kind === 'players') return a.nickName || a.userId || 'Player';
  if (kind === 'bases') return a.guildName || 'Palbox';
  if (kind === 'companions') return a.nickName || a.class || 'Companion Pal';
  if (kind === 'workers') return a.nickName || a.class || 'Base worker';
  if (kind === 'wild-pals') return a.nickName || a.class || 'Wild Pal';
  return a.nickName || a.class || a.unitType || 'NPC';
}

function activeMapKinds() {
  return new Set([...document.querySelectorAll('[data-map-kind]')].filter((el) => el.checked).map((el) => el.dataset.mapKind));
}

function mapSearchText(a, kind) {
  return `${actorName(a, kind)} ${a.guildName || ''} ${a.userId || ''} ${a.class || ''} ${a.level ?? ''}`.toLowerCase();
}

function validMapActors() {
  const enabled = activeMapKinds();
  const query = ($('#mapSearch').value || '').trim().toLowerCase();
  return (mapPayload.actors || []).filter((a) => {
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return false;
    const kind = actorKind(a);
    return enabled.has(kind) && (!query || mapSearchText(a, kind).includes(query));
  });
}

function updateMapCounts() {
  const counts = { players: 0, companions: 0, workers: 0, 'wild-pals': 0, npcs: 0, bases: 0 };
  for (const a of mapPayload.actors || []) {
    const k = actorKind(a);
    if (k in counts) counts[k]++;
  }
  $('#countPlayers').textContent = counts.players;
  $('#countCompanions').textContent = counts.companions;
  $('#countWorkers').textContent = counts.workers;
  $('#countWild').textContent = counts['wild-pals'];
  $('#countNpcs').textContent = counts.npcs;
  $('#countBases').textContent = counts.bases;
  $('#mapActorCount').textContent = (mapPayload.actors || []).length;
}

async function loadMap() {
  try {
    const d = await api('/api/map');
    mapPayload = { actors: d.actors || [], layer: d.layer || null, fps: d.fps, time: d.time };
    if ($('#heatmapToggle')?.checked) loadHeatmap();
    updateMapCounts();
    loadMapArtwork();
    renderMapMarkers();
    renderMapMeta();
  } catch (err) {
    $('#mapMeta').textContent = `Map API error · ${err.message}`;
  }
}

function loadMapArtwork() {
  const img = $('#mapArtwork');
  const url = mapPayload.layer?.imageUrl;
  if (!url) return;
  if (mapArtworkUrl === url && mapArtworkReady) return;
  mapArtworkUrl = url;
  mapArtworkReady = false;
  $('#mapArtworkError').classList.add('hidden');
  img.onload = () => {
    mapArtworkReady = true;
    $('#mapArtworkError').classList.add('hidden');
    requestAnimationFrame(() => fitMap(true));
  };
  img.onerror = () => {
    mapArtworkReady = false;
    $('#mapArtworkError').classList.remove('hidden');
  };
  img.src = url;
}

function renderMapMeta() {
  if (!$('#mapMeta')) return;
  const fps = mapPayload.fps ?? state?.metrics?.serverfps;
  const online = state?.online;
  const total = mapPayload.actors?.length || 0;
  $('#mapMeta').textContent = `${online ? 'Live' : 'Server offline'} · ${total} actors${fps != null ? ` · ${fps} FPS` : ''}`;
  const hint = $('#mapOfflineHint');
  if (!online && state?.lastError) {
    hint.textContent = `Live data unavailable: ${state.lastError}. The Palpagos map itself still works.`;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

function mapBounds() {
  const b = mapPayload.layer?.bounds;
  return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) ? b : [349400, 724400, -1099400, -724400];
}

function worldToScene(x, y) {
  const [maxX, maxY, minX, minY] = mapBounds();
  if (x < minX || x > maxX || y < minY || y > maxY) return null;
  return {
    x: ((y - minY) / (maxY - minY)) * MAP_SCENE_SIZE,
    y: ((maxX - x) / (maxX - minX)) * MAP_SCENE_SIZE
  };
}

function sceneToWorld(x, y) {
  const [maxX, maxY, minX, minY] = mapBounds();
  return {
    x: maxX - (y / MAP_SCENE_SIZE) * (maxX - minX),
    y: minY + (x / MAP_SCENE_SIZE) * (maxY - minY)
  };
}

function gameCoords(world) {
  return {
    x: Math.round((world.y - 158000) / 459),
    y: Math.round((world.x + 123888) / 459)
  };
}

function clampMapView() {
  const vp = $('#mapViewport').getBoundingClientRect();
  const scaled = MAP_SCENE_SIZE * mapView.scale;
  if (scaled <= vp.width) mapView.x = (vp.width - scaled) / 2;
  else mapView.x = Math.min(0, Math.max(vp.width - scaled, mapView.x));
  if (scaled <= vp.height) mapView.y = (vp.height - scaled) / 2;
  else mapView.y = Math.min(0, Math.max(vp.height - scaled, mapView.y));
}

function applyMapView() {
  clampMapView();
  $('#mapScene').style.transform = `translate3d(${mapView.x}px,${mapView.y}px,0) scale(${mapView.scale})`;
  renderMapMarkers();
  drawHeatmap();
}

function fitMap(force = false) {
  const vp = $('#mapViewport');
  if (!vp || vp.classList.contains('hidden')) return;
  const rect = vp.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const padding = 28;
  const scale = Math.max(0.01, Math.min((rect.width - padding * 2) / MAP_SCENE_SIZE, (rect.height - padding * 2) / MAP_SCENE_SIZE));
  if (force || !mapView.fittedScale) {
    mapView.fittedScale = scale;
    mapView.scale = scale;
    mapView.x = (rect.width - MAP_SCENE_SIZE * scale) / 2;
    mapView.y = (rect.height - MAP_SCENE_SIZE * scale) / 2;
    applyMapView();
  } else {
    mapView.fittedScale = scale;
  }
  drawHeatmap();
}

function zoomMap(factor, cx, cy) {
  const vp = $('#mapViewport').getBoundingClientRect();
  const px = cx ?? vp.width / 2;
  const py = cy ?? vp.height / 2;
  const old = mapView.scale;
  const min = Math.max(mapView.fittedScale * 0.8, 0.01);
  const max = Math.max(mapView.fittedScale * 28, min * 2);
  const next = Math.max(min, Math.min(max, old * factor));
  if (next === old) return;
  const sx = (px - mapView.x) / old;
  const sy = (py - mapView.y) / old;
  mapView.scale = next;
  mapView.x = px - sx * next;
  mapView.y = py - sy * next;
  applyMapView();
}


async function loadHeatmap() {
  if (!$('#heatmapToggle')?.checked) { heatmapPositions = []; drawHeatmap(); return; }
  try { const d = await api(`/api/heatmap?hours=${Number($('#heatmapHours').value || 24)}`); heatmapPositions = d.positions || []; drawHeatmap(); }
  catch { heatmapPositions = []; drawHeatmap(); }
}
function drawHeatmap() {
  const canvas = $('#mapHeatmap'); if (!canvas) return;
  const vp = $('#mapViewport').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(vp.width*dpr) || canvas.height !== Math.round(vp.height*dpr)) { canvas.width=Math.round(vp.width*dpr); canvas.height=Math.round(vp.height*dpr); canvas.style.width=`${vp.width}px`; canvas.style.height=`${vp.height}px`; }
  const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,vp.width,vp.height);
  if (!$('#heatmapToggle')?.checked || !heatmapPositions.length) return;
  ctx.globalCompositeOperation='lighter';
  for (const p of heatmapPositions) {
    const scene=worldToScene(Number(p.x),Number(p.y)); if(!scene) continue;
    const x=mapView.x+scene.x*mapView.scale, y=mapView.y+scene.y*mapView.scale;
    if(x<-70||y<-70||x>vp.width+70||y>vp.height+70)continue;
    const r=Math.max(18,Math.min(46,26*(mapView.scale/Math.max(mapView.fittedScale,0.001))**0.15));
    const g=ctx.createRadialGradient(x,y,0,x,y,r); g.addColorStop(0,'rgba(255,80,40,.14)');g.addColorStop(.45,'rgba(255,130,20,.07)');g.addColorStop(1,'rgba(255,180,0,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
  }
  ctx.globalCompositeOperation='source-over';
}
function markerClass(kind) {
  return `map-marker marker-${kind}`;
}

function renderMapMarkers() {
  const layer = $('#mapMarkers');
  const vp = $('#mapViewport');
  if (!layer || !vp) return;
  const rect = vp.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const frag = document.createDocumentFragment();
  for (const a of validMapActors()) {
    const scene = worldToScene(a.x, a.y);
    if (!scene) continue;
    const x = mapView.x + scene.x * mapView.scale;
    const y = mapView.y + scene.y * mapView.scale;
    if (x < -80 || y < -80 || x > rect.width + 80 || y > rect.height + 80) continue;
    const kind = actorKind(a);
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = markerClass(kind);
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
    marker.dataset.kind = kind;
    marker.dataset.x = a.x;
    marker.dataset.y = a.y;
    marker.dataset.name = actorName(a, kind);
    marker.dataset.guild = a.guildName || '';
    marker.dataset.level = a.level ?? '';
    marker.setAttribute('aria-label', marker.dataset.name);
    marker.innerHTML = kind === 'bases' ? '<span class="base-glyph">◆</span>' : `<span class="marker-core"></span>${kind === 'players' ? `<span class="marker-label">${esc(marker.dataset.name)}</span>` : ''}`;
    marker.addEventListener('mouseenter', showMarkerTooltip);
    marker.addEventListener('mousemove', moveMarkerTooltip);
    marker.addEventListener('mouseleave', hideMapTooltip);
    marker.addEventListener('focus', showMarkerTooltip);
    marker.addEventListener('blur', hideMapTooltip);
    frag.appendChild(marker);
  }
  layer.replaceChildren(frag);
}

function showMarkerTooltip(e) {
  const el = e.currentTarget;
  const kind = el.dataset.kind;
  const world = { x: Number(el.dataset.x), y: Number(el.dataset.y) };
  const game = gameCoords(world);
  const t = $('#mapTooltip');
  t.innerHTML = `<div class="tooltip-kind">${esc(kind.replace('-', ' '))}</div><strong>${esc(el.dataset.name)}</strong>${el.dataset.guild ? `<span>${esc(el.dataset.guild)}</span>` : ''}${el.dataset.level ? `<span>Level ${esc(el.dataset.level)}</span>` : ''}<span>X ${game.x} · Y ${game.y}</span>`;
  t.classList.remove('hidden');
  moveMarkerTooltip(e);
}
function moveMarkerTooltip(e) {
  const t = $('#mapTooltip');
  const vp = $('#mapViewport').getBoundingClientRect();
  const clientX = e.clientX || e.currentTarget.getBoundingClientRect().left;
  const clientY = e.clientY || e.currentTarget.getBoundingClientRect().top;
  t.style.left = `${Math.min(vp.width - 230, Math.max(12, clientX - vp.left + 16))}px`;
  t.style.top = `${Math.min(vp.height - 130, Math.max(12, clientY - vp.top + 16))}px`;
}
function hideMapTooltip() { $('#mapTooltip').classList.add('hidden'); }

const mapViewport = $('#mapViewport');
mapViewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.map-panel,.map-head,.map-zoom-controls,.map-marker,.map-coordinates')) return;
  mapDrag = { id: e.pointerId, clientX: e.clientX, clientY: e.clientY, x: mapView.x, y: mapView.y };
  mapViewport.setPointerCapture(e.pointerId);
  mapViewport.classList.add('is-dragging');
});
mapViewport.addEventListener('pointermove', (e) => {
  const rect = mapViewport.getBoundingClientRect();
  const sx = (e.clientX - rect.left - mapView.x) / mapView.scale;
  const sy = (e.clientY - rect.top - mapView.y) / mapView.scale;
  if (sx >= 0 && sy >= 0 && sx <= MAP_SCENE_SIZE && sy <= MAP_SCENE_SIZE) {
    const g = gameCoords(sceneToWorld(sx, sy));
    $('#mapCoords').textContent = `X ${g.x}  Y ${g.y}`;
  } else {
    $('#mapCoords').textContent = 'X —  Y —';
  }
  if (!mapDrag || mapDrag.id !== e.pointerId) return;
  mapView.x = mapDrag.x + (e.clientX - mapDrag.clientX);
  mapView.y = mapDrag.y + (e.clientY - mapDrag.clientY);
  applyMapView();
});
function endMapDrag(e) {
  if (!mapDrag || mapDrag.id !== e.pointerId) return;
  mapDrag = null;
  mapViewport.classList.remove('is-dragging');
  try { mapViewport.releasePointerCapture(e.pointerId); } catch {}
}
mapViewport.addEventListener('pointerup', endMapDrag);
mapViewport.addEventListener('pointercancel', endMapDrag);
mapViewport.addEventListener('pointerleave', () => { if (!mapDrag) $('#mapCoords').textContent = 'X —  Y —'; });
mapViewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = mapViewport.getBoundingClientRect();
  zoomMap(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

$('#mapZoomIn').onclick = () => zoomMap(1.25);
$('#mapZoomOut').onclick = () => zoomMap(0.8);
$('#mapCenterBtn').onclick = () => fitMap(true);
$('#mapFitBtn').onclick = () => fitMap(true);
$('#mapSearch').addEventListener('input', renderMapMarkers);
document.querySelectorAll('[data-map-kind]').forEach((el) => el.addEventListener('change', renderMapMarkers));
$('#heatmapToggle').addEventListener('change', loadHeatmap);
$('#heatmapHours').addEventListener('change', loadHeatmap);
window.addEventListener('resize', () => {
  cancelAnimationFrame(mapResizeFrame);
  mapResizeFrame = requestAnimationFrame(() => fitMap(true));
});

const initialView = location.hash.replace('#', '') || 'dashboard';
fetch('/api/state')
  .then((r) => {
    if (r.ok) {
      showApp();
      init().then(() => switchView(['dashboard', 'map', 'players', 'guilds', 'backups', 'admin', 'economy', 'system', 'audit'].includes(initialView) ? initialView : 'dashboard'));
    } else showLogin();
  })
  .catch(showLogin);
