// ==========================================
// COLOR PREDICTION APP ENGINE (app.js)
// API-Connected Client - All data synced
// via server API for cross-device support
// ==========================================

// --- API Base URL (auto-detect) ---
const API_BASE = window.location.origin + '/api';

// --- Async API Helper ---
async function api(method, path, body) {
    try {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (body !== undefined) opts.body = JSON.stringify(body);
        const res = await fetch(API_BASE + path, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        return await res.json();
    } catch (e) {
        console.error(`API ${method} ${path} error:`, e.message);
        throw e;
    }
}

// --- Safe localStorage (session/muted only - not game data) ---
const safeStorage = {
    getItem: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
    setItem: (key, v) => { try { localStorage.setItem(key, v); } catch {} },
    removeItem: (key) => { try { localStorage.removeItem(key); } catch {} }
};

// --- Web Audio API Synth Engine ---
let audioCtx = null;

function initAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playSound(type) {
    if (state.isMuted) return;
    try {
        initAudio();
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        const now = audioCtx.currentTime;

        if (type === 'click') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1000, now);
            gainNode.gain.setValueAtTime(0.05, now);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
            osc.start(now); osc.stop(now + 0.05);
        } else if (type === 'tick') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(600, now);
            gainNode.gain.setValueAtTime(0.08, now);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
            osc.start(now); osc.stop(now + 0.08);
        } else if (type === 'lockout') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, now);
            osc.frequency.exponentialRampToValueAtTime(400, now + 0.2);
            gainNode.gain.setValueAtTime(0.06, now);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
            osc.start(now); osc.stop(now + 0.2);
        } else if (type === 'win') {
            const notes = [261.63, 329.63, 392.00, 523.25];
            notes.forEach((freq, idx) => {
                const subOsc = audioCtx.createOscillator();
                const subGain = audioCtx.createGain();
                subOsc.connect(subGain);
                subGain.connect(audioCtx.destination);
                subOsc.type = 'sine';
                subOsc.frequency.setValueAtTime(freq, now + idx * 0.08);
                subGain.gain.setValueAtTime(0, now + idx * 0.08);
                subGain.gain.linearRampToValueAtTime(0.1, now + idx * 0.08 + 0.02);
                subGain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.25);
                subOsc.start(now + idx * 0.08);
                subOsc.stop(now + idx * 0.08 + 0.3);
            });
        } else if (type === 'lose') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(350, now);
            osc.frequency.linearRampToValueAtTime(120, now + 0.35);
            gainNode.gain.setValueAtTime(0.12, now);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
            osc.start(now); osc.stop(now + 0.4);
        }
    } catch (e) { console.warn('Audio synthesis failed:', e); }
}

function getColorsForNumber(num) {
    if (num === 0) return ['red', 'violet'];
    if (num === 5) return ['green', 'violet'];
    return num % 2 === 0 ? ['red'] : ['green'];
}

// --- Application Core State ---
let state = {
    currentUser: (() => { try { const s = safeStorage.getItem('predict_session'); return s ? JSON.parse(s) : null; } catch { return null; } })(),
    timeLeft: 30,
    roundEndTimestamp: 0,
    _lastRoundSync: 0,
    currentPeriod: '',
    activeBets: [],
    history: [],
    isMuted: safeStorage.getItem('predict_muted') === 'true',
    currentTab: 'game',
    betSelection: null,
    betBaseAmount: 10,
    betMultiplier: 1,
    _users: null, _deposits: null, _withdrawals: null, _rigs: null, _limits: null,
    _lastRoundPeriod: null, _roundClaimed: false
};

// --- API-Backed DB Layer (with local cache for speed) ---
const DB = {
    // USERS
    getUsers: async () => {
        const data = await api('GET', '/users');
        state._users = data;
        return data;
    },
    getUsersSync: () => state._users || [],
    saveUser: async (user) => {
        await api('PUT', '/users/' + user.id, user);
        // refresh cache
        state._users = state._users ? state._users.map(u => u.id === user.id ? user : u) : [user];
    },
    addUser: async (user) => {
        await api('POST', '/users', user);
        if (state._users) state._users.push(user);
    },

    // DEPOSITS
    getDeposits: async () => {
        const data = await api('GET', '/deposits');
        state._deposits = data;
        return data;
    },
    getDepositsSync: () => state._deposits || [],
    addDeposit: async (dep) => {
        await api('POST', '/deposits', dep);
        if (state._deposits) state._deposits.push(dep);
    },
    updateDeposit: async (dep) => {
        await api('PUT', '/deposits/' + dep.id, dep);
        if (state._deposits) {
            const idx = state._deposits.findIndex(d => d.id === dep.id);
            if (idx !== -1) state._deposits[idx] = dep;
        }
    },

    // WITHDRAWALS
    getWithdrawals: async () => {
        const data = await api('GET', '/withdrawals');
        state._withdrawals = data;
        return data;
    },
    getWithdrawalsSync: () => state._withdrawals || [],
    addWithdrawal: async (w) => {
        await api('POST', '/withdrawals', w);
        if (state._withdrawals) state._withdrawals.push(w);
    },
    updateWithdrawal: async (w) => {
        await api('PUT', '/withdrawals/' + w.id, w);
        if (state._withdrawals) {
            const idx = state._withdrawals.findIndex(x => x.id === w.id);
            if (idx !== -1) state._withdrawals[idx] = w;
        }
    },

    // RIGS
    getRigs: async () => {
        const data = await api('GET', '/rigs');
        state._rigs = data;
        return data;
    },
    getRigsSync: () => state._rigs || {},
    saveRigs: async (rigs) => {
        await api('POST', '/rigs', rigs);
        state._rigs = rigs;
    },

    // PERIOD
    getPeriod: async () => api('GET', '/period'),
    savePeriod: async (data) => api('POST', '/period', data),
    advancePeriod: async () => api('POST', '/advance_period'),

    // HISTORY
    getHistory: async () => api('GET', '/history'),
    addHistory: async (entry) => api('POST', '/history', entry),

    // BANK CONFIG
    getBankConfig: async () => api('GET', '/bank_config'),
    saveBankConfig: async (config) => api('POST', '/bank_config', config),

    // SUPPORT CONFIG
    getSupportConfig: async () => api('GET', '/support_config'),
    saveSupportConfig: async (config) => api('POST', '/support_config', config),

    // LIMITS (min deposit / min withdraw)
    getLimits: async () => {
        const data = await api('GET', '/limits');
        state._limits = data;
        return data;
    },
    getLimitsSync: () => state._limits || { minDeposit: 100, minWithdraw: 100 },
    saveLimits: async (config) => {
        await api('POST', '/limits', config);
        state._limits = config;
    },

    // MYBETS
    getMyBets: async (userId) => api('GET', '/mybets/' + userId),
    addMyBet: async (userId, bet) => api('POST', '/mybets/' + userId, bet),

    // REFERRAL
    getReferral: async (userId) => api('GET', '/referral?userId=' + encodeURIComponent(userId)),

    // MAINTENANCE
    getMaintenance: async () => api('GET', '/maintenance'),
    saveMaintenance: async (data) => api('POST', '/maintenance', data),

    // ADMIN STATS
    getAdminStats: async () => api('GET', '/admin/stats'),
    adminReset: async (data) => api('POST', '/admin/reset', data),

    // SERVER ROUND
    getRound: async () => api('GET', '/round'),
    placeServerBet: async (data) => api('POST', '/bets', data),
    settleRound: async (period) => api('POST', '/round/settle', { period }),
    getUserBets: async (period, userId) => api('GET', '/bets?period=' + encodeURIComponent(period) + '&userId=' + encodeURIComponent(userId))
};

// --- DOM Reference Selectors ---
const userDisplayNameEl = document.getElementById('user-display-name');
const userBalanceEl = document.getElementById('user-balance');
const currentPeriodEl = document.getElementById('current-period');
const activeBetsListEl = document.getElementById('active-bets-list');
const recordsGridViewEl = document.getElementById('records-grid-view');

const betModalOverlay = document.getElementById('bet-modal-overlay');
const modalBetTarget = document.getElementById('modal-bet-target');
const btnConfirmBet = document.getElementById('btn-confirm-bet');
const modalCloseBtn = document.getElementById('modal-close');

const btnMultDec = document.getElementById('btn-mult-dec');
const btnMultInc = document.getElementById('btn-mult-inc');

const previewBaseEl = document.getElementById('preview-base');
const previewMultEl = document.getElementById('preview-mult');
const previewTotalEl = document.getElementById('preview-total');
const previewPayoutEl = document.getElementById('preview-payout');

const resultDialogOverlay = document.getElementById('result-dialog-overlay');
const resultDialogBox = document.getElementById('result-dialog-box');
const dialogIconEl = document.getElementById('dialog-icon');
const dialogTitleEl = document.getElementById('dialog-title');
const dialogDescEl = document.getElementById('dialog-desc');
const dialogWinningCircleEl = document.getElementById('dialog-winning-circle');
const dialogCloseBtn = document.getElementById('dialog-close-btn');
const confettiCanvas = document.getElementById('confetti-canvas');

const btnSound = document.getElementById('btn-sound');
const soundOnIcon = document.getElementById('sound-on-icon');
const soundOffIcon = document.getElementById('sound-off-icon');
const btnLogout = document.getElementById('btn-logout');

