import cors from "cors";
import "dotenv/config";
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import multer from "multer";

import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// =============================================
// 1. INITIAL SETUP
// =============================================

const app = express();
const port = process.env.PORT || 8000;

// =============================================
// 2. GLOBAL MIDDLEWARE
// =============================================

// JSON Request গ্রহণ করার জন্য
app.use(
  express.json({
    verify: (req, res, buf) => {
      if (req.originalUrl === "/stripe/webhook") {
        req.rawBody = Buffer.from(buf);
      }
    },
  }),
);

// Frontend থেকে Request গ্রহণ করার জন্য
app.use(cors());

// =============================================
// 3. MONGODB CONNECTION
// =============================================

// Environment Variable থেকে MongoDB Credentials নেওয়া
const dbUser = process.env.DB_USER_ID;
const dbPassword = process.env.DB_PASSWORD;

// Credentials না থাকলে Error দেখাবে
if (!dbUser || !dbPassword) {
  throw new Error("MongoDB credentials are missing!");
}

// MongoDB Connection URL তৈরি
const mongoUri =
  `mongodb+srv://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}` +
  `@cluster0.stvgba2.mongodb.net/`;

// MongoDB Client তৈরি
const client = new MongoClient(mongoUri);

// Database নির্বাচন
const db = client.db("WEDDING_PLAN");

// Database Export
export { db };

// =============================================
// 4. DATABASE COLLECTIONS
// =============================================

// সকল Service এই Collection-এ থাকবে
const servicesCollection = db.collection("services");

// Better Auth-এর User Data এই Collection-এ থাকবে
const usersCollection = db.collection("user");

const transactionsCollection = db.collection("transactions");

const bookingsCollection = db.collection("bookings");

// =============================================
// 5. MULTER IMAGE UPLOAD CONFIGURATION
// =============================================

// Image Memory-তে রাখার জন্য Storage তৈরি
const storage = multer.memoryStorage();

// Multer Configuration
const upload = multer({
  storage,

  // File Size এবং সংখ্যা নির্ধারণ
  limits: {
    fileSize: 5 * 1024 * 1024, // Maximum 5 MB
    files: 5, // Maximum 5 Images
  },

  // শুধুমাত্র Image File গ্রহণ করা হবে
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"));
    }
  },
});

// =============================================
// 6. INTERNAL REQUEST VERIFICATION
// =============================================

// শুধুমাত্র Next.js API Route থেকে আসা
// Authorized Request গ্রহণ করার জন্য
const verifyInternalRequest = (req, res, next) => {
  const secret = req.headers["x-internal-secret"];

  // Internal Secret যাচাই
  if (
    !secret ||
    !process.env.INTERNAL_API_SECRET ||
    secret !== process.env.INTERNAL_API_SECRET
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized access",
    });
  }

  next();
};

// =============================================
// 7. IMGBB IMAGE UPLOAD FUNCTION
// =============================================

// Image ImgBB-তে Upload করে URL Return করবে
const uploadToImgBB = async (file) => {
  try {
    // ImgBB API Key সংগ্রহ
    const apiKey = process.env.IMGBB_API_KEY;

    if (!apiKey) {
      throw new Error("ImgBB API Key is missing!");
    }

    // FormData তৈরি
    const formData = new FormData();

    // Buffer থেকে Blob তৈরি
    const imageBlob = new Blob([file.buffer], {
      type: file.mimetype,
    });

    // Image FormData-তে যুক্ত
    formData.append("image", imageBlob, file.originalname);

    // সঠিক ImgBB API URL
    const imgBBUrl = `https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`;

    // ImgBB API-তে Image পাঠানো
    const response = await fetch(imgBBUrl, {
      method: "POST",
      body: formData,
    });

    // API Response JSON-এ Convert
    const result = await response.json();

    console.log("ImgBB Response Status:", response.status);

    // Upload সফল হয়েছে কিনা যাচাই
    if (!response.ok || !result.success) {
      throw new Error(result.error?.message || "ImgBB image upload failed");
    }

    // Uploaded Image URL Return
    return result.data.url;
  } catch (error) {
    console.error("IMGBB UPLOAD ERROR:", error);

    // মূল Error পরবর্তী Catch Block-এ পাঠানো
    throw error;
  }
};

// =============================================
// 8. ADD NEW SERVICE API
// =============================================

