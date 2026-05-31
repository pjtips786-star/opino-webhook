const express = require('express');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();
app.use(express.json());

// ========== Environment Variables ==========
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;

if (!WEBHOOK_SECRET || !FIREBASE_PRIVATE_KEY || !FIREBASE_CLIENT_EMAIL) {
    console.error('❌ Missing required environment variables!');
    process.exit(1);
}

// ========== Firebase Admin SDK ==========
initializeApp({
    credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        privateKey: FIREBASE_PRIVATE_KEY,
        clientEmail: FIREBASE_CLIENT_EMAIL,
    }),
    databaseURL: `https://${FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});
const db = getDatabase();

// ========== Health Check ==========
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

app.get('/', (req, res) => {
    res.status(200).json({ message: 'Opino Webhook Server is running!' });
});

// ========== Webhook Endpoint ==========
app.post('/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        const body = JSON.stringify(req.body);

        const expectedSignature = crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(body)
            .digest('hex');

        if (signature !== expectedSignature) {
            console.log('❌ Invalid signature');
            return res.status(400).send('Invalid signature');
        }

        const event = req.body.event;
        console.log(`✅ Webhook received: ${event}`);

        if (event === 'payment.captured') {
            const payment = req.body.payload.payment.entity;
            const userId = payment.notes?.user_id;
            const amount = payment.amount / 100; // paise → rupees
            const paymentId = payment.id;

            if (!userId) {
                console.log('⚠️ No user_id in notes. Cannot update wallet.');
                return res.status(200).send('OK');
            }

            console.log(`💰 Payment: User ${userId}, Amount ₹${amount}, Payment ID ${paymentId}`);

            // ✅ CORRECT PATH: /users/{userId}/wallet/vDeposit
            const walletRef = db.ref(`/users/${userId}/wallet/vDeposit`);
            
            // Transaction to safely increment (handles concurrent updates)
            await walletRef.transaction(current => {
                if (current === null) return amount;
                return current + amount;
            }, (error, committed, snapshot) => {
                if (error) {
                    console.error('❌ Transaction error:', error);
                } else if (committed) {
                    console.log(`✅ Wallet updated: ${userId} — vDeposit now ₹${snapshot.val()}`);
                }
            });

            // Also save transaction record (optional but good for audit)
            const txnRef = db.ref(`/transactions/${paymentId}`);
            await txnRef.set({
                txnId: paymentId,
                userId: userId,
                type: 'deposit',
                amount: amount,
                fee: 0,
                netAmount: amount,
                status: 'success',
                razorpayId: paymentId,
                description: 'Wallet Deposit via QR',
                timestamp: Date.now()
            });

            console.log(`✅ Transaction record saved for ${paymentId}`);
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Opino webhook server running on port ${PORT}`);
    console.log(`   Webhook URL: https://opino-webhook.onrender.com/webhook`);
});