const authOverlay = document.getElementById('auth-overlay');
const loginCard = document.getElementById('login-card');
const signupCard = document.getElementById('signup-card');
const toggleToSignup = document.getElementById('toggle-to-signup');
const toggleToLogin = document.getElementById('toggle-to-login');
const btnLoginSubmit = document.getElementById('btn-login-submit');
const btnSignupSubmit = document.getElementById('btn-signup-submit');
const signupReferralCodeInput = document.getElementById('signup-referral-code');

const depositModalOverlay = document.getElementById('deposit-modal-overlay');
const withdrawModalOverlay = document.getElementById('withdraw-modal-overlay');
const btnDepositTrigger = document.getElementById('btn-deposit-trigger');
const btnWithdrawTrigger = document.getElementById('btn-withdraw-trigger');
const depositModalClose = document.getElementById('deposit-modal-close');
const withdrawModalClose = document.getElementById('withdraw-modal-close');
const btnDepositSubmit = document.getElementById('btn-deposit-submit');
const btnWithdrawSubmit = document.getElementById('btn-withdraw-submit');
const btnCopyUpi = document.getElementById('btn-copy-upi');

const adminAccountHolder = document.getElementById('admin-account-holder');
const adminBankName = document.getElementById('admin-bank-name');
const adminUpiId = document.getElementById('admin-upi-id');
const adminQrUrl = document.getElementById('admin-qr-url');
const btnAdminSaveBank = document.getElementById('btn-admin-save-bank');
const adminBankMsg = document.getElementById('admin-bank-msg');

const adminSupportTelegram = document.getElementById('admin-support-telegram');
const adminSupportEmail = document.getElementById('admin-support-email');
const adminSupportPhone = document.getElementById('admin-support-phone');
const btnAdminSaveSupport = document.getElementById('btn-admin-save-support');
const adminSupportMsg = document.getElementById('admin-support-msg');

const adminSetPeriodInput = document.getElementById('admin-set-period-input');
const btnAdminSavePeriod = document.getElementById('btn-admin-save-period');
const adminPeriodMsg = document.getElementById('admin-period-msg');
const adminRigPeriod = document.getElementById('admin-rig-period');
const adminRigNumber = document.getElementById('admin-rig-number');
const btnAdminRigSubmit = document.getElementById('btn-admin-rig-submit');
const adminActiveRigs = document.getElementById('admin-active-rigs');
const adminDepositsTbody = document.getElementById('admin-deposits-tbody');
const adminWithdrawalsTbody = document.getElementById('admin-withdrawals-tbody');
const adminUsersTbody = document.getElementById('admin-users-tbody');
const navBtnAdmin = document.getElementById('nav-btn-admin');
const navBtnReferral = document.getElementById('nav-btn-referral');
const navBtnHistory = document.getElementById('nav-btn-history');
const admnStatUsers = document.getElementById('admn-stat-users');
const admnStatDeposits = document.getElementById('admn-stat-deposits');
const admnStatWithdrawals = document.getElementById('admn-stat-withdrawals');
const admnStatBets = document.getElementById('admn-stat-bets');
const admnStatPayouts = document.getElementById('admn-stat-payouts');
const admnStatProfit = document.getElementById('admn-stat-profit');
const adminMinDeposit = document.getElementById('admin-min-deposit');
const adminMinWithdraw = document.getElementById('admin-min-withdraw');
const btnAdminSaveLimits = document.getElementById('btn-admin-save-limits');
const adminLimitsMsg = document.getElementById('admin-limits-msg');
const adminMaintenanceEnabled = document.getElementById('admin-maintenance-enabled');
const adminMaintenanceEnd = document.getElementById('admin-maintenance-end');
const adminMaintenanceMessage = document.getElementById('admin-maintenance-message');
const adminMaintenanceDetails = document.getElementById('admin-maintenance-details');
const btnAdminSaveMaintenance = document.getElementById('btn-admin-save-maintenance');
const adminMaintenanceMsg = document.getElementById('admin-maintenance-msg');

