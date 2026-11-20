import cors from "cors";
import "dotenv/config";
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import multer from "multer";

const app = express();
const port = process.env.PORT || 8000;

/* =========================================
   1. MIDDLEWARE
========================================= */

app.use(express.json());
app.use(cors());

/* =========================================
   2. MONGODB CONNECTION
========================================= */

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER_ID}:${process.env.DB_PASSWORD}@cluster0.stvgba2.mongodb.net/`,
);

const db = client.db("WeddingDB");

export { db };

/* =========================================
   3. COLLECTIONS
========================================= */

// Services Collection
const servicesCollection = db.collection("services");

// Better Auth User Collection
const usersCollection = db.collection("user");

/* =========================================
   4. MULTER CONFIGURATION
========================================= */

// Multer ব্যবহার করে Frontend থেকে পাঠানো Image File গ্রহণ করব।
//
// memoryStorage() ব্যবহার করার কারণে Image Server-এর
// Local Folder-এ Save হবে না। বরং RAM-এ থাকবে।
//
// এরপর সেই Image সরাসরি ImgBB-তে Upload করব।
//
// সর্বোচ্চ ৫টি Image নেওয়া যাবে।
// প্রতিটি Image সর্বোচ্চ ৫ MB হতে পারবে।

const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 5,
  },
});

/* =========================================
   5. INTERNAL REQUEST VERIFICATION
========================================= */

// Frontend সরাসরি Express Backend-এ Request পাঠাবে না।
// Next.js API Route-এর মাধ্যমে Request আসবে।
//
// Next.js API Route থেকে একটি Secret পাঠানো হবে।
// এখানে সেই Secret যাচাই করা হবে।
//
// Secret ভুল হলে Request গ্রহণ করা হবে না।
//
// গুরুত্বপূর্ণ:
// এই Middleware Multer-এর আগে ব্যবহার করা হয়েছে,
// যাতে Unauthorized Request-এর Image Upload-এর জন্য
// Server-এর Memory ব্যবহার না হয়।

const verifyInternalRequest = (req, res, next) => {
  const secret = req.headers["x-internal-secret"];

  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized access",
    });
  }

  next();
};

/* =========================================
   6. IMGBB IMAGE UPLOAD FUNCTION
========================================= */

// এই Function-এর কাজ হচ্ছে Frontend থেকে পাওয়া
// Image File ImgBB Server-এ Upload করা।
//
// Upload সফল হলে ImgBB আমাদের একটি Image URL দেবে।
// সেই URL আমরা MongoDB-তে Save করব।
//
// Image Binary Data MongoDB-তে Save করছি না।

const uploadToImgBB = async (file) => {
  const formData = new FormData();

  const imageBlob = new Blob([file.buffer], {
    type: file.mimetype,
  });

  formData.append("image", imageBlob, file.originalname);

  const response = await fetch(
    `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
    {
      method: "POST",
      body: formData,
    },
  );

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error("Image upload failed");
  }

  return result.data.url;
};

/* =========================================
   7. ADD NEW SERVICE API
========================================= */

// API Endpoint: POST /services
//
// এই API ব্যবহার করে Vendor নতুন Service Add করতে পারবে।
//
// Frontend থেকে FormData পাঠাতে হবে।
//
// FormData-এর মধ্যে থাকবে:
// 1. serviceName
// 2. category
// 3. description
// 4. price
// 5. location
// 6. images (একাধিক Image)
//
// Vendor ID Frontend থেকে সরাসরি বিশ্বাস করা হবে না।
// Next.js API Route-এর Trusted Header থেকে নেওয়া হবে।

