const express = require("express");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require("dotenv").config();
const cors = require("cors");
const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

// --- DATABASE CONNECTION CONFIGURATION ---
const uri = `mongodb+srv://${process.env.user}:${process.env.password}@cluster0.1ivadd4.mongodb.net/?appName=Cluster0`;

let client;
let clientPromise;

if (!process.env.user || !process.env.password) {
  throw new Error("Missing environment variables: user or password");
}

if (process.env.NODE_ENV === "development") {
  // In development mode, use a global variable so the connection
  // isn't lost when the code hot-reloads
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  // In production (Vercel), create a new client but cache the promise
  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  clientPromise = client.connect();
}

// --- HELPER FUNCTION TO GET COLLECTIONS SAFELY ---
// This ensures we wait for the database to connect before trying to use it
async function getCollection(collectionName) {
  const connectedClient = await clientPromise;
  return connectedClient.db("profit-first").collection(collectionName);
}

app.get('/', (req, res) => {
    res.send("Server is Running");
});

// ============================================================
// --- ROUTE: PRE-CHECK BAN STATUS ---
// ============================================================
app.get("/check-ban-status", async (req, res) => {
    try {
        const { ip, deviceId } = req.query;
        const blockedUsers = await getCollection("blockedUsers"); // Get collection dynamically
        
        const query = { $or: [] };
        
        if (ip && ip !== 'undefined' && ip !== 'null') query.$or.push({ identifier: ip });
        if (deviceId && deviceId !== 'undefined' && deviceId !== 'null') query.$or.push({ identifier: deviceId });

        if (query.$or.length === 0) {
            return res.send({ banned: false });
        }

        const isBanned = await blockedUsers.findOne(query);

        if (isBanned) {
            console.log(`⛔ BAN CHECK: Blocked user attempted access (${isBanned.identifier})`);
            return res.send({ banned: true, reason: isBanned.note });
        }

        res.send({ banned: false });
    } catch (error) {
        console.error("Ban check error:", error);
        res.status(500).send({ banned: false }); 
    }
});

// ============================================================
// --- MAIN ORDER ROUTE ---
// ============================================================
app.post("/orders", async (req, res) => {
  try {
    const order = req.body;
    
    // Connect to collections
    const allOrders = await getCollection("allOrders");
    const blockedUsers = await getCollection("blockedUsers");
    const partialOrders = await getCollection("partialOrders");

    // 0. SECURITY: BLOCK SCAMMERS
    const targetDeviceId = order.clientInfo?.deviceId || order.deviceId; 
    const targetPhone = order.number ? String(order.number).trim() : null;
    const targetIp = order.clientInfo?.ip; 

    console.log("🛡️ Processing Order Check:", { device: targetDeviceId, phone: targetPhone, ip: targetIp });

    const blockQuery = { $or: [] };
    if (targetDeviceId) blockQuery.$or.push({ identifier: targetDeviceId });
    if (targetPhone) blockQuery.$or.push({ identifier: targetPhone });
    if (targetIp) blockQuery.$or.push({ identifier: targetIp }); 

    if (blockQuery.$or.length > 0) {
        const isBanned = await blockedUsers.findOne(blockQuery);
        
        if (isBanned) {
            console.log(`❌ BLOCKED ORDER: ${isBanned.identifier}`);
            return res.status(403).send({ 
                success: false, 
                message: "System declined this order due to security policies." 
            });
        }
    }

    // 1. DUPLICATE CHECK
    const existingOrder = await allOrders.findOne({
      number: targetPhone, 
      status: { $nin: ["Delivered", "Cancelled", "Returned", "Return", "Cancel"] } 
    });

    if (existingOrder) {
      return res.status(409).send({ 
        success: false, 
        reason: "active_order_exists", 
        message: "Active order already exists for this number." 
      });
    }

    // 2. ANALYTICS
    const previousOrderCount = await allOrders.countDocuments({ number: targetPhone });

    // 3. ENRICH DATA
    order.customerStats = {
        isReturningCustomer: previousOrderCount > 0,
        totalOrdersBeforeThis: previousOrderCount,
        customerType: previousOrderCount > 0 ? "Returning" : "New"
    };

    // 4. GENERATE ID & SAVE
    const count = await allOrders.countDocuments();
    const generatedOrderId = 501 + count;

    order.orderId = generatedOrderId;
    order.createdAt = new Date(); 
    order.number = targetPhone; 
    
    if (!order.phoneCallStatus) order.phoneCallStatus = "Pending"; 

    const result = await allOrders.insertOne(order);
    
    // CLEANUP PARTIALS
    if (targetPhone) {
        try {
            await partialOrders.deleteMany({
                $or: [
                    { number: targetPhone },              
                    { "marketing.number": targetPhone }, 
                    { phone: targetPhone }                
                ]
            });
            if (targetDeviceId) await partialOrders.deleteMany({ deviceId: targetDeviceId });
        } catch (cleanupError) {
            console.log("Error cleaning up partial orders:", cleanupError);
        }
    }

    res.send({ success: true, message: "Order placed", orderId: generatedOrderId, mongoResult: result });

  } catch (error) {
    console.log(error.name, error.message);
    res.status(500).send({ success: false, message: "Server Error" });
  }
});