app.post(
  "/services",
  verifyInternalRequest,
  upload.array("images", 5),

  async (req, res) => {
    try {
      // =========================================
      // STEP 1: GET VENDOR INFORMATION
      // =========================================

      const vendorEmail = req.headers["x-user-email"];
      const userId = req.headers["x-user-id"];

      if (!vendorEmail || !userId) {
        return res.status(400).json({
          success: false,
          message: "Vendor information is required",
        });
      }

      // =========================================
      // STEP 2: FIND VENDOR FROM DATABASE
      // =========================================

      const vendor = await usersCollection.findOne({
        email: vendorEmail,
      });

      if (!vendor) {
        return res.status(404).json({
          success: false,
          message: "Vendor not found",
        });
      }

      // =========================================
      // STEP 3: VERIFY VENDOR ID
      // =========================================

      if (vendor._id.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "Vendor ID does not match",
        });
      }

      const vendorId = vendor._id.toString();

      console.log("Received Vendor ID:", vendorId);
      console.log("Received Vendor Email:", vendorEmail);

      // =========================================
      // STEP 4: CHECK VENDOR ROLE
      // =========================================

      if (vendor.role !== "vendor") {
        return res.status(403).json({
          success: false,
          message: "Only vendors can add services",
        });
      }

      // =========================================
      // STEP 5: CHECK BLOCK STATUS
      // =========================================

      // Admin Block API uses banned field.
      if (vendor.banned === true) {
        return res.status(403).json({
          success: false,
          message: "Your account has been blocked",
        });
      }

      // =========================================
      // STEP 6: CHECK PREMIUM STATUS
      // =========================================

      const isPremium =
        vendor.subscriptionPlan === "premium" &&
        vendor.subscriptionStatus === "active";

      // =========================================
      // STEP 7: FREE VENDOR SERVICE LIMIT
      // =========================================

      if (!isPremium) {
        const totalServices = await servicesCollection.countDocuments({
          vendorId: vendorId,
        });

        // Free vendor can add maximum 3 services.
        if (totalServices >= 3) {
          return res.status(403).json({
            success: false,
            code: "SERVICE_LIMIT_REACHED",
            upgradeRequired: true,
            message:
              "You have reached your free service limit. Please pay $199 to unlock Lifetime Premium.",
            totalServices,
            freeLimit: 3,
            upgradeUrl: "/vendor/upgrade",
          });
        }
      }

      // =========================================
      // STEP 8: GET SERVICE FORM DATA
      // =========================================

      const { serviceName, category, description, price, location } = req.body;

      // =========================================
      // STEP 9: VALIDATE REQUIRED FIELDS
      // =========================================

      if (
        typeof serviceName !== "string" ||
        !serviceName.trim() ||
        typeof category !== "string" ||
        !category.trim() ||
        typeof description !== "string" ||
        !description.trim() ||
        price === undefined ||
        price === null ||
        price === "" ||
        typeof location !== "string" ||
        !location.trim()
      ) {
        return res.status(400).json({
          success: false,
          message: "All service fields are required",
        });
      }

      // =========================================
      // STEP 10: VALIDATE SERVICE PRICE
      // =========================================

      const servicePrice = Number(price);

      if (!Number.isFinite(servicePrice) || servicePrice <= 0) {
        return res.status(400).json({
          success: false,
          message: "Please provide a valid price",
        });
      }

      // =========================================
      // STEP 11: CHECK UPLOADED IMAGES
      // =========================================

      const images = req.files || [];

      if (images.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Please upload at least one image",
        });
      }

      // =========================================
      // STEP 12: UPLOAD IMAGES TO IMGBB
      // =========================================

      // Multer memoryStorage provides file.buffer.
      // uploadToImgBB must accept the Multer file object.

      const imageUrls = await Promise.all(
        images.map((file) => uploadToImgBB(file)),
      );

      console.log("Images uploaded successfully:", imageUrls.length);

      // Verify all image uploads were successful.
      if (
        imageUrls.length !== images.length ||
        imageUrls.some((url) => typeof url !== "string" || !url)
      ) {
        return res.status(500).json({
          success: false,
          message: "Image upload failed",
        });
      }

      // =========================================
      // STEP 13: CREATE NEW SERVICE DOCUMENT
      // =========================================

      const newService = {
        // Vendor Information
        vendorId: vendorId,
        vendorName: vendor.name,
        vendorEmail: vendor.email,

        // Service Information
        serviceName: serviceName.trim(),
        category: category.trim(),
        description: description.trim(),
        price: servicePrice,
        location: location.trim(),

        // Uploaded ImgBB Image URLs
        images: imageUrls,

        // Admin Approval
        approvalStatus: "pending",

        // Creation and Update Date
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // =========================================
      // STEP 14: SAVE SERVICE TO MONGODB
      // =========================================

      const result = await servicesCollection.insertOne(newService);

      // =========================================
      // STEP 15: SEND SUCCESS RESPONSE
      // =========================================

      return res.status(201).json({
        success: true,
        message: "Service added successfully. Waiting for admin approval.",

        serviceId: result.insertedId,

        isPremium,
        totalImages: imageUrls.length,

        service: {
          ...newService,
          _id: result.insertedId,
        },
      });
    } catch (error) {
      // =========================================
      // ERROR HANDLING
      // =========================================

      console.error("ADD SERVICE ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to add service",
        error: error.message,
        cause: error.cause?.message || null,
      });
    }
  },
);

// !!! GET METHOD for VENDOR service==============>
// !!! GET METHOD for VENDOR service==============>

