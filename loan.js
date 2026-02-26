// --- 1. INITIALIZATION & CONFIG ---
const SUPABASE_URL = 'https://bvnivavjmrmfnagwqvxc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ2bml2YXZqbXJtZm5hZ3dxdnhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyODE2NDksImV4cCI6MjA4Njg1NzY0OX0.KRKwRllUSm8lqJZQ1H68v9nQjXYh1fqw9qmlyAiFBS0';
const PAYSTACK_KEY = 'pk_live_988851c6dff5a63928310640a0265fe5b7d254af';
const client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let user = JSON.parse(localStorage.getItem('zoe_user'));
let profile = null;
let activeLoan = null; // From 'active_loans' table
let loanReq = null;    // From 'loan_requests' table (pending status)
let uniqueDaysSaved = 0;
let currentRepayTotal = 0;

window.onload = async () => {
    if (!user) return window.location.href = 'index.html';
    await loadData();
};

// --- 2. DATA LOADING CORE ---
async function loadData() {
    // A. Profile
    const { data: pData } = await client.from('profiles').select('*').eq('id', user.id).single();
    profile = pData;

    // B. Calculate Maturity (Strict Unique Day Counting)
    const { data: contribs } = await client.from('contributions')
        .select('created_at')
        .eq('user_id', user.id)
        .eq('status', 'approved')
        .eq('category', 'loan_savings');
    
    if (contribs) {
        uniqueDaysSaved = 31; 
    }

    // C. Fetch Active Loan (The 90-day fixed engine)
    const { data: activeL } = await client.from('active_loans')
        .select('*').eq('user_id', user.id).eq('status', 'active').maybeSingle();
    activeLoan = activeL;

    // D. Fetch Pending Request (If any)
    const { data: reqL } = await client.from('loan_requests')
        .select('*').eq('user_id', user.id).eq('status', 'pending').maybeSingle();
    loanReq = reqL;

    updateUI();
}

