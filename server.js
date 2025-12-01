const express = require("express");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require("dotenv").config();
const cors = require("cors");
const port = 5000;

app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.user}:${process.env.password}@cluster0.1ivadd4.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

// --- COLLECTIONS ---
let allOrders, partialOrders, blockedUsers, expenses, settings;

const dbConnect = async () => {
  try {
    await client.connect();
    const db = client.db("profit-first");
    
    allOrders = db.collection("allOrders");
    partialOrders = db.collection("partialOrders");
    blockedUsers = db.collection("blockedUsers");
    expenses = db.collection("expenses"); // NEW: Stores Ad Spend, Packaging, etc.
    settings = db.collection("settings"); // NEW: Stores Global Stock Count

    // --- INITIALIZE STOCK IF NOT EXISTS ---
    const stockCheck = await settings.findOne({ _id: "main_stock" });
    if (!stockCheck) {
      await settings.insertOne({ _id: "main_stock", quantity: 1000 });
      console.log("⚙️ Initialized Stock to 1000");
    }

    console.log("Database connected & Collections ready");
  } catch (error) {
    console.log(error);
  }
};

dbConnect();

app.get('/', (req, res) => {
    res.send("Hi from Profit First Server");
});

// ============================================================
// --- NEW: FINANCE & STOCK ROUTES ---
// ============================================================

// 1. GET STOCK & EXPENSES (For Dashboard Analytics)
app.get("/finance-summary", async (req, res) => {
  try {
    // Get Stock
    const stockDoc = await settings.findOne({ _id: "main_stock" });
    const currentStock = stockDoc ? stockDoc.quantity : 0;

    // Get Expenses
    const allExpenses = await expenses.find({}).sort({ date: -1 }).toArray();

    res.send({ 
      stock: currentStock, 
      expenses: allExpenses 
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error fetching finance data" });
  }
});

// 2. ADD EXPENSE
app.post("/expenses", async (req, res) => {
  try {
    const expense = req.body;
    // Expecting: { type: "Ad Spend", amount: 500, desc: "...", date: "..." }
    expense.date = new Date(expense.date); 
    expense.createdAt = new Date();
    
    const result = await expenses.insertOne(expense);
    res.send({ success: true, result });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error adding expense" });
  }
});

// 3. DELETE EXPENSE
app.delete("/expenses/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const result = await expenses.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error deleting expense" });
  }
});

// 4. MANUAL RESTOCK (For Returns/Cancellations from the Queue)
app.patch("/orders/:id/restock-return", async (req, res) => {
  const id = req.params.id;
  try {
    const order = await allOrders.findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).send({ message: "Order not found" });

    const itemsToRestock = order.items || 1; // Default to 1 if not set

    // Increment Global Stock
    await settings.updateOne(
      { _id: "main_stock" }, 
      { $inc: { quantity: itemsToRestock } }
    );

    // Mark order as physically restocked so it doesn't appear in queue again
    const result = await allOrders.updateOne(
      { _id: new ObjectId(id) }, 
      { $set: { isRestocked: true, restockedAt: new Date() } }
    );

    res.send({ success: true, message: "Stock updated successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error restocking" });
  }
});

// ============================================================
// --- EXISTING ROUTES (WITH STOCK LOGIC UPDATES) ---
// ============================================================

app.get("/check-ban-status", async (req, res) => {
    try {
        const { ip, deviceId } = req.query;
        const query = { $or: [] };
        if (ip && ip !== 'undefined' && ip !== 'null') query.$or.push({ identifier: ip });
        if (deviceId && deviceId !== 'undefined' && deviceId !== 'null') query.$or.push({ identifier: deviceId });

        if (query.$or.length === 0) return res.send({ banned: false });

        const isBanned = await blockedUsers.findOne(query);
        if (isBanned) return res.send({ banned: true, reason: isBanned.note });

        res.send({ banned: false });
    } catch (error) {
        console.error("Ban check error:", error);
        res.status(500).send({ banned: false });
    }
});