app.get("/orders", async (req, res) => {
  try {
    const allOrders = await getCollection("allOrders");
    const query = {};
    const sort = { createdAt: -1 };
    const result = await allOrders.find(query).sort(sort).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error fetching orders" });
  }
});

app.patch("/orders/:id", async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  const now = new Date();

  try {
    const allOrders = await getCollection("allOrders");
    const filter = { _id: new ObjectId(id) };
    let updateFields = { status: status };

    if (status === "Shipped") updateFields.shippedAt = now;
    else if (status === "Delivered") updateFields.deliveredAt = now;
    else if (status === "Cancelled") updateFields.cancelledAt = now;
    else if (status === "Returned") updateFields.returnedAt = now;

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
    const allOrders = await getCollection("allOrders");
    const result = await allOrders.updateOne({ _id: new ObjectId(id) }, { $set: { phoneCallStatus: callStatus } });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating call status" });
  }
});

app.patch("/orders/:id/shipping-method", async (req, res) => {
  const id = req.params.id;
  const { shippingMethod, shippingCost } = req.body;
  try {
    const allOrders = await getCollection("allOrders");
    const result = await allOrders.updateOne({ _id: new ObjectId(id) }, { $set: { shipping: shippingMethod, shippingCost: shippingCost } });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating shipping method" });
  }
});

app.patch("/orders/:id/price", async (req, res) => {
  const id = req.params.id;
  const { totalValue } = req.body;
  try {
    const allOrders = await getCollection("allOrders");
    const result = await allOrders.updateOne({ _id: new ObjectId(id) }, { $set: { totalValue: totalValue } });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating price" });
  }
});

app.post("/save-partial-order", async (req, res) => {
  try {
    const { deviceId, ...data } = req.body;
    if (!deviceId) return res.status(400).send({ success: false, message: "Device ID required" });

    const partialOrders = await getCollection("partialOrders");
    const filter = { deviceId: deviceId };
    const updateDoc = {
      $set: { ...data, lastUpdated: new Date(), status: "Abandoned" },
      $setOnInsert: { createdAt: new Date() }
    };
    const result = await partialOrders.updateOne(filter, updateDoc, { upsert: true });
    res.send({ success: true, result });
  } catch (error) {
    console.error("Partial Save Error:", error);
    res.status(500).send({ success: false });
  }
});

app.get("/partial-orders", async (req, res) => {
  try {
    const partialOrders = await getCollection("partialOrders");
    const result = await partialOrders.find({}).sort({ _id: -1 }).toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching partial orders:", error);
    res.status(500).send({ message: "Error fetching data" });
  }
});

app.delete("/partial-orders/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const partialOrders = await getCollection("partialOrders");
    const result = await partialOrders.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error deleting partial order" });
  }
});

