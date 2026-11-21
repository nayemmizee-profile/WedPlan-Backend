import cors from "cors";
import "dotenv/config";
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import multer from "multer";

// =============================================
// 1. INITIAL SETUP
// =============================================

const app = express();
const port = process.env.PORT || 8000;

// =============================================
// 2. GLOBAL MIDDLEWARE
// =============================================

// JSON Request গ্রহণ করার জন্য
app.use(express.json());

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

  // Step 1: Internal Request যাচাই
  verifyInternalRequest,

  // Step 2: সর্বোচ্চ ৫টি Image গ্রহণ
  upload.array("images", 5),

  async (req, res) => {
    try {
      // -----------------------------------------
      // STEP 1: GET VENDOR EMAIL
      // -----------------------------------------

      // Next.js API Route থেকে Verified Session-এর
      // Email গ্রহণ করা হচ্ছে
      // STEP 1: GET VENDOR INFORMATION

      const vendorEmail = req.headers["x-user-email"];
      const userId = req.headers["x-user-id"];

      if (!vendorEmail || !userId) {
        return res.status(400).json({
          success: false,
          message: "Vendor information is required",
        });
      }

      // Find vendor
      const vendor = await usersCollection.findOne({
        email: vendorEmail,
      });

      if (!vendor) {
        return res.status(404).json({
          success: false,
          message: "Vendor not found",
        });
      }

      // Verify MongoDB ID against Better Auth ID
      if (vendor._id.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "Vendor ID does not match",
        });
      }

      // Verify role
      if (vendor.role !== "vendor") {
        return res.status(403).json({
          success: false,
          message: "Only vendors can add services",
        });
      }

      const vendorId = vendor._id.toString();

      console.log("Received User ID:", req.headers["x-user-id"]);
      console.log("Received User Email:", req.headers["x-user-email"]);

      const allVendors = await usersCollection
        .find({
          role: "vendor",
        })
        .toArray();

      console.log("Available Vendors:", allVendors);

      // MongoDB-এর প্রকৃত Vendor ID সংগ্রহ

      // -----------------------------------------
      // STEP 3: CHECK VENDOR ROLE
      // -----------------------------------------

      // শুধুমাত্র Vendor Service Add করতে পারবে
      if (vendor.role !== "vendor") {
        return res.status(403).json({
          success: false,
          message: "Only vendors can add services",
        });
      }

      // -----------------------------------------
      // STEP 4: CHECK BLOCKED STATUS
      // -----------------------------------------

      // Admin Vendor-কে Block করলে
      // Service Add করতে পারবে না
      if (vendor.isBlocked === true) {
        return res.status(403).json({
          success: false,
          message: "Your account has been blocked",
        });
      }

      // -----------------------------------------
      // STEP 5: CHECK SUBSCRIPTION PLAN
      // -----------------------------------------

      // Vendor-এর Premium Subscription যাচাই
      const isPremium =
        vendor.subscriptionPlan === "premium" &&
        vendor.subscriptionExpiresAt &&
        new Date(vendor.subscriptionExpiresAt) > new Date();

      // -----------------------------------------
      // STEP 6: FREE PLAN SERVICE LIMIT
      // -----------------------------------------

      // Premium না হলে সর্বোচ্চ ৩টি Service Add করতে পারবে
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

      // -----------------------------------------
      // STEP 7: GET FORM DATA
      // -----------------------------------------

      // Frontend FormData থেকে Service Information নেওয়া
      const { serviceName, category, description, price, location } = req.body;

      // -----------------------------------------
      // STEP 8: VALIDATE FORM DATA
      // -----------------------------------------

      // Required Fields যাচাই
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

      // -----------------------------------------
      // STEP 9: VALIDATE PRICE
      // -----------------------------------------

      // Price Number-এ Convert
      const servicePrice = Number(price);

      // Positive Number কিনা যাচাই
      if (!Number.isFinite(servicePrice) || servicePrice <= 0) {
        return res.status(400).json({
          success: false,
          message: "Please provide a valid price",
        });
      }

      // -----------------------------------------
      // STEP 10: VALIDATE IMAGES
      // -----------------------------------------

      // অন্তত একটি Image Upload করতে হবে
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "At least one image is required",
        });
      }

      // -----------------------------------------
      // STEP 11: UPLOAD IMAGES TO IMGBB
      // -----------------------------------------

      // সকল Image ImgBB-তে Upload
      const imageUrls = await Promise.all(
        req.files.map((file) => uploadToImgBB(file)),
      );

      console.log("Images uploaded successfully:", imageUrls.length);

      // -----------------------------------------
      // STEP 12: CREATE SERVICE DOCUMENT
      // -----------------------------------------

      // MongoDB-তে Save করার জন্য Service Object
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

        // Uploaded Image URLs
        images: imageUrls,

        // Admin Approval-এর জন্য Default Status
        status: "pending",

        // Creation এবং Update Date
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // -----------------------------------------
      // STEP 13: INSERT INTO MONGODB
      // -----------------------------------------

      const result = await servicesCollection.insertOne(newService);

      // -----------------------------------------
      // STEP 14: SEND SUCCESS RESPONSE
      // -----------------------------------------

      return res.status(201).json({
        success: true,
        message: "Service added successfully. Waiting for admin approval.",

        serviceId: result.insertedId,

        service: {
          ...newService,
          _id: result.insertedId,
        },
      });
    } catch (error) {
      // -----------------------------------------
      // ERROR HANDLING
      // -----------------------------------------

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
    // 1. Total Users
    const totalUsers = await usersCollection.countDocuments();

    // 2. Total Services
    const totalServices = await servicesCollection.countDocuments();

    // 3. Total Bookings
    const totalBookings = await bookingsCollection.countDocuments();

    // 4. Total Transactions
    const totalTransactions = await transactionsCollection.countDocuments();

    const totalVendors = await usersCollection.countDocuments({
      $or: [{ role: "vendor" }, { accountType: "vendor" }],
    });

    const totalCustomers = await usersCollection.countDocuments({
      $or: [{ role: "user" }, { accountType: "user" }],
    });

    // 5. Service Statistics
    const serviceStats = await servicesCollection
      .aggregate([
        {
          $addFields: {
            finalStatus: {
              $ifNull: ["$approvalStatus", { $ifNull: ["$status", "pending"] }],
            },
          },
        },
        {
          $group: {
            _id: null,

            pendingServices: {
              $sum: {
                $cond: [{ $eq: ["$finalStatus", "pending"] }, 1, 0],
              },
            },

            approvedServices: {
              $sum: {
                $cond: [{ $eq: ["$finalStatus", "approved"] }, 1, 0],
              },
            },

            rejectedServices: {
              $sum: {
                $cond: [{ $eq: ["$finalStatus", "rejected"] }, 1, 0],
              },
            },

            activeServices: {
              $sum: {
                $cond: [{ $eq: ["$isActive", true] }, 1, 0],
              },
            },

            inactiveServices: {
              $sum: {
                $cond: [{ $eq: ["$isActive", false] }, 1, 0],
              },
            },
          },
        },
      ])
      .toArray();

    // 6. Default Statistics
    const stats = serviceStats[0] || {
      pendingServices: 0,
      approvedServices: 0,
      rejectedServices: 0,
      activeServices: 0,
      inactiveServices: 0,
    };

    // 7. Recent Services
    const recentServices = await servicesCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    // 8. Dashboard Response
    res.status(200).json({
      success: true,
      message: "Admin dashboard data fetched successfully",

      overview: {
        totalUsers,
        totalVendors,
        totalCustomers,

        totalServices,
        totalBookings,
        totalTransactions,

        pendingServices: stats.pendingServices,
        approvedServices: stats.approvedServices,
        rejectedServices: stats.rejectedServices,
        activeServices: stats.activeServices,
        inactiveServices: stats.inactiveServices,
      },

      recentServices: recentServices.map((service) => ({
        ...service,
        id: String(service._id),
        approvalStatus: service.approvalStatus || service.status || "pending",
      })),
    });
  } catch (error) {
    console.error("ADMIN OVERVIEW ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch admin overview",
      error: error.message,
    });
  }
});

/* =================================================
   END ADMIN ROUTES
================================================= */

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
