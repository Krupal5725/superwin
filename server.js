const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_DIR = path.join(__dirname, 'db');
const ROUND_DURATION = 30;
const BET_LOCK_SEC = 5;
const REFERRAL_BONUS = 20;

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

function readDB(name) {
    const fp = path.join(DB_DIR, name + '.json');
    try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null; }
    catch (e) { console.error('ReadDB:', name, e.message); return null; }
}
function writeDB(name, data) {
    const fp = path.join(DB_DIR, name + '.json');
    try { fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8'); return true; }
    catch (e) { console.error('WriteDB:', name, e.message); return false; }
}

function getColorsForNumber(num) {
    if (num === 0) return ['red', 'violet'];
    if (num === 5) return ['green', 'violet'];
    return num % 2 === 0 ? ['red'] : ['green'];
}
function getPayoutRatio(target) {
    if (target === 'green' || target === 'red') return 2.0;
    if (target === 'violet') return 4.5;
    return 9.0;
}
function getTodayDateString() {
    const d = new Date();
    return d.getFullYear().toString() +
        (d.getMonth() + 1).toString().padStart(2, '0') +
        d.getDate().toString().padStart(2, '0');
}
function advancePeriodNumber(periodStr) {
    const m = periodStr.match(/\d+$/);
    if (!m) return (parseInt(periodStr, 10) + 1).toString();
    const num = m[0];
    const prefix = periodStr.slice(0, periodStr.length - num.length);
    return prefix + (parseInt(num, 10) + 1).toString().padStart(num.length, '0');
}
function genReferralCode(existingUsers) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = 'REF' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while ((existingUsers || []).some(u => u.referralCode === code));
    return code;
}
function ensureReferralCodes() {
    const users = readDB('users') || [];
    let changed = false;
    for (const u of users) {
        if (!u.referralCode) { u.referralCode = genReferralCode(users); changed = true; }
    }
    if (changed) writeDB('users', users);
}
function rebuildRound(period) {
    const round = { period, endTimestamp: Date.now() + ROUND_DURATION * 1000, duration: ROUND_DURATION };
    writeDB('round', round);
    return round;
}
function ensureRound() {
    const pd = readDB('period') || { currentPeriod: getTodayDateString() + '0001' };
    let round = readDB('round');
    if (!round || round.period !== pd.currentPeriod) round = rebuildRound(pd.currentPeriod);
    return round;
}

function settleRound(period) {
    const pd = readDB('period') || {};
    if (pd.currentPeriod !== period) return { code: 'STALE' };
    const history = readDB('history') || [];
    if (history.some(h => h.period === period)) return { code: 'DONE' };

    const rigs = readDB('rigs') || {};
    let winNum;
    if (rigs[period] !== undefined) { winNum = rigs[period]; delete rigs[period]; writeDB('rigs', rigs); }
    else winNum = Math.floor(Math.random() * 10);
    const winColors = getColorsForNumber(winNum);

    const activeBets = readDB('activebets') || [];
    const periodBets = activeBets.filter(b => b.period === period);
    const users = readDB('users') || [];
    const mybetsUpdates = {};

    for (const bet of periodBets) {
        let payout = 0, won = false;
        if (typeof bet.target === 'number') {
            if (bet.target === winNum) { payout = bet.amount * 9.0; won = true; }
        } else {
            if (winColors.includes(bet.target)) {
                won = true;
                if (winNum === 0 && bet.target === 'red') payout = bet.amount * 1.5;
                else if (winNum === 5 && bet.target === 'green') payout = bet.amount * 1.5;
                else payout = bet.amount * getPayoutRatio(bet.target);
            }
        }
        if (payout > 0) {
            const u = users.find(u => u.id === bet.userId);
            if (u) u.balance = Number(u.balance || 0) + payout;
        }
        const entry = { period, target: bet.target, amount: bet.amount, resultNumber: winNum, resultColors: winColors, payout, status: won ? 'won' : 'lost', timestamp: bet.timestamp };
        (mybetsUpdates[bet.userId] = mybetsUpdates[bet.userId] || []).push(entry);
    }
    writeDB('users', users);
    for (const uid of Object.keys(mybetsUpdates)) {
        const key = 'mybets_' + uid;
        const existing = readDB(key) || [];
        for (const e of mybetsUpdates[uid]) existing.unshift(e);
        while (existing.length > 200) existing.pop();
        writeDB(key, existing);
    }
    writeDB('activebets', activeBets.filter(b => b.period !== period));

    history.unshift({ period, number: winNum, colors: winColors });
    while (history.length > 500) history.pop();
    writeDB('history', history);

    const next = advancePeriodNumber(period);
    pd.currentPeriod = next;
    pd.counter = (pd.counter || 1) + 1;
    writeDB('period', pd);
    const newRound = rebuildRound(next);

    return { code: 'OK', period, number: winNum, colors: winColors, nextPeriod: next, endTimestamp: newRound.endTimestamp };
}