// --- Application Startup ---
async function initApp() {
    try {
        // Load initial data from server
        const [users, periodData, history, deposits, withdrawals, rigs, limits] = await Promise.all([
            DB.getUsers(),
            DB.getPeriod(),
            DB.getHistory(),
            DB.getDeposits(),
            DB.getWithdrawals(),
            DB.getRigs(),
            DB.getLimits()
        ]);

        state.currentPeriod = periodData.currentPeriod;
        state.history = history;
        state._rigs = rigs;
        state._limits = limits || { minDeposit: 100, minWithdraw: 100 };
        applyLimitsToModals();

        // Sync session user from server
        if (state.currentUser) {
            const freshUser = users.find(u => u.id === state.currentUser.id);
            if (freshUser) {
                state.currentUser = freshUser;
                safeStorage.setItem('predict_session', JSON.stringify(freshUser));
            } else {
                // User doesn't exist on server - clear session
                state.currentUser = null;
                safeStorage.removeItem('predict_session');
            }
        }

        // Seed mock history if empty (server does this too—kept as fallback)
        if (state.history.length === 0) {
            await generateMockHistory(20);
        }

        setupEventListeners();
        checkAuthSession();
        await syncRoundFromServer();
        await checkMaintenance();
        startTimer();
        renderRecords();
        updatePeriodDisplay();
        await updateDepositSheetDetails();

        console.log('✅ App initialized - connected to server');
    } catch (e) {
        console.error('❌ Server connection failed:', e.message);
        alert('⚠️ Cannot connect to server!\n\nPlease make sure the server is running:\nnode server.js\n\nThen refresh this page.');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// Sync data from server every 5 seconds (balance, deposits, round timing, results)
setInterval(async () => {
    try {
        const [round, periodData, users, deposits, withdrawals, rigs, history] = await Promise.all([
            DB.getRound(),
            DB.getPeriod(),
            DB.getUsers(),
            DB.getDeposits(),
            DB.getWithdrawals(),
            DB.getRigs(),
            DB.getHistory()
        ]);

        const prevPeriod = state.currentPeriod;
        state._rigs = rigs;
        state.roundEndTimestamp = round.endTimestamp;
        state._lastRoundSync = Date.now();
        state.history = history;

        // Update period + detect round transition (server-driven results)
        if (round.period && prevPeriod && round.period !== prevPeriod) {
            state.currentPeriod = round.period;
            state.timeLeft = Math.max(0, Math.ceil((round.endTimestamp - Date.now()) / 1000));
            updatePeriodDisplay();

            // Show result for the just-ended period (server-side resolved)
            if (round.lastResult && round.lastResult.period === prevPeriod) {
                await showOutcomeForPeriod(prevPeriod, round.lastResult);
            }

            renderRecords();
            renderTrends();
            renderMyBets();
            if (state.currentUser) {
                state.activeBets = await DB.getUserBets(state.currentPeriod, state.currentUser.id);
                renderActiveBets();
            }
        }

        // Refresh current user balance from server
        if (state.currentUser) {
            const freshUser = users.find(u => u.id === state.currentUser.id);
            if (freshUser && freshUser.balance !== state.currentUser.balance) {
                state.currentUser = freshUser;
                safeStorage.setItem('predict_session', JSON.stringify(freshUser));
                if (userBalanceEl) userBalanceEl.textContent = freshUser.balance.toFixed(2);
                if (state.currentTab === 'profile') renderProfile();
            }
        }

        // Always refresh records so all devices see same data across refresh
        renderRecords();
        renderTrends();

        await checkMaintenance();
    } catch (e) {
        // Silently ignore sync errors (server might be briefly unavailable)
    }
}, 5000);

async function generateMockHistory(count) {
    const results = [];
    for (let i = 0; i < count; i++) {
        const num = Math.floor(Math.random() * 10);
        results.push({
            period: (parseInt(state.currentPeriod) - count + i).toString(),
            number: num,
            colors: getColorsForNumber(num)
        });
    }
    // Add all to server and local state
    for (const entry of results) {
        state.history.push(entry);
        try { await DB.addHistory(entry); } catch {}
    }
}

function updatePeriodDisplay() {
    if (currentPeriodEl) currentPeriodEl.textContent = state.currentPeriod;
    if (adminRigPeriod) adminRigPeriod.value = state.currentPeriod;
    if (adminSetPeriodInput && !adminSetPeriodInput.value) {
        adminSetPeriodInput.value = state.currentPeriod;
    }
}

async function checkMaintenance() {
    if (state.currentUser && state.currentUser.role === 'admin') return false;
    try {
        const data = await DB.getMaintenance();
        const overlay = document.getElementById('maintenance-overlay');
        if (!overlay) return false;
        
        if (data && data.enabled) {
            const msgEl = document.getElementById('maintenance-message');
            const detailsEl = document.getElementById('maintenance-details');
            const endEl = document.getElementById('maintenance-end-time');
            if (msgEl) msgEl.textContent = data.message || 'Scheduled maintenance in progress';
            if (detailsEl) detailsEl.textContent = data.details || '';
            if (endEl) endEl.textContent = data.endTime ? 'Expected end: ' + new Date(Number(data.endTime)).toLocaleString('en-IN') : '';
            overlay.style.display = 'flex';
            return true;
        } else {
            overlay.style.display = 'none';
            return false;
        }
    } catch (e) {
        return false;
    }
}

async function updateDepositSheetDetails() {
    try {
        const bankConfig = await DB.getBankConfig();
        const payeeEl = document.getElementById('deposit-payee-name');
        const bankEl = document.getElementById('deposit-bank-name');
        const upiEl = document.getElementById('copy-upi-id');
        const qrContainer = document.getElementById('deposit-qr-container');

        if (payeeEl) payeeEl.textContent = bankConfig.accountHolder || 'Predict Pro Official';
        if (bankEl) bankEl.textContent = bankConfig.bankName || 'HDFC Bank';
        if (upiEl) upiEl.textContent = bankConfig.upiId || 'predictpro@upi';

        if (qrContainer) {
            if (bankConfig.qrUrl && bankConfig.qrUrl.trim() !== '') {
                qrContainer.innerHTML = `
                    <div style="text-align: center; padding: 6px; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <img src="${bankConfig.qrUrl}" alt="Merchant QR Code" style="max-width: 150px; height: auto; border-radius: 6px;">
                        <div style="font-size: 0.72rem; color: var(--text-gray); font-weight: 600; margin-top: 4px;">SCAN TO PAY</div>
                    </div>
                `;
            } else {
                qrContainer.innerHTML = `
                    <div class="qr-box">
                        <div class="qr-pixel-corner top-left"></div>
                        <div class="qr-pixel-corner top-right"></div>
                        <div class="qr-pixel-corner bottom-left"></div>
                        <div class="qr-pixel-center"></div>
                        <span style="font-size: 0.72rem; color: var(--text-gray); font-weight: 600; z-index: 1;">SCAN TO PAY</span>
                    </div>
                `;
            }
        }
    } catch (e) { console.warn('Could not load bank config:', e.message); }
}

function checkAuthSession() {
    if (state.currentUser) {
        if (authOverlay) authOverlay.classList.remove('active');
        if (btnLogout) btnLogout.style.display = 'flex';

        if (userDisplayNameEl) userDisplayNameEl.textContent = state.currentUser.username;
        if (userBalanceEl) userBalanceEl.textContent = state.currentUser.balance.toFixed(2);

        if (navBtnAdmin) {
            navBtnAdmin.style.display = state.currentUser.role === 'admin' ? 'flex' : 'none';
        }
        if (navBtnReferral) {
            navBtnReferral.style.display = 'flex';
        }
        if (navBtnHistory) {
            navBtnHistory.style.display = 'flex';
        }

        if (state.currentTab === 'profile') renderProfile();
    } else {
        if (authOverlay) authOverlay.classList.add('active');
        if (btnLogout) btnLogout.style.display = 'none';
        if (navBtnAdmin) navBtnAdmin.style.display = 'none';
        if (navBtnReferral) navBtnReferral.style.display = 'none';
        if (navBtnHistory) navBtnHistory.style.display = 'none';
        if (userDisplayNameEl) userDisplayNameEl.textContent = 'Guest';
        if (userBalanceEl) userBalanceEl.textContent = '0.00';
    }
}

// --- Authentication Operations ---
async function handleLogin() {
    const userVal = document.getElementById('login-username').value.trim();
    const passVal = document.getElementById('login-password').value.trim();

    if (!userVal || !passVal) { alert('Please enter both username and password.'); return; }

    try {
        const users = await DB.getUsers();
        const userMatch = users.find(u => (u.username === userVal || u.phone === userVal) && u.password === passVal);

        if (userMatch) {
            state.currentUser = userMatch;
            safeStorage.setItem('predict_session', JSON.stringify(userMatch));
            playSound('win');
            checkAuthSession();
            switchTab('game');
            document.getElementById('login-username').value = '';
            document.getElementById('login-password').value = '';
        } else {
            alert('Invalid login details! Try again.');
            playSound('lose');
        }
    } catch (e) {
        alert('Login failed: ' + e.message);
    }
}

async function handleSignup() {
    const userVal = document.getElementById('signup-username').value.trim();
    const phoneVal = document.getElementById('signup-phone').value.trim();
    const passVal = document.getElementById('signup-password').value.trim();

    if (!userVal || !phoneVal || !passVal) { alert('All fields are mandatory.'); return; }
    if (phoneVal.length !== 10 || isNaN(phoneVal)) { alert('Please enter a valid 10-digit phone number.'); return; }

    try {
        const users = await DB.getUsers();
        if (users.some(u => u.username === userVal)) { alert('Username already taken!'); return; }
        if (users.some(u => u.phone === phoneVal)) { alert('Phone number already registered!'); return; }

        const refCode = (signupReferralCodeInput ? signupReferralCodeInput.value : '').trim() || safeStorage.getItem('predict_ref') || '';
        const newPlayer = {
            id: 'u_' + Date.now(),
            username: userVal,
            phone: phoneVal,
            password: passVal,
            balance: 0.00,
            role: 'user',
            referralCode: refCode || undefined
        };

        const result = await DB.addUser(newPlayer);
        if (result && result.bonusApplied) {
            safeStorage.removeItem('predict_ref');
            if (signupReferralCodeInput) signupReferralCodeInput.value = '';
            alert('🎉 Registration successful! You received a ₹20 welcome bonus! Please login.');
        } else if (refCode) {
            safeStorage.removeItem('predict_ref');
            if (signupReferralCodeInput) signupReferralCodeInput.value = '';
            alert('Registration successful! (Referral code was invalid or expired).');
        } else {
            alert('Registration successful! Please login.');
        }
        if (signupCard) signupCard.style.display = 'none';
        if (loginCard) loginCard.style.display = 'block';

        document.getElementById('signup-username').value = '';
        document.getElementById('signup-phone').value = '';
        document.getElementById('signup-password').value = '';
    } catch (e) {
        alert('Registration failed: ' + e.message);
    }
}

function handleLogout() {
    state.currentUser = null;
    safeStorage.removeItem('predict_session');
    state.activeBets = [];
    checkAuthSession();
    playSound('click');
}

// --- Deposit & Withdraw ---
async function submitDepositRequest() {
    const amt = parseFloat(document.getElementById('deposit-amount').value);
    const utr = document.getElementById('deposit-utr').value.trim();
    const limits = await DB.getLimits();
    const minDeposit = Number(limits.minDeposit) || 100;

    if (isNaN(amt) || amt < minDeposit) { alert(`Minimum deposit amount is ₹${minDeposit}.`); return; }
    if (utr.length !== 12 || isNaN(utr)) { alert('Please enter a valid 12-digit transaction UTR number.'); return; }

    try {
        const deposits = await DB.getDeposits();
        if (deposits.some(d => d.utr === utr)) { alert('This UTR has already been submitted!'); return; }

        const newDep = {
            id: 'd_' + Date.now(),
            userId: state.currentUser.id,
            username: state.currentUser.username,
            amount: amt,
            utr: utr,
            status: 'pending',
            timestamp: Date.now()
        };

        await DB.addDeposit(newDep);

        if (depositModalOverlay) depositModalOverlay.classList.remove('active');
        document.getElementById('deposit-amount').value = '';
        document.getElementById('deposit-utr').value = '';
        playSound('win');

        const depositSuccessOverlay = document.getElementById('deposit-success-dialog-overlay');
        if (depositSuccessOverlay) depositSuccessOverlay.classList.add('active');
    } catch (e) {
        alert('Deposit submission failed: ' + e.message);
    }
}

async function submitWithdrawalRequest() {
    const amt = parseFloat(document.getElementById('withdraw-amount').value);
    const upi = document.getElementById('withdraw-upi-id').value.trim();
    const limits = await DB.getLimits();
    const minWithdraw = Number(limits.minWithdraw) || 100;

    if (isNaN(amt) || amt < minWithdraw) { alert(`Minimum withdrawal limit is ₹${minWithdraw}.`); return; }
    if (!upi.includes('@')) { alert('Please enter a valid UPI ID (e.g. name@bank).'); return; }
    if (state.currentUser.balance < amt) { alert('Insufficient wallet balance for this withdrawal.'); return; }

    try {
        const updatedUser = { ...state.currentUser, balance: state.currentUser.balance - amt };
        await DB.saveUser(updatedUser);
        state.currentUser = updatedUser;
        safeStorage.setItem('predict_session', JSON.stringify(updatedUser));
        if (userBalanceEl) userBalanceEl.textContent = updatedUser.balance.toFixed(2);

        const newWith = {
            id: 'w_' + Date.now(),
            userId: state.currentUser.id,
            username: state.currentUser.username,
            amount: amt,
            upiId: upi,
            status: 'pending',
            timestamp: Date.now()
        };

        await DB.addWithdrawal(newWith);
        alert('Withdrawal request submitted! Pending Admin approval.');
        if (withdrawModalOverlay) withdrawModalOverlay.classList.remove('active');
        document.getElementById('withdraw-amount').value = '';
        document.getElementById('withdraw-upi-id').value = '';
        playSound('click');
    } catch (e) {
        alert('Withdrawal failed: ' + e.message);
    }
}

// Apply current min limits to deposit/withdraw modal hints
function applyLimitsToModals() {
    const limits = DB.getLimitsSync();
    const minDeposit = Number(limits.minDeposit) || 100;
    const minWithdraw = Number(limits.minWithdraw) || 100;
    const depInput = document.getElementById('deposit-amount');
    const wdInput = document.getElementById('withdraw-amount');
    if (depInput) {
        depInput.min = minDeposit;
        depInput.placeholder = `Enter amount to deposit (min ₹${minDeposit})`;
    }
    if (wdInput) {
        wdInput.min = minWithdraw;
        wdInput.placeholder = `Enter amount to withdraw (min ₹${minWithdraw})`;
    }
}

async function submitAdminLimitSetting() {
    const minDeposit = adminMinDeposit ? parseInt(adminMinDeposit.value.trim()) : NaN;
    const minWithdraw = adminMinWithdraw ? parseInt(adminMinWithdraw.value.trim()) : NaN;

    if (isNaN(minDeposit) || minDeposit < 1) { alert('Please enter a valid minimum deposit amount.'); return; }
    if (isNaN(minWithdraw) || minWithdraw < 1) { alert('Please enter a valid minimum withdrawal amount.'); return; }

    try {
        const limits = { minDeposit, minWithdraw };
        await DB.saveLimits(limits);
        applyLimitsToModals();
        if (adminLimitsMsg) adminLimitsMsg.textContent = `Limits saved: Min Deposit ₹${minDeposit}, Min Withdraw ₹${minWithdraw}`;
        playSound('click');
    } catch (e) {
        alert('Failed to save limits: ' + e.message);
    }
}

async function submitAdminMaintenanceSetting() {
    const toggleEl = document.getElementById('admin-maintenance-toggle');
    const msgEl = document.getElementById('admin-maintenance-message');
    const detailsEl = document.getElementById('admin-maintenance-details');
    const statusEl = document.getElementById('admin-maintenance-msg');

    if (!toggleEl) return;

    const enabled = toggleEl.checked;

    try {
        const data = {
            enabled,
            endTime: enabled ? Date.now() + 24 * 60 * 60 * 1000 : 0,
            message: msgEl ? msgEl.value.trim() : 'Scheduled maintenance in progress',
            details: detailsEl ? detailsEl.value.trim() : ''
        };
        await DB.saveMaintenance(data);
        if (statusEl) statusEl.textContent = enabled ? 'Maintenance enabled!' : 'Maintenance disabled!';
        playSound('click');
        alert(enabled ? 'Maintenance mode enabled!' : 'Maintenance mode disabled!');
        await checkMaintenance();
    } catch (e) {
        alert('Failed to save maintenance settings: ' + e.message);
    }
}

async function submitAdminResetData() {
    const msgEl = document.getElementById('admin-reset-msg');
    const confirmed = prompt('This will PERMANENTLY delete all deposits, withdrawals, bets, history, and reset all user balances to zero. Type RESET to confirm:');
    if (confirmed !== 'RESET') {
        if (msgEl) msgEl.textContent = 'Reset cancelled.';
        return;
    }
    try {
        await DB.adminReset({ confirm: 'RESET' });
        if (msgEl) msgEl.textContent = 'All data reset successfully! Reloading...';
        playSound('click');
        setTimeout(() => location.reload(), 1500);
    } catch (e) {
        if (msgEl) msgEl.textContent = 'Reset failed: ' + e.message;
        alert('Reset failed: ' + e.message);
    }
}

// --- Admin Panel Operations ---
async function loadAdminDashboard() {
    if (!state.currentUser || state.currentUser.role !== 'admin') return;

    try {
        const [bankConfig, supportConfig, deposits, withdrawals, users, rigs, limits, maintenance] = await Promise.all([
            DB.getBankConfig(),
            DB.getSupportConfig(),
            DB.getDeposits(),
            DB.getWithdrawals(),
            DB.getUsers(),
            DB.getRigs(),
            DB.getLimits(),
            DB.getMaintenance()
        ]);

        if (adminMinDeposit) adminMinDeposit.value = limits.minDeposit || 100;
        if (adminMinWithdraw) adminMinWithdraw.value = limits.minWithdraw || 100;
        applyLimitsToModals();

        // Load maintenance settings
        if (maintenance) {
            const toggleEl = document.getElementById('admin-maintenance-toggle');
            const msgEl = document.getElementById('admin-maintenance-message');
            const detailsEl = document.getElementById('admin-maintenance-details');
            if (toggleEl) toggleEl.checked = !!maintenance.enabled;
            if (msgEl) msgEl.value = maintenance.message || '';
            if (detailsEl) detailsEl.value = maintenance.details || '';
        }

        // Render business dashboard stats
        try {
            const stats = await DB.getAdminStats();
            const fmt = (n) => '₹' + (Number(n) || 0).toFixed(2);
            if (admnStatUsers) admnStatUsers.textContent = stats.totalUsers;
            if (admnStatDeposits) admnStatDeposits.textContent = fmt(stats.totalApprovedDeposits);
            if (admnStatWithdrawals) admnStatWithdrawals.textContent = fmt(stats.totalApprovedWithdrawals);
            if (admnStatBets) admnStatBets.textContent = fmt(stats.totalBets);
            if (admnStatPayouts) admnStatPayouts.textContent = fmt(stats.totalPayouts);
            if (admnStatProfit) {
                admnStatProfit.textContent = fmt(stats.companyProfit);
                admnStatProfit.style.color = stats.companyProfit >= 0 ? '#22c55e' : '#f87171';
            }
        } catch (statsErr) {
            console.error('loadAdminStats error:', statsErr.message);
        }

        if (adminAccountHolder) adminAccountHolder.value = bankConfig.accountHolder || '';
        if (adminBankName) adminBankName.value = bankConfig.bankName || '';
        if (adminUpiId) adminUpiId.value = bankConfig.upiId || '';
        if (adminQrUrl) adminQrUrl.value = bankConfig.qrUrl || '';

        if (adminSupportTelegram) adminSupportTelegram.value = supportConfig.telegram || '';
        if (adminSupportEmail) adminSupportEmail.value = supportConfig.email || '';
        if (adminSupportPhone) adminSupportPhone.value = supportConfig.phone || '';

        if (adminRigPeriod) adminRigPeriod.value = state.currentPeriod;
        if (adminSetPeriodInput) adminSetPeriodInput.value = state.currentPeriod;

        if (adminActiveRigs) {
            adminActiveRigs.textContent = rigs[state.currentPeriod] !== undefined
                ? `Rig active: Target number for next round is ${rigs[state.currentPeriod]}`
                : 'No target rigged. Round outcome is fair random.';
        }

        // Render pending deposits
        const pendingDeps = deposits.filter(d => d.status === 'pending');
        if (adminDepositsTbody) {
            adminDepositsTbody.innerHTML = pendingDeps.length === 0
                ? `<tr><td colspan="4" style="text-align:center; padding: 12px; color: var(--text-gray);">No pending requests</td></tr>`
                : pendingDeps.map(d => `
                    <tr>
                        <td><b>${d.username}</b></td>
                        <td>₹${d.amount.toFixed(2)}</td>
                        <td><code style="background: #e2e8f0; padding: 2px 4px; border-radius: 4px;">${d.utr}</code></td>
                        <td>
                            <button class="admin-btn approve" onclick="adminApproveDeposit('${d.id}')">Approve</button>
                            <button class="admin-btn reject" onclick="adminRejectDeposit('${d.id}')">Reject</button>
                        </td>
                    </tr>
                `).join('');
        }

        // Render pending withdrawals
        const pendingWith = withdrawals.filter(w => w.status === 'pending');
        if (adminWithdrawalsTbody) {
            adminWithdrawalsTbody.innerHTML = pendingWith.length === 0
                ? `<tr><td colspan="4" style="text-align:center; padding: 12px; color: var(--text-gray);">No pending requests</td></tr>`
                : pendingWith.map(w => `
                    <tr>
                        <td><b>${w.username}</b></td>
                        <td>₹${w.amount.toFixed(2)}</td>
                        <td><code>${w.upiId}</code></td>
                        <td>
                            <button class="admin-btn approve" onclick="adminApproveWithdrawal('${w.id}')">Approve</button>
                            <button class="admin-btn reject" onclick="adminRejectWithdrawal('${w.id}')">Reject</button>
                        </td>
                    </tr>
                `).join('');
        }

        // Render users
        if (adminUsersTbody) {
            adminUsersTbody.innerHTML = users.map(u => `
                <tr>
                    <td><b>${u.username}</b> ${u.role === 'admin' ? '<span style="color:var(--color-blue); font-size:0.65rem;">(Admin)</span>' : ''}</td>
                    <td>${u.phone}</td>
                    <td style="color:#000; font-weight:600;">₹${u.balance.toFixed(2)}</td>
                    <td><button class="admin-btn edit" onclick="adminEditUserBalance('${u.id}')">Edit Balance</button></td>
                </tr>
            `).join('');
        }
    } catch (e) {
        console.error('loadAdminDashboard error:', e.message);
    }
}

async function submitAdminBankSetting() {
    const holder = adminAccountHolder ? adminAccountHolder.value.trim() : '';
    const bank = adminBankName ? adminBankName.value.trim() : '';
    const upi = adminUpiId ? adminUpiId.value.trim() : '';
    const qr = adminQrUrl ? adminQrUrl.value.trim() : '';

    if (!upi) { alert('Please enter a valid Merchant UPI ID.'); return; }

    try {
        const config = {
            accountHolder: holder || 'Predict Pro Official',
            bankName: bank || 'HDFC Bank',
            upiId: upi,
            qrUrl: qr
        };
        await DB.saveBankConfig(config);
        await updateDepositSheetDetails();
        if (adminBankMsg) adminBankMsg.textContent = 'Deposit bank details & QR code updated successfully!';
        playSound('win');
        alert('Deposit Method Settings Saved!');
    } catch (e) {
        alert('Failed to save bank config: ' + e.message);
    }
}

async function submitAdminSupportSetting() {
    const telegram = adminSupportTelegram ? adminSupportTelegram.value.trim() : '';
    const email = adminSupportEmail ? adminSupportEmail.value.trim() : '';
    const phone = adminSupportPhone ? adminSupportPhone.value.trim() : '';

    try {
        await DB.saveSupportConfig({ telegram, email, phone });
        if (adminSupportMsg) adminSupportMsg.textContent = 'Customer Support contact settings updated!';
        playSound('win');
        alert('Customer Support Settings Saved!');
    } catch (e) {
        alert('Failed to save support config: ' + e.message);
    }
}

// Global admin actions (onclick from table rows)
window.adminApproveDeposit = async (id) => {
    try {
        const deposits = await DB.getDeposits();
        const dep = deposits.find(d => d.id === id);
        if (!dep) return;

        const users = await DB.getUsers();
        const user = users.find(u => u.id === dep.userId);
        if (user) {
            await DB.saveUser({ ...user, balance: user.balance + dep.amount });
        }

        await DB.updateDeposit({ ...dep, status: 'approved' });
        playSound('win');
        alert('Deposit approved successfully!');
        await loadAdminDashboard();

        // Refresh current session user balance if needed
        if (state.currentUser && state.currentUser.id === dep.userId) {
            const updatedUsers = await DB.getUsers();
            const freshUser = updatedUsers.find(u => u.id === state.currentUser.id);
            if (freshUser) {
                state.currentUser = freshUser;
                safeStorage.setItem('predict_session', JSON.stringify(freshUser));
                if (userBalanceEl) userBalanceEl.textContent = freshUser.balance.toFixed(2);
            }
        }
    } catch (e) { alert('Error: ' + e.message); }
};

window.adminRejectDeposit = async (id) => {
    try {
        const deposits = await DB.getDeposits();
        const dep = deposits.find(d => d.id === id);
        if (!dep) return;
        await DB.updateDeposit({ ...dep, status: 'rejected' });
        playSound('lose');
        alert('Deposit request rejected.');
        await loadAdminDashboard();
    } catch (e) { alert('Error: ' + e.message); }
};

window.adminApproveWithdrawal = async (id) => {
    try {
        const withdrawals = await DB.getWithdrawals();
        const w = withdrawals.find(x => x.id === id);
        if (!w) return;
        await DB.updateWithdrawal({ ...w, status: 'approved' });
        playSound('win');
        alert('Withdrawal approved successfully!');
        await loadAdminDashboard();
    } catch (e) { alert('Error: ' + e.message); }
};

window.adminRejectWithdrawal = async (id) => {
    try {
        const withdrawals = await DB.getWithdrawals();
        const w = withdrawals.find(x => x.id === id);
        if (!w) return;

        // Refund balance
        const users = await DB.getUsers();
        const user = users.find(u => u.id === w.userId);
        if (user) {
            const updatedUser = { ...user, balance: user.balance + w.amount };
            await DB.saveUser(updatedUser);
            if (state.currentUser && state.currentUser.id === w.userId) {
                state.currentUser = updatedUser;
                safeStorage.setItem('predict_session', JSON.stringify(updatedUser));
                if (userBalanceEl) userBalanceEl.textContent = updatedUser.balance.toFixed(2);
            }
        }

        await DB.updateWithdrawal({ ...w, status: 'rejected' });
        playSound('lose');
        alert('Withdrawal rejected. Funds refunded to user wallet.');
        await loadAdminDashboard();
    } catch (e) { alert('Error: ' + e.message); }
};

window.adminEditUserBalance = async (userId) => {
    try {
        const users = await DB.getUsers();
        const u = users.find(x => x.id === userId);
        if (!u) return;

        const inputVal = prompt(`Enter new balance for ${u.username}:`, u.balance);
        if (inputVal === null) return;

        const newBal = parseFloat(inputVal);
        if (isNaN(newBal) || newBal < 0) { alert('Please enter a valid balance.'); return; }

        const updatedUser = { ...u, balance: newBal };
        await DB.saveUser(updatedUser);

        if (state.currentUser && state.currentUser.id === userId) {
            state.currentUser = updatedUser;
            safeStorage.setItem('predict_session', JSON.stringify(updatedUser));
            if (userBalanceEl) userBalanceEl.textContent = updatedUser.balance.toFixed(2);
        }

        alert('Balance updated successfully!');
        await loadAdminDashboard();
    } catch (e) { alert('Error: ' + e.message); }
};

async function submitAdminPeriodSetting() {
    if (!adminSetPeriodInput) return;
    const val = adminSetPeriodInput.value.trim();
    if (!val) { alert('Please enter a period ID.'); return; }

    try {
        await DB.savePeriod({ currentPeriod: val });
        state.currentPeriod = val;
        updatePeriodDisplay();
        if (adminPeriodMsg) adminPeriodMsg.textContent = `Period set to: ${val}`;
        playSound('win');
        alert(`Period updated! Current active period is now: ${val}`);
    } catch (e) {
        alert('Failed to update period: ' + e.message);
    }
}

async function submitAdminRigOutcome() {
    const rigs = await DB.getRigs();
    const val = adminRigNumber.value;
    const activePeriod = state.currentPeriod;

    try {
        if (val === '') {
            delete rigs[activePeriod];
            await DB.saveRigs(rigs);
            alert('RIG outcome removed. Fair random results active.');
        } else {
            rigs[activePeriod] = parseInt(val);
            await DB.saveRigs(rigs);
            alert(`Target rigged! Next number for period ${activePeriod} will be ${val}.`);
        }
        await loadAdminDashboard();
        playSound('click');
    } catch (e) {
        alert('Failed to save rig: ' + e.message);
    }
}

// --- Server-Synced Clock Countdown Timer ---
async function syncRoundFromServer() {
    try {
        const [round, history] = await Promise.all([
            DB.getRound(),
            DB.getHistory()
        ]);
        const prevPeriod = state.currentPeriod;
        state.roundEndTimestamp = round.endTimestamp;
        state._lastRoundSync = Date.now();
        state.history = history;

        if (round.period && prevPeriod && round.period !== prevPeriod) {
            state.currentPeriod = round.period;
            updatePeriodDisplay();

            if (round.lastResult && round.lastResult.period === prevPeriod) {
                await showOutcomeForPeriod(prevPeriod, round.lastResult);
            }

            if (state.currentUser) {
                state.activeBets = await DB.getUserBets(state.currentPeriod, state.currentUser.id);
            }
        }

        if (state.currentPeriod !== round.period) {
            state.currentPeriod = round.period;
            updatePeriodDisplay();
        }

        state.timeLeft = Math.max(0, Math.ceil((state.roundEndTimestamp - Date.now()) / 1000));

        renderRecords();
        renderTrends();
        if (state.currentUser) {
            renderActiveBets();
        }
    } catch (e) {
        console.warn('round sync failed:', e.message);
    }
}

async function showOutcomeForPeriod(period, lastResult) {
    if (!state.currentUser) return;
    try {
        const mybets = await DB.getMyBets(state.currentUser.id);
        const periodBets = mybets.filter(b => b.period === period);
        if (periodBets.length === 0) return;
        const totalBetCost = periodBets.reduce((s, b) => s + (b.amount || 0), 0);
        const totalPayout = periodBets.reduce((s, b) => s + (b.payout || 0), 0);
        showOutcomeDialog(totalPayout, totalBetCost, lastResult.number, lastResult.colors);
    } catch (e) { console.warn('outcome dialog failed:', e.message); }
}

function startTimer() {
    setInterval(async () => {
        // Use server endTimestamp so every device shows the same countdown
        state.timeLeft = Math.max(0, Math.ceil((state.roundEndTimestamp - Date.now()) / 1000));
        updateTimerUI();

        const lockoutOverlay = document.getElementById('lockout-overlay');
        const lockoutDigit = document.getElementById('lockout-timer-digit');
        if (state.timeLeft <= 5) {
            if (state.timeLeft === 5) playSound('lockout');
            else if (state.timeLeft > 0) playSound('tick');
            if (lockoutOverlay) lockoutOverlay.classList.add('active');
            if (lockoutDigit) lockoutDigit.textContent = state.timeLeft > 0 ? state.timeLeft : '0';
            closeBetModal();
        } else {
            if (lockoutOverlay) lockoutOverlay.classList.remove('active');
        }

        // Round just ended — immediately fetch server result/new round
        if (state.timeLeft === 0 && Date.now() - state._lastRoundSync > 1000) {
            state._lastRoundSync = Date.now();
            await syncRoundFromServer();
        }
    }, 1000);
}

function updateTimerUI() {
    const min = Math.floor(state.timeLeft / 60);
    const sec = state.timeLeft % 60;
    const min1 = document.getElementById('timer-min-1');
    const min2 = document.getElementById('timer-min-2');
    const sec1 = document.getElementById('timer-sec-1');
    const sec2 = document.getElementById('timer-sec-2');
    if (min1) min1.textContent = Math.floor(min / 10);
    if (min2) min2.textContent = min % 10;
    if (sec1) sec1.textContent = Math.floor(sec / 10);
    if (sec2) sec2.textContent = sec % 10;
    const digits = document.querySelectorAll('.digit');
    digits.forEach(d => { d.style.color = state.timeLeft <= 5 ? 'var(--color-red)' : 'var(--color-blue)'; });
}

// --- Event Listeners ---
function setupEventListeners() {
    if (toggleToSignup) toggleToSignup.addEventListener('click', () => {
        playSound('click');
        if (loginCard) loginCard.style.display = 'none';
        if (signupCard) {
            signupCard.style.display = 'block';
            if (signupReferralCodeInput && !signupReferralCodeInput.value) {
                const storedRef = safeStorage.getItem('predict_ref');
                if (storedRef) signupReferralCodeInput.value = storedRef;
            }
        }
    });
    if (toggleToLogin) toggleToLogin.addEventListener('click', () => {
        playSound('click');
        if (signupCard) signupCard.style.display = 'none';
        if (loginCard) loginCard.style.display = 'block';
    });

    if (btnLoginSubmit) btnLoginSubmit.addEventListener('click', handleLogin);
    if (btnSignupSubmit) btnSignupSubmit.addEventListener('click', handleSignup);
    if (btnLogout) btnLogout.addEventListener('click', handleLogout);

    if (btnDepositTrigger) btnDepositTrigger.addEventListener('click', () => {
        if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); alert('Please sign in to deposit!'); return; }
        playSound('click');
        updateDepositSheetDetails();
        if (depositModalOverlay) depositModalOverlay.classList.add('active');
    });
    if (depositModalClose) depositModalClose.addEventListener('click', () => {
        if (depositModalOverlay) depositModalOverlay.classList.remove('active');
        playSound('click');
    });
    if (btnDepositSubmit) btnDepositSubmit.addEventListener('click', submitDepositRequest);

    if (btnCopyUpi) btnCopyUpi.addEventListener('click', () => {
        const upiEl = document.getElementById('copy-upi-id');
        if (!upiEl) return;
        const upiText = upiEl.textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(upiText).then(() => { playSound('win'); alert(`UPI ID "${upiText}" copied!`); }).catch(() => alert(`UPI ID: ${upiText}`));
        } else { alert(`UPI ID: ${upiText}`); }
    });

    const btnCopyReferral = document.getElementById('btn-copy-referral');
    if (btnCopyReferral) btnCopyReferral.addEventListener('click', () => {
        const linkEl = document.getElementById('referral-link');
        if (!linkEl) return;
        const text = linkEl.textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => { playSound('win'); alert('Referral link copied!'); }).catch(() => alert(`Referral link: ${text}`));
        } else { alert(`Referral link: ${text}`); }
    });

    if (btnWithdrawTrigger) btnWithdrawTrigger.addEventListener('click', () => {
        if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); alert('Please sign in to withdraw!'); return; }
        playSound('click');
        if (withdrawModalOverlay) withdrawModalOverlay.classList.add('active');
    });
    if (withdrawModalClose) withdrawModalClose.addEventListener('click', () => {
        if (withdrawModalOverlay) withdrawModalOverlay.classList.remove('active');
        playSound('click');
    });
    if (btnWithdrawSubmit) btnWithdrawSubmit.addEventListener('click', submitWithdrawalRequest);

    if (btnAdminSaveBank) btnAdminSaveBank.addEventListener('click', submitAdminBankSetting);
    if (btnAdminSaveSupport) btnAdminSaveSupport.addEventListener('click', submitAdminSupportSetting);
    if (btnAdminSavePeriod) btnAdminSavePeriod.addEventListener('click', submitAdminPeriodSetting);
    if (btnAdminRigSubmit) btnAdminRigSubmit.addEventListener('click', submitAdminRigOutcome);
    if (btnAdminSaveLimits) btnAdminSaveLimits.addEventListener('click', submitAdminLimitSetting);
    const btnAdminSaveMaintenance = document.getElementById('btn-admin-save-maintenance');
    if (btnAdminSaveMaintenance) btnAdminSaveMaintenance.addEventListener('click', submitAdminMaintenanceSetting);
    const btnAdminResetData = document.getElementById('btn-admin-reset-data');
    if (btnAdminResetData) btnAdminResetData.addEventListener('click', submitAdminResetData);

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            playSound('click');
            switchTab(btn.getAttribute('data-tab'));
        });
    });

    document.querySelectorAll('.btn-game-color').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); alert('Please sign in to place predictions!'); return; }
            if (state.timeLeft <= 5) return;
            openBetModal(btn.getAttribute('data-target'));
        });
    });

    document.querySelectorAll('.btn-number').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); alert('Please sign in to place predictions!'); return; }
            if (state.timeLeft <= 5) return;
            openBetModal(parseInt(btn.getAttribute('data-num')));
        });
    });

    const navToTrends = document.getElementById('nav-to-trends');
    if (navToTrends) navToTrends.addEventListener('click', () => { playSound('click'); switchTab('trends'); });

    if (btnSound) btnSound.addEventListener('click', () => {
        state.isMuted = !state.isMuted;
        updateUI();
        safeStorage.setItem('predict_muted', state.isMuted);
        playSound('click');
    });

    if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeBetModal);
    if (betModalOverlay) betModalOverlay.addEventListener('click', e => { if (e.target === betModalOverlay) closeBetModal(); });

    document.querySelectorAll('.btn-mult-option').forEach(btn => {
        btn.addEventListener('click', () => {
            playSound('click');
            document.querySelectorAll('.btn-mult-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.betMultiplier = parseInt(btn.getAttribute('data-mult'));
            updateBetModalSummary();
        });
    });

    document.querySelectorAll('.btn-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            playSound('click');
            document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.betBaseAmount = parseInt(btn.getAttribute('data-val'));
            updateBetModalSummary();
        });
    });

    if (btnConfirmBet) btnConfirmBet.addEventListener('click', placeBet);

    if (dialogCloseBtn) dialogCloseBtn.addEventListener('click', () => {
        playSound('click');
        if (resultDialogOverlay) resultDialogOverlay.classList.remove('active');
    });

    const btnDepositSuccessClose = document.getElementById('btn-deposit-success-close');
    const depositSuccessOverlay = document.getElementById('deposit-success-dialog-overlay');
    if (btnDepositSuccessClose && depositSuccessOverlay) {
        btnDepositSuccessClose.addEventListener('click', () => { playSound('click'); depositSuccessOverlay.classList.remove('active'); });
    }

    // Profile Tab buttons
    const profileBtnDeposit = document.getElementById('profile-btn-deposit');
    if (profileBtnDeposit) profileBtnDeposit.addEventListener('click', () => {
        if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); return; }
        playSound('click'); updateDepositSheetDetails();
        if (depositModalOverlay) depositModalOverlay.classList.add('active');
    });

    const profileBtnWithdraw = document.getElementById('profile-btn-withdraw');
    if (profileBtnWithdraw) profileBtnWithdraw.addEventListener('click', () => {
        if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); return; }
        playSound('click');
        if (withdrawModalOverlay) withdrawModalOverlay.classList.add('active');
    });

    const btnChangePassword = document.getElementById('btn-change-password');
    if (btnChangePassword) btnChangePassword.addEventListener('click', handlePasswordChange);

    const profileBtnLogoutMain = document.getElementById('profile-btn-logout-main');
    if (profileBtnLogoutMain) profileBtnLogoutMain.addEventListener('click', handleLogout);

    document.querySelectorAll('.txn-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            playSound('click');
            document.querySelectorAll('.txn-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderProfileTransactions(btn.getAttribute('data-filter'));
        });
    });
}

