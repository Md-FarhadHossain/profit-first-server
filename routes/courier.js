const express = require("express");
const router = express.Router();
const { ObjectId } = require('mongodb');
const axios = require('axios'); // You need to install this: npm install axios

// CONFIGURATION
const STEADFAST_BASE_URL = "https://portal.packzy.com/api/v1";
const API_KEY = process.env.STEADFAST_API_KEY; 
const SECRET_KEY = process.env.STEADFAST_SECRET_KEY;

// Middleware to check headers
const steadfastHeaders = {
    'Api-Key': API_KEY,
    'Secret-Key': SECRET_KEY,
    'Content-Type': 'application/json'
};

module.exports = (client) => {
    const allOrders = client.db("profit-first").collection("allOrders");

    // 1. CREATE ORDER IN STEADFAST
    router.post("/create-order", async (req, res) => {
        const { orderId } = req.body;

        try {
            // Fetch the full order details from DB
            const order = await allOrders.findOne({ _id: new ObjectId(orderId) });

            if (!order) {
                return res.status(404).json({ success: false, message: "Order not found" });
            }

            if (order.courierConsignmentId) {
                return res.status(400).json({ success: false, message: "Order already sent to courier" });
            }

            // Prepare Payload for Steadfast
            const payload = {
                invoice: order.orderId.toString(), // Using your numeric OrderID
                recipient_name: order.name,
                recipient_phone: order.number,
                recipient_address: order.address,
                cod_amount: order.totalValue, // Assuming totalValue is the collectable amount
                note: order.note || "Handle with care",
                delivery_type: 0 // 0 = Home Delivery
            };

            // Call Steadfast API
            const response = await axios.post(`${STEADFAST_BASE_URL}/create_order`, payload, {
                headers: steadfastHeaders
            });

            const courierData = response.data;

            if (courierData.status === 200) {
                // Update Local DB with Courier Info
                await allOrders.updateOne(
                    { _id: new ObjectId(orderId) },
                    {
                        $set: {
                            status: "Shipped", // Auto update status
                            courierConsignmentId: courierData.consignment.consignment_id,
                            courierTrackingCode: courierData.consignment.tracking_code,
                            courierStatus: courierData.consignment.status,
                            shippedAt: new Date()
                        }
                    }
                );

                return res.json({ 
                    success: true, 
                    message: "Sent to Courier Successfully", 
                    tracking_code: courierData.consignment.tracking_code 
                });
            } else {
                // Handle API errors from Steadfast
                return res.status(400).json({ 
                    success: false, 
                    message: "Courier API Error", 
                    details: courierData 
                });
            }

        } catch (error) {
            console.error("Courier Create Error:", error.response?.data || error.message);
            res.status(500).json({ success: false, message: "Internal Server Error" });
        }
    });

    // 2. CHECK STATUS (Manual or Polling)
    // Use this to update individual order status from Frontend
    router.get("/check-status/:id", async (req, res) => {
        const orderId = req.params.id;

        try {
            const order = await allOrders.findOne({ _id: new ObjectId(orderId) });
            
            if (!order || !order.courierConsignmentId) {
                return res.status(404).json({ success: false, message: "No courier data found for this order" });
            }

            // Fetch from Steadfast
            const response = await axios.get(`${STEADFAST_BASE_URL}/status_by_cid/${order.courierConsignmentId}`, {
                headers: steadfastHeaders
            });

            const statusData = response.data;
            
            if (statusData.status === 200) {
                const deliveryStatus = statusData.delivery_status; // e.g., 'delivered', 'cancelled'

                // Map Steadfast status to Your System Status
                let localStatus = order.status;
                if (deliveryStatus === 'delivered') localStatus = "Delivered";
                if (deliveryStatus === 'cancelled') localStatus = "Cancelled";
                if (deliveryStatus === 'partial_delivered') localStatus = "Delivered"; // Handle partial as delivered or custom

                // Update DB
                await allOrders.updateOne(
                    { _id: new ObjectId(orderId) },
                    {
                        $set: {
                            courierStatus: deliveryStatus,
                            status: localStatus
                        }
                    }
                );

                res.json({ success: true, courierStatus: deliveryStatus, localStatus: localStatus });
            } else {
                res.status(400).json({ success: false, message: "Failed to fetch status from courier" });
            }

        } catch (error) {
            console.error("Status Check Error:", error);
            res.status(500).json({ success: false, message: "Server Error" });
        }
    });

    // 3. WEBHOOK HANDLER
    // NOTE: Steadfast docs do not explicitly mention a webhook URL setting.
    // If they verify via signature, add that check here.
    // If they support webhooks, point them to: https://your-domain.com/courier/webhook
    router.post("/webhook", async (req, res) => {
        try {
            const data = req.body;
            console.log("Webhook received:", data);

            // Assuming payload has consignment_id and status
            // Adjust 'consignment_id' and 'status' based on actual webhook payload if they provide one
            if (data.consignment_id && data.status) {
                 await allOrders.updateOne(
                    { courierConsignmentId: data.consignment_id },
                    { 
                        $set: { 
                            courierStatus: data.status,
                            // Optional: Update main status if mapping matches
                            // status: mapCourierStatusToLocal(data.status) 
                        } 
                    }
                );
            }

            res.status(200).send("Webhook received");
        } catch (error) {
            console.error("Webhook Error:", error);
            res.status(500).send("Error");
        }
    });

    return router;
};