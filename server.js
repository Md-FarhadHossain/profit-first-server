const express = require("express")
const app = express();
const { MongoClient, ServerApiVersion } = require('mongodb');
require("dotenv").config()
const cors = require("cors")
const port = 5000

app.use(express.json())
app.use(cors())


const uri = `mongodb+srv://${process.env.user}:${process.env.password}@cluster0.1ivadd4.mongodb.net/?appName=Cluster0`
console.log(uri)

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
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
    res.send("Hi")
})


app.post("/orders", async (req, res) => {
  try {
    const order = req.body;
    const result = await allOrders.insertOne(order);
    res.send(result);
  } catch (error) {
    console.log(error.name, error.message);
  }
});

app.get("/orders", async (req, res) => {
  try {
    const query = {};
    // This sort object tells MongoDB to sort by the _id field in descending order.
    // Since _ids are generated chronologically, -1 gets the newest ones first.
    const sort = { _id: -1 };

    // I've added .sort(sort) to your query here
    const result = await allOrders.find(query).sort(sort).toArray();

    res.send(result);
  } catch (error) {
    console.log(error);
  }
});
app.listen(port, () => {  
    console.log(`server is running ${port}`)
})