app.post(
  "/services",
  verifyInternalRequest,
  upload.array("images", 5),
  async (req, res) => {
    try {
      /* -----------------------------------------
         STEP 1: GET VENDOR ID
      ----------------------------------------- */

      // Next.js API Route থেকে Vendor ID আসবে।
      // x-user-id Header-এর মাধ্যমে পাঠানো হবে।

      const vendorId = req.headers["x-user-id"];
      console.log("Vendor ID from header:", vendorId);

      console.log("User collection name:", usersCollection.collectionName);

      const allUsers = await usersCollection.find({}).limit(5).toArray();

      console.log("Users from database:", allUsers);

      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID is required",
        });
      }

      /* -----------------------------------------
         STEP 2: FIND VENDOR
      ----------------------------------------- */

      // Better Auth-এর User Collection থেকে Vendor খুঁজব।
      // এখানে ধরে নেওয়া হয়েছে User ID Field-এর নাম "id"।

      const vendor = await usersCollection.findOne({
        _id: new ObjectId(vendorId),
      });

      if (!vendor) {
        return res.status(404).json({
          success: false,
          message: "Vendor not found",
        });
      }

      /* -----------------------------------------
         STEP 3: CHECK USER ROLE
      ----------------------------------------- */

      // শুধুমাত্র Vendor-রাই Service Add করতে পারবে।
      // Customer বা Admin এই API ব্যবহার করতে পারবে না।

      if (vendor.role !== "vendor") {
        return res.status(403).json({
          success: false,
          message: "Only vendors can add services",
        });
      }

      /* -----------------------------------------
         STEP 4: CHECK BLOCKED STATUS
      ----------------------------------------- */

      // Admin যদি কোনো Vendor-কে Block করে,
      // তাহলে সেই Vendor নতুন Service Add করতে পারবে না।

      if (vendor.isBlocked === true) {
        return res.status(403).json({
          success: false,
          message: "Your account has been blocked",
        });
      }

      /* -----------------------------------------
         STEP 5: CHECK SUBSCRIPTION PLAN
      ----------------------------------------- */

      // Vendor-এর Subscription Premium কি না যাচাই করব।
      //
      // Premium Plan-এর মেয়াদ শেষ না হলে Unlimited
      // Service Add করতে পারবে।
      //
      // Free Plan-এর Vendor সর্বোচ্চ ৩টি Service Add
      // করতে পারবে।

      const isPremium =
        vendor.subscriptionPlan === "premium" &&
        vendor.subscriptionExpiresAt &&
        new Date(vendor.subscriptionExpiresAt) > new Date();

      /* -----------------------------------------
         STEP 6: FREE PLAN SERVICE LIMIT
      ----------------------------------------- */

      // Premium না হলে Vendor-এর মোট Service গণনা করব।
      //
      // Pending, Approved এবং Rejected সব Service
      // এই গণনার মধ্যে থাকবে।
      //
      // ৩টি Service হয়ে গেলে নতুন Service Add করতে পারবে না।
      // তখন Frontend-কে Upgrade Page-এ পাঠানোর জন্য
      // upgradeRequired: true পাঠানো হবে।

      if (!isPremium) {
        const totalServices = await servicesCollection.countDocuments({
          vendorId: vendorId,
        });

        if (totalServices >= 3) {
          return res.status(403).json({
            success: false,
            upgradeRequired: true,
            message:
              "Free plan allows only 3 services. Please upgrade to Premium.",
          });
        }
      }

      /* -----------------------------------------
         STEP 7: GET FORM DATA
      ----------------------------------------- */

      // Frontend-এর FormData থেকে Service-এর তথ্য নিচ্ছি।

      const { serviceName, category, description, price, location } = req.body;

      /* -----------------------------------------
         STEP 8: VALIDATE FORM DATA
      ----------------------------------------- */

      // প্রয়োজনীয় কোনো Field খালি থাকলে Request গ্রহণ করব না।

      if (
        !serviceName?.trim() ||
        !category?.trim() ||
        !description?.trim() ||
        !price ||
        !location?.trim()
      ) {
        return res.status(400).json({
          success: false,
          message: "All service fields are required",
        });
      }

      // Price অবশ্যই একটি Valid Positive Number হতে হবে।

      const servicePrice = Number(price);

      if (!Number.isFinite(servicePrice) || servicePrice <= 0) {
        return res.status(400).json({
          success: false,
          message: "Please provide a valid price",
        });
      }

      /* -----------------------------------------
         STEP 9: VALIDATE IMAGE FILES
      ----------------------------------------- */

      // অন্তত একটি Image Upload করতে হবে।

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "At least one image is required",
        });
      }

      /* -----------------------------------------
         STEP 10: UPLOAD IMAGES TO IMGBB
      ----------------------------------------- */

      // প্রতিটি Image ImgBB-তে Upload হবে।
      //
      // Promise.all() ব্যবহার করার কারণে একাধিক Image
      // একসঙ্গে Upload হবে।
      //
      // Upload সফল হলে Image URL-গুলো imageUrls Array-তে
      // পাওয়া যাবে।

      const imageUrls = await Promise.all(
        req.files.map((file) => uploadToImgBB(file)),
      );

      /* -----------------------------------------
         STEP 11: CREATE SERVICE DOCUMENT
      ----------------------------------------- */

      // MongoDB-তে Save করার জন্য নতুন Object তৈরি করছি।
      //
      // status: "pending" রাখা হয়েছে।
      // অর্থাৎ Admin Approve না করা পর্যন্ত Service
      // Public Website-এ দেখানো উচিত নয়।

      const newService = {
        vendorId: vendorId,
        serviceName: serviceName.trim(),
        category: category.trim(),
        description: description.trim(),
        price: servicePrice,
        location: location.trim(),
        images: imageUrls,
        status: "pending",
        createdAt: new Date(),
      };

      /* -----------------------------------------
         STEP 12: INSERT INTO MONGODB
      ----------------------------------------- */

      // Services Collection-এ নতুন Service Insert করছি।

      const result = await servicesCollection.insertOne(newService);

      /* -----------------------------------------
         STEP 13: SEND SUCCESS RESPONSE
      ----------------------------------------- */

      // Insert সফল হলে Frontend-এ Success Response পাঠাব।

      return res.status(201).json({
        success: true,
        message: "Service added successfully. Waiting for admin approval.",
        serviceId: result.insertedId,
        service: newService,
      });
    } catch (error) {
      /* -----------------------------------------
         ERROR HANDLING
      ----------------------------------------- */

      console.error("Add Service Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to add service",
        error: error.message,
      });
    }
  },
);

/* =========================================
   8. HOME ROUTE
========================================= */

app.get("/", (req, res) => {
  res.send("Hello World!");
});

/* =========================================
   9. START MONGODB CONNECTION
========================================= */

client
  .connect()
  .then(() => {
    console.log("Successfully connected to MongoDB!");
  })
  .catch((error) => {
    console.error("MongoDB connection failed:", error);
  });

/* =========================================
   10. SERVER
========================================= */

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
