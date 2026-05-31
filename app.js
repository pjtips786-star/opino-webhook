const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ⚠️ Ye secret Razorpay Dashboard wala hona chahiye
const WEBHOOK_SECRET = 'MtFFhDMLs4wrDo7UbHxaEjI7';

// Webhook endpoint
app.post('/webhook', (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        const body = JSON.stringify(req.body);
        
        // Signature verify karo
        const expectedSignature = crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(body)
            .digest('hex');
        
        if (signature !== expectedSignature) {
            console.log('❌ Invalid signature');
            return res.status(400).send('Invalid signature');
        }
        
        if (req.body.event === 'payment.captured') {
            const payment = req.body.payload.payment.entity;
            const userId = payment.notes.user_id;
            const amount = payment.amount / 100;
            
            console.log(`✅ Payment received: User ${userId}, Amount ₹${amount}`);
            
            // 🔴 TODO: Yahan Firebase mein wallet update karna hai
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Error');
    }
});

// Health check endpoint (Render ke liye)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Webhook server running on port ${port}`);
});
