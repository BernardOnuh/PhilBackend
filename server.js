// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || '', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
    console.log('Connected to MongoDB');
});

// Customer Schema
const customerSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    phone: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

// Order Schema
const orderSchema = new mongoose.Schema({
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    orderCode: { type: String, unique: true, required: true }, // Unique order verification code
    type: { type: String, enum: ['room', 'food'], required: true },
    items: [{
        id: String,
        name: String,
        price: Number,
        quantity: { type: Number, default: 1 },
        // For room bookings
        checkIn: Date,
        checkOut: Date,
        // For food orders
        category: String
    }],
    totalAmount: { type: Number, required: true },
    status: { 
        type: String, 
        enum: ['pending', 'paid', 'confirmed', 'cancelled'], 
        default: 'pending' 
    },
    paymentReference: String,
    paymentStatus: {
        type: String,
        enum: ['pending', 'success', 'failed'],
        default: 'pending'
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Function to generate unique order code
const generateOrderCode = () => {
    const prefix = 'PH'; // Philopethotels prefix
    const timestamp = Date.now().toString().slice(-6); // Last 6 digits of timestamp
    const random = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4 random chars
    return `${prefix}${timestamp}${random}`;
};

const Customer = mongoose.model('Customer', customerSchema);
const Order = mongoose.model('Order', orderSchema);

// Routes

// Create or get customer
app.post('/api/customers', async (req, res) => {
    try {
        const { email, firstName, lastName, phone } = req.body;
        
        let customer = await Customer.findOne({ email });
        
        if (!customer) {
            customer = new Customer({ email, firstName, lastName, phone });
            await customer.save();
        }
        
        res.status(201).json({ success: true, customer });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Create order
app.post('/api/orders', async (req, res) => {
    try {
        const { customerData, items, type, totalAmount } = req.body;
        
        // Create or find customer
        let customer = await Customer.findOne({ email: customerData.email });
        
        if (!customer) {
            customer = new Customer(customerData);
            await customer.save();
        }
        
        // Generate unique order code
        let orderCode;
        let isUnique = false;
        
        while (!isUnique) {
            orderCode = generateOrderCode();
            const existingOrder = await Order.findOne({ orderCode });
            if (!existingOrder) {
                isUnique = true;
            }
        }
        
        // Create order
        const order = new Order({
            customer: customer._id,
            orderCode,
            type,
            items,
            totalAmount
        });
        
        await order.save();
        
        res.status(201).json({ 
            success: true, 
            order,
            orderCode // Return the order code to the frontend
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Initialize payment with Paystack
app.post('/api/payments/initialize', async (req, res) => {
    try {
        const { orderId, email } = req.body;
        
        const order = await Order.findById(orderId).populate('customer');
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        
        const paymentData = {
            email: email || order.customer.email,
            amount: order.totalAmount * 100, // Paystack expects amount in kobo
            reference: `order_${order._id}_${Date.now()}`,
            callback_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/callback`,
            metadata: {
                orderId: order._id,
                customerName: `${order.customer.firstName} ${order.customer.lastName}`,
                orderType: order.type
            }
        };
        
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            paymentData,
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        // Update order with payment reference
        order.paymentReference = paymentData.reference;
        await order.save();
        
        res.json({
            success: true,
            authorization_url: response.data.data.authorization_url,
            access_code: response.data.data.access_code,
            reference: paymentData.reference
        });
        
    } catch (error) {
        console.error('Payment initialization error:', error.response?.data || error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Payment initialization failed',
            details: error.response?.data?.message || error.message
        });
    }
});

// Verify payment
app.post('/api/payments/verify', async (req, res) => {
    try {
        const { reference } = req.body;
        
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
                }
            }
        );
        
        const paymentData = response.data.data;
        
        if (paymentData.status === 'success') {
            // Update order status
            const order = await Order.findOne({ paymentReference: reference });
            if (order) {
                order.paymentStatus = 'success';
                order.status = 'paid';
                order.updatedAt = new Date();
                await order.save();
            }
        }
        
        res.json({
            success: true,
            status: paymentData.status,
            amount: paymentData.amount / 100, // Convert from kobo to naira
            reference: paymentData.reference
        });
        
    } catch (error) {
        console.error('Payment verification error:', error.response?.data || error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Payment verification failed',
            details: error.response?.data?.message || error.message
        });
    }
});

// Get customer orders by email (simplified access)
app.get('/api/orders/customer/:email', async (req, res) => {
    try {
        const { email } = req.params;
        
        const customer = await Customer.findOne({ email });
        if (!customer) {
            return res.status(404).json({ success: false, error: 'No orders found for this email address' });
        }
        
        const orders = await Order.find({ customer: customer._id })
            .populate('customer')
            .sort({ createdAt: -1 });
        
        res.json({ success: true, orders, customer: customer });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get single order by order code (internal/company use)
app.get('/api/orders/track/:orderCode', async (req, res) => {
    try {
        const { orderCode } = req.params;
        
        const order = await Order.findOne({ orderCode }).populate('customer');
        
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        
        // Return full order details for internal use
        res.json({ success: true, order });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get single order details by email and order code (customer verification)
app.post('/api/orders/verify', async (req, res) => {
    try {
        const { email, orderCode } = req.body;
        
        if (!email) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email address is required' 
            });
        }
        
        // If orderCode is provided, get specific order
        if (orderCode) {
            const order = await Order.findOne({ orderCode }).populate('customer');
            
            if (!order) {
                return res.status(404).json({ success: false, error: 'Order not found' });
            }
            
            // Check if email matches the customer who placed the order
            if (order.customer.email.toLowerCase() !== email.toLowerCase()) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'This order does not belong to the provided email address' 
                });
            }
            
            res.json({ 
                success: true, 
                message: 'Order verified successfully',
                order 
            });
        } else {
            // If no orderCode, return all orders for the email
            const customer = await Customer.findOne({ email: email.toLowerCase() });
            
            if (!customer) {
                return res.status(404).json({ success: false, error: 'No orders found for this email address' });
            }
            
            const orders = await Order.find({ customer: customer._id })
                .populate('customer')
                .sort({ createdAt: -1 });
            
            res.json({ 
                success: true, 
                orders,
                customer
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Paystack webhook (optional, for real-time updates)
app.post('/api/webhooks/paystack', async (req, res) => {
    try {
        const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');
            
        if (hash === req.headers['x-paystack-signature']) {
            const event = req.body;
            
            if (event.event === 'charge.success') {
                const reference = event.data.reference;
                const order = await Order.findOne({ paymentReference: reference });
                
                if (order) {
                    order.paymentStatus = 'success';
                    order.status = 'paid';
                    order.updatedAt = new Date();
                    await order.save();
                }
            }
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Webhook error');
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Server is running' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;