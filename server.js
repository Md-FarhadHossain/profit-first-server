const express = require("express");
const app = express();
// Import ObjectId here
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

app.get('/', (req, res) => {
    res.send("Hi");
});

// --- UPDATED POST ROUTE WITH DUPLICATE CHECK ---
app.post("/orders", async (req, res) => {
  try {
    const order = req.body;

    // 1. CHECK FOR EXISTING ACTIVE ORDER
    // We look for an order with the same number where the status is NOT finished.
    // Finished statuses = "Delivered", "Cancelled", "Returned"
    const existingOrder = await allOrders.findOne({
      number: order.number,
      status: { 
        $nin: ["Delivered", "Cancelled", "Returned", "Return", "Cancel"] 
      } 
    });

    // 2. IF ACTIVE ORDER EXISTS, STOP AND RETURN ERROR
    if (existingOrder) {
      return res.status(409).send({ 
        success: false, 
        reason: "active_order_exists", 
        message: "Active order already exists for this number." 
      });
    }

    // 3. IF NO DUPLICATE, PROCEED TO CREATE ORDER
    const count = await allOrders.countDocuments();
    const generatedOrderId = 501 + count;

    order.orderId = generatedOrderId;
    order.createdAt = new Date(); 
    
    // Set default call status if not provided
    order.phoneCallStatus = "Pending"; 

    const result = await allOrders.insertOne(order);
    
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

// --- EXISTING ROUTE: Update Order Status (Processing, Shipped, etc) ---
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

// --- NEW ROUTE: Update Call Status (Pending, Confirmed, No Answer) ---
app.patch("/orders/:id/call-status", async (req, res) => {
  const id = req.params.id;
  const { callStatus } = req.body;

  try {
    const filter = { _id: new ObjectId(id) };
    
    // Note: We map 'callStatus' from frontend to 'phoneCallStatus' in Database
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

app.listen(port, () => {  
    console.log(`server is running ${port}`);
});