function initDefaultData() {
    if (!readDB('users')) writeDB('users', [
        { id: 'u_admin', username: 'admin', phone: '9999999999', password: 'admin', balance: 0, role: 'admin' },
        { id: 'u_test', username: 'testuser', phone: '1234567890', password: 'user123', balance: 1000, role: 'user' }
    ]);
    if (!readDB('deposits')) writeDB('deposits', []);
    if (!readDB('withdrawals')) writeDB('withdrawals', []);
    if (!readDB('rigs')) writeDB('rigs', {});
    if (!readDB('history')) writeDB('history', []);
    const hist = readDB('history');
    if (hist.length === 0) {
        const today = getTodayDateString();
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const yStr = yesterday.getFullYear().toString() +
            (yesterday.getMonth() + 1).toString().padStart(2, '0') +
            yesterday.getDate().toString().padStart(2, '0');
        const mock = [];
        for (let i = 1; i <= 20; i++) {
            const num = Math.floor(Math.random() * 10);
            mock.push({ period: yStr + String(i).padStart(4, '0'), number: num, colors: getColorsForNumber(num) });
        }
        writeDB('history', mock);
        console.log('🌱 Seeded 20 mock history records');
    }
    if (!readDB('activebets')) writeDB('activebets', []);
    if (!readDB('bank_config')) writeDB('bank_config', { accountHolder: 'Predict Pro Official', bankName: 'HDFC Bank', upiId: 'predictpro@upi', qrUrl: '' });
    if (!readDB('support_config')) writeDB('support_config', { telegram: '@PredictProSupport', email: 'support@predictpro.com', phone: '' });
    if (!readDB('limits')) writeDB('limits', { minDeposit: 100, minWithdraw: 100 });
    if (!readDB('period')) {
        const ts = getTodayDateString();
        writeDB('period', { currentPeriod: ts + '0001', lastDate: ts, counter: 1 });
    }
    if (!readDB('referrals')) writeDB('referrals', []);
    if (!readDB('maintenance')) writeDB('maintenance', { enabled: false, endTime: 0, message: 'Scheduled maintenance in progress', details: '' });
    ensureReferralCodes();
    ensureRound();
    console.log('✅ Database initialized');
}

function checkMidnightReset() {
    const ts = getTodayDateString();
    const pd = readDB('period') || {};
    if (pd.lastDate !== ts) {
        const newPeriod = ts + '0001';
        writeDB('period', { currentPeriod: newPeriod, lastDate: ts, counter: 1 });
        rebuildRound(newPeriod);
        console.log('🕛 Midnight reset! New period: ' + newPeriod);
    }
}
setInterval(checkMidnightReset, 60000);

// Auto-settle expired rounds so every device sees the same result
function autoSettleExpiredRounds() {
    const round = readDB('round');
    if (!round || Date.now() < round.endTimestamp) return;
    const result = settleRound(round.period);
    if (result.code === 'OK') {
        console.log('🎯 Auto-settled period ' + result.period + ' — Number: ' + result.number);
    }
}
setInterval(autoSettleExpiredRounds, 1000);

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function sendJSON(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(JSON.stringify(data));
}
function sendError(res, code, msg) { sendJSON(res, code, { error: msg }); }
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c.toString());
        req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