app.get("/vendor/services", verifyInternalRequest, async (req, res) => {
  try {
    const vendorId = req.headers["x-user-id"];

    if (!vendorId) {
      return res.status(401).json({
        success: false,
        message: "Vendor authentication required",
      });
    }

    // Find only this vendor's services
    const query = {
      vendorId: vendorId,
    };

    // Fetch all vendor services without filtering or sorting
    const services = await servicesCollection.find(query).toArray();

    // Calculate status counts
    const statusCounts = await servicesCollection
      .aggregate([
        {
          $match: {
            vendorId: vendorId,
          },
        },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const counts = {
      pending: 0,
      approved: 0,
      rejected: 0,
    };

    statusCounts.forEach((item) => {
      if (item._id in counts) {
        counts[item._id] = item.count;
      }
    });

    return res.status(200).json({
      success: true,
      totalServices: services.length,
      counts,
      services,
    });
  } catch (error) {
    console.error("GET VENDOR SERVICES ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch services",
      error: error.message,
    });
  }
});

// ===========================================
// ? END
// ===========================================

// ===========================================
//  Get single card details
// ===========================================

//  end ==============================================
// end single card details
// ====================================================

// =================================================
//! ADMIN middleware
// =================================================

/* =================================================
   ADMIN MIDDLEWARE & HELPERS
================================================= */

// Admin User IDs
const adminUserIds = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// Admin Verification Middleware
const verifyAdmin = (req, res, next) => {
  const secret = req.headers["x-internal-secret"];
  const userId = req.headers["x-user-id"];

  // Verify internal secret
  if (
    !process.env.INTERNAL_API_SECRET ||
    secret !== process.env.INTERNAL_API_SECRET
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized request",
    });
  }

  // Verify Admin User ID
  if (!adminUserIds.includes(String(userId || ""))) {
    return res.status(403).json({
      success: false,
      message: "Admin access required",
    });
  }

  next();
};

// MongoDB ID Helper
const getIdFilter = (id) => {
  if (ObjectId.isValid(id)) {
    return {
      $or: [{ _id: new ObjectId(id) }, { _id: id }, { id: id }],
    };
  }

  return {
    $or: [{ _id: id }, { id: id }],
  };
};

// Remove Password from User Data
const safeUser = (user) => {
  if (!user) return null;

  const { password, ...rest } = user;

  return {
    ...rest,
    id: String(user._id || user.id),
  };
};

// Escape Regex Special Characters
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* =================================================
   ADMIN USER MANAGEMENT
================================================= */

// GET: Fetch All Users with Search, Role & Pagination
app.get("/admin/users", verifyAdmin, async (req, res) => {
  try {
    const { search = "", role = "", page = 1, limit = 10 } = req.query;

    const currentPage = Math.max(1, Number(page) || 1);
    const pageLimit = Math.min(50, Math.max(1, Number(limit) || 10));

    const filter = {};

    // Role Filter
    if (role) {
      filter.role = role;
    }

    // Search by Name or Email
    if (search.trim()) {
      const regex = new RegExp(escapeRegex(search.trim()), "i");

      filter.$or = [{ name: regex }, { email: regex }];
    }

    // Fetch Users and Total Count
    const [users, total] = await Promise.all([
      usersCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * pageLimit)
        .limit(pageLimit)
        .toArray(),

      usersCollection.countDocuments(filter),
    ]);

    // Format User Data
    const data = users.map((user) => ({
      ...safeUser(user),
      isAdmin: adminUserIds.includes(String(user._id || user.id)),
    }));

    res.json({
      success: true,
      data: {
        users: data,
        total,
        page: currentPage,
        limit: pageLimit,
        totalPages: Math.ceil(total / pageLimit),
      },
    });
  } catch (error) {
    console.error("Admin Users Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
    });
  }
});

// GET: Fetch Single User Details
app.get("/admin/users/:id", verifyAdmin, async (req, res) => {
  try {
    const user = await usersCollection.findOne(getIdFilter(req.params.id));

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      data: {
        ...safeUser(user),
        isAdmin: adminUserIds.includes(String(user._id || user.id)),
      },
    });
  } catch (error) {
    console.error("User Details Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch user details",
    });
  }
});

// PATCH: Block User
app.patch("/admin/users/:id/block", verifyAdmin, async (req, res) => {
  try {
    const user = await usersCollection.findOne(getIdFilter(req.params.id));

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const targetId = String(user._id || user.id);

    if (adminUserIds.includes(targetId)) {
      return res.status(403).json({
        success: false,
        message: "Admin cannot be blocked",
      });
    }

    // User-কে Block করা
    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: {
          banned: true,
          banReason: "Blocked by administrator",
          updatedAt: new Date(),
        },
      },
    );

    // আগের Login Session বাতিল করা
    await db.collection("session").deleteMany({
      userId: targetId,
    });

    res.json({
      success: true,
      message: "User blocked successfully",
    });
  } catch (error) {
    console.error("Block User Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to block user",
      error: error.message,
    });
  }
});

// PATCH: Unblock User
app.patch("/admin/users/:id/unblock", verifyAdmin, async (req, res) => {
  try {
    const user = await usersCollection.findOne(getIdFilter(req.params.id));

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const targetId = String(user._id || user.id);

    if (adminUserIds.includes(targetId)) {
      return res.status(403).json({
        success: false,
        message: "Invalid operation",
      });
    }

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: {
          banned: false,
          updatedAt: new Date(),
        },
        $unset: {
          banReason: "",
          banExpires: "",
        },
      },
    );

    res.json({
      success: true,
      message: "User unblocked successfully",
    });
  } catch (error) {
    console.error("Unblock User Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to unblock user",
      error: error.message,
    });
  }
});

/* =================================================
   ADMIN SERVICE MANAGEMENT
================================================= */