function switchTab(tabName) {
    state.currentTab = tabName;
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `tab-${tabName}`);
    });
    if (tabName === 'trends') renderTrends();
    else if (tabName === 'mybets') renderMyBets();
    else if (tabName === 'referral') renderReferral();
    else if (tabName === 'history') renderHistory();
    else if (tabName === 'profile') renderProfile();
    else if (tabName === 'admin') loadAdminDashboard();
}

// --- Bet Modal ---
function openBetModal(selection) {
    playSound('click');
    state.betSelection = selection;
    state.betMultiplier = 1;
    document.querySelectorAll('.btn-mult-option').forEach(b => {
        b.classList.toggle('active', parseInt(b.getAttribute('data-mult')) === state.betMultiplier);
    });
    if (modalBetTarget) {
        modalBetTarget.textContent = typeof selection === 'number' ? `NUMBER ${selection}` : selection.toUpperCase();
        modalBetTarget.className = 'bet-badge';
        if (selection === 'green') modalBetTarget.classList.add('green');
        else if (selection === 'red') modalBetTarget.classList.add('red');
        else if (selection === 'violet') modalBetTarget.classList.add('violet');
        else modalBetTarget.classList.add('number');
    }
    updateBetModalSummary();
    if (betModalOverlay) betModalOverlay.classList.add('active');
}