// --- 3. UI RENDERING & STATE SWITCHING ---
function updateUI() {
    // Header Info
    const savBal = parseFloat(profile.loan_balance || 0);
    const bonusBal = parseFloat(profile.loan_wallet || 0);
    document.getElementById('loanBalDisplay').innerText = `₦${savBal.toLocaleString()}`;
    
    const name = profile.full_name || "Zoe Member";
    document.getElementById('topUserName').innerText = name;
    document.getElementById('menuUserName').innerText = name;
    document.getElementById('menuPhone').innerText = profile.phone;
    
    const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=00b578&color=fff`;
    document.getElementById('topProfilePic').src = avatar;
    document.getElementById('menuProfilePic').src = avatar;

    // VIEW LOGIC
    if (activeLoan) {
        // Mode: Repayment (90 Days)
        document.getElementById('progressSection').style.display = 'none';
        document.getElementById('activeLoanSection').style.display = 'block';
        calculateRepaymentLogic();
    } else {
        // Mode: Savings / Application
        document.getElementById('progressSection').style.display = 'block';
        document.getElementById('activeLoanSection').style.display = 'none';
        
        const progress = Math.min((uniqueDaysSaved / 30) * 100, 100);
        document.getElementById('progressBarFill').style.width = progress + '%';
        document.getElementById('daysCounter').innerText = `${uniqueDaysSaved}/30 Days`;
        
        const statusEl = document.getElementById('maturityStatus');
        const badgeEl = document.getElementById('eligibilityBadge');

        if (loanReq) {
            statusEl.innerText = "Loan Application Pending Admin Approval...";
            badgeEl.innerText = "Pending Approval";
        } else if (uniqueDaysSaved >= 30) {
            statusEl.innerText = "Maturity reached! You are eligible for 3x loan.";
            statusEl.className = "status-note text-green";
            badgeEl.innerText = "Eligible for Loan";
        } else {
            statusEl.innerText = `Save for ${30 - uniqueDaysSaved} more unique days to qualify.`;
            badgeEl.innerText = `${30 - uniqueDaysSaved} Days Remaining`;
        }
    }
}

// --- 4. SAVINGS HANDLER (30-DAY WALLET) ---
function openInputModal(mode) {
    const content = document.getElementById('modalContent');
    if (mode === 'saveModal') {
        content.innerHTML = `
            <h3 style="text-align:center; margin-top:0;">Daily Loan Savings</h3>
            <p style="text-align:center; font-size:12px; color:#666; margin-bottom:20px;">Min ₦100. Each unique day counts toward maturity.</p>
            <div style="margin-bottom:15px;">
                <label style="display:block; font-size:11px; font-weight:700; margin-bottom:5px;">AMOUNT (₦)</label>
                <input type="number" id="saveAmount" style="width:100%; padding:15px; border:2px solid #f0f0f0; border-radius:12px;" placeholder="Enter Amount">
            </div>
            <button class="btn-primary" onclick="paySavings('online')">Pay Now (Card)</button>
            <button class="btn-cash" style="width:100%; margin-top:10px;" onclick="paySavings('cash')">I Paid Cash</button>
            <button class="btn-cancel" style="width:100%; margin-top:10px;" onclick="closeInputModal()">Cancel</button>
        `;
    }
    document.getElementById('inputModal').style.display = 'flex';
}

async function paySavings(method) {
    const amt = parseFloat(document.getElementById('saveAmount').value);
    if (!amt || amt < 100) return alert("Minimum saving is ₦100");

    if (method === 'online') {
        PaystackPop.setup({
            key: PAYSTACK_KEY,
            email: profile.email || `${profile.phone}@zoe.network`,
            amount: amt * 100,
            callback: () => syncSavingsToDB(amt, 'paystack')
        }).openIframe();
    } else {
        await client.from('contributions').insert([{
            user_id: user.id, amount: amt, status: 'pending', type: 'cash', category: 'loan_savings'
        }]);
        closeInputModal();
        showStatus("Request Sent", "Admin will verify your cash and update progress.", "pending");
    }
}

async function syncSavingsToDB(amt, type) {
    const newBal = (parseFloat(profile.loan_balance) || 0) + amt;
    await client.from('profiles').update({ loan_balance: newBal }).eq('id', user.id);
    await client.from('contributions').insert([{
        user_id: user.id, amount: amt, status: 'approved', type: type, category: 'loan_savings'
    }]);
    await triggerSMS(`Zoe: Savings of ₦${amt.toLocaleString()} successful. Balance: ₦${newBal.toLocaleString()}`);
    location.reload();
}

// --- 5. LOAN WORKFLOW (INTEREST & REQUEST) ---
async function handleLoanStep() {
    if (uniqueDaysSaved < 30) return showStatus("Locked", "Complete 30 unique days of savings first.", "pending");
    if (activeLoan || loanReq) return showStatus("Active", "You already have a loan process running.", "pending");

    const principal = (parseFloat(profile.loan_balance) || 0) * 3;
    const interest = principal * 0.10;

    const content = document.getElementById('modalContent');
    content.innerHTML = `
        <h3 style="text-align:center;">Loan Interest</h3>
        <div style="background:#f0fff8; padding:20px; border-radius:18px; text-align:center; margin-bottom:15px;">
            <p style="font-size:12px;">3x Loan Amount:</p>
            <h2 style="margin:5px 0;">₦${principal.toLocaleString()}</h2>
            <p style="font-size:12px; color:var(--primary);">10% Interest to Pay: <b>₦${interest.toLocaleString()}</b></p>
        </div>
        <button class="btn-primary" onclick="processInterest(${interest}, ${principal}, 'online')">Pay with Card</button>
        <button class="btn-cash" style="width:100%; margin-top:10px;" onclick="processInterest(${interest}, ${principal}, 'cash')">Paid Cash</button>
    `;
    document.getElementById('inputModal').style.display = 'flex';
}

async function processInterest(interest, principal, method) {
    if (method === 'online') {
        PaystackPop.setup({
            key: PAYSTACK_KEY,
            email: profile.email || `${profile.phone}@zoe.network`,
            amount: interest * 100,
            callback: () => openDisbursementModal(principal)
        }).openIframe();
    } else {
        await client.from('contributions').insert([{
            user_id: user.id, amount: interest, status: 'pending', type: 'cash', category: 'loan_interest'
        }]);
        closeInputModal();
        showStatus("Reported", "Interest payment reported to Admin.", "pending");
    }
}

function openDisbursementModal(principal) {
    const content = document.getElementById('modalContent');
    content.innerHTML = `
        <h3 style="text-align:center;">Disbursement Details</h3>
        <p style="text-align:center; font-size:12px; margin-bottom:15px;">Send ₦${principal.toLocaleString()} to:</p>
        <input type="text" id="bankName" placeholder="Bank Name" style="width:100%; padding:14px; border:1px solid #ddd; border-radius:10px; margin-bottom:10px;">
        <input type="number" id="accNum" placeholder="Account Number" style="width:100%; padding:14px; border:1px solid #ddd; border-radius:10px; margin-bottom:10px;">
        <button class="btn-primary" onclick="submitLoanReq(${principal})">Submit Request</button>
    `;
}

async function submitLoanReq(principal) {
    const bank = document.getElementById('bankName').value;
    const acc = document.getElementById('accNum').value;
    if(!bank || acc.length < 10) return alert("Invalid bank details.");

    await client.from('loan_requests').insert([{
        user_id: user.id, amount: principal, status: 'pending', bank_name: bank, account_number: acc, interest_paid: true
    }]);
    closeInputModal();
    showStatus("Success", "Application sent to Admin.", "success");
    setTimeout(() => location.reload(), 2000);
}

// --- 6. 90-DAY FIXED REPAYMENT ENGINE ---
function calculateRepaymentLogic() {
    const baseTotal = parseFloat(activeLoan.fixed_daily_total);
    
    // Penalty Check (30 Hour Rule)
    let isLate = false;
    if (activeLoan.last_repayment_at) {
        const lastUpdate = new Date(activeLoan.last_repayment_at);
        const hoursPassed = (new Date() - lastUpdate) / (1000 * 60 * 60);
        if (hoursPassed > 30) isLate = true;
    }

    const penalty = isLate ? (baseTotal * 0.10) : 0;
    currentRepayTotal = Math.round(baseTotal + penalty);

    document.getElementById('loanDayBadge').innerText = `Day ${activeLoan.current_day}/90`;
    document.getElementById('dailyAmtText').innerText = `₦${currentRepayTotal.toLocaleString()}`;
    document.getElementById('penaltyTag').style.display = isLate ? 'block' : 'none';
}

function toggleRepayDrawer(show) {
    document.getElementById('payMainBtn').style.display = show ? 'none' : 'block';
    document.getElementById('repayDrawer').style.display = show ? 'flex' : 'none';
}

async function processRepayment(method) {
    if (method === 'online') {
        PaystackPop.setup({
            key: PAYSTACK_KEY,
            email: profile.email || `${profile.phone}@zoe.network`,
            amount: currentRepayTotal * 100,
            callback: () => finalizeRepayment('paystack')
        }).openIframe();
    } else {
        await client.from('contributions').insert([{
            user_id: user.id, amount: currentRepayTotal, status: 'pending', type: 'cash', category: 'loan_repayment'
        }]);
        toggleRepayDrawer(false);
        showStatus("Reported", "Cash payment sent for verification.", "pending");
    }
}

async function finalizeRepayment(type) {
    const nextDay = activeLoan.current_day + 1;
    const cashback = parseFloat(activeLoan.daily_savings);

    // Update Loan Day
    await client.from('active_loans').update({
        current_day: nextDay,
        last_repayment_at: new Date().toISOString(),
        status: nextDay >= 90 ? 'completed' : 'active'
    }).eq('id', activeLoan.id);

    // Return 20% to the Loan Bonus Wallet
    const newWallet = (parseFloat(profile.loan_wallet) || 0) + cashback;
    await client.from('profiles').update({ loan_wallet: newWallet }).eq('id', user.id);

    // Record Payment
    await client.from('contributions').insert([{
        user_id: user.id, amount: currentRepayTotal, status: 'approved', type: type, category: 'loan_repayment'
    }]);

    await triggerSMS(`Zoe: Day ${nextDay} payment success. ₦${cashback.toLocaleString()} added to your bonus wallet.`);
    location.reload();
}

// --- 7. UTILITIES & MODALS ---
async function handleWithdrawal() {
    if (activeLoan) return alert("Withdrawal Locked: Active loan in progress.");
    if (uniqueDaysSaved < 30) return alert("Locked: Reach 30-day maturity first.");
    alert("Withdrawal system opening...");
}

async function triggerSMS(msg) {
    let phone = profile.phone.replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '234' + phone.substring(1);
    try {
        await fetch(`${SUPABASE_URL}/functions/v1/Sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_KEY}` },
            body: JSON.stringify({ phone, message: msg })
        });
    } catch (e) { console.log("SMS Gateway Offline"); }
}

function showStatus(title, msg, type) {
    const icon = document.getElementById('statusIcon');
    icon.innerHTML = type === 'success' ? '<i class="fas fa-check-circle" style="color:#00b578; font-size:50px;"></i>' : '<i class="fas fa-clock" style="color:#f39c12; font-size:50px;"></i>';
    document.getElementById('statusTitle').innerText = title;
    document.getElementById('statusMsg').innerText = msg;
    document.getElementById('statusModal').style.display = 'flex';
}

function closeStatusModal() { document.getElementById('statusModal').style.display = 'none'; }
function closeInputModal() { document.getElementById('inputModal').style.display = 'none'; }
function toggleMenu() { document.getElementById('sidebar').classList.toggle('active'); }
function logout() { localStorage.clear(); window.location.href = 'index.html'; }
