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

const dbConnect = async () => {
  try {
    await client.connect();
    console.log("Database connected");
  } catch (error) {
    console.log(error);
  }
};

dbConnect();

// --- COLLECTIONS ---
const allOrders = client.db("profit-first").collection("allOrders");
const partialOrders = client.db("profit-first").collection("partialOrders");
// 1. NEW COLLECTION FOR BLACKLIST
const blockedUsers = client.db("profit-first").collection("blockedUsers"); 


app.get('/', (req, res) => {
    res.send("Hi");
});

// --- UPDATED POST ROUTE WITH SECURITY BLOCKING ---
app.post("/orders", async (req, res) => {
  try {
    const order = req.body;

    // ============================================================
    // 0. SECURITY: BLOCK SCAMMERS (Device ID & Phone Number)
    // ============================================================
    // We look for the ID in clientInfo (from your screenshot) or root level
    const targetDeviceId = order.clientInfo?.deviceId || order.deviceId; 
    const targetPhone = order.number;

    // Construct query: Is the Device ID OR Phone Number in our blacklist?
    const blockQuery = {
        $or: []
    };

    if (targetDeviceId) blockQuery.$or.push({ identifier: targetDeviceId });
    if (targetPhone) blockQuery.$or.push({ identifier: targetPhone });

    // Only run check if we have something to check
    if (blockQuery.$or.length > 0) {
        const isBanned = await blockedUsers.findOne(blockQuery);
        
        if (isBanned) {
            console.log(`Blocked attempt from: ${isBanned.identifier} (${isBanned.reason})`);
            // Return 403 Forbidden - Frontend should handle this and show a generic error
            return res.status(403).send({ 
                success: false, 
                message: "System declined this order due to security policies." 
            });
        }
    }
    // ============================================================


    // 1. SECURITY: CHECK FOR DUPLICATE ACTIVE ORDERS
    const existingOrder = await allOrders.findOne({
      number: order.number,
      status: { 
        $nin: ["Delivered", "Cancelled", "Returned", "Return", "Cancel"] 
      } 
    });

    if (existingOrder) {
      return res.status(409).send({ 
        success: false, 
        reason: "active_order_exists", 
        message: "Active order already exists for this number." 
      });
    }

    // 2. ANALYTICS: CHECK FOR RECURRING CUSTOMER HISTORY
    const previousOrderCount = await allOrders.countDocuments({ number: order.number });

    // 3. ENRICH DATA
    order.customerStats = {
        isReturningCustomer: previousOrderCount > 0,
        totalOrdersBeforeThis: previousOrderCount,
        customerType: previousOrderCount > 0 ? "Returning" : "New"
    };

    // 4. GENERATE ORDER ID & SAVE
    const count = await allOrders.countDocuments();
    const generatedOrderId = 501 + count;

    order.orderId = generatedOrderId;
    order.createdAt = new Date(); 
    
    // Set default call status if not provided
    if (!order.phoneCallStatus) {
        order.phoneCallStatus = "Pending"; 
    }

    const result = await allOrders.insertOne(order);
    
    // ============================================================
    // --- FIX: AUTO-DELETE FROM ABANDONED ORDERS ---
    // ============================================================
    if (order.number) {
        try {
            await partialOrders.deleteMany({
                $or: [
                    { number: order.number },             // Matches if saved at root
                    { "marketing.number": order.number }, // Matches if saved inside marketing obj
                    { phone: order.number }               // Fallback check
                ]
            });
            
            // If your checkout sends deviceId, clean that specific session too
            if (targetDeviceId) {
                await partialOrders.deleteMany({ deviceId: targetDeviceId });
            }
        } catch (cleanupError) {
            console.log("Error cleaning up partial orders:", cleanupError);
        }
    }
    // ============================================================

    res.send({ success: true, message: "Order placed", orderId: generatedOrderId, mongoResult: result });

  } catch (error) {
    console.log(error.name, error.message);
    res.status(500).send({ success: false, message: "Server Error" });
  }
});


app.get("/orders", async (req, res) => {
  try {
    const query = {};
    const sort = { createdAt: -1 };
    const result = await allOrders.find(query).sort(sort).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
  }
});

// --- UPDATED ROUTE: Update Order Status & Save Timestamps ---
app.patch("/orders/:id", async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  const now = new Date();

  try {
    const filter = { _id: new ObjectId(id) };
    
    // Base update: always update status
    let updateFields = {
      status: status
    };

    // Add specific timestamps based on status
    if (status === "Shipped") {
        updateFields.shippedAt = now;
    } else if (status === "Delivered") {
        updateFields.deliveredAt = now;
    } else if (status === "Cancelled") {
        updateFields.cancelledAt = now;
    } else if (status === "Returned") {
        updateFields.returnedAt = now;
    }

    const updateDoc = {
      $set: updateFields,
    };

    const result = await allOrders.updateOne(filter, updateDoc);
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating status" });
  }
});