// GET: Fetch All Services with Search & Status Filter
app.get("/admin/services", verifyAdmin, async (req, res) => {
  try {
    const { search = "", status = "" } = req.query;

    const filter = {};

    // Status Filter
    if (status) {
      filter.$or = [
        { approvalStatus: status },
        {
          approvalStatus: { $exists: false },
          status,
        },
      ];
    }

    // Search Services
    if (search.trim()) {
      const regex = new RegExp(escapeRegex(search.trim()), "i");

      const searchFilter = {
        $or: [
          { serviceName: regex },
          { title: regex },
          { category: regex },
          { location: regex },
        ],
      };

      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, searchFilter];

        delete filter.$or;
      } else {
        Object.assign(filter, searchFilter);
      }
    }

    // Fetch Services
    const services = await servicesCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    // Attach Vendor Information
    const data = await Promise.all(
      services.map(async (service) => {
        const vendor = service.vendorId
          ? await usersCollection.findOne(getIdFilter(String(service.vendorId)))
          : null;

        return {
          ...service,
          id: String(service._id),
          vendorName: vendor?.name || "Unknown Vendor",
          vendorEmail: vendor?.email || "",
          approvalStatus: service.approvalStatus || service.status || "pending",
        };
      }),
    );

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("========== ADMIN SERVICES ERROR ==========");
    console.error("Error Message:", error.message);
    console.error("Error Stack:", error.stack);
    console.error("===========================================");

    res.status(500).json({
      success: false,
      message: "Failed to fetch services",
      error: error.message,
    });
  }
});

// PATCH: Approve Service
app.patch("/admin/services/:id/approve", verifyAdmin, async (req, res) => {
  try {
    const result = await servicesCollection.updateOne(
      getIdFilter(req.params.id),
      {
        $set: {
          approvalStatus: "approved",
          status: "approved",
          isActive: true,
          updatedAt: new Date(),
        },
      },
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    res.json({
      success: true,
      message: "Service approved successfully",
    });
  } catch (error) {
    console.error("Approve Service Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to approve service",
    });
  }
});

// PATCH: Reject Service
app.patch("/admin/services/:id/reject", verifyAdmin, async (req, res) => {
  try {
    const result = await servicesCollection.updateOne(
      getIdFilter(req.params.id),
      {
        $set: {
          approvalStatus: "rejected",
          status: "rejected",
          isActive: false,
          updatedAt: new Date(),
        },
      },
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    res.json({
      success: true,
      message: "Service rejected successfully",
    });
  } catch (error) {
    console.error("Reject Service Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to reject service",
    });
  }
});

// PATCH: Activate / Deactivate Service
app.patch("/admin/services/:id/status", verifyAdmin, async (req, res) => {
  try {
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "Valid isActive value is required",
      });
    }

    const result = await servicesCollection.updateOne(
      getIdFilter(req.params.id),
      {
        $set: {
          isActive,
          updatedAt: new Date(),
        },
      },
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    res.json({
      success: true,
      message: `Service ${isActive ? "activated" : "deactivated"} successfully`,
    });
  } catch (error) {
    console.error("Service Status Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to update service status",
    });
  }
});

// DELETE: Delete Service
app.delete("/admin/services/:id", verifyAdmin, async (req, res) => {
  try {
    const result = await servicesCollection.deleteOne(
      getIdFilter(req.params.id),
    );

    if (!result.deletedCount) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    res.json({
      success: true,
      message: "Service deleted successfully",
    });
  } catch (error) {
    console.error("Delete Service Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete service",
    });
  }
});

// =================================================
// ADMIN DASHBOARD OVERVIEW
// =================================================

app.get("/admin/overview", verifyAdmin, async (req, res) => {
  try {
    // Registered users
    const totalUsers = await usersCollection.countDocuments();

    // Vendors
    const totalVendors = await usersCollection.countDocuments({
      role: "vendor",
    });

    // Customers
    const totalCustomers = await usersCollection.countDocuments({
      role: "user",
    });

    // Services
    const totalServices = await servicesCollection.countDocuments();

    // Pending services
    const pendingServices = await servicesCollection.countDocuments({
      approvalStatus: "pending",
    });

    // Total transactions (all statuses)
    const totalTransactions = await transactionsCollection.countDocuments();

    // Total successfully received payment amount
    const transactionStats = await transactionsCollection
      .aggregate([
        {
          $match: {
            status: "paid",
            currency: "usd",
          },
        },
        {
          $group: {
            _id: null,
            totalAmount: {
              $sum: "$amount",
            },
          },
        },
      ])
      .toArray();

    const totalTransactionAmount = transactionStats[0]?.totalAmount || 0;

    return res.status(200).json({
      success: true,
      overview: {
        totalUsers,
        totalVendors,
        totalCustomers,
        totalServices,
        pendingServices,
        totalTransactions,
        totalTransactionAmount,
      },
    });
  } catch (error) {
    console.error("Admin Overview Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load admin overview",
    });
  }
});

// =====================================================
// Admin Transactions
// =====================================================

