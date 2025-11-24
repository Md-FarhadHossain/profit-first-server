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

const allOrders = client.db("profit-first").collection("allOrders");
const partialOrders = client.db("profit-first").collection("partialOrders");


app.get('/', (req, res) => {
    res.send("Hi");
});

// --- UPDATED POST ROUTE ---
app.post("/orders", async (req, res) => {
  try {
    const order = req.body;

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
    // Since the order is now successfully submitted, we remove the 
    // "draft" version from the partialOrders collection so it doesn't 
    // show up as abandoned anymore.
    
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
            if (order.deviceId) {
                await partialOrders.deleteMany({ deviceId: order.deviceId });
            }
        } catch (cleanupError) {
            console.log("Error cleaning up partial orders:", cleanupError);
            // We don't fail the request here, just log the error
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
    const sort = { _id: -1 };
    const result = await allOrders.find(query).sort(sort).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
  }
});

// --- EXISTING ROUTE: Update Order Status ---
app.patch("/orders/:id", async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

  try {
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: {
        status: status
      },
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


// --- NEW ROUTE: SAVE PARTIAL DATA (ABANDONED CART) ---
app.post("/save-partial-order", async (req, res) => {
  try {
    const { deviceId, ...data } = req.body;

    if (!deviceId) {
      return res.status(400).send({ success: false, message: "Device ID required" });
    }

    // We identify the user by their 'deviceId'. 
    // If they come back 1 hour later on the same phone, we update the same record.
    const filter = { deviceId: deviceId };
    
    const updateDoc = {
      $set: {
        ...data,
        lastUpdated: new Date(), // So you know when they last typed
        status: "Abandoned"      // distinct from "Processing"
      },
      $setOnInsert: {
        createdAt: new Date()    // Only set this when creating new
      }
    };

    // upsert: true -> Create if not exists, Update if exists
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
    // 1. Find all records in the 'partialOrders' collection
    // 2. Sort by 'lastUpdated' in descending order (-1) so the newest ones show first
    const result = await partialOrders
      .find({})
      .sort({ lastUpdated: -1 }) 
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
    // We strip the _id to create a new document in partialOrders
    // We force the status to 'Abandoned'
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

app.listen(port, () => {  
    console.log(`server is running ${port}`);
});