// --- NEW ROUTE: Update Call Status ---
app.patch("/orders/:id/call-status", async (req, res) => {
  const id = req.params.id;
  const { callStatus } = req.body;

  try {
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: {
        phoneCallStatus: callStatus 
      },
    };

    const result = await allOrders.updateOne(filter, updateDoc);
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating call status" });
  }
});

// --- NEW ROUTE: Update Shipping Method (Added for completeness) ---
app.patch("/orders/:id/shipping-method", async (req, res) => {
  const id = req.params.id;
  // Frontend sends 'shippingMethod' but your DB uses 'shipping'
  const { shippingMethod, shippingCost } = req.body;

  try {
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: {
        shipping: shippingMethod, 
        shippingCost: shippingCost
      },
    };

    const result = await allOrders.updateOne(filter, updateDoc);
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating shipping method" });
  }
});

// --- NEW ROUTE: Update Price (REQUESTED) ---
app.patch("/orders/:id/price", async (req, res) => {
  const id = req.params.id;
  const { totalValue } = req.body;

  try {
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: {
        totalValue: totalValue
      },
    };

    const result = await allOrders.updateOne(filter, updateDoc);
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating price" });
  }
});

// --- NEW ROUTE: SAVE PARTIAL DATA (ABANDONED CART) ---
app.post("/save-partial-order", async (req, res) => {
  try {
    const { deviceId, ...data } = req.body;

    if (!deviceId) {
      return res.status(400).send({ success: false, message: "Device ID required" });
    }

    const filter = { deviceId: deviceId };
    
    const updateDoc = {
      $set: {
        ...data,
        lastUpdated: new Date(),
        status: "Abandoned"
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    };

    const result = await partialOrders.updateOne(filter, updateDoc, { upsert: true });

    res.send({ success: true, result });

  } catch (error) {
    console.error("Partial Save Error:", error);
    res.status(500).send({ success: false });
  }
});


// --- NEW ROUTE: GET PARTIAL ORDERS (View Abandoned Carts) ---
app.get("/partial-orders", async (req, res) => {
  try {
    const result = await partialOrders
      .find({})
      .sort({ _id: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Error fetching partial orders:", error);
    res.status(500).send({ message: "Error fetching data" });
  }
});


app.delete("/partial-orders/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const filter = { _id: new ObjectId(id) };
    const result = await partialOrders.deleteOne(filter);
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error deleting partial order" });
  }
});


// --- NEW ROUTE: REVERSE MIGRATION (Active -> Abandoned) ---
app.post("/orders/:id/move-to-abandoned", async (req, res) => {
  const id = req.params.id;
  try {
    // 1. Find the order in Active Orders
    const order = await allOrders.findOne({ _id: new ObjectId(id) });
    if (!order) {
        return res.status(404).send({ success: false, message: "Order not found" });
    }

    // 2. Prepare data for Partial Orders
    const abandonedOrder = {
        ...order,
        _id: undefined, // Let MongoDB generate a fresh ID
        status: "Abandoned", 
        movedFromActive: true,
        restoredAt: new Date()
    };

    // 3. Insert into Partial Orders
    await partialOrders.insertOne(abandonedOrder);

    // 4. Delete from Active Orders
    await allOrders.deleteOne({ _id: new ObjectId(id) });

    res.send({ success: true, message: "Order moved to Abandoned" });

  } catch (error) {
    console.log("Reverse Migration Error:", error);
    res.status(500).send({ message: "Error moving order" });
  }
});

// --- NEW ROUTE: Update Order Note ---
app.patch("/orders/:id/note", async (req, res) => {
  const id = req.params.id;
  const { note } = req.body;

  try {
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: {
        note: note
      },
    };

    const result = await allOrders.updateOne(filter, updateDoc);
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error updating note" });
  }
});


// ============================================================
// --- NEW ADMIN ROUTES FOR BLOCKING SCAMMERS ---
// ============================================================

// 1. Manually Block a User (Send 'identifier' = deviceId or phoneNumber)
app.post("/admin/block-user", async (req, res) => {
    try {
        const { identifier, note } = req.body; // identifier can be deviceId OR phone number
        
        if (!identifier) return res.status(400).send({message: "Identifier required"});

        // Check if already blocked
        const exists = await blockedUsers.findOne({ identifier: identifier });
        if (exists) return res.status(400).send({message: "User already blocked"});

        const blockData = {
            identifier: identifier,
            note: note || "Blocked for spam",
            blockedAt: new Date()
        };

        const result = await blockedUsers.insertOne(blockData);
        res.send({ success: true, message: "User blocked successfully", result });
    } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Error blocking user" });
    }
});

// 2. Get All Blocked Users
app.get("/admin/blocked-users", async (req, res) => {
    try {
        const result = await blockedUsers.find({}).sort({ blockedAt: -1 }).toArray();
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Error fetching blocked users" });
    }
});

// 3. Unblock User (Remove from blacklist)
app.delete("/admin/blocked-users/:identifier", async (req, res) => {
    try {
        const identifier = req.params.identifier;
        const result = await blockedUsers.deleteOne({ identifier: identifier });
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Error unblocking user" });
    }
});
// ============================================================


app.listen(port, () => {  
    console.log(`server is running ${port}`);
});