app.get("/admin/transactions", verifyAdmin, async (req, res) => {
  try {
    const { search = "", status = "", plan = "" } = req.query;

    const pipeline = [
      {
        $lookup: {
          from: "user",
          let: { vendorId: "$vendorId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [{ $toString: "$_id" }, "$$vendorId"],
                },
              },
            },
            {
              $project: {
                name: 1,
                email: 1,
                image: 1,
                role: 1,
                subscriptionPlan: 1,
                subscriptionStatus: 1,
              },
            },
          ],
          as: "vendor",
        },
      },
      {
        $unwind: {
          path: "$vendor",
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    // Search Filter
    if (search.trim()) {
      const regex = new RegExp(
        search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );

      pipeline.push({
        $match: {
          $or: [
            { vendorEmail: regex },
            { vendorId: regex },
            { stripeSessionId: regex },
            { stripePaymentIntent: regex },
            { plan: regex },
            { status: regex },
            { "vendor.name": regex },
            { "vendor.email": regex },
          ],
        },
      });
    }

    // Status Filter
    if (status) {
      pipeline.push({
        $match: { status },
      });
    }

    // Plan Filter
    if (plan) {
      pipeline.push({
        $match: { plan },
      });
    }

    // Latest transactions first
    pipeline.push({
      $sort: { createdAt: -1 },
    });

    const transactions = await transactionsCollection
      .aggregate(pipeline)
      .toArray();

    const formattedTransactions = transactions.map((transaction) => ({
      id: transaction._id.toString(),

      vendorId: transaction.vendorId,

      vendorName: transaction.vendor?.name || "Unknown Vendor",

      vendorEmail:
        transaction.vendor?.email || transaction.vendorEmail || "Unknown Email",

      vendorImage: transaction.vendor?.image || null,

      vendorRole: transaction.vendor?.role || null,

      subscriptionPlan: transaction.vendor?.subscriptionPlan || null,

      subscriptionStatus: transaction.vendor?.subscriptionStatus || null,

      plan: transaction.plan,

      amount: transaction.amount,

      currency: transaction.currency,

      status: transaction.status,

      stripeSessionId: transaction.stripeSessionId,

      stripePaymentIntent: transaction.stripePaymentIntent || null,

      createdAt: transaction.createdAt,

      paidAt: transaction.paidAt || null,
    }));

    return res.status(200).json({
      success: true,
      total: formattedTransactions.length,
      data: formattedTransactions,
    });
  } catch (error) {
    console.error("Admin Transactions Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch transactions",
    });
  }
});

// ====================================================

/* =================================================
   END ADMIN ROUTES
================================================= */

// ?===============================================
// STRIPE checkout
// ?===============================================
// Create Stripe Checkout Session

app.post("/payments/create-checkout-session", async (req, res) => {
  try {
    // 1. Verify internal request
    const secret = req.headers["x-internal-secret"];
    const userId = req.headers["x-user-id"];

    if (
      !process.env.INTERNAL_API_SECRET ||
      secret !== process.env.INTERNAL_API_SECRET
    ) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized request",
      });
    }

    // 2. Validate user ID
    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    // 3. Find vendor
    const vendor = await usersCollection.findOne({
      _id: new ObjectId(userId),
    });

    if (!vendor || vendor.role !== "vendor") {
      return res.status(403).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // 4. Check blocked status
    if (vendor.isBlocked === true || vendor.banned === true) {
      return res.status(403).json({
        success: false,
        message: "Your account is blocked",
      });
    }

    // 5. Check existing Premium
    if (
      vendor.subscriptionPlan === "premium" &&
      vendor.subscriptionStatus === "active"
    ) {
      return res.status(400).json({
        success: false,
        message: "You already have Premium access",
      });
    }

    // 6. Count vendor services
    // Supports both string and ObjectId vendorId
    const totalServices = await servicesCollection.countDocuments({
      vendorId: {
        $in: [userId, new ObjectId(userId)],
      },
    });

    if (totalServices < 3) {
      return res.status(403).json({
        success: false,
        message: "You can add 3 free services first",
      });
    }

    // 7. Validate CLIENT_URL
    const clientUrl = process.env.CLIENT_URL?.trim().replace(/\/+$/, "");

    if (!clientUrl) {
      throw new Error("CLIENT_URL is missing in backend .env");
    }

    let parsedClientUrl;

    try {
      parsedClientUrl = new URL(clientUrl);
    } catch {
      throw new Error(
        `Invalid CLIENT_URL: ${clientUrl}. Please include http:// or https://`,
      );
    }

    if (
      parsedClientUrl.protocol !== "http:" &&
      parsedClientUrl.protocol !== "https:"
    ) {
      throw new Error("CLIENT_URL must use HTTP or HTTPS");
    }

    // 8. Create Stripe Checkout Session
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",

      customer_email: vendor.email,

      client_reference_id: userId,

      metadata: {
        userId: userId.toString(),
        plan: "premium",
      },

      line_items: [
        {
          price_data: {
            currency: "usd",

            product_data: {
              name: "Wedding Plan Premium Membership",
              description: "Unlimited additional service listings",
            },

            unit_amount: 19900,
          },

          quantity: 1,
        },
      ],

      success_url: `${clientUrl}/vendor/payment/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${clientUrl}/vendor/upgrade`,
    });
    console.log("CHECKOUT SESSION CREATED:", {
      sessionId: checkoutSession.id,
      userId: checkoutSession.metadata?.userId,
      plan: checkoutSession.metadata?.plan,
      clientReferenceId: checkoutSession.client_reference_id,
      amount: checkoutSession.amount_total,
      currency: checkoutSession.currency,
    });

    // 9. Save pending transaction
    await transactionsCollection.updateOne(
      {
        stripeSessionId: checkoutSession.id,
      },
      {
        $setOnInsert: {
          vendorId: userId,
          vendorEmail: vendor.email,
          plan: "premium",
          amount: 199,
          currency: "usd",
          stripeSessionId: checkoutSession.id,
          status: "pending",
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    // 10. Send Stripe URL
    return res.status(200).json({
      success: true,
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    });
  } catch (error) {
    console.error("========== STRIPE CHECKOUT ERROR ==========");
    console.error("Error Message:", error.message);
    console.error("Error Type:", error.type);
    console.error("Error Code:", error.code);
    console.error("Full Error:", error);
    console.error("============================================");

    return res.status(500).json({
      success: false,
      message: "Could not create checkout session",
      debug: error.message,
    });
  }
});

