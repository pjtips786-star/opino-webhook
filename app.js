const express = require('express');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();
app.use(express.json());

// Environment variables se read karo
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;

if (!WEBHOOK_SECRET || !FIREBASE_PRIVATE_KEY || !FIREBASE_CLIENT_EMAIL) {
    console.error('❌ Missing environment variables!');
    process.exit(1);
}

// Firebase Admin SDK initialize
initializeApp({
    credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        privateKey: FIREBASE_PRIVATE_KEY,
        clientEmail: FIREBASE_CLIENT_EMAIL,
    }),
    databaseURL: `https://${FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});

const db = getDatabase();

// Webhook endpoint
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

        console.log('✅ Webhook received:', req.body.event);

        if (req.body.event === 'payment.captured') {
            const payment = req.body.payload.payment.entity;
            const userId = payment.notes?.user_id;
            const amount = payment.amount / 100;
            const paymentId = payment.id;

            if (!userId) {
                console.log('⚠️ No user_id in notes');
                return res.status(200).send('OK');
            }

            console.log(`💰 Payment: User ${userId}, Amount ₹${amount}`);

            // 🔥 Firebase Wallet Update
            const walletRef = db.ref(`/wallets/${userId}`);
            const snapshot = await walletRef.once('value');
            let currentDeposit = snapshot.exists() ? (snapshot.child('vDeposit').val() || 0) : 0;
            const newDeposit = currentDeposit + amount;

            await walletRef.update({
                vDeposit: newDeposit,
                lastUpdated: Date.now()
            });

            console.log(`✅ Wallet updated: User ${userId}, New Deposit ₹${newDeposit}`);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

app.get('/', (req, res) => {
    res.status(200).json({ message: 'Opino Webhook Running' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
