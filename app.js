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

// ========== Health Check Endpoints ==========
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

app.get('/', (req, res) => {
    res.status(200).json({ message: 'Opino Webhook Server is running!' });
});

// ========== Main Webhook Endpoint ==========
app.post('/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        const body = JSON.stringify(req.body);

        // 1. Verify Razorpay signature
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

        // 2. Handle payment.captured event
        if (event === 'payment.captured') {
            const payment = req.body.payload.payment.entity;
            const userId = payment.notes?.user_id;
            const orderId = payment.notes?.order_id;
            const amount = payment.amount / 100; // paise → rupees
            const paymentId = payment.id;

            if (!userId) {
                console.log('⚠️ No user_id in notes. Cannot update wallet.');
                return res.status(200).send('OK');
            }

            console.log(`💰 Payment captured:`);
            console.log(`   User ID: ${userId}`);
            console.log(`   Order ID: ${orderId}`);
            console.log(`   Amount: ₹${amount}`);
            console.log(`   Payment ID: ${paymentId}`);

            // 3. Check if already processed (idempotency)
            const transactionCheck = await db.ref(`/transactions/${paymentId}`).once('value');
            if (transactionCheck.exists()) {
                console.log(`⚠️ Transaction ${paymentId} already processed. Skipping.`);
                return res.status(200).send('OK');
            }

            // 4. Update Deposit Order Status (if orderId exists)
            if (orderId) {
                const orderRef = db.ref(`/depositOrders/${userId}/${orderId}`);
                const orderSnapshot = await orderRef.once('value');
                
                if (orderSnapshot.exists()) {
                    await orderRef.update({
                        status: 'success',
                        razorpayPaymentId: paymentId,
                        updatedAt: Date.now()
                    });
                    console.log(`✅ Deposit order updated: ${orderId} → success`);
                } else {
                    // Order doesn't exist, create one (fallback)
                    await orderRef.set({
                        orderId: orderId,
                        userId: userId,
                        amount: amount,
                        status: 'success',
                        razorpayPaymentId: paymentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });
                    console.log(`⚠️ Order didn't exist, created new: ${orderId}`);
                }
            }

            // 5. Update User's Wallet (vDeposit)
            const walletRef = db.ref(`/users/${userId}/wallet/vDeposit`);
            const walletSnapshot = await walletRef.once('value');
            const currentBalance = walletSnapshot.val() || 0;
            const newBalance = currentBalance + amount;

            await walletRef.set(newBalance);
            console.log(`💰 Wallet updated: ₹${currentBalance} → ₹${newBalance}`);

            // 6. Also update total balance if you have one
            const totalBalanceRef = db.ref(`/users/${userId}/wallet/totalBalance`);
            const totalSnapshot = await totalBalanceRef.once('value');
            const currentTotal = totalSnapshot.val() || 0;
            await totalBalanceRef.set(currentTotal + amount);

            // 7. Save Transaction Record
            const transactionRef = db.ref(`/transactions/${paymentId}`);
            await transactionRef.set({
                txnId: paymentId,
                userId: userId,
                type: 'deposit',
                amount: amount,
                fee: 0,
                netAmount: amount,
                status: 'success',
                razorpayId: paymentId,
                description: 'Wallet Deposit via ' + (orderId ? 'Order ' + orderId : 'Direct'),
                timestamp: Date.now()
            });
            console.log(`✅ Transaction record saved: ${paymentId}`);

            // 8. Create Notification for User
            const notificationRef = db.ref(`/notifications/${userId}`).push();
            await notificationRef.set({
                notifId: notificationRef.key,
                title: 'Deposit Successful',
                message: `₹${amount} has been added to your wallet.`,
                type: 'wallet',
                isRead: false,
                timestamp: Date.now()
            });
            console.log(`✅ Notification sent to user: ${userId}`);
        }

        // 9. Handle payment.failed event
        if (event === 'payment.failed') {
            const payment = req.body.payload.payment.entity;
            const userId = payment.notes?.user_id;
            const orderId = payment.notes?.order_id;
            const paymentId = payment.id;

            console.log(`❌ Payment failed: ${paymentId}`);

            if (orderId && userId) {
                await db.ref(`/depositOrders/${userId}/${orderId}`).update({
                    status: 'failed',
                    updatedAt: Date.now()
                });
                console.log(`⚠️ Deposit order marked as failed: ${orderId}`);
            }
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// ========== Start Server ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Opino webhook server running on port ${PORT}`);
    console.log(`   Webhook URL: https://opino-webhook.onrender.com/webhook`);
    console.log(`   Health URL: https://opino-webhook.onrender.com/health`);
});