function closeBetModal() {
    if (betModalOverlay) betModalOverlay.classList.remove('active');
}

function updateBetModalSummary() {
    const cost = state.betBaseAmount * state.betMultiplier;
    const ratio = getPayoutRatio(state.betSelection);
    if (previewBaseEl) previewBaseEl.textContent = `₹${state.betBaseAmount.toFixed(2)}`;
    if (previewMultEl) previewMultEl.textContent = `x ${state.betMultiplier}`;
    if (previewTotalEl) previewTotalEl.textContent = `₹${cost.toFixed(2)}`;
    if (previewPayoutEl) previewPayoutEl.textContent = `₹${(cost * ratio).toFixed(2)}`;
}

function getPayoutRatio(selection) {
    if (selection === 'green' || selection === 'red') return 2.0;
    if (selection === 'violet') return 4.5;
    return 9.0;
}

async function placeBet() {
    if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); return; }
    const cost = state.betBaseAmount * state.betMultiplier;

    try {
        // Server-side bet placement: balance deducted + bet recorded on server
        const result = await DB.placeServerBet({
            userId: state.currentUser.id,
            username: state.currentUser.username,
            target: state.betSelection,
            amount: cost,
            period: state.currentPeriod
        });

        state.currentUser.balance = result.balance;
        safeStorage.setItem('predict_session', JSON.stringify(state.currentUser));
        if (userBalanceEl) userBalanceEl.textContent = result.balance.toFixed(2);

        state.activeBets.push({
            target: state.betSelection,
            amount: cost,
            period: state.currentPeriod,
            timestamp: Date.now()
        });

        closeBetModal();
        renderActiveBets();
        playSound('click');
    } catch (e) {
        alert('Bet failed: ' + e.message);
        playSound('lose');
    }
}