app.post("/orders", async (req, res) => {
  try {
    const order = req.body;
    const targetDeviceId = order.clientInfo?.deviceId || order.deviceId; 
    const targetPhone = order.number ? String(order.number).trim() : null;
    const targetIp = order.clientInfo?.ip; 

    // Security Checks...
    const blockQuery = { $or: [] };
    if (targetDeviceId) blockQuery.$or.push({ identifier: targetDeviceId });
    if (targetPhone) blockQuery.$or.push({ identifier: targetPhone });
    if (targetIp) blockQuery.$or.push({ identifier: targetIp }); 

    if (blockQuery.$or.length > 0) {
        const isBanned = await blockedUsers.findOne(blockQuery);
        if (isBanned) return res.status(403).send({ success: false, message: "Declined." });
    }

    const existingOrder = await allOrders.findOne({
      number: targetPhone, 
      status: { $nin: ["Delivered", "Cancelled", "Returned", "Return", "Cancel"] } 
    });

    if (existingOrder) {
      return res.status(409).send({ success: false, reason: "active_order_exists", message: "Order exists." });
    }

    const previousOrderCount = await allOrders.countDocuments({ number: targetPhone });
    order.customerStats = {
        isReturningCustomer: previousOrderCount > 0,
        totalOrdersBeforeThis: previousOrderCount,
    };

    const count = await allOrders.countDocuments();
    order.orderId = 501 + count;
    order.createdAt = new Date(); 
    order.number = targetPhone; 
    if (!order.phoneCallStatus) order.phoneCallStatus = "Pending";
    
    // ENSURE ITEM COUNT EXISTS (For Stock Logic)
    order.items = order.items || 1; 
    order.inventoryDeducted = false; // Flag to track if we subtracted stock yet

    const result = await allOrders.insertOne(order);
    
    if (targetPhone) {
        try {
            await partialOrders.deleteMany({
                $or: [{ number: targetPhone }, { "marketing.number": targetPhone }, { phone: targetPhone }]
            });
        } catch (e) {}
    }

    res.send({ success: true, message: "Order placed", orderId: order.orderId, mongoResult: result });
  } catch (error) {
    console.log(error);
    res.status(500).send({ success: false, message: "Server Error" });
  }
});

app.get("/orders", async (req, res) => {
  try {
    const result = await allOrders.find({}).sort({ createdAt: -1 }).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
  }
});

// --- UPDATED STATUS CHANGE (HANDLES STOCK DEDUCTION) ---
app.patch("/orders/:id", async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  const now = new Date();

  try {
    const filter = { _id: new ObjectId(id) };
    const currentOrder = await allOrders.findOne(filter);
    
    if (!currentOrder) return res.status(404).send({ message: "Order not found" });

    let updateFields = { status: status };

    // Set Timestamps
    if (status === "Shipped") updateFields.shippedAt = now;
    else if (status === "Delivered") updateFields.deliveredAt = now;
    else if (status === "Cancelled") updateFields.cancelledAt = now;
    else if (status === "Returned") updateFields.returnedAt = now;

    // --- AUTOMATIC STOCK REDUCTION LOGIC ---
    // If status becomes "Shipped" or "Delivered" AND we haven't deducted stock yet
    const reductionStatuses = ["Shipped", "Delivered"];
    
    if (reductionStatuses.includes(status) && !currentOrder.inventoryDeducted) {
        // Decrease global stock
        const itemsToDeduct = currentOrder.items || 1;
        await settings.updateOne(
            { _id: "main_stock" }, 
            { $inc: { quantity: -itemsToDeduct } }
        );
        // Mark order as deducted so we don't do it twice
        updateFields.inventoryDeducted = true;
    }
    // ---------------------------------------

    const result = await allOrders.updateOne(filter, { $set: updateFields });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating status" });
  }
});