// ?=====================================================
// ?=====================================================

app.post("/stripe/verify-payment", verifyInternalRequest, async (req, res) => {
  try {
    const { sessionId } = req.body;

    const userId = req.headers["x-user-id"];

    if (!sessionId || !userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment information",
      });
    }

    // STEP 1: Retrieve Checkout Session from Stripe
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

    // STEP 2: Verify Payment
    if (
      checkoutSession.mode !== "payment" ||
      checkoutSession.payment_status !== "paid" ||
      checkoutSession.amount_total !== 19900 ||
      checkoutSession.currency !== "usd" ||
      checkoutSession.metadata?.plan !== "premium" ||
      checkoutSession.metadata?.userId !== userId
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed",
      });
    }

    // STEP 3: Find Transaction
    const transaction = await transactionsCollection.findOne({
      stripeSessionId: sessionId,
      vendorId: userId,
      plan: "premium",
      amount: 199,
      currency: "usd",
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    // STEP 4: Already Paid Check
    if (transaction.status === "paid") {
      return res.status(200).json({
        success: true,
        message: "Premium already activated",
      });
    }

    if (transaction.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Transaction is already being processed",
      });
    }

    // STEP 5: Atomically Claim Transaction
    const claimResult = await transactionsCollection.updateOne(
      {
        _id: transaction._id,
        status: "pending",
      },
      {
        $set: {
          status: "processing",
          processingAt: new Date(),
        },
      },
    );

    if (claimResult.modifiedCount !== 1) {
      return res.status(409).json({
        success: false,
        message: "Transaction is already being processed",
      });
    }

    try {
      // STEP 6: Activate Vendor Premium
      const updateResult = await usersCollection.updateOne(
        {
          _id: new ObjectId(userId),
          role: "vendor",
        },
        {
          $set: {
            subscriptionPlan: "premium",
            subscriptionStatus: "active",
            premiumActivatedAt: new Date(),
            stripeCustomerId: checkoutSession.customer || null,
          },
        },
      );

      if (updateResult.matchedCount !== 1) {
        throw new Error("Vendor not found");
      }

      // STEP 7: Mark Transaction Paid
      const transactionUpdate = await transactionsCollection.updateOne(
        {
          _id: transaction._id,
          status: "processing",
        },
        {
          $set: {
            status: "paid",
            stripePaymentIntent: checkoutSession.payment_intent || null,
            paidAt: new Date(),
          },
          $unset: {
            processingAt: "",
          },
        },
      );

      if (transactionUpdate.modifiedCount !== 1) {
        throw new Error("Transaction update failed");
      }

      return res.status(200).json({
        success: true,
        message: "Premium activated successfully",
      });
    } catch (processingError) {
      console.error("Premium Activation Error:", processingError);

      await transactionsCollection.updateOne(
        {
          _id: transaction._id,
          status: "processing",
        },
        {
          $set: {
            status: "pending",
          },
          $unset: {
            processingAt: "",
          },
        },
      );

      throw processingError;
    }
  } catch (error) {
    console.error("Payment Verification Error:", error);

    return res.status(500).json({
      success: false,
      message: "Payment verification failed",
    });
  }
});

// ?=====================================================

// ===================================================
//  usering booking
// ===================================================

app.post("/bookings", verifyInternalRequest, async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];
    const userEmail = req.headers["x-user-email"];
    const userRole = req.headers["x-user-role"];

    const { serviceId, eventDate } = req.body;

    // Only normal users can book
    if (userRole !== "user") {
      return res.status(403).json({
        success: false,
        message: "Only users can book services",
      });
    }

    if (!userId || !userEmail) {
      return res.status(401).json({
        success: false,
        message: "User information is required",
      });
    }

    if (!ObjectId.isValid(serviceId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service ID",
      });
    }

    if (!eventDate || Number.isNaN(Date.parse(eventDate))) {
      return res.status(400).json({
        success: false,
        message: "Valid event date is required",
      });
    }

    // Verify user from database
    const user = await usersCollection.findOne({
      email: userEmail,
    });

    if (!user || user.role !== "user") {
      return res.status(403).json({
        success: false,
        message: "User account is not authorized",
      });
    }

    // Find approved and active service
    const service = await servicesCollection.findOne({
      _id: new ObjectId(serviceId),
      status: "approved",
      approvalStatus: "approved",
      isActive: true,
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found or unavailable",
      });
    }

    // Prevent booking own service
    if (service.vendorId === userId) {
      return res.status(403).json({
        success: false,
        message: "You cannot book your own service",
      });
    }

    const booking = {
      serviceId: service._id.toString(),
      serviceName: service.serviceName,
      serviceImage: service.images?.[0] || "",
      price: service.price,

      vendorId: service.vendorId,
      vendorName: service.vendorName,
      vendorEmail: service.vendorEmail,

      userId,
      userName: user.name,
      userEmail: user.email,

      eventDate: new Date(eventDate),

      status: "pending",

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);

    res.status(201).json({
      success: true,
      message: "Booking request sent successfully",
      bookingId: result.insertedId,
    });
  } catch (error) {
    console.error("Create Booking Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to send booking request",
    });
  }
});