function renderActiveBets() {
    if (!activeBetsListEl) return;
    if (state.activeBets.length === 0) {
        activeBetsListEl.innerHTML = '<div class="empty-bets-state">No bets placed in this round yet.</div>';
        return;
    }
    activeBetsListEl.innerHTML = state.activeBets.map(bet => {
        let displayTarget = typeof bet.target === 'number' ? `Number: ${bet.target}` : bet.target;
        let badgeClass = typeof bet.target === 'number' ? 'number' : bet.target;
        return `
            <div class="active-bet-item">
                <div class="bet-target"><span class="bet-badge ${badgeClass}">${displayTarget}</span></div>
                <div class="bet-details">
                    <span class="bet-amount">₹${bet.amount.toFixed(2)}</span>
                    <span class="bet-status">Pending</span>
                </div>
            </div>
        `;
    }).join('');
}

// --- Round Resolution (server-side only — clients stay in sync) ---
function showOutcomeDialog(totalWin, totalBetCost, winNum, winColors) {
    const won = totalWin > 0;
    const winAmount = totalWin - totalBetCost;

    if (resultDialogBox) resultDialogBox.className = 'dialog-box ' + (won ? 'win' : 'loss');
    if (won) {
        playSound('win');
        if (dialogTitleEl) dialogTitleEl.textContent = 'CONGRATS! YOU WON';
        if (dialogDescEl) dialogDescEl.textContent = `You made a profit of ₹${winAmount.toFixed(2)}`;
        if (dialogIconEl) dialogIconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:28px;height:28px"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138z"/></svg>`;
        triggerConfetti(40);
    } else {
        playSound('lose');
        if (dialogTitleEl) dialogTitleEl.textContent = 'ROUND MISSED';
        if (dialogDescEl) dialogDescEl.textContent = `You lost ₹${totalBetCost.toFixed(2)}. Better luck next time!`;
        if (dialogIconEl) dialogIconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:28px;height:28px"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`;
    }

    if (dialogWinningCircleEl) {
        dialogWinningCircleEl.textContent = winNum;
        dialogWinningCircleEl.className = 'circle-dot';
        if (winColors.length === 2) dialogWinningCircleEl.classList.add(winColors[0] + '-' + winColors[1]);
        else dialogWinningCircleEl.classList.add(winColors[0]);
    }
    if (resultDialogOverlay) resultDialogOverlay.classList.add('active');
}