app.post("/orders/:id/move-to-abandoned", async (req, res) => {
  const id = req.params.id;
  try {
    const allOrders = await getCollection("allOrders");
    const partialOrders = await getCollection("partialOrders");
    
    const order = await allOrders.findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).send({ success: false, message: "Order not found" });

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
    console.log("Reverse Migration Error:", error);
    res.status(500).send({ message: "Error moving order" });
  }
});

app.patch("/orders/:id/note", async (req, res) => {
  const id = req.params.id;
  const { note } = req.body;
  try {
    const allOrders = await getCollection("allOrders");
    const result = await allOrders.updateOne({ _id: new ObjectId(id) }, { $set: { note: note } });
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating note" });
  }
});

// ADMIN ROUTES
app.post("/admin/block-user", async (req, res) => {
    try {
        let { identifier, note } = req.body; 
        if (!identifier) return res.status(400).send({message: "Identifier required"});
        
        // Clean the identifier
        identifier = String(identifier).trim();

        const blockedUsers = await getCollection("blockedUsers");
        const exists = await blockedUsers.findOne({ identifier: identifier });
        if (exists) return res.status(400).send({message: "User already blocked"});

        const blockData = { identifier: identifier, note: note || "Blocked for spam", blockedAt: new Date() };
        const result = await blockedUsers.insertOne(blockData);
        res.send({ success: true, message: "User blocked successfully", result });
    } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Error blocking user" });
    }
});

app.get("/admin/blocked-users", async (req, res) => {
    try {
        const blockedUsers = await getCollection("blockedUsers");
        const result = await blockedUsers.find({}).sort({ blockedAt: -1 }).toArray();
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Error fetching blocked users" });
    }
});

app.delete("/admin/blocked-users/:identifier", async (req, res) => {
    try {
        const identifier = req.params.identifier;
        const blockedUsers = await getCollection("blockedUsers");
        const result = await blockedUsers.deleteOne({ identifier: identifier });
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Error unblocking user" });
    }
});

// ============================================================
// --- ROUTE: MANUAL ORDER ENTRY (ADMIN) ---
// ============================================================
app.post("/manual-orders", async (req, res) => {
  try {
    const { 
      name, 
      number, 
      address, 
      shipping, 
      shippingCost, 
      productPrice,
      source, 
      note 
    } = req.body;

    const allOrders = await getCollection("allOrders");

    // 1. GENERATE ID (Consistent with main logic)
    const count = await allOrders.countDocuments();
    const generatedOrderId = 501 + count;

    // 2. CALCULATE TOTAL
    // Ensure numbers are numbers to prevent string concatenation errors
    const finalTotal = Number(productPrice) + Number(shippingCost);

    // 3. CONSTRUCT ORDER OBJECT
    // We mock clientInfo so the dashboard doesn't crash if it tries to read it
    const newOrder = {
      orderId: generatedOrderId,
      createdAt: new Date(),
      status: "Processing",
      
      // Admin entered orders are usually already confirmed via chat/call
      phoneCallStatus: "Confirmed", 
      
      customer: {
        name: name,
        phone: number
      },
      name: name,         // Keeping flat structure for compatibility
      number: number,     // Keeping flat structure for compatibility
      address: address,
      shipping: shipping,
      shippingCost: Number(shippingCost),
      totalValue: finalTotal,
      
      // The Key Requirement: Source Tracking
      source: source || "Manual", 
      
      note: note || "",
      
      // Metadata for admin tracking
      isManualOrder: true,
      
      // Mock technical data to prevent UI errors on the main dashboard
      clientInfo: {
        userAgent: "Manual Entry (Admin Dashboard)",
        ip: "127.0.0.1"
      }
    };

    const result = await allOrders.insertOne(newOrder);

    res.send({ 
      success: true, 
      message: "Manual order added successfully", 
      orderId: generatedOrderId, 
      mongoResult: result 
    });

  } catch (error) {
    console.log("Manual Order Error:", error);
    res.status(500).send({ success: false, message: "Server Error" });
  }
});

app.listen(port, () => {  
    console.log(`server is running ${port}`);
});