// =============================================

//  geting booking
// =============================================

// ==============================================
// GET VENDOR BOOKINGS
// ==============================================

app.get("/vendor/bookings", verifyInternalRequest, async (req, res) => {
  try {
    const vendorId = req.headers["x-user-id"];
    const vendorRole = req.headers["x-user-role"];

    if (!vendorId || vendorRole !== "vendor") {
      return res.status(403).json({
        success: false,
        message: "Vendor access denied",
      });
    }

    // ১. URL থেকে status গ্রহণ
    const { status = "all" } = req.query;

    // ২. Allowed status যাচাই
    const allowedStatuses = ["all", "pending", "accepted", "rejected"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    // ৩. Vendor অনুযায়ী query তৈরি
    const query = { vendorId };

    // ৪. All ছাড়া অন্য filter হলে status যোগ
    if (status !== "all") {
      query.status = status;
    }

    // ৫. Filter অনুযায়ী booking বের করা
    const bookings = await bookingsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    // ৬. সব status-এর count বের করা
    const [pending, accepted, rejected] = await Promise.all([
      bookingsCollection.countDocuments({
        vendorId,
        status: "pending",
      }),
      bookingsCollection.countDocuments({
        vendorId,
        status: "accepted",
      }),
      bookingsCollection.countDocuments({
        vendorId,
        status: "rejected",
      }),
    ]);

    return res.status(200).json({
      success: true,
      bookings,
      counts: {
        pending,
        accepted,
        rejected,
      },
    });
  } catch (error) {
    console.error("Vendor Bookings Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch bookings",
    });
  }
});
// ==============================================
// booking id
// ==============================================
app.patch("/bookings/:id/accept", verifyInternalRequest, async (req, res) => {
  try {
    const vendorId = req.headers["x-user-id"];
    const vendorRole = req.headers["x-user-role"];

    if (vendorRole !== "vendor") {
      return res.status(403).json({
        success: false,
        message: "Only vendors can accept bookings",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID",
      });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: new ObjectId(id),
        vendorId,
        status: "pending",
      },
      {
        $set: {
          status: "accepted",
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending booking not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Booking accepted successfully",
    });
  } catch (error) {
    console.error("Accept Booking Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to accept booking",
    });
  }
});
// ==============================================
// booking rejecte
// =============================================

app.patch("/bookings/:id/reject", verifyInternalRequest, async (req, res) => {
  try {
    const vendorId = req.headers["x-user-id"];
    const vendorRole = req.headers["x-user-role"];

    if (vendorRole !== "vendor") {
      return res.status(403).json({
        success: false,
        message: "Only vendors can reject bookings",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID",
      });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: new ObjectId(id),
        vendorId,
        status: "pending",
      },
      {
        $set: {
          status: "rejected",
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending booking not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Booking rejected successfully",
    });
  } catch (error) {
    console.error("Reject Booking Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to reject booking",
    });
  }
});

// ===========================================
// book service route
// ==========================================

// ==========================================
// my-bookings
// =========================================

app.get("/my-bookings", verifyInternalRequest, async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];
    const userRole = req.headers["x-user-role"];

    // Authentication check
    if (!userId || userRole !== "user") {
      return res.status(403).json({
        success: false,
        message: "Only authenticated users can access their bookings",
      });
    }

    // Fetch bookings belonging to this user
    const bookings = await bookingsCollection
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      totalBookings: bookings.length,
      bookings,
    });
  } catch (error) {
    console.error("My Bookings Backend Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch bookings",
    });
  }
});

// ============================================
// user dashboard
// =============================================

app.get("/user/dashboard", verifyInternalRequest, async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    const bookingsCollection = db.collection("bookings");
    const favoritesCollection = db.collection("favorites");

    // Get all bookings of logged-in user
    const bookings = await bookingsCollection
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    // Booking statistics
    const totalBookings = bookings.length;

    const pendingBookings = bookings.filter(
      (booking) => booking.status === "pending",
    ).length;

    const confirmedBookings = bookings.filter(
      (booking) => booking.status === "accepted",
    ).length;

    const rejectedBookings = bookings.filter(
      (booking) => booking.status === "rejected",
    ).length;

    const cancelledBookings = bookings.filter(
      (booking) => booking.status === "cancelled",
    ).length;

    // Favorite vendors count
    const totalFavorites = await favoritesCollection.countDocuments({
      userId,
    });

    // Recent bookings
    const recentBookings = bookings.slice(0, 5);

    // Upcoming accepted events
    const now = new Date();

    const upcomingEvent =
      bookings
        .filter((booking) => {
          return (
            booking.status === "accepted" && new Date(booking.eventDate) >= now
          );
        })
        .sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate))[0] ||
      null;

    return res.status(200).json({
      success: true,

      stats: {
        totalBookings,
        pendingBookings,
        confirmedBookings,
        rejectedBookings,
        cancelledBookings,
        totalFavorites,
      },

      recentBookings,
      upcomingEvent,
    });
  } catch (error) {
    console.error("User dashboard error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load dashboard data",
    });
  }
});

