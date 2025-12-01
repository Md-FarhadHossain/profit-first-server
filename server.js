const express = require("express");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require("dotenv").config();
const cors = require("cors");
const port = 5000;

app.use(express.json());
app.use(cors());

// --- CONFIGURATION ---
// ⚠️ SECURITY WARNING: Ideally, put this in your .env file as OPENROUTER_API_KEY
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "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";
const AI_MODEL = "google/gemma-2-9b-it:free"; // Using the free Gemma model as requested

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
const blockedUsers = client.db("profit-first").collection("blockedUsers"); 


// --- AI HELPER FUNCTION ---
const analyzeAddressWithAI = async (address) => {
    if (!address || address.length < 4) return { district: "Unknown", thana: "Unknown" };

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://profit-first.com", // Replace with your site URL
                "X-Title": "Profit First Dashboard",
            },
            body: JSON.stringify({
                "model": AI_MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a location parser for Bangladesh. You will receive an address. Your job is to extract the 'District' and 'Thana' (Sub-district). Return ONLY a JSON object in this format: {\"district\": \"Name\", \"thana\": \"Name\"}. If you cannot find them, return {\"district\": \"Unknown\", \"thana\": \"Unknown\"}. Do not add any markdown formatting."
                    },
                    {
                        "role": "user",
                        "content": `Address to parse: "${address}"`
                    }
                ],
                "response_format": { type: "json_object" } 
            })
        });

        const data = await response.json();
        const content = data.choices[0].message.content;
        
        // Clean up markdown if AI adds it (e.g. ```json ... ```)
        const cleanJson = content.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(cleanJson);

    } catch (error) {
        console.error("AI Address Parsing Failed:", error);
        return { district: "Manual Check", thana: "Manual Check" };
    }
};

app.get('/', (req, res) => {
    res.send("Hi");
});

// ============================================================
// --- BAN CHECK ROUTE ---
// ============================================================
app.get("/check-ban-status", async (req, res) => {
    try {
        const { ip, deviceId } = req.query;
        
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


// --- UPDATED POST ROUTE WITH AI ---
app.post("/orders", async (req, res) => {
  try {
    const order = req.body;

    // 0. SECURITY: BLOCK SCAMMERS
    const targetDeviceId = order.clientInfo?.deviceId || order.deviceId; 
    const targetPhone = order.number ? String(order.number).trim() : null;
    const targetIp = order.clientInfo?.ip; 

    // console.log("🛡️ Processing Order Check:", { device: targetDeviceId, phone: targetPhone, ip: targetIp });

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

    // 4. AI ADDRESS PROCESSING (NEW IMPLEMENTATION)
    console.log("🤖 AI Analysis started for address:", order.address);
    const locationDetails = await analyzeAddressWithAI(order.address);
    console.log("🤖 AI Result:", locationDetails);
    
    order.locationInfo = {
        district: locationDetails.district,
        thana: locationDetails.thana,
        aiProcessed: true
    };

    // 5. GENERATE ID & SAVE
    const count = await allOrders.countDocuments();
    const generatedOrderId = 501 + count;

    order.orderId = generatedOrderId;
    order.createdAt = new Date(); 
    order.number = targetPhone; 
    
    if (!order.phoneCallStatus) order.phoneCallStatus = "Pending"; 

    const result = await allOrders.insertOne(order);
    
    // CLEANUP
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
    const query = {};
    const sort = { createdAt: -1 };
    const result = await allOrders.find(query).sort(sort).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
  }
});

app.patch("/orders/:id", async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  const now = new Date();

  try {
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

// --- NEW ROUTE: MANUAL AI TRIGGER ---
app.post("/orders/:id/analyze-location", async (req, res) => {
    try {
        const id = req.params.id;
        // Use ObjectId if valid, otherwise handle as string ID if you use generated IDs differently
        // Assuming mongo _id here based on previous routes
        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { orderId: parseInt(id) };
        
        const order = await allOrders.findOne(query);
        
        if (!order) return res.status(404).send({ success: false, message: "Order not found" });
        if (!order.address) return res.status(400).send({ success: false, message: "No address to analyze" });

        console.log("👆 Manual AI Analysis requested for:", order.orderId);
        const locationDetails = await analyzeAddressWithAI(order.address);
        
        const updateDoc = {
            $set: {
                locationInfo: {
                    district: locationDetails.district,
                    thana: locationDetails.thana,
                    aiProcessed: true
                }
            }
        };

        // Update based on the same query used to find it
        await allOrders.updateOne(query, updateDoc);
        
        res.send({ 
            success: true, 
            data: locationDetails 
        });

    } catch (error) {
        console.error("Manual AI Analysis Error:", error);
        res.status(500).send({ success: false, message: "Analysis failed" });
    }
});

app.patch("/orders/:id/note", async (req, res) => {
  const id = req.params.id;
  const { note } = req.body;
  try {
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
        const result = await blockedUsers.find({}).sort({ blockedAt: -1 }).toArray();
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Error fetching blocked users" });
    }
});

app.delete("/admin/blocked-users/:identifier", async (req, res) => {
    try {
        const identifier = req.params.identifier;
        const result = await blockedUsers.deleteOne({ identifier: identifier });
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Error unblocking user" });
    }
});

app.listen(port, () => {  
    console.log(`server is running ${port}`);
});