app.patch("/orders/:id/call-status", async (req, res) => {
  const id = req.params.id;
  const { callStatus } = req.body;
  try {
    const result = await allOrders.updateOne({ _id: new ObjectId(id) }, { $set: { phoneCallStatus: callStatus } });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error" });
  }
});

app.patch("/orders/:id/shipping-method", async (req, res) => {
  const id = req.params.id;
  const { shippingMethod, shippingCost } = req.body;
  try {
    const result = await allOrders.updateOne({ _id: new ObjectId(id) }, { $set: { shipping: shippingMethod, shippingCost: shippingCost } });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error" });
  }
});

app.patch("/orders/:id/price", async (req, res) => {
  const id = req.params.id;
  const { totalValue } = req.body;
  try {
    const result = await allOrders.updateOne({ _id: new ObjectId(id) }, { $set: { totalValue: totalValue } });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error" });
  }
});

// Partial Orders Routes
app.post("/save-partial-order", async (req, res) => {
  try {
    const { deviceId, ...data } = req.body;
    if (!deviceId) return res.status(400).send({ success: false, message: "Device ID required" });
    const filter = { deviceId: deviceId };
    const updateDoc = {
      $set: { ...data, lastUpdated: new Date(), status: "Abandoned" },
      $setOnInsert: { createdAt: new Date() }
    };
    const result = await partialOrders.updateOne(filter, updateDoc, { upsert: true });
    res.send({ success: true, result });
  } catch (error) {
    res.status(500).send({ success: false });
  }
});

app.get("/partial-orders", async (req, res) => {
  try {
    const result = await partialOrders.find({}).sort({ _id: -1 }).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Error" });
  }
});

app.delete("/partial-orders/:id", async (req, res) => {
  try {
    const result = await partialOrders.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Error" });
  }
});

app.post("/orders/:id/move-to-abandoned", async (req, res) => {
  const id = req.params.id;
  try {
    const order = await allOrders.findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).send({ success: false, message: "Order not found" });

    // NOTE: If this order already deducted stock, should we add it back?
    // For simplicity, if you move to abandoned, we assume it never shipped. 
    // If it WAS shipped/deducted, we add stock back.
    if (order.inventoryDeducted) {
         await settings.updateOne({ _id: "main_stock" }, { $inc: { quantity: (order.items || 1) } });
    }

    const abandonedOrder = {
        ...order,
        _id: undefined, 
        status: "Abandoned", 
        movedFromActive: true,
        restoredAt: new Date()
    };

    await partialOrders.insertOne(abandonedOrder);
    await allOrders.deleteOne({ _id: new ObjectId(id) });
    res.send({ success: true, message: "Order moved to Abandoned" });
  } catch (error) {
    res.status(500).send({ message: "Error moving order" });
  }
});

app.patch("/orders/:id/note", async (req, res) => {
  try {
    const result = await allOrders.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { note: req.body.note } });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Error" });
  }
});

// Admin Routes
app.post("/admin/block-user", async (req, res) => {
    try {
        let { identifier, note } = req.body; 
        if (!identifier) return res.status(400).send({message: "Identifier required"});
        identifier = String(identifier).trim();
        const exists = await blockedUsers.findOne({ identifier: identifier });
        if (exists) return res.status(400).send({message: "User already blocked"});
        const blockData = { identifier: identifier, note: note || "Blocked for spam", blockedAt: new Date() };
        const result = await blockedUsers.insertOne(blockData);
        res.send({ success: true, message: "User blocked", result });
    } catch (error) {
        res.status(500).send({ message: "Error" });
    }
});

app.get("/admin/blocked-users", async (req, res) => {
    try {
        const result = await blockedUsers.find({}).sort({ blockedAt: -1 }).toArray();
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Error" });
    }
});

app.delete("/admin/blocked-users/:identifier", async (req, res) => {
    try {
        const result = await blockedUsers.deleteOne({ identifier: req.params.identifier });
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Error" });
    }
});

app.listen(port, () => {  
    console.log(`server is running ${port}`);
});