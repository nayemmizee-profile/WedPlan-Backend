import cors from "cors";
import "dotenv/config";
import express from "express";
import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(express.json());
app.use(cors());

// MongoDB Connection
const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER_ID}:${process.env.DB_PASSWORD}@cluster0.stvgba2.mongodb.net/`,
);

const db = client.db("WeddingDB");

export { db };

// Home Route
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// Start MongoDB Connection
client
  .connect()
  .then(() => {
    console.log("Successfully connected to MongoDB!");
  })
  .catch((error) => {
    console.error("MongoDB connection failed:", error);
  });

// Server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