function triggerConfetti(count) {
    if (!confettiCanvas) return;
    confettiCanvas.innerHTML = '';
    const colors = ['#4bb475', '#e15244', '#625df5', '#f39c12', '#3a86ff'];
    for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.className = 'confetti-particle';
        p.style.left = Math.random() * 100 + '%';
        p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        p.style.width = Math.random() * 5 + 4 + 'px';
        p.style.height = Math.random() * 5 + 4 + 'px';
        p.style.animationDuration = Math.random() * 1.0 + 1.0 + 's';
        p.style.animationDelay = Math.random() * 0.2 + 's';
        confettiCanvas.appendChild(p);
    }
}

// --- Records & Trends ---
function renderRecords() {
    if (!recordsGridViewEl) return;
    const recentRecords = state.history.slice(0, 12);
    let html = `<div class="record-circle"><div class="circle-dot pending">?</div><span class="record-period">${state.currentPeriod.slice(-3)}</span></div>`;
    html += recentRecords.map(rec => {
        let colorsClass = rec.colors.join('-');
        let shortPeriod = rec.period.slice(-3);
        return `<div class="record-circle"><div class="circle-dot ${colorsClass}">${rec.number}</div><span class="record-period">${shortPeriod}</span></div>`;
    }).join('');
    recordsGridViewEl.innerHTML = html;
}

function renderTrends() {
    if (state.history.length === 0) return;
    const statsList = state.history.slice(0, 50);
    const total = statsList.length;
    let greenCount = 0, redCount = 0, violetCount = 0;
    statsList.forEach(rec => {
        if (rec.colors.includes('green')) greenCount++;
        if (rec.colors.includes('red')) redCount++;
        if (rec.colors.includes('violet')) violetCount++;
    });
    const el = (id) => document.getElementById(id);
    if (el('stat-green-percent')) el('stat-green-percent').textContent = `${total ? Math.round((greenCount / total) * 100) : 0}%`;
    if (el('stat-red-percent')) el('stat-red-percent').textContent = `${total ? Math.round((redCount / total) * 100) : 0}%`;
    if (el('stat-violet-percent')) el('stat-violet-percent').textContent = `${total ? Math.round((violetCount / total) * 100) : 0}%`;
    if (el('count-green')) el('count-green').textContent = greenCount;
    if (el('count-violet')) el('count-violet').textContent = violetCount;
    if (el('count-red')) el('count-red').textContent = redCount;
    const maxVal = Math.max(greenCount, redCount, violetCount) || 1;
    if (el('bar-green')) el('bar-green').style.width = `${(greenCount / maxVal) * 100}%`;
    if (el('bar-violet')) el('bar-violet').style.width = `${(violetCount / maxVal) * 100}%`;
    if (el('bar-red')) el('bar-red').style.width = `${(redCount / maxVal) * 100}%`;
    const trendMapGrid = el('trend-map-grid');
    if (trendMapGrid) {
        trendMapGrid.innerHTML = state.history.slice(0, 20).map(rec => {
            const style = `background-color: var(--color-${rec.colors[0]})`;
            return `<div class="trend-map-dot" style="${style}; color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1)">${rec.number}</div>`;
        }).join('');
    }
}