// ============================================
// Home services card
// ============================================

app.get("/services/approved", async (req, res) => {
  try {
    const { sort = "newest" } = req.query;

    const sortOptions = {
      newest: { createdAt: -1 },
      lowToHigh: { price: 1 },
      highToLow: { price: -1 },
    };

    const sortQuery = sortOptions[sort] || sortOptions.newest;

    const approvedServices = await servicesCollection
      .find({
        status: "approved",
        approvalStatus: "approved",
        isActive: true,
      })
      .sort(sortQuery)
      .limit(10)
      .toArray();

    res.status(200).json({
      success: true,
      totalServices: approvedServices.length,
      services: approvedServices,
    });
  } catch (error) {
    console.error("Approved Services Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch approved services",
    });
  }
});

// ================================================
// all services page
// =============================================

app.get("/services/all-approved", async (req, res) => {
  try {
    const { sort = "newest" } = req.query;

    const sortOptions = {
      newest: { createdAt: -1 },
      lowToHigh: { price: 1 },
      highToLow: { price: -1 },
    };

    const sortQuery = sortOptions[sort] || sortOptions.newest;

    // Fetch ALL approved and active services
    // No limit here

    const approvedServices = await servicesCollection
      .find({
        status: "approved",
        approvalStatus: "approved",
        isActive: true,
      })
      .sort(sortQuery)
      .toArray();

    res.status(200).json({
      success: true,
      totalServices: approvedServices.length,
      services: approvedServices,
    });
  } catch (error) {
    console.error("All Approved Services Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch all approved services",
    });
  }
});

// Get Single Service by ID
app.get("/services/:id", verifyInternalRequest, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service ID",
      });
    }

    const service = await db
      .collection("services")
      .findOne({ _id: new ObjectId(id) });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    return res.status(200).json({
      success: true,
      service,
    });
  } catch (error) {
    console.error("Service Details Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch service",
    });
  }
});

// ============================================

// ============================================
// VENDOR TRANSACTION HISTORY
// ============================================

app.get(
  "/api/vendor/dashboard/subscription",
  verifyInternalRequest,
  async (req, res) => {
    try {
      const vendorId = req.headers["x-user-id"];

      if (!vendorId) {
        return res.status(401).json({
          success: false,
          message: "Vendor authentication required",
        });
      }

      const limit = Math.min(Math.max(Number(req.query.limit) || 3, 1), 10);

      // 1. Get vendor information from usersCollection
      const user = await usersCollection.findOne(
        { _id: new ObjectId(vendorId) },
        {
          projection: {
            password: 0,
          },
        },
      );

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "Vendor not found",
        });
      }

      // 2. Get latest successful payment to determine current plan
      const latestPayment = await transactionsCollection.findOne(
        {
          vendorId,
          status: "paid",
        },
        {
          sort: {
            paidAt: -1,
            createdAt: -1,
          },
        },
      );

      // 3. Get premium payment history
      const transactions = await transactionsCollection
        .find({
          vendorId,
          plan: "premium",
          status: "paid",
        })
        .sort({
          paidAt: -1,
          createdAt: -1,
        })
        .limit(limit)
        .project({
          vendorId: 0,
          vendorEmail: 0,
        })
        .toArray();

      // 4. Prepare subscription information
      const subscription = {
        plan: latestPayment?.plan?.toLowerCase() || "free",
        status: user.subscriptionStatus || "inactive",
        expiryDate: user.subscriptionExpiry || null,
      };

      return res.status(200).json({
        success: true,
        subscription,
        totalTransactions: transactions.length,
        transactions,
      });
    } catch (error) {
      console.error("Vendor Subscription Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to load subscription",
      });
    }
  },
);

// =============================================
// 9. HOME ROUTE
// =============================================

// Backend Server সচল আছে কিনা পরীক্ষা
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// =============================================
// 10. GLOBAL ERROR HANDLER
// =============================================

// Multer এবং অন্যান্য Middleware-এর Error Handle
app.use((error, req, res, next) => {
  console.error("GLOBAL ERROR:", error);

  // Multer Error Handle
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  // অন্য Middleware Error
  return res.status(400).json({
    success: false,
    message: error.message || "Something went wrong",
  });
});

// =============================================
// 11. CONNECT DATABASE AND START SERVER
// =============================================

// MongoDB Connection সফল হওয়ার পর Express Server চালু
// এখানে startServer() ব্যবহার করা হচ্ছে না

client
  .connect()
  .then(() => {
    console.log("Successfully connected to MongoDB!");

    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("MongoDB connection failed:", error);
  });

export default app;