async function handleAPI(req, res, urlPath, method, queryStr) {
    const segs = urlPath.replace('/api/', '').split('/');
    const resource = segs[0];
    const id = segs[1];

    // ROUND (server clock)
    if (resource === 'round' && method === 'GET') {
        checkMidnightReset();
        const round = ensureRound();
        const history = readDB('history') || [];
        sendJSON(res, 200, { ...round, lastResult: history.length ? history[0] : null });
        return;
    }

    // ROUND SETTLE
    if (resource === 'round' && id === 'settle' && method === 'POST') {
        const body = await parseBody(req);
        const result = settleRound(body.period);
        if (result.code === 'STALE' || result.code === 'DONE') {
            sendJSON(res, 409, { code: result.code, error: result.code === 'STALE' ? 'Round already advanced' : 'Already settled' });
        } else {
            sendJSON(res, 200, result);
        }
        return;
    }

    // BETS (place + fetch)
    if (resource === 'bets') {
        if (method === 'POST') {
            const body = await parseBody(req);
            const round = readDB('round');
            if (!round || round.period !== body.period) { sendError(res, 409, 'Round changed. Please refresh.'); return; }
            if (Date.now() >= round.endTimestamp - BET_LOCK_SEC * 1000) { sendError(res, 400, 'Betting locked. Wait for next round.'); return; }
            if (typeof body.target === 'undefined' || !(body.amount > 0)) { sendError(res, 400, 'Invalid bet data.'); return; }
            const users = readDB('users') || [];
            const user = users.find(u => u.id === body.userId);
            if (!user) { sendError(res, 404, 'User not found.'); return; }
            if (user.balance < body.amount) { sendError(res, 400, 'Insufficient balance!'); return; }
            user.balance -= body.amount;
            writeDB('users', users);
            const bet = { id: 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), userId: body.userId, username: body.username || user.username, target: body.target, amount: body.amount, period: body.period, timestamp: Date.now() };
            const ab = readDB('activebets') || [];
            ab.push(bet);
            writeDB('activebets', ab);
            sendJSON(res, 201, { bet, balance: user.balance });
            return;
        }
        if (method === 'GET') {
            const qs = new URLSearchParams(queryStr || '');
            const period = qs.get('period');
            const userId = qs.get('userId');
            let list = readDB('activebets') || [];
            if (period) list = list.filter(b => b.period === period);
            if (userId) list = list.filter(b => b.userId === userId);
            sendJSON(res, 200, list);
            return;
        }
    }

    // PERIOD
    if (resource === 'period' && !id) {
        if (method === 'GET') { checkMidnightReset(); ensureRound(); sendJSON(res, 200, readDB('period')); return; }
        if (method === 'POST') {
            const body = await parseBody(req);
            const updated = { ...(readDB('period') || {}), ...body };
            writeDB('period', updated);
            rebuildRound(updated.currentPeriod);
            sendJSON(res, 200, updated);
            return;
        }
    }

    // USERS
    if (resource === 'users') {
        if (method === 'GET') { sendJSON(res, 200, readDB('users') || []); return; }
        if (method === 'POST') {
            const body = await parseBody(req);
            const users = readDB('users') || [];
            const refCode = (body.referralCode || '').toString().trim().toUpperCase();
            const newUser = {
                ...body,
                referralCode: genReferralCode(users),
                referralEarnings: 0,
                balance: Number(body.balance || 0)
            };
            let bonusApplied = false;
            if (refCode) {
                const ref = users.find(x => x.referralCode && String(x.referralCode).toUpperCase() === refCode && x.id !== newUser.id);
                if (ref) {
                    newUser.balance = Number(newUser.balance || 0) + REFERRAL_BONUS;
                    newUser.referrerId = ref.id;
                    ref.balance = Number(ref.balance || 0) + REFERRAL_BONUS;
                    ref.referralEarnings = Number(ref.referralEarnings || 0) + REFERRAL_BONUS;
                    const all = readDB('referrals') || [];
                    all.push({ referrerId: ref.id, userId: newUser.id, username: newUser.username, timestamp: Date.now(), bonus: REFERRAL_BONUS });
                    writeDB('referrals', all);
                    bonusApplied = true;
                }
            }
            users.push(newUser);
            writeDB('users', users);
            sendJSON(res, 201, { ...newUser, bonusApplied });
            return;
        }
        if (method === 'PUT' && id) { const body = await parseBody(req); const u = readDB('users') || []; const i = u.findIndex(x => x.id === id); if (i === -1) { sendError(res, 404, 'User not found'); return; } u[i] = { ...u[i], ...body }; writeDB('users', u); sendJSON(res, 200, u[i]); return; }
    }

    // DEPOSITS
    if (resource === 'deposits') {
        if (method === 'GET') { sendJSON(res, 200, readDB('deposits') || []); return; }
        if (method === 'POST') { const body = await parseBody(req); const d = readDB('deposits') || []; d.push(body); writeDB('deposits', d); sendJSON(res, 201, body); return; }
        if (method === 'PUT' && id) { const body = await parseBody(req); const d = readDB('deposits') || []; const i = d.findIndex(x => x.id === id); if (i === -1) { sendError(res, 404, 'Not found'); return; } d[i] = { ...d[i], ...body }; writeDB('deposits', d); sendJSON(res, 200, d[i]); return; }
    }

    // WITHDRAWALS
    if (resource === 'withdrawals') {
        if (method === 'GET') { sendJSON(res, 200, readDB('withdrawals') || []); return; }
        if (method === 'POST') { const body = await parseBody(req); const w = readDB('withdrawals') || []; w.push(body); writeDB('withdrawals', w); sendJSON(res, 201, body); return; }
        if (method === 'PUT' && id) { const body = await parseBody(req); const w = readDB('withdrawals') || []; const i = w.findIndex(x => x.id === id); if (i === -1) { sendError(res, 404, 'Not found'); return; } w[i] = { ...w[i], ...body }; writeDB('withdrawals', w); sendJSON(res, 200, w[i]); return; }
    }

    // RIGS
    if (resource === 'rigs') {
        if (method === 'GET') { sendJSON(res, 200, readDB('rigs') || {}); return; }
        if (method === 'POST') { const body = await parseBody(req); writeDB('rigs', body); sendJSON(res, 200, body); return; }
    }

    // HISTORY
    if (resource === 'history') {
        if (method === 'GET') { sendJSON(res, 200, readDB('history') || []); return; }
        if (method === 'POST') { const body = await parseBody(req); const h = readDB('history') || []; h.unshift(body); while (h.length > 500) h.pop(); writeDB('history', h); sendJSON(res, 201, body); return; }
    }

    // REFERRAL
    if (resource === 'referral' && method === 'GET') {
        const qs = new URLSearchParams(queryStr || '');
        const userId = qs.get('userId') || id;
        const users = readDB('users') || [];
        const me = users.find(x => x.id === userId);
        if (!me) { sendError(res, 404, 'User not found'); return; }
        const all = readDB('referrals') || [];
        const list = all.filter(r => r.referrerId === me.id).sort((a, b) => b.timestamp - a.timestamp);
        sendJSON(res, 200, {
            myCode: me.referralCode || '',
            totalUsers: list.length,
            totalIncome: Number(me.referralEarnings || 0),
            referrals: list
        });
        return;
    }

    // MAINTENANCE
    if (resource === 'maintenance') {
        if (method === 'GET') { sendJSON(res, 200, readDB('maintenance') || { enabled: false, endTime: 0, message: '', details: '' }); return; }
        if (method === 'POST') { const body = await parseBody(req); writeDB('maintenance', body); sendJSON(res, 200, body); return; }
    }

    // ADMIN RESET
    if (resource === 'admin' && id === 'reset' && method === 'POST') {
        const body = await parseBody(req);
        const confirm = (body && body.confirm) ? String(body.confirm).toUpperCase() : '';
        if (confirm !== 'RESET') {
            sendError(res, 400, 'Confirmation required. Send { confirm: "RESET" }');
            return;
        }
        const ts = getTodayDateString();
        writeDB('deposits', []);
        writeDB('withdrawals', []);
        writeDB('activebets', []);
        writeDB('history', []);
        writeDB('rigs', {});
        writeDB('referrals', []);
        writeDB('period', { currentPeriod: ts + '0001', lastDate: ts, counter: 1 });
        writeDB('maintenance', { enabled: false, endTime: 0, message: '', details: '' });
        const users = readDB('users') || [];
        for (const u of users) {
            if (u.role !== 'admin') {
                u.balance = 0;
                u.referralEarnings = 0;
                u.referrals = [];
                u.referralCode = genReferralCode(users);
                u.referrerId = null;
            }
            // Clear per-user bet history files
            writeDB('mybets_' + u.id, []);
        }
        writeDB('users', users);
        ensureRound();
        console.log('🔄 Admin reset executed');
        sendJSON(res, 200, { ok: true, message: 'All data reset successfully' });
        return;
    }

    // BANK CONFIG
    if (resource === 'bank_config') {
        if (method === 'GET') { sendJSON(res, 200, readDB('bank_config') || {}); return; }
        if (method === 'POST') { const body = await parseBody(req); writeDB('bank_config', body); sendJSON(res, 200, body); return; }
    }

    // SUPPORT CONFIG
    if (resource === 'support_config') {
        if (method === 'GET') { sendJSON(res, 200, readDB('support_config') || {}); return; }
        if (method === 'POST') { const body = await parseBody(req); writeDB('support_config', body); sendJSON(res, 200, body); return; }
    }

    // ADMIN STATS
    if (resource === 'admin' && id === 'stats' && method === 'GET') {
        const users = readDB('users') || [];
        const deposits = readDB('deposits') || [];
        const withdrawals = readDB('withdrawals') || [];
        const players = users.filter(u => u.role !== 'admin');
        let totDep = 0, totWith = 0, totBets = 0, totPayouts = 0;
        deposits.forEach(d => { if (d.status === 'approved') totDep += Number(d.amount) || 0; });
        withdrawals.forEach(w => { if (w.status === 'approved') totWith += Number(w.amount) || 0; });
        players.forEach(u => { (readDB('mybets_' + u.id) || []).forEach(b => { totBets += Number(b.amount) || 0; totPayouts += Number(b.payout) || 0; }); });
        sendJSON(res, 200, { totalUsers: players.length, totalApprovedDeposits: totDep, totalApprovedWithdrawals: totWith, totalBets: totBets, totalPayouts: totPayouts, companyProfit: totBets - totPayouts, totalPlayerBalance: players.reduce((s, u) => s + (Number(u.balance) || 0), 0) });
        return;
    }

    // LIMITS
    if (resource === 'limits') {
        if (method === 'GET') { sendJSON(res, 200, readDB('limits') || { minDeposit: 100, minWithdraw: 100 }); return; }
        if (method === 'POST') { const body = await parseBody(req); writeDB('limits', body); sendJSON(res, 200, body); return; }
    }

    // MYBETS
    if (resource === 'mybets' && id) {
        const key = 'mybets_' + id;
        if (method === 'GET') { sendJSON(res, 200, readDB(key) || []); return; }
        if (method === 'POST') { const body = await parseBody(req); const mb = readDB(key) || []; mb.unshift(body); while (mb.length > 200) mb.pop(); writeDB(key, mb); sendJSON(res, 201, body); return; }
    }

    // ADVANCE PERIOD
    if (resource === 'advance_period' && method === 'POST') {
        const pd = readDB('period') || {};
        const next = advancePeriodNumber(pd.currentPeriod || '');
        pd.currentPeriod = next;
        pd.counter = (pd.counter || 1) + 1;
        writeDB('period', pd);
        rebuildRound(next);
        sendJSON(res, 200, pd);
        return;
    }

    sendError(res, 404, 'Not found');
}

const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];
    const queryStr = req.url.split('?')[1] || '';
    const method = req.method;

    if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end();
        return;
    }

    if (urlPath.startsWith('/api/')) {
        try { await handleAPI(req, res, urlPath, method, queryStr); }
        catch (e) { console.error('API Error:', e.message); sendError(res, 500, 'Server error'); }
        return;
    }

    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    filePath = path.join(__dirname, filePath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); res.end(err.code === 'ENOENT' ? '404' : '500'); return; }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

initDefaultData();
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🚀 SUPERWIN SERVER STARTED!');
    console.log(`📡 Local:   http://localhost:${PORT}`);
    const os = require('os');
    for (const nets of Object.values(os.networkInterfaces())) {
        for (const net of nets) {
            if (net.family === 'IPv4' && !net.internal) console.log(`   📱 Other devices: http://${net.address}:${PORT}`);
        }
    }
    console.log('');
});