async function renderHistory() {
    const container = document.getElementById('history-list-container');
    if (!container) return;
    try {
        const history = await DB.getHistory();
        if (history.length === 0) {
            container.innerHTML = '<div class="empty-txn-state">No history records found.</div>';
            return;
        }
        container.innerHTML = history.map(rec => {
            const colorsClass = rec.colors.join('-');
            const dateStr = rec.period ? rec.period.slice(0, 8) : '';
            const periodShort = rec.period ? rec.period.slice(-4) : '';
            return `
                <div class="history-item">
                    <div class="history-left">
                        <span class="history-period">Period: ${rec.period}</span>
                        <span class="history-date">${dateStr}</span>
                    </div>
                    <div class="history-right">
                        <span class="circle-dot ${colorsClass}" style="width:28px;height:28px;font-size:0.85rem;border:none;display:inline-flex">${rec.number}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        container.innerHTML = '<div class="empty-txn-state">Could not load history.</div>';
    }
}

async function renderMyBets() {
        const container = document.getElementById('bets-history-container');
        if (!container) return;
        if (!state.currentUser) {
            container.innerHTML = '<div class="empty-history-state"><p>Please login to see your betting logs.</p></div>';
            return;
        }
        try {
            const mybets = await DB.getMyBets(state.currentUser.id);
            if (mybets.length === 0) {
                container.innerHTML = '<div class="empty-history-state"><p>No history found. Place some bets to see records here!</p></div>';
                return;
            }
            container.innerHTML = mybets.map(bet => {
                const betWon = bet.status === 'won';
                let targetDisplay = typeof bet.target === 'number' ? `Number: ${bet.target}` : bet.target.toUpperCase();
                let targetBadgeClass = typeof bet.target === 'number' ? 'number' : bet.target;
                let payoutInfo = betWon
                    ? `<span class="history-col-val won">+₹${bet.payout.toFixed(2)}</span>`
                    : `<span class="history-col-val" style="color: var(--text-gray)">-₹${bet.amount.toFixed(2)}</span>`;
                let colorsClass = bet.resultColors.join('-');
                let winningResultHtml = `<span class="circle-dot ${colorsClass}" style="width:18px;height:18px;font-size:0.65rem;border:none;display:inline-flex">${bet.resultNumber}</span>`;
                return `
                    <div class="history-bet-card">
                        <div class="history-card-top">
                            <span class="history-period-lbl">Period: ${bet.period}</span>
                            <span class="history-status-lbl ${bet.status}">${bet.status}</span>
                        </div>
                        <div class="history-card-details">
                            <div class="history-col">
                                <span class="history-col-label">Bet On</span>
                                <span class="history-col-val"><span class="bet-badge ${targetBadgeClass}" style="padding:1px 4px;font-size:0.65rem;">${targetDisplay}</span></span>
                            </div>
                            <div class="history-col">
                                <span class="history-col-label">Outcome</span>
                                <span class="history-col-val">${winningResultHtml}</span>
                            </div>
                            <div class="history-col" style="text-align:right;">
                                <span class="history-col-label">Payout / Net</span>
                                ${payoutInfo}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        } catch (e) {
            container.innerHTML = '<div class="empty-history-state"><p>Could not load bet history.</p></div>';
        }
    }

    async function renderReferral() {
        if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); return; }
        try {
            const data = await DB.getReferral(state.currentUser.id);
            const linkEl = document.getElementById('referral-link');
            if (linkEl) linkEl.textContent = `${location.origin}/?ref=${data.myCode}`;
            const totalUsersEl = document.getElementById('referral-total-users');
            if (totalUsersEl) totalUsersEl.textContent = data.totalUsers;
            const totalIncomeEl = document.getElementById('referral-total-income');
            if (totalIncomeEl) totalIncomeEl.textContent = '₹' + Number(data.totalIncome || 0).toFixed(2);
            const listEl = document.getElementById('referral-users-list');
            if (!listEl) return;
            if (!data.referrals || data.referrals.length === 0) {
                listEl.innerHTML = '<div class="empty-txn-state">No referrals yet. Share your link to earn ₹20 per friend!</div>';
                return;
            }
            listEl.innerHTML = data.referrals.map(r => {
                const dateObj = new Date(r.timestamp);
                const dateStr = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' + dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
                return `
                    <div class="txn-item">
                        <div class="txn-left">
                            <div class="txn-type-badge deposit">Referral</div>
                            <div class="txn-details">
                                <span class="txn-ref">${r.username}</span>
                                <span class="txn-date">${dateStr}</span>
                            </div>
                        </div>
                        <div class="txn-right">
                            <span class="txn-amount plus">+₹${r.bonus.toFixed(2)}</span>
                        </div>
                    </div>
                `;
            }).join('');
        } catch (e) {
            const listEl = document.getElementById('referral-users-list');
            if (listEl) listEl.innerHTML = '<div class="empty-txn-state">Could not load referral data.</div>';
        }
    }

function updateUI() {
    if (state.isMuted) {
        if (soundOnIcon) soundOnIcon.style.display = 'none';
        if (soundOffIcon) soundOffIcon.style.display = 'block';
    } else {
        if (soundOnIcon) soundOnIcon.style.display = 'block';
        if (soundOffIcon) soundOffIcon.style.display = 'none';
    }
}

// --- Profile Tab ---
let currentTxnFilter = 'all';

async function renderProfile() {
    if (!state.currentUser) { if (authOverlay) authOverlay.classList.add('active'); return; }

    const u = state.currentUser;
    const el = (id) => document.getElementById(id);
    let displayUid = u.id ? u.id.replace(/^u_/, '') : '849001';
    if (!isNaN(displayUid) && displayUid.length > 8) displayUid = displayUid.slice(-6);

    if (el('profile-card-username')) el('profile-card-username').textContent = u.username;
    if (el('profile-card-phone')) el('profile-card-phone').textContent = u.phone ? `+91 ${u.phone}` : 'No phone registered';
    if (el('profile-uid-val')) el('profile-uid-val').textContent = displayUid;
    if (el('profile-card-balance')) el('profile-card-balance').textContent = u.balance.toFixed(2);

    // Load support config for display
    try {
        const supportConfig = await DB.getSupportConfig();
        const tgBtn = el('profile-support-telegram-btn');
        const tgLbl = el('profile-support-telegram-lbl');
        const emailBtn = el('profile-support-email-btn');
        const emailLbl = el('profile-support-email-lbl');
        const waBtn = el('profile-support-whatsapp-btn');
        const waLbl = el('profile-support-whatsapp-lbl');

        if (supportConfig.telegram) {
            const tgLink = supportConfig.telegram.startsWith('http') ? supportConfig.telegram : `https://t.me/${supportConfig.telegram.replace('@', '')}`;
            if (tgBtn) { tgBtn.href = tgLink; tgBtn.style.display = 'flex'; }
            if (tgLbl) tgLbl.textContent = `Telegram Support (${supportConfig.telegram})`;
        } else {
            if (tgBtn) tgBtn.style.display = 'none';
        }

        if (supportConfig.email) {
            if (emailBtn) { emailBtn.href = `mailto:${supportConfig.email}`; emailBtn.style.display = 'flex'; }
            if (emailLbl) emailLbl.textContent = `Email Support (${supportConfig.email})`;
        } else {
            if (emailBtn) emailBtn.style.display = 'none';
        }

        if (supportConfig.phone) {
            const waLink = `https://wa.me/${supportConfig.phone.replace(/\D/g, '')}`;
            if (waBtn) { waBtn.href = waLink; waBtn.style.display = 'flex'; }
            if (waLbl) waLbl.textContent = `WhatsApp Helpline (${supportConfig.phone})`;
        }
    } catch {}

    await renderProfileTransactions(currentTxnFilter);
}

async function renderProfileTransactions(filter = 'all') {
    currentTxnFilter = filter;
    const container = document.getElementById('profile-transactions-container');
    if (!container) return;
    if (!state.currentUser) { container.innerHTML = '<div class="empty-txn-state">Please login to view transactions.</div>'; return; }

    try {
        const [deposits, withdrawals] = await Promise.all([DB.getDeposits(), DB.getWithdrawals()]);

        let allTxns = [
            ...deposits.filter(d => d.userId === state.currentUser.id).map(d => ({
                type: 'deposit', amount: d.amount, ref: `UTR: ${d.utr}`, status: d.status, timestamp: d.timestamp
            })),
            ...withdrawals.filter(w => w.userId === state.currentUser.id).map(w => ({
                type: 'withdraw', amount: w.amount, ref: `UPI: ${w.upiId}`, status: w.status, timestamp: w.timestamp
            }))
        ].sort((a, b) => b.timestamp - a.timestamp);

        if (filter === 'deposit') allTxns = allTxns.filter(t => t.type === 'deposit');
        else if (filter === 'withdraw') allTxns = allTxns.filter(t => t.type === 'withdraw');

        if (allTxns.length === 0) {
            container.innerHTML = `<div class="empty-txn-state">No ${filter === 'all' ? '' : filter} transaction history found.</div>`;
            return;
        }

        container.innerHTML = allTxns.map(t => {
            const isDep = t.type === 'deposit';
            const dateObj = new Date(t.timestamp);
            const dateStr = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' + dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            const statusClass = t.status === 'approved' ? 'approved' : t.status === 'rejected' ? 'rejected' : 'pending';
            const statusText = t.status === 'approved' ? 'Approved' : t.status === 'rejected' ? 'Rejected' : 'Pending';
            return `
                <div class="txn-item">
                    <div class="txn-left">
                        <div class="txn-type-badge ${t.type}">${isDep ? 'Deposit' : 'Withdrawal'}</div>
                        <div class="txn-details">
                            <span class="txn-ref">${t.ref}</span>
                            <span class="txn-date">${dateStr}</span>
                        </div>
                    </div>
                    <div class="txn-right">
                        <span class="txn-amount ${isDep ? 'plus' : 'minus'}">${isDep ? '+' : '-'}₹${t.amount.toFixed(2)}</span>
                        <span class="status-badge ${statusClass}">${statusText}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        container.innerHTML = '<div class="empty-txn-state">Could not load transactions.</div>';
    }
}

async function handlePasswordChange() {
    if (!state.currentUser) { alert('Please login first.'); return; }
    const oldPass = document.getElementById('profile-old-pass').value.trim();
    const newPass = document.getElementById('profile-new-pass').value.trim();
    const confirmPass = document.getElementById('profile-confirm-pass').value.trim();

    if (!oldPass || !newPass || !confirmPass) { alert('Please fill all password fields.'); return; }
    if (oldPass !== state.currentUser.password) { alert('Current password is incorrect!'); playSound('lose'); return; }
    if (newPass.length < 4) { alert('New password must be at least 4 characters long.'); return; }
    if (newPass !== confirmPass) { alert('New password and confirm password do not match!'); return; }

    try {
        const updatedUser = { ...state.currentUser, password: newPass };
        await DB.saveUser(updatedUser);
        state.currentUser = updatedUser;
        safeStorage.setItem('predict_session', JSON.stringify(updatedUser));
        playSound('win');
        alert('Password updated successfully!');
        document.getElementById('profile-old-pass').value = '';
        document.getElementById('profile-new-pass').value = '';
        document.getElementById('profile-confirm-pass').value = '';
    } catch (e) {
        alert('Password change failed: ' + e.message);
    }
}
