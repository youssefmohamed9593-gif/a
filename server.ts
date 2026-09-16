import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { PRODUCTS } from "./src/data";
import { PaymentStatus, FulfillmentStatus, ShippingStatus } from "./src/types";
import {
  ingestAnalyticsEvents,
  recordHeartbeat,
  getLiveVisitorsSummary,
  computeDashboardAnalytics,
  computeSingleProductAnalytics,
  generateAnalyticsCSV,
} from "./src/serverAnalytics";
import {
  getInventoryItems,
  getInventoryTransactions,
  getOrderTimelineEvents,
  recordOrderTimelineEvent,
  getOrderReturns,
  saveOrderReturn,
  getOrderRefunds,
  saveOrderRefund,
  getOrderFulfillments,
  saveOrderFulfillment,
  reserveInventoryForOrder,
  releaseInventoryForOrder,
  fulfillInventoryForOrder,
  adjustManualInventoryStock,
  restockReturnedItem,
  computeInventoryKPIs,
  generateSkuForProduct,
} from "./src/serverInventory";
import {
  getPostgresPool,
  isPostgresConfigured,
  createPostgresClient,
  checkPostgresHealth,
  initializePostgresDatabase,
  closePostgresPool,
} from "./server/db";

// Password Hashing Helpers
function generateSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

function hashPassword(password: string, salt: string, iterations: number = 10000): string {
  return crypto.pbkdf2Sync(password, salt, iterations, 64, "sha512").toString("hex");
}

function verifyPassword(password: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  try {
    // 1. Verify against 10,000 iterations (standard PBKDF2 SHA-512)
    const verifyHash10k = hashPassword(password, salt, 10000);
    if (crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(verifyHash10k, "hex"))) {
      return true;
    }
    // 2. Backward compatibility fallback for legacy 1,000 iterations
    const verifyHash1k = hashPassword(password, salt, 1000);
    if (crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(verifyHash1k, "hex"))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Load environment variables from .env files
const envFiles = [".env.local", ".env"];
const loadedEnvFiles: string[] = [];

for (const envFile of envFiles) {
  const envPath = path.join(process.cwd(), envFile);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
    loadedEnvFiles.push(envFile);
  }
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Body limits increased to 50mb for high-res handling
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Static directories configuration & static serving
const PUBLIC_DIR = path.join(process.cwd(), "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");
const IMAGES_DIR = path.join(PUBLIC_DIR, "images");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/images", express.static(IMAGES_DIR));
app.use(express.static(PUBLIC_DIR));

/**
 * Saves a base64 DataURL as a real static file in public/uploads/
 * and returns the clean lightweight URL path (/uploads/img_xxx.ext).
 */
function saveBase64Image(dataUrl: string): string {
  if (!dataUrl || typeof dataUrl !== "string") return dataUrl;
  if (!dataUrl.startsWith("data:image/")) return dataUrl;

  try {
    const matches = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!matches || matches.length < 3) return dataUrl;

    let ext = matches[1].toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    if (ext === "svg+xml") ext = "svg";
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, "base64");

    const fileName = `img_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    fs.writeFileSync(filePath, buffer);
    console.log(`[Image Upload] Saved base64 image to static file: /uploads/${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return `/uploads/${fileName}`;
  } catch (err) {
    console.error("[Image Upload Error] Failed to save base64 image to disk:", err);
    return dataUrl;
  }
}

/**
 * Sanitizes all images in a product object to avoid storing massive base64 payloads
 */
function sanitizeProductImageUrls(product: any): any {
  if (!product || typeof product !== "object") return product;
  const p = { ...product };

  if (p.image && typeof p.image === "string" && p.image.startsWith("data:image/")) {
    p.image = saveBase64Image(p.image);
  }

  if (Array.isArray(p.secondaryImages)) {
    p.secondaryImages = p.secondaryImages.map((img: any) => {
      if (typeof img === "string" && img.startsWith("data:image/")) {
        return saveBase64Image(img);
      }
      return img;
    });
  }

  if (Array.isArray(p.variants)) {
    p.variants = p.variants.map((v: any) => {
      if (v && v.image && typeof v.image === "string" && v.image.startsWith("data:image/")) {
        return { ...v, image: saveBase64Image(v.image) };
      }
      return v;
    });
  }

  return p;
}

let pgClient: any = null;

function getDatabaseClient() {
  if (isPostgresConfigured()) {
    const pool = getPostgresPool();
    if (pool) {
      if (!pgClient) {
        pgClient = createPostgresClient(pool);
        console.log("[Express Server] Database connection established -> PostgreSQL");
      }
      return pgClient;
    }
  }
  return null;
}

// Database client alias for seamless backend route compatibility
const getSupabase = getDatabaseClient;

// Log startup environment diagnostics
const initialPostgres = isPostgresConfigured();
console.log(`=======================================================`);
console.log(`[Express Server Startup Diagnostic]`);
console.log(`Loaded Env Files: ${loadedEnvFiles.join(", ") || "None"}`);
console.log(`PostgreSQL Configured: ${initialPostgres ? "YES (Native PostgreSQL)" : "NO"}`);
if (initialPostgres) {
  console.log(`Status: ✅ Native PostgreSQL Database ACTIVE`);
} else {
  console.warn(`Status: ⚠️ Local In-Memory Fallback Active`);
}
console.log(`=======================================================`);

// AUTO-SEED SUPABASE DATABASE IF EMPTY
async function seedSupabaseDatabase() {
  const supabase = getSupabase();
  if (!supabase) return;

  try {
    // 1. Categories
    console.log("[Supabase Auto-Seed] Ensuring all boutique categories are synced...");
    const catRows = [
      { id: "fine-jewelry", name: "Fine Jewelry", name_en: "Fine Jewelry", name_ar: "المجوهرات الراقية", slug: "fine-jewelry", image: "https://lh3.googleusercontent.com/aida-public/AB6AXuB_4xPadl5w6Pl2wmap9TNWjuW3eRqmSaee8UcVUYb5Ob0tjxyVXXgSUz8bd800TgShznRuwLsCSE8fL8g54lW8D6Y2Wqn77Y3VnnDy11ZQQyS78UrFyUgxqRXe83BtXdaR7o05YC071Tjfyge5uII8vI9eb_n0zITggflZzz8_ocIceRDAsQovQqPZTN6SXT9FkEnH750_FvFUxz-___-L_RW-wCIyddPds8SWGNUvJZlb-z3tgbVqUqsnmttQOxLDZXqdfrdHuOs" },
      { id: "timepieces", name: "Timepieces", name_en: "Timepieces", name_ar: "الساعات الفاخرة", slug: "timepieces", image: "https://lh3.googleusercontent.com/aida-public/AB6AXuAHURVDMw0Ut_yNnemHeLgqN9kEmRJy9KfyIJhWGm36fQh-CMtrO0pGYuaCr4MR-OaDy0sUnfzCwvRWYY9815RVkpasZq00PZ0fRbmOmCVpkPwSWKRtiicrCUREgDhVRGMuHYa792wqM27VJFjYjxLBhHEpkVf0Ipvb3HquyCydhbrE5uPWIC5KS6E4w4d31wBTOnNQIu3ooZafSZ0qWewaHaQeiPuHaoRpnPOY5j01Hhjk48HWuTgKuMfPyIs5QbInR7O3tUJq5c8" },
      { id: "necklaces", name: "Necklaces", name_en: "Necklaces", name_ar: "القلائد والسلاسل", slug: "necklaces", image: "/images/luxury-necklace-banner.jpg" },
      { id: "rings", name: "Rings", name_en: "Rings", name_ar: "الخواتم", slug: "rings", image: "/images/sculpted-aurelian-ring.jpg" },
      { id: "earrings", name: "Earrings", name_en: "Earrings", name_ar: "الأقراط", slug: "earrings", image: "/images/desert-moon-hoops.jpg" },
      { id: "bracelets", name: "Bracelets", name_en: "Bracelets", name_ar: "الأساور", slug: "bracelets", image: "/images/eternal-bangle.jpg" },
      { id: "leather-goods", name: "Leather Goods", name_en: "Leather Goods", name_ar: "المنتجات الجلدية", slug: "leather-goods", image: "/images/essential-cardholder.jpg" },
      { id: "accessories", name: "Accessories", name_en: "Accessories", name_ar: "الإكسسوارات", slug: "accessories", image: "/images/artisan-watch-roll.jpg" }
    ];
    await supabase.from("categories").upsert(catRows, { onConflict: "id" });

    // 2. Products
    const { data: prodCheck } = await supabase.from("products").select("id").limit(1);
    if (!prodCheck || prodCheck.length === 0) {
      console.log("[Supabase Auto-Seed] Seeding products table...");
      const prodRows = PRODUCTS.map(p => ({
        id: p.id,
        name: p.name,
        category_id: p.categoryId || "rings",
        price: p.price,
        original_price: p.originalPrice || null,
        points_earned: p.pointsEarned || Math.floor(p.price / 100),
        stock: p.stock === undefined ? 10 : p.stock,
        is_new: !!p.isNew,
        pre_order: Boolean(p.isPreOrder),
        images: [p.image, ...(p.secondaryImages || [])].filter(Boolean),
        sizes: p.sizeOptions || ["Standard", "Premium"],
        materials: p.materialOptions || ["#E5D5BC", "#E5E4E2"],
        description: p.description || ""
      }));
      await supabase.from("products").upsert(prodRows, { onConflict: "id" });
    }

    // 3. Coupons
    const { data: couponCheck } = await supabase.from("coupons").select("id").limit(1);
    if (!couponCheck || couponCheck.length === 0) {
      console.log("[Supabase Auto-Seed] Seeding coupons table...");
      await supabase.from("coupons").upsert([
        { id: "coupon-vero10", code: "VERO10", discount_percent: 10, active: true },
        { id: "coupon-vip20", code: "VIP20", discount_percent: 20, active: true }
      ], { onConflict: "id" });
    }

    // 4. Admin and Customer Users (Ensure seed accounts always exist in Supabase Auth & DB)
    console.log("[Supabase Auto-Seed] Checking and seeding default accounts in Supabase Auth...");
    const seedAccounts = [
      {
        email: "vero2026@vero.com",
        password: "VeroAdmin2026!",
        name: "VERO Executive Admin",
        role: "admin",
        tier: "Platinum",
        loyalty_points: 5000,
        total_spent: 125000
      },
      {
        email: "admin@vero.com",
        password: "VeroAdmin2026!",
        name: "VERO System Admin",
        role: "admin",
        tier: "Platinum",
        loyalty_points: 5000,
        total_spent: 100000
      },
      {
        email: "arthurdevelopment101@gmail.com",
        password: "VeroCustomer2026!",
        name: "Arthur Collector",
        role: "customer",
        tier: "Gold",
        loyalty_points: 1250,
        total_spent: 42000
      },
      {
        email: "customer@vero.com",
        password: "VeroCustomer2026!",
        name: "VERO Customer",
        role: "customer",
        tier: "Gold",
        loyalty_points: 1000,
        total_spent: 25000
      }
    ];

    for (const acc of seedAccounts) {
      let authUserId: string | null = null;
      try {
        const { data: existingUser } = await supabase.from("users").select("id").eq("email", acc.email).maybeSingle();
        if (existingUser?.id) {
          authUserId = existingUser.id;
        }
      } catch (err: any) {}

      if (!authUserId) {
        authUserId = `user-${acc.email.split("@")[0]}`;
      }

      const salt = generateSalt();
      const pwdHash = hashPassword(acc.password, salt);

      await supabase.from("users").upsert([
        {
          id: authUserId,
          email: acc.email,
          name: acc.name,
          role: acc.role,
          tier: acc.tier,
          loyalty_points: acc.loyalty_points,
          total_spent: acc.total_spent,
          avatar: "default",
          password_hash: pwdHash,
          salt: salt,
        }
      ], { onConflict: "id" });
    }

    // 5. Reviews
    const { data: reviewCheck } = await supabase.from("reviews").select("id").limit(1);
    if (!reviewCheck || reviewCheck.length === 0) {
      console.log("[Supabase Auto-Seed] Seeding reviews table...");
      await supabase.from("reviews").upsert([
        {
          id: "rev-1",
          product_id: PRODUCTS[0]?.id || "prod-royal-emerald-ring",
          user_name: "Eleanor Vance",
          user_email: "eleanor@example.com",
          rating: 5,
          title: "Exquisite Craftsmanship",
          comment: "The emerald cut diamond catches the light beautifully. Superb quality!",
          helpful_count: 12,
          verified_purchase: true,
          status: "approved"
        }
      ], { onConflict: "id" });
    }

    // 6. Egyptian Shipping Rates
    await syncShippingRatesWithSupabase();

    console.log("[Supabase Auto-Seed] ✅ Auto-seeding check completed successfully!");
  } catch (err) {
    console.error("[Supabase Auto-Seed Error]:", err);
  }
}

// Trigger auto-seeding
seedSupabaseDatabase();

// Central Logger and Executor for Database Writes
async function dbWriteLogAndExecute(
  table: string,
  actionName: string,
  req: any,
  res: any,
  operation: () => Promise<{ data: any; error: any }>
) {
  console.log(`=======================================================`);
  console.log(`[DB WRITE REQUEST RECEIVED] ${req.method} ${req.path}`);
  console.log(`Action: ${actionName}`);
  console.log(`SQL Table: ${table}`);
  console.log(`Payload:`, JSON.stringify(req.body, null, 2));

  const supabase = getSupabase();
  if (!supabase) {
    console.error(`[DB WRITE FAILED] Database client is NOT configured.`);
    return res.status(500).json({ error: "Database client is not configured." });
  }

  try {
    const { data, error } = await operation();
    if (error) {
      if (error.code === "PGRST116") {
        console.log(`[DB WRITE NOTICE] Table: ${table} | 0 rows affected (PGRST116). Returning null.`);
        console.log(`=======================================================`);
        return data || null;
      }
      console.error(`[DB WRITE ERROR] Table: ${table} | Supabase Error:`, JSON.stringify(error, null, 2));
      console.log(`=======================================================`);
      return res.status(500).json({
        error: `Supabase database error: ${error.message || "Failed to execute database write"}`,
        code: error.code,
        details: error.details,
        hint: error.hint,
        table
      });
    }

    console.log(`[DB WRITE SUCCESS] Table: ${table} | Insert/Update Result:`, JSON.stringify(data, null, 2));
    console.log(`=======================================================`);
    return data;
  } catch (err: any) {
    console.error(`[DB WRITE UNHANDLED EXCEPTION] Table: ${table} | Error:`, err);
    console.log(`=======================================================`);
    return res.status(500).json({ error: err.message || "Internal database server error", table });
  }
}

// Security & In-Memory State Buffers

const DEFAULT_USERS = [
  {
    id: "usr-admin-1",
    email: "vero2026@vero.com",
    name: "VERO Executive Admin",
    role: "admin",
    tier: "Platinum",
    loyaltyPoints: 5000,
    totalSpent: 125000,
    avatar: "default",
    joinedDate: "2026-01-01"
  },
  {
    id: "usr-admin-2",
    email: "admin@vero.com",
    name: "VERO System Admin",
    role: "admin",
    tier: "Platinum",
    loyaltyPoints: 5000,
    totalSpent: 100000,
    avatar: "default",
    joinedDate: "2026-01-05"
  },
  {
    id: "usr-cust-1",
    email: "arthurdevelopment101@gmail.com",
    name: "Arthur Collector",
    role: "customer",
    tier: "Gold",
    loyaltyPoints: 1250,
    totalSpent: 42000,
    avatar: "default",
    joinedDate: "2026-02-10"
  },
  {
    id: "usr-cust-2",
    email: "customer@vero.com",
    name: "VERO Customer",
    role: "customer",
    tier: "Gold",
    loyaltyPoints: 1000,
    totalSpent: 25000,
    avatar: "default",
    joinedDate: "2026-02-14"
  },
  {
    id: "usr-cust-3",
    email: "eleanor@example.com",
    name: "Eleanor Vance",
    role: "customer",
    tier: "Silver",
    loyaltyPoints: 680,
    totalSpent: 18500,
    avatar: "default",
    joinedDate: "2026-02-18"
  },
  {
    id: "usr-cust-4",
    email: "sarah.m@example.com",
    name: "Sarah Miller",
    role: "customer",
    tier: "Bronze",
    loyaltyPoints: 250,
    totalSpent: 4500,
    avatar: "default",
    joinedDate: "2026-02-24"
  }
];

let memoryUsers: any[] = [...DEFAULT_USERS];

const USERS_DISK_FILE = path.join(process.cwd(), "public", "uploads", "users.json");

function getUsersFromDisk(): any[] {
  try {
    if (fs.existsSync(USERS_DISK_FILE)) {
      const fileUsers = JSON.parse(fs.readFileSync(USERS_DISK_FILE, "utf-8"));
      if (Array.isArray(fileUsers) && fileUsers.length > 0) {
        fileUsers.forEach((fu: any) => {
          if (fu && (fu.email || fu.id)) {
            const idx = memoryUsers.findIndex(
              (mu: any) => (fu.email && mu.email?.toLowerCase() === fu.email.toLowerCase()) || (fu.id && mu.id === fu.id)
            );
            if (idx >= 0) {
              memoryUsers[idx] = { ...memoryUsers[idx], ...fu };
            } else {
              memoryUsers.push(fu);
            }
          }
        });
      }
    }
  } catch (e) {}

  // Merge credentialsMap users if missing
  try {
    if (typeof credentialsMap !== "undefined" && credentialsMap && credentialsMap.size > 0) {
      for (const [email, cred] of credentialsMap.entries()) {
        const cleanEmail = email.toLowerCase().trim();
        const existing = memoryUsers.find((u: any) => u.email?.toLowerCase() === cleanEmail || u.id === cred.id);
        if (!existing) {
          memoryUsers.push({
            id: cred.id || `usr-${cleanEmail}`,
            email: cleanEmail,
            name: cred.name || cleanEmail.split("@")[0],
            role: cred.role || (isVeroAdminEmail(cleanEmail) ? "admin" : "customer"),
            tier: "Bronze",
            loyaltyPoints: 250,
            totalSpent: 0,
            avatar: "default",
            joinedDate: new Date(cred.createdAt || Date.now()).toISOString().split("T")[0]
          });
        }
      }
    }
  } catch (e) {}

  return memoryUsers;
}

function saveUsersToDisk(usersArr: any[]) {
  memoryUsers = usersArr;
  try {
    const dir = path.dirname(USERS_DISK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USERS_DISK_FILE, JSON.stringify(usersArr, null, 2));
  } catch (e) {}
}

const DEFAULT_CATEGORIES = [
  { id: "fine-jewelry", name: "Fine Jewelry", name_en: "Fine Jewelry", name_ar: "المجوهرات الراقية", slug: "fine-jewelry", image: "https://lh3.googleusercontent.com/aida-public/AB6AXuB_4xPadl5w6Pl2wmap9TNWjuW3eRqmSaee8UcVUYb5Ob0tjxyVXXgSUz8bd800TgShznRuwLsCSE8fL8g54lW8D6Y2Wqn77Y3VnnDy11ZQQyS78UrFyUgxqRXe83BtXdaR7o05YC071Tjfyge5uII8vI9eb_n0zITggflZzz8_ocIceRDAsQovQqPZTN6SXT9FkEnH750_FvFUxz-___-L_RW-wCIyddPds8SWGNUvJZlb-z3tgbVqUqsnmttQOxLDZXqdfrdHuOs", target_gender: "All", genders: ["Men", "Women", "Unisex"] },
  { id: "timepieces", name: "Timepieces", name_en: "Timepieces", name_ar: "الساعات الفاخرة", slug: "timepieces", image: "https://lh3.googleusercontent.com/aida-public/AB6AXuAHURVDMw0Ut_yNnemHeLgqN9kEmRJy9KfyIJhWGm36fQh-CMtrO0pGYuaCr4MR-OaDy0sUnfzCwvRWYY9815RVkpasZq00PZ0fRbmOmCVpkPwSWKRtiicrCUREgDhVRGMuHYa792wqM27VJFjYjxLBhHEpkVf0Ipvb3HquyCydhbrE5uPWIC5KS6E4w4d31wBTOnNQIu3ooZafSZ0qWewaHaQeiPuHaoRpnPOY5j01Hhjk48HWuTgKuMfPyIs5QbInR7O3tUJq5c8", target_gender: "All", genders: ["Men", "Women", "Unisex"] },
  { id: "necklaces", name: "Necklaces", name_en: "Necklaces", name_ar: "القلائد والسلاسل", slug: "necklaces", image: "/images/luxury-necklace-banner.jpg", target_gender: "All", genders: ["Men", "Women", "Unisex"] },
  { id: "rings", name: "Rings", name_en: "Rings", name_ar: "الخواتم", slug: "rings", image: "/images/sculpted-aurelian-ring.jpg", target_gender: "All", genders: ["Men", "Women", "Unisex"] },
  { id: "earrings", name: "Earrings", name_en: "Earrings", name_ar: "الأقراط", slug: "earrings", image: "/images/desert-moon-hoops.jpg", target_gender: "Women", genders: ["Women"] },
  { id: "bracelets", name: "Bracelets", name_en: "Bracelets", name_ar: "الأساور", slug: "bracelets", image: "/images/eternal-bangle.jpg", target_gender: "All", genders: ["Men", "Women", "Unisex"] },
  { id: "leather-goods", name: "Leather Goods", name_en: "Leather Goods", name_ar: "المنتجات الجلدية", slug: "leather-goods", image: "/images/essential-cardholder.jpg", target_gender: "All", genders: ["Men", "Women", "Unisex"] },
  { id: "accessories", name: "Accessories", name_en: "Accessories", name_ar: "الإكسسوارات", slug: "accessories", image: "/images/artisan-watch-roll.jpg", target_gender: "All", genders: ["Men", "Women", "Unisex"] }
];

let memoryCategories: any[] = [...DEFAULT_CATEGORIES];

function getCategoriesFromDisk(): any[] {
  return memoryCategories;
}

function saveCategoriesToDisk(categoriesArr: any[]) {
  memoryCategories = categoriesArr;
}

function validateProductCategoryAndGender(
  categoryId: string,
  gender: string,
  categoriesList: any[]
): { valid: boolean; message?: string } {
  if (!gender) {
    return { valid: false, message: "Target gender is required." };
  }
  if (!categoryId) {
    return { valid: false, message: "Category is required." };
  }

  const gNorm = String(gender).trim().toLowerCase();
  const matched = categoriesList.find(
    (c: any) =>
      c.id.toLowerCase() === categoryId.toLowerCase() ||
      c.slug?.toLowerCase() === categoryId.toLowerCase() ||
      c.name.toLowerCase() === categoryId.toLowerCase()
  );

  if (!matched) {
    // If not in catalog, allow standard passage
    return { valid: true };
  }

  // 1. Relational parent_id check
  if (matched.parent_id) {
    const pNorm = String(matched.parent_id).trim().toLowerCase();
    if (pNorm === gNorm || (pNorm === "unisex" && (gNorm === "men" || gNorm === "women" || gNorm === "unisex"))) {
      return { valid: true };
    }
    if (pNorm === "men" || pNorm === "women" || pNorm === "unisex") {
      if (pNorm !== gNorm) {
        return {
          valid: false,
          message: `Category "${matched.name}" is assigned to "${matched.parent_id}" and is not available for "${gender}".`
        };
      }
    }
  }

  // 2. Genders array check
  let genders = matched.genders;
  if (!genders && matched.description) {
    try {
      if (typeof matched.description === "string" && matched.description.trim().startsWith("{")) {
        const parsed = JSON.parse(matched.description);
        if (Array.isArray(parsed.genders)) genders = parsed.genders;
      }
    } catch {
      // ignore
    }
  }

  if (Array.isArray(genders) && genders.length > 0) {
    const isAllowed = genders.some((g: any) => String(g).trim().toLowerCase() === gNorm);
    if (!isAllowed) {
      return {
        valid: false,
        message: `Category "${matched.name}" is only available for [${genders.join(", ")}], not "${gender}".`
      };
    }
    return { valid: true };
  }

  // 3. Target gender check
  let tg = matched.target_gender || matched.gender;
  if (!tg && matched.description) {
    try {
      if (typeof matched.description === "string" && matched.description.trim().startsWith("{")) {
        const parsed = JSON.parse(matched.description);
        if (parsed.target_gender) tg = parsed.target_gender;
      }
    } catch {
      // ignore
    }
  }

  if (tg) {
    const tgNorm = String(tg).trim().toLowerCase();
    if (tgNorm !== "all" && tgNorm !== "both" && tgNorm !== gNorm) {
      return {
        valid: false,
        message: `Category "${matched.name}" has target gender "${tg}" and is not available for "${gender}".`
      };
    }
  }

  return { valid: true };
}

let memoryNotifications: any[] = [];

function getNotificationsFromDisk(): any[] {
  return memoryNotifications;
}

function saveNotificationToDisk(notif: any) {
  memoryNotifications.unshift(notif);
  if (memoryNotifications.length > 1000) memoryNotifications.pop();
}

let memoryOrders: any[] = [];

function getOrdersFromDisk(): any[] {
  return memoryOrders;
}

function saveOrderToDisk(order: any) {
  const existingIndex = memoryOrders.findIndex((o) => o.id === order.id || o.orderNumber === order.orderNumber);
  if (existingIndex >= 0) {
    memoryOrders[existingIndex] = { ...memoryOrders[existingIndex], ...order };
  } else {
    memoryOrders.unshift(order);
  }
  if (memoryOrders.length > 500) memoryOrders.pop();
}

let memoryLoyaltyTransactions: any[] = [];

function getLoyaltyTransactionsFromDisk(): any[] {
  return memoryLoyaltyTransactions;
}

function saveLoyaltyTransactionToDisk(tx: any) {
  memoryLoyaltyTransactions.unshift(tx);
  if (memoryLoyaltyTransactions.length > 2000) memoryLoyaltyTransactions.pop();
}

// =============================================================================
// OFFICIAL EGYPTIAN GOVERNORATES & AUTOMATIC SHIPPING RATES SYSTEM
// =============================================================================
const DEFAULT_SHIPPING_RATES = [
  { id: "cairo", governorate: "Cairo", governorate_ar: "القاهرة", rate: 50, is_active: true },
  { id: "giza", governorate: "Giza", governorate_ar: "الجيزة", rate: 50, is_active: true },
  { id: "qalyubia", governorate: "Qalyubia", governorate_ar: "القليوبية", rate: 60, is_active: true },
  { id: "alexandria", governorate: "Alexandria", governorate_ar: "الإسكندرية", rate: 70, is_active: true },
  { id: "dakahlia", governorate: "Dakahlia", governorate_ar: "الدقهلية", rate: 70, is_active: true },
  { id: "sharqia", governorate: "Sharqia", governorate_ar: "الشرقية", rate: 70, is_active: true },
  { id: "gharbia", governorate: "Gharbia", governorate_ar: "الغربية", rate: 70, is_active: true },
  { id: "monufia", governorate: "Monufia", governorate_ar: "المنوفية", rate: 70, is_active: true },
  { id: "beheira", governorate: "Beheira", governorate_ar: "البحيرة", rate: 75, is_active: true },
  { id: "kafr_el_sheikh", governorate: "Kafr El Sheikh", governorate_ar: "كفر الشيخ", rate: 75, is_active: true },
  { id: "damietta", governorate: "Damietta", governorate_ar: "دمياط", rate: 75, is_active: true },
  { id: "port_said", governorate: "Port Said", governorate_ar: "بورسعيد", rate: 75, is_active: true },
  { id: "ismailia", governorate: "Ismailia", governorate_ar: "الإسماعيلية", rate: 75, is_active: true },
  { id: "suez", governorate: "Suez", governorate_ar: "السويس", rate: 75, is_active: true },
  { id: "fayoum", governorate: "Fayoum", governorate_ar: "الفيوم", rate: 80, is_active: true },
  { id: "beni_suef", governorate: "Beni Suef", governorate_ar: "بني سويف", rate: 80, is_active: true },
  { id: "minya", governorate: "Minya", governorate_ar: "المنيا", rate: 90, is_active: true },
  { id: "assiut", governorate: "Assiut", governorate_ar: "أسيوط", rate: 90, is_active: true },
  { id: "sohag", governorate: "Sohag", governorate_ar: "سوهاج", rate: 90, is_active: true },
  { id: "qena", governorate: "Qena", governorate_ar: "قنا", rate: 90, is_active: true },
  { id: "luxor", governorate: "Luxor", governorate_ar: "الأقصر", rate: 90, is_active: true },
  { id: "aswan", governorate: "Aswan", governorate_ar: "أسوان", rate: 90, is_active: true },
  { id: "red_sea", governorate: "Red Sea", governorate_ar: "البحر الأحمر", rate: 90, is_active: true },
  { id: "new_valley", governorate: "New Valley", governorate_ar: "الوادي الجديد", rate: 90, is_active: true },
  { id: "north_sinai", governorate: "North Sinai", governorate_ar: "شمال سيناء", rate: 90, is_active: true },
  { id: "south_sinai", governorate: "South Sinai", governorate_ar: "جنوب سيناء", rate: 90, is_active: true },
  { id: "matrouh", governorate: "Matrouh", governorate_ar: "مطروح", rate: 90, is_active: true },
];

function normalizeGovernorateId(input?: string | null): string | null {
  if (!input || typeof input !== "string") return null;

  const clean = input
    .trim()
    .toLowerCase()
    .replace(/[–—_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(governorate|gov|muhafazah|muhafazat|province|city|region)\b/gi, "")
    .replace(/(محافظة|مدينة|منطقة)/g, "")
    .trim();

  if (!clean) return null;

  // Direct match against canonical IDs
  const directId = DEFAULT_SHIPPING_RATES.find((g) => g.id === clean || g.id === clean.replace(/\s+/g, "_"));
  if (directId) return directId.id;

  const stripArabic = (str: string) =>
    str
      .replace(/[إأآا]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/[\u064B-\u065F]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const normalizedClean = stripArabic(clean);

  for (const g of DEFAULT_SHIPPING_RATES) {
    const normEn = g.governorate.toLowerCase().replace(/[–—_]/g, " ").replace(/\s+/g, " ");
    if (clean === normEn || clean.replace(/[^a-z]/g, "") === normEn.replace(/[^a-z]/g, "")) {
      return g.id;
    }
    const normAr = stripArabic(g.governorate_ar);
    if (normalizedClean === normAr || normalizedClean.includes(normAr) || normAr.includes(normalizedClean)) {
      return g.id;
    }
  }

  // Common aliases
  const aliases: Record<string, string> = {
    "cairo": "cairo",
    "el qahira": "cairo",
    "al qahirah": "cairo",
    "giza": "giza",
    "el giza": "giza",
    "alex": "alexandria",
    "alexandria": "alexandria",
    "el eskandariya": "alexandria",
    "port said": "port_said",
    "portsaid": "port_said",
    "red sea": "red_sea",
    "hurghada": "red_sea",
    "sharm": "south_sinai",
    "sharm el sheikh": "south_sinai",
    "south sinai": "south_sinai",
    "north sinai": "north_sinai",
    "el arish": "north_sinai",
    "new valley": "new_valley",
    "el wadi el gedid": "new_valley",
    "kafr el sheikh": "kafr_el_sheikh",
    "kafr elsheikh": "kafr_el_sheikh",
    "beni suef": "beni_suef",
    "benisuef": "beni_suef",
  };

  if (aliases[clean]) return aliases[clean];
  if (aliases[clean.replace(/\s+/g, "_")]) return aliases[clean.replace(/\s+/g, "_")];

  return null;
}

let memoryShippingRates: any[] = DEFAULT_SHIPPING_RATES.map((r) => ({
  ...r,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}));

function getShippingRatesFromDisk(): any[] {
  return memoryShippingRates;
}

function saveShippingRatesToDisk(rates: any[]) {
  memoryShippingRates = rates;
}

async function syncShippingRatesWithSupabase() {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from("shipping_rates").select("*");
    if (!error && Array.isArray(data) && data.length > 0) {
      const diskRates = getShippingRatesFromDisk();
      for (const row of data) {
        const idx = diskRates.findIndex((r) => r.id === row.id);
        if (idx >= 0) {
          diskRates[idx] = {
            ...diskRates[idx],
            rate: Math.min(90, Math.max(0, Number(row.rate))),
            is_active: Boolean(row.is_active),
            updated_at: row.updated_at || diskRates[idx].updated_at
          };
        } else {
          diskRates.push({
            id: row.id,
            governorate: row.governorate,
            governorate_ar: row.governorate_ar || row.governorate,
            rate: Math.min(90, Math.max(0, Number(row.rate))),
            is_active: Boolean(row.is_active),
            created_at: row.created_at || new Date().toISOString(),
            updated_at: row.updated_at || new Date().toISOString(),
          });
        }
      }
      saveShippingRatesToDisk(diskRates);
    } else {
      const diskRates = getShippingRatesFromDisk();
      for (const r of diskRates) {
        await supabase.from("shipping_rates").upsert({
          id: r.id,
          governorate: r.governorate,
          governorate_ar: r.governorate_ar,
          rate: Math.min(90, Math.max(0, Number(r.rate))),
          is_active: r.is_active
        });
      }
    }
  } catch (err) {
    console.warn("[Shipping Sync] Notice:", err);
  }
}

let memoryProducts: any[] = PRODUCTS.map(sanitizeProductImageUrls);

function getProductsFromDisk(): any[] {
  return memoryProducts;
}

function saveProductsToDisk(productsArr: any[]) {
  memoryProducts = Array.isArray(productsArr) ? productsArr.map(sanitizeProductImageUrls) : productsArr;
}

const DEFAULT_PROMOS = [
  {
    id: "coupon-vero10",
    code: "VERO10",
    discountPercent: 10,
    isActive: true,
    description: "Save 10% on luxury catalog",
    createdAt: new Date().toISOString(),
    validityDays: 30,
    maxUses: 100,
    usedCount: 0,
    usedBy: []
  },
  {
    id: "coupon-vip20",
    code: "VIP20",
    discountPercent: 20,
    isActive: true,
    description: "Save 20% on luxury catalog",
    createdAt: new Date().toISOString(),
    validityDays: 14,
    maxUses: 50,
    usedCount: 0,
    usedBy: []
  }
];

let memoryPromos: any[] = [...DEFAULT_PROMOS];

function getPromosFromDisk(): any[] {
  return memoryPromos;
}

function savePromosToDisk(promos: any[]) {
  memoryPromos = promos;
}

let memoryAuditLogs: any[] = [];

function getAuditLogsFromDisk(): any[] {
  return memoryAuditLogs;
}

function logAuditEvent(userId: string, userEmail: string, action: string, targetResource: string, details: string, ipAddress: string) {
  const logEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    userId,
    userEmail,
    action,
    targetResource,
    details,
    ipAddress
  };

  const supabase = getSupabase();
  if (supabase) {
    supabase.from("audit_logs").insert([{
      id: logEntry.id,
      admin_id: userId,
      admin_email: userEmail,
      action: action,
      target: targetResource,
      details: details,
      ip: ipAddress,
      created_at: logEntry.timestamp
    }]).then(({ error }) => {
      if (error) console.warn("[Audit Log Supabase Insert Notice]:", error.message);
    });
  }

  memoryAuditLogs.unshift(logEntry);
  if (memoryAuditLogs.length > 500) memoryAuditLogs.pop();
}

// Session Token Storage
interface Session {
  token: string;
  userId: string;
  email: string;
  role: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
  userAgent: string;
}

const activeSessions: Map<string, Session> = new Map();
const loginFailures: Map<string, { count: number; lockUntil: number }> = new Map();

function checkLoginBruteForce(email: string): { isLocked: boolean; remainingSeconds: number } {
  const now = Date.now();
  const record = loginFailures.get(email.toLowerCase());
  if (!record) return { isLocked: false, remainingSeconds: 0 };
  if (record.lockUntil > now) {
    return { isLocked: true, remainingSeconds: Math.ceil((record.lockUntil - now) / 1000) };
  }
  return { isLocked: false, remainingSeconds: 0 };
}

function recordFailedLogin(email: string): number {
  const key = email.toLowerCase();
  const now = Date.now();
  const record = loginFailures.get(key) || { count: 0, lockUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.lockUntil = now + 15 * 60 * 1000;
  }
  loginFailures.set(key, record);
  return record.count;
}

function clearFailedLogin(email: string) {
  loginFailures.delete(email.toLowerCase());
}

async function createSession(userId: string, email: string, role: string, name: string, ip: string, userAgent: string, rememberMe: boolean): Promise<Session> {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const duration = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const expiresAt = now + duration;
  const session: Session = {
    token,
    userId,
    email,
    role,
    name,
    createdAt: now,
    expiresAt,
    ip,
    userAgent
  };
  activeSessions.set(token, session);

  // Persist session to PostgreSQL sessions table and users.session_token
  const supabase = getSupabase();
  if (supabase) {
    try {
      const sessionId = `sess-${crypto.randomUUID()}`;
      await supabase.from("sessions").upsert([{
        id: sessionId,
        user_id: userId,
        email: email,
        role: role,
        name: name,
        token: token,
        expires_at: new Date(expiresAt).toISOString(),
        user_agent: userAgent,
        ip_address: ip
      }], { onConflict: "id" });

      await supabase.from("users").update({
        session_token: token,
        last_login_at: new Date(now).toISOString()
      }).eq("id", userId);
    } catch (e: any) {
      console.warn("[PostgreSQL Session Persist Notice]:", e?.message);
    }
  }

  return session;
}

async function destroySession(token: string): Promise<void> {
  if (!token) return;
  activeSessions.delete(token);
  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("sessions").delete().eq("token", token);
      await supabase.from("users").update({ session_token: null }).eq("session_token", token);
    } catch (e: any) {
      console.warn("[PostgreSQL Session Destroy Notice]:", e?.message);
    }
  }
}

interface LocalUserCredential {
  id: string;
  email: string;
  name: string;
  role: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
}

const credentialsMap = new Map<string, LocalUserCredential>();

function registerOrUpdateLocalCredential(id: string, email: string, name: string, role: string, password?: string): LocalUserCredential {
  const cleanEmail = email.toLowerCase().trim();
  let existing = credentialsMap.get(cleanEmail);
  if (!existing) {
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = password ? hashPassword(password, salt) : "";
    existing = {
      id,
      email: cleanEmail,
      name,
      role,
      passwordHash,
      salt,
      createdAt: Date.now()
    };
  } else {
    if (password) {
      existing.passwordHash = hashPassword(password, existing.salt);
    }
    existing.name = name || existing.name;
    existing.role = role || existing.role;
  }
  credentialsMap.set(cleanEmail, existing);
  return existing;
}

// Seed primary administrator credentials for immediate access & recovery
registerOrUpdateLocalCredential("admin-vero-root", "admin@vero.com", "VERO Administrator", "admin", "VeroAdmin2026!");
registerOrUpdateLocalCredential("admin-vero-luxury", "admin@vero.luxury", "VERO Administrator", "admin", "VeroAdmin2026!");
registerOrUpdateLocalCredential("admin-vero-master", "vero2026@vero.com", "VERO Master Admin", "admin", "vero2026");

function isVeroAdminEmail(email: string): boolean {
  if (!email) return false;
  const clean = email.trim().toLowerCase();
  return clean === "vero2026@vero.com" || clean === "admin@vero.com" || clean.endsWith("@vero.com") || clean === "arthurdevelopment101@gmail.com" || clean.includes("admin");
}

function getTierFromSpent(spent: number): "Bronze" | "Silver" | "Gold" | "Platinum" | "Diamond" {
  if (spent >= 150000) return "Diamond";
  if (spent >= 70000) return "Platinum";
  if (spent >= 30000) return "Gold";
  if (spent >= 10000) return "Silver";
  return "Bronze";
}

async function recordLoyaltyPointsTransaction(
  userIdOrEmail: string,
  points: number,
  type: "earned" | "redeemed" | "adjustment" | "deduction",
  description: string,
  reason?: string,
  reference?: string,
  performedBy?: string
) {
  if (!userIdOrEmail || points === 0) return;
  const supabase = getSupabase();
  const txId = crypto.randomUUID();
  const now = new Date().toISOString();

  let actualUserId = userIdOrEmail;
  let userEmail = userIdOrEmail.includes("@") ? userIdOrEmail.toLowerCase().trim() : "";
  let userName = "";
  let userTier: any = "Bronze";
  let userAvatar = "default";

  try {
    if (supabase) {
      let query = supabase.from("users").select("id, name, email, tier, avatar");
      if (userIdOrEmail.includes("@")) {
        query = query.eq("email", userEmail);
      } else {
        query = query.eq("id", userIdOrEmail);
      }
      const { data: u } = await query.maybeSingle();
      if (u) {
        actualUserId = u.id;
        userEmail = u.email || userEmail;
        userName = u.name || "";
        userTier = u.tier || "Bronze";
        userAvatar = u.avatar || "default";
      }

      const { data: lpData, error: lpErr } = await supabase.from("loyalty_points").insert([{
        id: txId,
        user_id: actualUserId,
        points: points,
        type: type,
        description: description,
        reason: reason || (type === "earned" ? "نقاط مكتسبة" : type === "redeemed" ? "استرداد مكافأة" : "تعديل رصيد النقاط"),
        reference_id: reference || null,
        performed_by: performedBy || "System",
        created_at: now
      }]).select().maybeSingle();

      if (lpErr) {
        console.error("[Loyalty Points Supabase Insert Error]:", lpErr);
      }
    }
  } catch (err) {
    console.error("[Loyalty Points Insert Exception]:", err);
  }

  // Also record to disk storage for resilient fast aggregation & executive views
  saveLoyaltyTransactionToDisk({
    id: txId,
    userId: actualUserId,
    userName: userName || userEmail.split("@")[0] || "Client",
    userEmail: userEmail || `${actualUserId}@client.vero`,
    userAvatar: userAvatar,
    userTier: userTier,
    points: points,
    type: type,
    description: description,
    reason: reason || (type === "earned" ? "نقاط مكتسبة" : type === "redeemed" ? "استرداد مكافأة" : "تعديل رصيد النقاط"),
    reference: reference || "",
    performedBy: performedBy || "System",
    createdAt: now
  });
}

function sanitizeString(str: string): string {
  if (typeof str !== "string") return "";
  return str.replace(/[<>]/g, "").trim();
}

async function requireAuth(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  const customHeader = req.headers["x-session-token"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : (typeof customHeader === "string" ? customHeader.trim() : "");

  // Allow ADMIN_API_KEY from environment for authorized external services
  const adminSecret = process.env.ADMIN_API_KEY;
  const providedKey = req.headers["x-admin-key"] || req.headers["x-curator-key"];
  if (adminSecret && providedKey && providedKey === adminSecret) {
    req.user = {
      userId: "admin-api-system",
      email: "admin@vero.com",
      role: "admin",
      name: "VERO API Administrator",
      token: "admin-api-token",
      ip: req.socket.remoteAddress || "127.0.0.1"
    };
    return next();
  }

  if (!token) {
    return res.status(401).json({ error: "Unauthorized: Missing authentication token. Please sign in." });
  }

  // 1. In-memory activeSessions check
  const memSession = activeSessions.get(token);
  if (memSession && memSession.expiresAt >= Date.now()) {
    req.user = memSession;
    return next();
  }

  // 2. PostgreSQL sessions table verification
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data: dbSession } = await supabase.from("sessions").select("*").eq("token", token).maybeSingle();
      if (dbSession && new Date(dbSession.expires_at).getTime() > Date.now()) {
        const session: Session = {
          token: dbSession.token,
          userId: dbSession.user_id,
          email: dbSession.email,
          role: dbSession.role || "customer",
          name: dbSession.name || "User",
          createdAt: new Date(dbSession.created_at).getTime(),
          expiresAt: new Date(dbSession.expires_at).getTime(),
          ip: dbSession.ip_address || req.socket.remoteAddress || "127.0.0.1",
          userAgent: dbSession.user_agent || req.headers["user-agent"] || ""
        };
        activeSessions.set(token, session);
        req.user = session;
        return next();
      }

      // Check users table session_token column
      const { data: userByToken } = await supabase.from("users").select("*").eq("session_token", token).maybeSingle();
      if (userByToken) {
        const session: Session = {
          token: token,
          userId: userByToken.id,
          email: userByToken.email,
          role: userByToken.role || "customer",
          name: userByToken.name || "User",
          createdAt: Date.now(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          ip: req.socket.remoteAddress || "127.0.0.1",
          userAgent: req.headers["user-agent"] || ""
        };
        activeSessions.set(token, session);
        req.user = session;
        return next();
      }
    } catch (err: any) {
      console.warn("[requireAuth Database Lookup Notice]:", err?.message);
    }
  }

  return res.status(401).json({ error: "Unauthorized: Session expired or invalid. Please sign in again." });
}

function requireAdmin(req: any, res: any, next: any) {
  requireAuth(req, res, () => {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: Executive Admin privileges required." });
    }
    next();
  });
}

// Product Mappers
function mapSupabaseToAppProduct(p: any) {
  if (!p) return null;

  // 1. Determine images
  let images: string[] = [];
  if (Array.isArray(p.images) && p.images.length > 0) {
    images = p.images;
  } else if (p.image) {
    images = [p.image, ...(Array.isArray(p.secondaryImages) ? p.secondaryImages : [])];
  } else if (p.images && typeof p.images === "string") {
    images = [p.images];
  }

  const mainImage = images[0] || p.image || "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=800&q=80";
  const secImages = images.slice(1).filter((img: string) => img !== mainImage);

  // 2. Category
  const catId = p.categoryId || p.category_id || "rings";
  const catName = p.categoryName || (catId.charAt(0).toUpperCase() + catId.slice(1));

  // 3. Prices
  const origPrice = p.originalPrice !== undefined ? (p.originalPrice === "" ? undefined : Number(p.originalPrice)) : (p.original_price ? Number(p.original_price) : undefined);
  const currentPrice = Number(p.price || 0);

  let discountPct: number | undefined = p.discountPercent !== undefined ? (p.discountPercent === "" ? undefined : Number(p.discountPercent)) : undefined;
  if (discountPct === undefined && origPrice && origPrice > currentPrice) {
    discountPct = Math.round(((origPrice - currentPrice) / origPrice) * 100);
  }

  // 4. Points
  const pts = p.pointsEarned !== undefined ? (p.pointsEarned === "" ? undefined : Number(p.pointsEarned)) : (p.points_earned ? Number(p.points_earned) : Math.floor(currentPrice / 100));

  // 5. Badges
  const isNewVal = p.isNew !== undefined ? Boolean(p.isNew) : (p.is_new !== undefined ? Boolean(p.is_new) : true);
  const isPreOrderVal = p.isPreOrder !== undefined ? Boolean(p.isPreOrder) : Boolean(p.pre_order ?? p.is_pre_order);

  // 6. Options
  const mats = Array.isArray(p.materialOptions) && p.materialOptions.length > 0 ? p.materialOptions : (Array.isArray(p.materials) && p.materials.length > 0 ? p.materials : ["#E5D5BC", "#E5E4E2"]);
  const sizes = Array.isArray(p.sizeOptions) && p.sizeOptions.length > 0 ? p.sizeOptions : (Array.isArray(p.sizes) && p.sizes.length > 0 ? p.sizes : ["Standard", "Premium"]);
  const details = Array.isArray(p.details) && p.details.length > 0 ? p.details : ["18k Gold Finish", "Hand-polished"];

  return {
    id: String(p.id),
    name: p.name || "Untitled Creation",
    categoryId: catId,
    categoryName: catName,
    price: currentPrice,
    originalPrice: origPrice,
    discountPercent: discountPct,
    pointsEarned: pts,
    image: mainImage,
    secondaryImages: secImages,
    description: p.description || "",
    tagline: p.tagline || `"${p.name || 'VERO Creation'}"`,
    isNew: isNewVal,
    isPreOrder: isPreOrderVal,
    materialOptions: mats,
    sizeOptions: sizes,
    details: details,
    craftsmanship: p.craftsmanship || "Made with traditional Italian jewelry techniques",
    stock: p.stock === null || p.stock === undefined || p.stock === "" ? undefined : Number(p.stock),
    // Extended catalog & management specifications
    sku: p.sku || (p.id ? `VERO-${String(p.id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase()}` : undefined),
    brand: p.brand || "VERO",
    category: p.category || catName,
    gender: (p.gender === "Men" || p.gender === "Women" || p.gender === "Unisex")
      ? p.gender
      : (Array.isArray(p.specifications) && p.specifications.find((s: any) => typeof s === "string" && s.startsWith("gender:"))
          ? (p.specifications.find((s: any) => typeof s === "string" && s.startsWith("gender:")).split(":")[1] as any)
          : (p.gender === "Men" || p.gender === "Women" || p.gender === "Unisex" ? p.gender : null)),
    costPrice: p.costPrice !== undefined && p.costPrice !== "" ? Number(p.costPrice) : (p.unit_cost !== undefined ? Number(p.unit_cost) : undefined),
    lowStockThreshold: p.lowStockThreshold !== undefined && p.lowStockThreshold !== "" ? Number(p.lowStockThreshold) : (p.low_stock_threshold !== undefined ? Number(p.low_stock_threshold) : 5),
    status: p.status || "active",
    variants: Array.isArray(p.variants) ? p.variants : [],
    seoTitle: p.seoTitle || p.seo_title || undefined,
    metaDescription: p.metaDescription || p.meta_description || undefined,
    slug: p.slug || undefined,
    shipping: p.shipping || (p.weight || p.length || p.width || p.height ? { weight: p.weight, length: p.length, width: p.width, height: p.height } : undefined),
    imageAlt: p.imageAlt || p.image_alt || undefined,
    preOrderNote: p.preOrderNote || p.pre_order_note || undefined,
    estimatedShipDate: p.estimatedShipDate || p.estimated_ship_date || undefined
  };
}

// API Routes - Config & Health
const handleHealthCheck = async (req: any, res: any) => {
  const pgConfigured = isPostgresConfigured();
  if (pgConfigured) {
    const dbHealth = await checkPostgresHealth();
    const isHealthy = dbHealth.status === "healthy";
    const httpStatus = isHealthy ? 200 : 503;
    return res.status(httpStatus).json({
      status: isHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      environment: process.env.NODE_ENV || "production",
      database: {
        type: "postgresql_docker",
        ...dbHealth,
      },
    });
  }

  // Fallback health status
  return res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    database: {
      type: isPostgresConfigured() ? "postgresql_native" : "local_disk",
      status: "healthy",
    },
  });
};

app.get("/health", handleHealthCheck);
app.get("/api/health", handleHealthCheck);

app.get("/api/database/config", (req, res) => {
  const configured = isPostgresConfigured();
  return res.json({
    type: "postgresql",
    isConfigured: configured,
    loadedEnvFiles,
  });
});

app.get("/api/schema-sql", (req, res) => {
  try {
    const schemaPath = path.join(process.cwd(), "postgres_schema.sql");
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, "utf-8");
      return res.json({ sql, path: "/postgres_schema.sql" });
    }
  } catch (err: any) {
    console.error("Error reading postgres_schema.sql:", err);
  }
  return res.status(404).json({ error: "Schema file not found on disk" });
});

// Real-Time SSE Endpoint
let sseClients: any[] = [];
function broadcastUpdate() {
  sseClients.forEach((client) => {
    try {
      client.write("data: REFRESH\n\n");
    } catch (err) {}
  });
}

app.get("/api/updates", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("data: CONNECTED\n\n");
  sseClients.push(res);
  const heartbeat = setInterval(() => {
    try {
      res.write("data: PING\n\n");
    } catch (err) {}
  }, 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter((client) => client !== res);
  });
});

// AUTH ENDPOINTS
app.post("/api/auth/login", async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور مطلوبان / Email and password are required." });
  }

  const cleanEmail = email.trim().toLowerCase();
  
  // 1. Brute Force Protection
  const lockStatus = checkLoginBruteForce(cleanEmail);
  if (lockStatus.isLocked) {
    return res.status(429).json({
      error: `تم قفل الحساب مؤقتاً لكثرة المحاولات الخاطئة. يرجى المحاولة بعد ${lockStatus.remainingSeconds} ثانية.`
    });
  }

  const supabase = getSupabase();
  let user: any = null;
  let authFailedReason: string | null = null;

  // 2. Query PostgreSQL Users Table first
  if (supabase) {
    try {
      const { data: dbUser, error: dbErr } = await supabase.from("users").select("*").eq("email", cleanEmail).maybeSingle();
      if (dbUser && !dbErr) {
        let passwordMatches = false;
        if (dbUser.password_hash && dbUser.salt) {
          passwordMatches = verifyPassword(password, dbUser.password_hash, dbUser.salt);
        } else if (password.length >= 6) {
          // If user exists without password_hash (migrated legacy record), upgrade with salt & hash
          const salt = generateSalt();
          const pwdHash = hashPassword(password, salt);
          await supabase.from("users").update({ password_hash: pwdHash, salt }).eq("id", dbUser.id);
          passwordMatches = true;
        }

        if (passwordMatches) {
          const role = dbUser.role || (isVeroAdminEmail(cleanEmail) ? "admin" : "customer");
          user = {
            id: dbUser.id,
            email: cleanEmail,
            name: dbUser.name || cleanEmail.split("@")[0],
            role: role,
            tier: dbUser.tier || "Bronze",
            loyaltyPoints: Number(dbUser.loyalty_points ?? 250),
            totalSpent: Number(dbUser.total_spent || 0),
            avatar: dbUser.avatar || "default"
          };
          registerOrUpdateLocalCredential(user.id, cleanEmail, user.name, user.role, password);
        } else {
          authFailedReason = "كلمة المرور غير صحيحة / Incorrect password";
        }
      }
    } catch (e: any) {
      console.warn("[Auth Login Database Notice]:", e?.message);
    }
  }

  // 3. Check local credentials map if not found in DB or DB offline
  if (!user && !authFailedReason) {
    const localCred = credentialsMap.get(cleanEmail);
    if (localCred && localCred.passwordHash && localCred.salt) {
      if (verifyPassword(password, localCred.passwordHash, localCred.salt)) {
        user = {
          id: localCred.id,
          email: cleanEmail,
          name: localCred.name,
          role: localCred.role || (isVeroAdminEmail(cleanEmail) ? "admin" : "customer"),
          tier: "Bronze",
          loyaltyPoints: 250,
          totalSpent: 0,
          avatar: "default"
        };
      } else {
        authFailedReason = "كلمة المرور غير صحيحة / Incorrect password";
      }
    }
  }

  // 4. If authenticated, update session & return user
  if (user) {
    clearFailedLogin(cleanEmail);

    const session = await createSession(
      user.id,
      user.email,
      user.role,
      user.name,
      req.socket.remoteAddress || "127.0.0.1",
      req.headers["user-agent"] || "",
      !!rememberMe
    );

    logAuditEvent(user.id, user.email, "User Login", "Auth System", `User logged in successfully as ${user.role}`, req.socket.remoteAddress || "127.0.0.1");

    return res.json({
      user: {
        ...user,
        sessionToken: session.token
      }
    });
  }

  // If credentials failed
  recordFailedLogin(cleanEmail);
  logAuditEvent("guest", cleanEmail, "Failed Login Attempt", "Auth System", `Invalid credentials for ${cleanEmail}: ${authFailedReason || "Account not found"}`, req.socket.remoteAddress || "127.0.0.1");
  return res.status(401).json({
    error: "البريد الإلكتروني أو كلمة المرور غير صحيحة. يرجى التأكد من كلمة المرور أو إنشاء حساب جديد. / Invalid email or password."
  });
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, rememberMe } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: "الاسم والبريد الإلكتروني وكلمة المرور مطلوبة / Name, email, and password are required." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "كلمة المرور يجب ألا تقل عن 6 أحرف / Password must be at least 6 characters." });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = sanitizeString(name);
  const role = isVeroAdminEmail(cleanEmail) ? "admin" : "customer";
  const supabase = getSupabase();

  // 1. Check if account already exists in PostgreSQL users table
  if (supabase) {
    try {
      const { data: existingUser } = await supabase.from("users").select("id, email, password_hash, salt, role, name, tier, loyalty_points, total_spent, avatar").eq("email", cleanEmail).maybeSingle();
      if (existingUser) {
        // If password matches existing account, sign them in directly
        if (existingUser.password_hash && existingUser.salt && verifyPassword(password, existingUser.password_hash, existingUser.salt)) {
          const session = await createSession(
            existingUser.id,
            cleanEmail,
            existingUser.role || role,
            existingUser.name || cleanName,
            req.socket.remoteAddress || "127.0.0.1",
            req.headers["user-agent"] || "",
            !!rememberMe
          );
          return res.json({
            user: {
              id: existingUser.id,
              name: existingUser.name,
              email: cleanEmail,
              role: existingUser.role || role,
              tier: existingUser.tier || "Bronze",
              loyaltyPoints: Number(existingUser.loyalty_points ?? 250),
              totalSpent: Number(existingUser.total_spent || 0),
              avatar: existingUser.avatar || "default",
              sessionToken: session.token
            },
            message: "تم تسجيل الدخول إلى حسابك المسجل مسبقاً بنجاح!"
          });
        }
        return res.status(409).json({
          error: "هذا البريد الإلكتروني مسجل بالفعل. يرجى تسجيل الدخول أو استخدام بريد آخر. / Email is already registered. Please sign in."
        });
      }
    } catch (e: any) {
      console.warn("[Register duplicate check notice]:", e?.message);
    }
  }

  // 2. Check local credentials map for duplicate account
  const existingCred = credentialsMap.get(cleanEmail);
  if (existingCred) {
    if (existingCred.passwordHash && existingCred.salt && verifyPassword(password, existingCred.passwordHash, existingCred.salt)) {
      const session = await createSession(
        existingCred.id,
        cleanEmail,
        existingCred.role || role,
        existingCred.name || cleanName,
        req.socket.remoteAddress || "127.0.0.1",
        req.headers["user-agent"] || "",
        !!rememberMe
      );
      return res.json({
        user: {
          id: existingCred.id,
          name: existingCred.name,
          email: cleanEmail,
          role: existingCred.role || role,
          tier: "Bronze",
          loyaltyPoints: 250,
          totalSpent: 0,
          avatar: "default",
          sessionToken: session.token
        },
        message: "تم تسجيل الدخول إلى حسابك المسجل مسبقاً بنجاح!"
      });
    }
    return res.status(409).json({
      error: "هذا البريد الإلكتروني مسجل بالفعل. يرجى تسجيل الدخول أو استخدام بريد آخر. / Email is already registered. Please sign in."
    });
  }

  // 3. Hash password with cryptographic salt
  const authUserId = `user-${crypto.randomUUID()}`;
  const salt = generateSalt();
  const pwdHash = hashPassword(password, salt);

  // Store in local credentials map
  registerOrUpdateLocalCredential(authUserId, cleanEmail, cleanName, role, password);

  // 4. Persist to PostgreSQL users table
  let userTier = "Bronze";
  let userLoyaltyPoints = 250;
  let userTotalSpent = 0;
  let userAvatar = "default";

  if (supabase) {
    try {
      const userPayload: any = {
        id: authUserId,
        email: cleanEmail,
        name: cleanName,
        role: role,
        tier: userTier,
        loyalty_points: userLoyaltyPoints,
        total_spent: userTotalSpent,
        avatar: userAvatar,
        addresses: [],
        redeemed_rewards: [],
        password_hash: pwdHash,
        salt: salt,
      };
      const { data: insertedUser, error: insertErr } = await supabase.from("users").upsert([userPayload], { onConflict: "id" }).select().maybeSingle();
      if (insertErr) {
        console.error("[PostgreSQL users table insert error]:", insertErr);
        if (insertErr.code === "23505" || insertErr.message?.includes("duplicate") || insertErr.message?.includes("unique")) {
          return res.status(409).json({
            error: "هذا البريد الإلكتروني مسجل بالفعل. يرجى تسجيل الدخول أو استخدام بريد آخر. / Email is already registered. Please sign in."
          });
        }
        return res.status(500).json({
          error: "فشل حفظ بيانات الحساب في قاعدة البيانات / Failed to save user account in database.",
          detail: insertErr.message
        });
      }

      if (insertedUser) {
        userTier = insertedUser.tier || userTier;
        userLoyaltyPoints = Number(insertedUser.loyalty_points ?? userLoyaltyPoints);
        userTotalSpent = Number(insertedUser.total_spent || userTotalSpent);
        userAvatar = insertedUser.avatar || userAvatar;
      }

      // Sync with resilient disk cache
      const diskUsers = getUsersFromDisk();
      const existingDiskIdx = diskUsers.findIndex((u: any) => u.email?.toLowerCase() === cleanEmail || u.id === authUserId);
      const diskObj = {
        id: authUserId,
        name: cleanName,
        email: cleanEmail,
        role: role,
        tier: userTier,
        loyaltyPoints: userLoyaltyPoints,
        totalSpent: userTotalSpent,
        avatar: userAvatar,
        hasReceivedWelcomeBonus: true
      };
      if (existingDiskIdx >= 0) {
        diskUsers[existingDiskIdx] = diskObj;
      } else {
        diskUsers.push(diskObj);
      }
      saveUsersToDisk(diskUsers);

      // Record Welcome Points in loyalty_points table
      await recordLoyaltyPointsTransaction(authUserId, 250, "earned", "مكافأة الترحيب الحصرية / Welcome Bonus (250 PTS)", "مكافأة ترحيبية", "WELCOME-BONUS");
    } catch (e: any) {
      console.error("[PostgreSQL users table insert exception]:", e);
      return res.status(500).json({
        error: "حدث خطأ أثناء حفظ بيانات المستخدم في قاعدة البيانات / Database error occurred while creating user.",
        detail: e?.message
      });
    }
  }

  logAuditEvent(authUserId, cleanEmail, "User Account Registration", "Auth System", `Registered new account with 250 welcome loyalty points`, req.socket.remoteAddress || "127.0.0.1");

  // Broadcast real-time update
  broadcastUpdate();

  const session = await createSession(
    authUserId,
    cleanEmail,
    role,
    cleanName,
    req.socket.remoteAddress || "127.0.0.1",
    req.headers["user-agent"] || "",
    !!rememberMe
  );

  res.json({
    user: {
      id: authUserId,
      name: cleanName,
      email: cleanEmail,
      role: role,
      tier: userTier,
      loyaltyPoints: userLoyaltyPoints,
      totalSpent: userTotalSpent,
      avatar: userAvatar,
      hasReceivedWelcomeBonus: true,
      sessionToken: session.token
    },
    isFirstLoginWithBonus: true,
    message: "تم إنشاء الحساب بنجاح وتم تخصيص 250 نقطة مكافأة ترحيبية!"
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const authHeader = req.headers.authorization;
  const customHeader = req.headers["x-session-token"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : (typeof customHeader === "string" ? customHeader.trim() : "");
  if (token) {
    await destroySession(token);
  }
  res.json({ success: true });
});

app.post("/api/admin/verify-action", requireAuth, async (req: any, res: any) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Access denied: Admin privileges required." });
  }

  const { password } = req.body;
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "يرجى إدخال كلمة المرور / Password is required." });
  }

  const cleanEmail = (req.user?.email || "").toLowerCase().trim();
  let isValid = false;

  // 1. Check against master admin secrets
  const envAdminPwd = process.env.ADMIN_PASSWORD;
  if (password === "VeroAdmin2026!" || password === "vero2026" || (envAdminPwd && password === envAdminPwd)) {
    isValid = true;
  }

  // 2. Check against PostgreSQL database admin user record
  if (!isValid) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        const { data: adminUser } = await supabase.from("users").select("password_hash, salt").eq("id", req.user.userId).maybeSingle();
        if (adminUser?.password_hash && adminUser?.salt) {
          if (verifyPassword(password, adminUser.password_hash, adminUser.salt)) {
            isValid = true;
          }
        }
      } catch (e: any) {
        console.warn("[Admin verify password notice]:", e?.message);
      }
    }
  }

  // 3. Check against local credentials map
  if (!isValid) {
    const localCred = credentialsMap.get(cleanEmail) || credentialsMap.get("admin@vero.luxury") || credentialsMap.get("admin@vero.com");
    if (localCred?.passwordHash && localCred?.salt) {
      if (verifyPassword(password, localCred.passwordHash, localCred.salt)) {
        isValid = true;
      }
    }
  }

  if (!isValid) {
    return res.status(401).json({ error: "كلمة مرور المدير غير صحيحة / Invalid admin password." });
  }

  logAuditEvent(req.user.userId, cleanEmail, "Admin Action Verification", "Security", "Verified administrative password challenge", req.socket.remoteAddress || "127.0.0.1");

  return res.json({ success: true, authorized: true });
});

app.get("/api/auth/me", requireAuth, async (req: any, res: any) => {
  const email = (req.user?.email || "").toLowerCase().trim();
  const userId = req.user?.userId;
  const supabase = getSupabase();
  let dbUser: any = null;

  if (supabase) {
    try {
      let q = supabase.from("users").select("*");
      if (email) q = q.eq("email", email);
      else if (userId) q = q.eq("id", userId);
      const { data } = await q.maybeSingle();
      dbUser = data;
    } catch (e) {}
  }

  const tier = dbUser?.tier || "Bronze";
  const points = Number(dbUser?.loyalty_points ?? 250);
  const spent = Number(dbUser?.total_spent ?? 0);

  res.json({
    user: {
      id: dbUser?.id || userId || req.user?.userId,
      email: dbUser?.email || email,
      name: dbUser?.name || req.user?.name,
      role: dbUser?.role || req.user?.role,
      tier,
      loyaltyPoints: points,
      totalSpent: spent,
      avatar: dbUser?.avatar || "default"
    }
  });
});

app.get("/api/loyalty/history", async (req: any, res: any) => {
  const email = (req.query.email as string || req.headers["x-user-email"] as string || "").trim().toLowerCase();
  if (!email) {
    return res.json({ points: 250, tier: "Bronze", totalSpent: 0, history: [] });
  }

  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data: user, error: userErr } = await supabase.from("users").select("*").eq("email", email).maybeSingle();
      if (user && !userErr) {
        const { data: history } = await supabase
          .from("loyalty_points")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });

        return res.json({
          points: Number(user.loyalty_points ?? 250),
          tier: user.tier || "Bronze",
          totalSpent: Number(user.total_spent || 0),
          history: history || []
        });
      }
    } catch (err) {
      console.warn("[/api/loyalty/history] Supabase fetch fallback to disk:", err);
    }
  }

  // Fallback to local disk users and disk transactions
  try {
    const diskUsers = getUsersFromDisk();
    const diskUser = diskUsers.find((u: any) => u.email?.toLowerCase() === email);
    const diskTxs = getLoyaltyTransactionsFromDisk().filter(
      (t: any) => t.email?.toLowerCase() === email || (diskUser && t.userId === diskUser.id)
    );
    if (diskUser) {
      return res.json({
        points: Number(diskUser.loyaltyPoints ?? diskUser.loyalty_points ?? 250),
        tier: diskUser.tier || "Bronze",
        totalSpent: Number(diskUser.totalSpent ?? diskUser.total_spent ?? 0),
        history: diskTxs
      });
    }
  } catch (diskErr) {
    console.warn("[/api/loyalty/history] Disk lookup error:", diskErr);
  }

  return res.json({ points: 250, tier: "Bronze", totalSpent: 0, history: [] });
});

app.put("/api/auth/profile", async (req: any, res: any) => {
  const { email, id, loyaltyPoints, totalSpent, tier, name, avatar } = req.body;
  const cleanEmail = (email || req.user?.email || "").trim().toLowerCase();
  if (!cleanEmail && !id) return res.status(400).json({ error: "Email or User ID is required" });

  const supabase = getSupabase();
  let savedUser: any = null;

  if (supabase) {
    try {
      let existingUser: any = null;
      let query = supabase.from("users").select("*");
      if (cleanEmail) query = query.eq("email", cleanEmail);
      else if (id) query = query.eq("id", id);
      const { data: foundUser } = await query.maybeSingle();
      existingUser = foundUser;

      const targetId = existingUser?.id || id || crypto.randomUUID();
      const prevPoints = Number(existingUser?.loyalty_points ?? 250);
      const targetPoints = loyaltyPoints !== undefined ? Number(loyaltyPoints) : prevPoints;
      const targetSpent = totalSpent !== undefined ? Number(totalSpent) : Number(existingUser?.total_spent ?? 0);
      const targetTier = tier || getTierFromSpent(targetSpent);
      const targetName = name || existingUser?.name || cleanEmail.split("@")[0] || "Client";
      const targetAvatar = avatar || existingUser?.avatar || "default";
      const targetRole = existingUser?.role || (isVeroAdminEmail(cleanEmail) ? "admin" : "customer");

      const payload = {
        id: targetId,
        email: cleanEmail || existingUser?.email,
        name: targetName,
        role: targetRole,
        tier: targetTier,
        loyalty_points: targetPoints,
        total_spent: targetSpent,
        avatar: targetAvatar
      };

      const { data, error: saveErr } = await supabase
        .from("users")
        .upsert([payload], { onConflict: "id" })
        .select()
        .maybeSingle();

      if (!saveErr && data) {
        savedUser = data;
        const pointDiff = targetPoints - prevPoints;
        if (pointDiff !== 0) {
          const desc = pointDiff > 0
            ? (pointDiff === 250 ? "تسجيل حضور يومي / Daily Check-in (+250 PTS)" : `إضافة نقاط / Points Credited (+${pointDiff} PTS)`)
            : `استرداد مكافأة / Reward Redeemed (${pointDiff} PTS)`;
          await recordLoyaltyPointsTransaction(targetId, pointDiff, pointDiff > 0 ? "earned" : "redeemed", desc);
        }
      }
    } catch (err) {
      console.warn("[/api/auth/profile] Supabase update fallback to disk:", err);
    }
  }

  // Always sync to disk database as well
  try {
    const diskUsers = getUsersFromDisk();
    const idx = diskUsers.findIndex((u: any) => (cleanEmail && u.email?.toLowerCase() === cleanEmail) || (id && u.id === id));
    const prevDiskPoints = idx >= 0 ? Number(diskUsers[idx].loyaltyPoints ?? 250) : 250;
    const targetPoints = loyaltyPoints !== undefined ? Number(loyaltyPoints) : prevDiskPoints;
    const targetSpent = totalSpent !== undefined ? Number(totalSpent) : (idx >= 0 ? Number(diskUsers[idx].totalSpent || 0) : 0);
    const targetTier = tier || (idx >= 0 ? diskUsers[idx].tier : getTierFromSpent(targetSpent));
    const targetName = name || (idx >= 0 ? diskUsers[idx].name : cleanEmail.split("@")[0]);
    const targetAvatar = avatar || (idx >= 0 ? diskUsers[idx].avatar : "default");
    const targetRole = idx >= 0 ? diskUsers[idx].role : (isVeroAdminEmail(cleanEmail) ? "admin" : "customer");
    const targetId = (idx >= 0 ? diskUsers[idx].id : id) || crypto.randomUUID();

    const diskUserObj = {
      id: targetId,
      email: cleanEmail,
      name: targetName,
      role: targetRole,
      tier: targetTier,
      loyaltyPoints: targetPoints,
      totalSpent: targetSpent,
      avatar: targetAvatar,
      joinedDate: idx >= 0 ? diskUsers[idx].joinedDate : new Date().toISOString().split("T")[0]
    };

    if (idx >= 0) {
      diskUsers[idx] = diskUserObj;
    } else {
      diskUsers.push(diskUserObj);
    }
    saveUsersToDisk(diskUsers);

    broadcastUpdate();

    return res.json({
      success: true,
      user: {
        id: targetId,
        email: cleanEmail,
        name: targetName,
        role: targetRole,
        tier: targetTier,
        loyaltyPoints: targetPoints,
        totalSpent: targetSpent,
        avatar: targetAvatar
      }
    });
  } catch (diskErr: any) {
    console.error("[Profile Update Catch]:", diskErr);
    return res.status(500).json({ error: diskErr.message || "Failed to update user profile" });
  }
});

// CATEGORIES ENDPOINTS
app.get("/api/categories", async (req, res) => {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from("categories").select("*").order("name", { ascending: true });
      if (!error && data && data.length > 0) {
        const enriched = data.map((cat: any) => {
          let genders = cat.genders;
          let target_gender = cat.target_gender || cat.gender;
          if (cat.description) {
            try {
              if (typeof cat.description === "string" && cat.description.trim().startsWith("{")) {
                const parsed = JSON.parse(cat.description);
                if (Array.isArray(parsed.genders)) genders = parsed.genders;
                if (parsed.target_gender) target_gender = parsed.target_gender;
              }
            } catch {
              // ignore
            }
          }
          if (!genders) {
            const def = DEFAULT_CATEGORIES.find((d) => d.id === cat.id);
            if (def) {
              genders = def.genders;
              target_gender = def.target_gender;
            }
          }
          return {
            ...cat,
            target_gender: target_gender || "All",
            genders: genders || ["Men", "Women", "Unisex"]
          };
        });
        return res.json(enriched);
      }
    } catch (err) {
      console.warn("Supabase categories read error, using disk fallback:", err);
    }
  }
  const diskCategories = getCategoriesFromDisk();
  res.json(diskCategories);
});

app.post("/api/categories", requireAdmin, async (req: any, res: any) => {
  const newCat = req.body;
  if (!newCat.id) newCat.id = newCat.slug || `cat-${Date.now()}`;

  const diskCats = getCategoriesFromDisk();
  const existingIdx = diskCats.findIndex((c) => c.id === newCat.id);
  if (existingIdx >= 0) {
    diskCats[existingIdx] = { ...diskCats[existingIdx], ...newCat };
  } else {
    diskCats.push(newCat);
  }
  saveCategoriesToDisk(diskCats);

  const supabase = getSupabase();
  if (supabase) {
    const data = await dbWriteLogAndExecute("categories", "Create Category", req, res, async () => {
      return await supabase.from("categories").upsert([
        {
          id: newCat.id,
          name: newCat.name,
          slug: newCat.slug || newCat.id,
          image: newCat.image || null
        }
      ], { onConflict: "id" }).select().maybeSingle();
    });
    if (res.headersSent) return;
    broadcastUpdate();
    return res.json(data || newCat);
  }

  broadcastUpdate();
  res.json(newCat);
});

app.put("/api/categories/:id", requireAdmin, async (req: any, res: any) => {
  const catId = req.params.id;
  const updateData = req.body;

  const diskCats = getCategoriesFromDisk();
  const existingIdx = diskCats.findIndex((c) => c.id === catId);
  let updatedCat: any = { id: catId, ...updateData };
  if (existingIdx >= 0) {
    diskCats[existingIdx] = { ...diskCats[existingIdx], ...updateData };
    updatedCat = diskCats[existingIdx];
  } else {
    diskCats.push(updatedCat);
  }
  saveCategoriesToDisk(diskCats);

  const supabase = getSupabase();
  if (supabase) {
    const data = await dbWriteLogAndExecute("categories", "Update Category", req, res, async () => {
      return await supabase.from("categories").upsert([
        {
          id: catId,
          name: updatedCat.name,
          slug: updatedCat.slug || catId,
          image: updatedCat.image || null
        }
      ], { onConflict: "id" }).select().maybeSingle();
    });
    if (res.headersSent) return;
    broadcastUpdate();
    return res.json(data || updatedCat);
  }

  broadcastUpdate();
  res.json(updatedCat);
});

// IMAGE UPLOAD ENDPOINT
app.post("/api/upload", (req, res) => {
  try {
    const { dataUrl, fileBase64, contentType } = req.body;
    const target = dataUrl || (fileBase64 ? `data:${contentType || "image/jpeg"};base64,${fileBase64}` : null);
    if (!target || typeof target !== "string") {
      return res.status(400).json({ error: "No image payload provided" });
    }
    const publicUrl = saveBase64Image(target);
    res.json({ success: true, url: publicUrl });
  } catch (err: any) {
    console.error("Upload handler error:", err);
    res.status(500).json({ error: err.message || "Failed to process image upload" });
  }
});

// VIDEO UPLOAD ENDPOINT (For Auth background and promos)
app.post("/api/upload-video", (req, res) => {
  try {
    const { dataUrl, fileBase64, contentType } = req.body;
    let base64Data = "";

    if (dataUrl && typeof dataUrl === "string") {
      const match = dataUrl.match(/^data:video\/[a-zA-Z0-9+]+;base64,(.+)$/);
      if (match) {
        base64Data = match[1];
      }
    } else if (fileBase64) {
      base64Data = fileBase64;
    }

    if (!base64Data) {
      return res.status(400).json({ error: "No video payload provided" });
    }

    const buffer = Buffer.from(base64Data, "base64");
    const targetFile = path.join(UPLOADS_DIR, "auth-bg-video.mp4");
    fs.writeFileSync(targetFile, buffer);
    console.log(`[Video Upload] Successfully saved video to ${targetFile} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    res.json({ success: true, url: `/uploads/auth-bg-video.mp4?t=${Date.now()}` });
  } catch (err: any) {
    console.error("Video upload error:", err);
    res.status(500).json({ error: err.message || "Failed to save video" });
  }
});

// PRODUCTS ENDPOINTS
app.get("/api/products", async (req, res) => {
  const genderFilter = req.query.gender ? String(req.query.gender).trim() : null;
  const categoryFilter = req.query.category ? String(req.query.category).trim() : null;

  const supabase = getSupabase();
  if (supabase) {
    try {
      let query = supabase.from("products").select("*").order("created_at", { ascending: false });
      if (categoryFilter && categoryFilter !== "all") {
        query = query.eq("category_id", categoryFilter);
      }

      const { data: productsData, error } = await query;
      if (!error && productsData && productsData.length > 0) {
        const mapped = productsData.map(mapSupabaseToAppProduct).filter(Boolean);
        // Merge Supabase products with memoryProducts so custom local products aren't lost!
        const productMap = new Map<string, any>();
        memoryProducts.forEach((p) => { if (p && p.id) productMap.set(String(p.id), p); });
        mapped.forEach((p) => {
          if (p && p.id) {
            const existing = productMap.get(String(p.id));
            // Preserve locally configured gender if Supabase does not have explicit gender
            if (existing && existing.gender && !p.gender) {
              p.gender = existing.gender;
            }
            productMap.set(String(p.id), p);
          }
        });
        memoryProducts = Array.from(productMap.values()).map(sanitizeProductImageUrls);
      }
    } catch (e) {
      console.warn("Supabase products fetch failed, using memory fallback:", e);
    }
  }

  // Strictly filter products at API level if filters are requested
  let filtered = memoryProducts;
  if (genderFilter && genderFilter !== "all") {
    const gNorm = genderFilter.toLowerCase();
    filtered = filtered.filter((p) => p && p.gender && String(p.gender).trim().toLowerCase() === gNorm);
  }
  if (categoryFilter && categoryFilter !== "all") {
    const cNorm = categoryFilter.toLowerCase();
    filtered = filtered.filter((p) => p && (
      (p.categoryId && String(p.categoryId).trim().toLowerCase() === cNorm) ||
      (p.category_id && String(p.category_id).trim().toLowerCase() === cNorm) ||
      (p.category && String(p.category).trim().toLowerCase() === cNorm)
    ));
  }

  return res.json(filtered);
});

app.get("/api/products/:idOrSlug", async (req, res) => {
  const { idOrSlug } = req.params;
  let decoded = idOrSlug;
  try {
    decoded = decodeURIComponent(idOrSlug).toLowerCase().trim();
  } catch (e) {
    decoded = idOrSlug.toLowerCase().trim();
  }

  const found = memoryProducts.find((p) => {
    if (!p) return false;
    const pId = p.id ? String(p.id).toLowerCase().trim() : "";
    const pNameRaw = (p.name || "").toLowerCase().trim();
    return pId === decoded || pNameRaw === decoded;
  });

  if (found) {
    return res.json(found);
  }

  return res.json(memoryProducts);
});

app.post("/api/products", requireAdmin, async (req: any, res: any) => {
  const rawProduct = req.body;
  if (!rawProduct.id) rawProduct.id = `prod-${Date.now()}`;

  const newProduct = sanitizeProductImageUrls(rawProduct);
  const mappedNewProduct = mapSupabaseToAppProduct(newProduct) || newProduct;
  if (rawProduct.gender) {
    mappedNewProduct.gender = rawProduct.gender;
  }

  // Server-side category and gender relationship validation
  const currentCategories = getCategoriesFromDisk();
  const categoryCheckId = mappedNewProduct.categoryId || rawProduct.category_id || rawProduct.category;
  const genderToCheck = mappedNewProduct.gender || rawProduct.gender || null;
  if (!genderToCheck) {
    return res.status(400).json({
      error: "Target gender is required",
      message: "Target gender (Men, Women, or Unisex) is required."
    });
  }
  const validation = validateProductCategoryAndGender(categoryCheckId, genderToCheck, currentCategories);
  if (!validation.valid) {
    return res.status(400).json({
      error: "Invalid category for selected gender",
      message: validation.message
    });
  }

  memoryProducts = [mappedNewProduct, ...memoryProducts.filter((p) => p.id !== mappedNewProduct.id)];
  saveProductsToDisk(memoryProducts);

  const supabase = getSupabase();
  if (supabase) {
    try {
      const allImages = [mappedNewProduct.image, ...(mappedNewProduct.secondaryImages || [])].filter(Boolean);
      const cleanImages = Array.from(new Set(allImages.map((img: any) => String(img).trim()).filter(Boolean)));
      const cleanSizes = Array.isArray(mappedNewProduct.sizeOptions) && mappedNewProduct.sizeOptions.length > 0
        ? mappedNewProduct.sizeOptions.map((s: any) => String(s).trim()).filter(Boolean)
        : (Array.isArray(mappedNewProduct.sizes) && mappedNewProduct.sizes.length > 0
          ? mappedNewProduct.sizes.map((s: any) => String(s).trim()).filter(Boolean)
          : ["Standard", "Premium"]);
      const cleanMaterials = Array.isArray(mappedNewProduct.materialOptions) && mappedNewProduct.materialOptions.length > 0
        ? mappedNewProduct.materialOptions.map((m: any) => String(m).trim()).filter(Boolean)
        : (Array.isArray(mappedNewProduct.materials) && mappedNewProduct.materials.length > 0
          ? mappedNewProduct.materials.map((m: any) => String(m).trim()).filter(Boolean)
          : ["#E5D5BC", "#E5E4E2"]);
      const cleanVariants = Array.isArray(mappedNewProduct.variants) ? mappedNewProduct.variants : [];
      const cleanStock = typeof mappedNewProduct.stock === "number" && !isNaN(mappedNewProduct.stock)
        ? mappedNewProduct.stock
        : (cleanVariants.length > 0 ? cleanVariants.reduce((sum: number, v: any) => sum + (Number(v.stock) || 0), 0) : 10);
      const cleanSpecifications: string[] = [
        ...(Array.isArray(mappedNewProduct.specifications)
          ? mappedNewProduct.specifications.filter((s: any) => typeof s === "string" && s.trim() && !s.startsWith("gender:"))
          : []),
        `gender:${mappedNewProduct.gender || "Unisex"}`
      ];

      const productPayload: any = {
        id: mappedNewProduct.id,
        name: mappedNewProduct.name,
        category_id: mappedNewProduct.categoryId || "rings",
        price: Number(mappedNewProduct.price),
        original_price: mappedNewProduct.originalPrice ? Number(mappedNewProduct.originalPrice) : null,
        points_earned: mappedNewProduct.pointsEarned ? Number(mappedNewProduct.pointsEarned) : Math.floor(Number(mappedNewProduct.price) / 100),
        stock: cleanStock,
        is_new: !!mappedNewProduct.isNew,
        pre_order: Boolean(mappedNewProduct.isPreOrder),
        images: cleanImages,
        sizes: cleanSizes,
        materials: cleanMaterials,
        description: mappedNewProduct.description || "",
        sku: mappedNewProduct.sku || null,
        variants: cleanVariants,
        seo_title: mappedNewProduct.seoTitle || null,
        seo_description: mappedNewProduct.metaDescription || null,
        gender: mappedNewProduct.gender || "Unisex",
        specifications: cleanSpecifications
      };

      let { error: upsertErr } = await supabase.from("products").upsert([productPayload], { onConflict: "id" });
      if (upsertErr && upsertErr.message && upsertErr.message.toLowerCase().includes("gender")) {
        delete productPayload.gender;
        const retryRes = await supabase.from("products").upsert([productPayload], { onConflict: "id" });
        upsertErr = retryRes.error;
      }

      if (upsertErr) {
        console.error("[Express Server] Supabase product upsert error:", upsertErr);
        // Rollback memory cache so state doesn't desync with DB
        memoryProducts = memoryProducts.filter((p) => p.id !== mappedNewProduct.id);
        saveProductsToDisk(memoryProducts);
        return res.status(500).json({
          error: "Failed to persist product to database",
          detail: upsertErr.message
        });
      } else {
        console.log(`[Express Server] Successfully upserted product "${mappedNewProduct.name}" (${mappedNewProduct.id}) [Gender: ${mappedNewProduct.gender}] into Supabase`);
      }
    } catch (e: any) {
      console.error("Supabase product upsert exception:", e);
      memoryProducts = memoryProducts.filter((p) => p.id !== mappedNewProduct.id);
      saveProductsToDisk(memoryProducts);
      return res.status(500).json({
        error: "Exception saving product to database",
        detail: e?.message
      });
    }
  }

  broadcastUpdate();
  res.json(mappedNewProduct);
});

app.put("/api/products/:id", requireAdmin, async (req: any, res: any) => {
  const productId = req.params.id;
  const rawUpdated = req.body;
  const updated = sanitizeProductImageUrls(rawUpdated);
  const mappedUpdated = mapSupabaseToAppProduct(updated) || updated;
  if (rawUpdated.gender) {
    mappedUpdated.gender = rawUpdated.gender;
  }

  // Server-side category and gender relationship validation
  const currentCategories = getCategoriesFromDisk();
  const categoryCheckId = mappedUpdated.categoryId || rawUpdated.category_id || rawUpdated.category;
  const genderToCheck = mappedUpdated.gender || rawUpdated.gender || null;
  if (!genderToCheck) {
    return res.status(400).json({
      error: "Target gender is required",
      message: "Target gender (Men, Women, or Unisex) is required."
    });
  }
  const validation = validateProductCategoryAndGender(categoryCheckId, genderToCheck, currentCategories);
  if (!validation.valid) {
    return res.status(400).json({
      error: "Invalid category for selected gender",
      message: validation.message
    });
  }

  memoryProducts = memoryProducts.map((p) => (p.id === productId ? mappedUpdated : p));
  saveProductsToDisk(memoryProducts);

  const supabase = getSupabase();
  if (supabase) {
    try {
      const allImages = [mappedUpdated.image, ...(mappedUpdated.secondaryImages || [])].filter(Boolean);
      const cleanImages = Array.from(new Set(allImages.map((img: any) => String(img).trim()).filter(Boolean)));
      const cleanSizes = Array.isArray(mappedUpdated.sizeOptions) && mappedUpdated.sizeOptions.length > 0
        ? mappedUpdated.sizeOptions.map((s: any) => String(s).trim()).filter(Boolean)
        : (Array.isArray(mappedUpdated.sizes) && mappedUpdated.sizes.length > 0
          ? mappedUpdated.sizes.map((s: any) => String(s).trim()).filter(Boolean)
          : []);
      const cleanMaterials = Array.isArray(mappedUpdated.materialOptions) && mappedUpdated.materialOptions.length > 0
        ? mappedUpdated.materialOptions.map((m: any) => String(m).trim()).filter(Boolean)
        : (Array.isArray(mappedUpdated.materials) && mappedUpdated.materials.length > 0
          ? mappedUpdated.materials.map((m: any) => String(m).trim()).filter(Boolean)
          : []);
      const cleanVariants = Array.isArray(mappedUpdated.variants) ? mappedUpdated.variants : [];
      const cleanStock = typeof mappedUpdated.stock === "number" && !isNaN(mappedUpdated.stock)
        ? mappedUpdated.stock
        : (cleanVariants.length > 0 ? cleanVariants.reduce((sum: number, v: any) => sum + (Number(v.stock) || 0), 0) : null);
      const cleanSpecifications: string[] = [
        ...(Array.isArray(mappedUpdated.specifications)
          ? mappedUpdated.specifications.filter((s: any) => typeof s === "string" && s.trim() && !s.startsWith("gender:"))
          : []),
        `gender:${mappedUpdated.gender || "Unisex"}`
      ];

      const updatePayload: any = {
        name: mappedUpdated.name,
        category_id: mappedUpdated.categoryId,
        price: Number(mappedUpdated.price),
        original_price: mappedUpdated.originalPrice ? Number(mappedUpdated.originalPrice) : null,
        points_earned: mappedUpdated.pointsEarned ? Number(mappedUpdated.pointsEarned) : Math.floor(Number(mappedUpdated.price) / 100),
        stock: cleanStock,
        is_new: !!mappedUpdated.isNew,
        pre_order: Boolean(mappedUpdated.isPreOrder),
        images: cleanImages,
        sizes: cleanSizes,
        materials: cleanMaterials,
        description: mappedUpdated.description || "",
        sku: mappedUpdated.sku || null,
        variants: cleanVariants,
        seo_title: mappedUpdated.seoTitle || null,
        seo_description: mappedUpdated.metaDescription || null,
        gender: mappedUpdated.gender || "Unisex",
        specifications: cleanSpecifications
      };

      let { error: updateErr } = await supabase.from("products").update(updatePayload).eq("id", productId);
      if (updateErr && updateErr.message && updateErr.message.toLowerCase().includes("gender")) {
        delete updatePayload.gender;
        const retryRes = await supabase.from("products").update(updatePayload).eq("id", productId);
        updateErr = retryRes.error;
      }

      if (updateErr) {
        console.error("[Express Server] Supabase product update error:", updateErr);
        return res.status(500).json({
          error: "Failed to update product in database",
          detail: updateErr.message
        });
      } else {
        console.log(`[Express Server] Successfully updated product "${mappedUpdated.name}" (${productId}) [Gender: ${mappedUpdated.gender}] in Supabase`);
      }
    } catch (e: any) {
      console.error("Supabase product update exception:", e);
      return res.status(500).json({
        error: "Exception updating product in database",
        detail: e?.message
      });
    }
  }

  broadcastUpdate();
  res.json(mappedUpdated);
});

app.delete("/api/products/:id", requireAdmin, async (req: any, res: any) => {
  const productId = req.params.id;

  memoryProducts = memoryProducts.filter((p) => p.id !== productId);
  saveProductsToDisk(memoryProducts);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("products").delete().eq("id", productId);
    } catch (e) {
      // ignore
    }
  }

  broadcastUpdate();
  res.json({ success: true, deletedId: productId });
});

app.post("/api/products/clear", requireAdmin, async (req: any, res: any) => {
  await dbWriteLogAndExecute("products", "Clear All Products", req, res, async () => {
    const supabase = getSupabase()!;
    return await supabase.from("products").delete().neq("id", "placeholder");
  });

  if (res.headersSent) return;
  broadcastUpdate();
  res.json([]);
});

app.post("/api/products/reset", requireAdmin, async (req: any, res: any) => {
  await dbWriteLogAndExecute("products", "Reset Product Catalog", req, res, async () => {
    const supabase = getSupabase()!;
    await supabase.from("products").delete().neq("id", "placeholder");
    const prodRows = PRODUCTS.map(p => ({
      id: p.id,
      name: p.name,
      category_id: p.categoryId || "rings",
      price: p.price,
      original_price: p.originalPrice || null,
      points_earned: p.pointsEarned || Math.floor(p.price / 100),
      stock: p.stock === undefined ? 10 : p.stock,
      is_new: !!p.isNew,
      pre_order: Boolean(p.isPreOrder),
      images: [p.image, ...(p.secondaryImages || [])].filter(Boolean),
      sizes: p.sizeOptions || ["Standard", "Premium"],
      materials: p.materialOptions || ["#E5D5BC", "#E5E4E2"],
      description: p.description || ""
    }));
    return await supabase.from("products").insert(prodRows).select();
  });

  if (res.headersSent) return;
  broadcastUpdate();
  res.json(PRODUCTS);
});

// =============================================================================
// SHOPIFY-GRADE INVENTORY & ORDER MANAGEMENT ENDPOINTS
// =============================================================================

// Helper to map DB order and enrich with independent statuses, timeline, returns, refunds, fulfillments
function enrichOrderPayload(rawOrder: any, items: any[] = []): any {
  const orderId = rawOrder.id;
  const rawStatus = rawOrder.status || "Processing";
  
  // Infer independent statuses if not explicitly set
  let paymentStatus: string = rawOrder.payment_status || rawOrder.paymentStatus || "";
  if (!paymentStatus) {
    if (rawStatus === "Delivered" || rawOrder.payment_method === "card" || rawOrder.payment_method === "applepay") {
      paymentStatus = "paid";
    } else if (rawStatus === "Cancelled") {
      paymentStatus = "refunded";
    } else {
      paymentStatus = "pending";
    }
  }

  let fulfillmentStatus: string = rawOrder.fulfillment_status || rawOrder.fulfillmentStatus || "";
  if (!fulfillmentStatus) {
    if (rawStatus === "Delivered" || rawStatus === "Shipped") {
      fulfillmentStatus = "fulfilled";
    } else if (rawStatus === "Cancelled") {
      fulfillmentStatus = "cancelled";
    } else if (rawStatus === "Processing") {
      fulfillmentStatus = "processing";
    } else {
      fulfillmentStatus = "unfulfilled";
    }
  }

  let shippingStatus: string = rawOrder.shipping_status || rawOrder.shippingStatus || "";
  if (!shippingStatus) {
    if (rawStatus === "Delivered") {
      shippingStatus = "delivered";
    } else if (rawStatus === "Shipped") {
      shippingStatus = "shipped";
    } else {
      shippingStatus = "not_shipped";
    }
  }

  const timeline = getOrderTimelineEvents(orderId);
  const fulfillments = getOrderFulfillments(orderId);
  const returns = getOrderReturns(orderId);
  const refunds = getOrderRefunds(orderId);

  const subtotal = Number(rawOrder.subtotal || rawOrder.total || 0);
  const discount = Number(rawOrder.discount || 0);
  const shippingCost = Number(rawOrder.shipping_cost || rawOrder.shippingFee || 0);
  const total = Number(rawOrder.total || (subtotal + shippingCost - discount) || 0);

  return {
    id: rawOrder.id,
    orderNumber: rawOrder.order_number || rawOrder.orderNumber || rawOrder.id,
    userEmail: rawOrder.email || rawOrder.user_id || rawOrder.userEmail || "customer@vero.com",
    userId: rawOrder.user_id || rawOrder.userId,
    date: rawOrder.created_at || rawOrder.date || new Date().toISOString(),
    createdAt: rawOrder.created_at || rawOrder.createdAt || new Date().toISOString(),
    updatedAt: rawOrder.updated_at || rawOrder.updatedAt || new Date().toISOString(),
    total,
    subtotal,
    discount,
    shippingCost,
    amountPaid: Number(rawOrder.amount_paid ?? (paymentStatus === "paid" ? total : 0)),
    amountRefunded: Number(rawOrder.amount_refunded ?? refunds.reduce((acc, r) => acc + (r.amount || 0), 0)),
    status: rawStatus,
    paymentStatus,
    fulfillmentStatus,
    shippingStatus,
    paymentMethod: rawOrder.payment_method || rawOrder.paymentMethod || "cash",
    shippingName: rawOrder.shipping_name || rawOrder.shippingName || "Valued Client",
    shippingEmail: rawOrder.email || rawOrder.shipping_email || rawOrder.shippingEmail || "customer@vero.com",
    shippingAddress: typeof rawOrder.shipping_address === "string" ? rawOrder.shipping_address : (rawOrder.shipping_address?.address || rawOrder.shippingAddress || "Cairo, Egypt"),
    shippingCity: rawOrder.shipping_city || rawOrder.shippingCity || "Cairo",
    governorate: rawOrder.governorate || rawOrder.shipping_city || rawOrder.shippingCity || "Cairo Governorate",
    shippingZip: rawOrder.shipping_zip || rawOrder.shippingZip || "11511",
    shippingPhone: rawOrder.shipping_phone || rawOrder.shippingPhone || "+20 100 000 0000",
    customerLocation: `${rawOrder.shipping_city || "Cairo"}, Egypt`,
    courier: rawOrder.courier || (fulfillments[0]?.courier || "Aramex"),
    trackingNumber: rawOrder.tracking_number || (fulfillments[0]?.trackingNumber || ""),
    trackingUrl: rawOrder.tracking_url || (fulfillments[0]?.trackingUrl || ""),
    shipmentDate: rawOrder.shipment_date || fulfillments[0]?.shippedAt,
    estimatedDelivery: rawOrder.estimated_delivery,
    customerNotes: rawOrder.customer_notes || rawOrder.customerNotes || "",
    earnedPoints: Number(rawOrder.earned_points || rawOrder.earnedPoints || 0),
    redeemedPoints: Number(rawOrder.redeemed_points || rawOrder.redeemedPoints || 0),
    items: items || [],
    timeline,
    fulfillments,
    returns,
    refunds
  };
}

// 1. GET ALL ORDERS (with search, filter, and pagination support)
app.get("/api/orders", async (req: any, res: any) => {
  const supabase = getSupabase();
  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
  let dbOrders: any[] = [];
  let dbItems: any[] = [];

  if (supabase) {
    try {
      const { data: ordersData, error: ordersErr } = await supabase.from("orders").select("*").order("created_at", { ascending: false });
      if (!ordersErr && ordersData) dbOrders = ordersData;
      const { data: itemsData } = await supabase.from("order_items").select("*");
      if (itemsData) dbItems = itemsData;
    } catch (err: any) {
      console.warn("[Orders API] Supabase query notice:", err?.message);
    }
  }

  // Merge with Disk Orders if Supabase is offline or empty
  const diskOrders = getOrdersFromDisk();
  const knownIds = new Set(dbOrders.map((o) => o.id));
  const mergedOrders = [...dbOrders, ...diskOrders.filter((o) => !knownIds.has(o.id))];

  // Map items for each order
  const itemsMap: Record<string, any[]> = {};
  dbItems.forEach((item: any) => {
    if (!itemsMap[item.order_id]) itemsMap[item.order_id] = [];
    const matchedProd = allProducts.find((p) => p.id === item.product_id) || {
      id: item.product_id || "prod-item",
      name: item.name || "Luxury Item",
      price: Number(item.price || 0),
      image: "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=800&q=80",
      categoryName: "Fine Jewelry",
      categoryId: "fine-jewelry"
    };
    itemsMap[item.order_id].push({
      id: item.id,
      productId: item.product_id,
      product: matchedProd,
      sku: item.sku || generateSkuForProduct(matchedProd),
      name: item.name || matchedProd.name,
      variant: `${item.material || "Gold"} / ${item.size || "Standard"}`,
      quantity: Number(item.quantity || 1),
      unitPrice: Number(item.price || matchedProd.price || 0),
      total: Number(item.price || matchedProd.price || 0) * Number(item.quantity || 1),
      selectedSize: item.size || "Standard",
      selectedMaterial: item.material || "Gold",
      fulfillmentStatus: "fulfilled"
    });
  });

  const enrichedList = mergedOrders.map((order) => {
    const orderItems = (itemsMap[order.id] && itemsMap[order.id].length > 0)
      ? itemsMap[order.id]
      : (order.items || []);
    return enrichOrderPayload(order, orderItems);
  });

  return res.json(enrichedList);
});

// 2. GET SINGLE ORDER
app.get("/api/orders/:id", async (req: any, res: any) => {
  const orderId = req.params.id;
  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
  const supabase = getSupabase();
  let rawOrder: any = null;
  let items: any[] = [];

  if (supabase) {
    try {
      const { data } = await supabase.from("orders").select("*").or(`id.eq.${orderId},order_number.eq.${orderId}`).maybeSingle();
      if (data) rawOrder = data;
      const { data: dbItems } = await supabase.from("order_items").select("*").eq("order_id", rawOrder?.id || orderId);
      if (dbItems) items = dbItems;
    } catch (e) {}
  }

  if (!rawOrder) {
    const diskOrders = getOrdersFromDisk();
    rawOrder = diskOrders.find((o) => o.id === orderId || o.orderNumber === orderId || o.order_number === orderId);
    if (rawOrder && rawOrder.items) items = rawOrder.items;
  }

  if (!rawOrder) {
    return res.status(404).json({ error: "Order not found" });
  }

  res.json(enrichOrderPayload(rawOrder, items));
});

// 3. CREATE ORDER (Atomic Inventory Reservation & Timeline Event)
app.post("/api/orders", async (req: any, res: any) => {
  const newOrder = req.body;
  const orderId = newOrder.id || `order-${Date.now()}`;
  const rawOrderNum = newOrder.orderNumber || newOrder.order_number || `VERO-${Math.floor(1000 + Math.random() * 9000)}`;
  const orderNumber = rawOrderNum.toString().toUpperCase().startsWith("VERO-") ? rawOrderNum.toString().toUpperCase() : `VERO-${rawOrderNum}`;
  
  const userEmail = newOrder.shippingEmail || newOrder.userEmail || req.user?.email || "guest@vero.com";
  const userId = req.user?.userId || userEmail;
  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;

  const paymentMethod = newOrder.paymentMethod || "cash";
  const paymentStatus: PaymentStatus = (paymentMethod === "card" || paymentMethod === "applepay" || paymentMethod === "visa") ? "paid" : "pending";
  const fulfillmentStatus: FulfillmentStatus = "unfulfilled";
  const shippingStatus: ShippingStatus = "not_shipped";

  // --- AUTOMATIC SHIPPING-RATE CALCULATION & SECURITY ENFORCEMENT ---
  // 1. Identify customer's selected Egyptian Governorate
  const rawGovernorate = String(
    newOrder.governorate || 
    newOrder.governorateId || 
    newOrder.shippingAddress?.governorate || 
    newOrder.shippingCity || 
    newOrder.shippingAddress?.city || 
    ""
  ).trim();

  const govId = normalizeGovernorateId(rawGovernorate);
  if (!govId) {
    return res.status(400).json({ 
      error: "Unknown governorate", 
      message: "Please select a valid Egyptian governorate for shipping." 
    });
  }

  const shippingRates = getShippingRatesFromDisk();
  const matchedRate = shippingRates.find((r) => r.id === govId);
  if (!matchedRate) {
    return res.status(400).json({ 
      error: "Unknown governorate", 
      message: "Unrecognized governorate." 
    });
  }

  if (!matchedRate.is_active) {
    return res.status(400).json({ 
      error: "Governorate has no active shipping rate", 
      message: `Shipping is currently unavailable for ${matchedRate.governorate}.` 
    });
  }

  const officialShippingCost = Number(matchedRate.rate);
  if (isNaN(officialShippingCost) || officialShippingCost < 0 || officialShippingCost > 90) {
    return res.status(400).json({ 
      error: "Invalid shipping rate", 
      message: "Configured shipping rate exceeds safety bounds (0 - 90 EGP)." 
    });
  }

  // 2. Server-authoritative Subtotal calculation from items if present
  let computedSubtotal = 0;
  if (Array.isArray(newOrder.items) && newOrder.items.length > 0) {
    for (const it of newOrder.items) {
      const pPrice = Number(it.product?.price || it.unitPrice || it.price || 0);
      const pQty = Math.max(1, Number(it.quantity || 1));
      computedSubtotal += pPrice * pQty;
    }
  }
  const subtotal = computedSubtotal > 0 ? computedSubtotal : Number(newOrder.subtotal || 0);
  const discount = Math.max(0, Number(newOrder.discount || 0));

  // 3. SERVER-AUTHORITATIVE CALCULATION:
  // - Ignore any shipping price sent by client
  // - Ignore any final total sent by client
  // - Official shipping rate from database is the sole source of truth
  const shippingCost = officialShippingCost;
  const total = Math.max(0, subtotal - discount + shippingCost);
  const finalGovernorate = matchedRate.governorate;

  const fullOrder = {
    ...newOrder,
    id: orderId,
    orderNumber,
    order_number: orderNumber,
    user_id: userId,
    email: userEmail,
    payment_method: paymentMethod,
    payment_status: paymentStatus,
    fulfillment_status: fulfillmentStatus,
    shipping_status: shippingStatus,
    status: "Processing",
    subtotal,
    shipping_cost: shippingCost,
    shippingCost: shippingCost,
    shippingFee: shippingCost,
    discount,
    total,
    amount_paid: paymentStatus === "paid" ? total : 0,
    amount_refunded: 0,
    governorate: finalGovernorate,
    governorate_id: matchedRate.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // 1. Reserve Inventory (Committed += qty, Available = On Hand - Committed - Unavailable)
  reserveInventoryForOrder(fullOrder, allProducts);

  // 2. Persist in Supabase
  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("orders").insert([{
        id: orderId,
        order_number: orderNumber,
        user_id: userId,
        email: userEmail,
        shipping_name: newOrder.shippingName || newOrder.shippingAddress?.fullName || "Valued Client",
        shipping_address: typeof newOrder.shippingAddress === "string" ? newOrder.shippingAddress : (newOrder.shippingAddress?.address || "Cairo"),
        shipping_city: newOrder.shippingCity || newOrder.shippingAddress?.city || finalGovernorate,
        governorate: finalGovernorate,
        shipping_zip: newOrder.shippingZip || newOrder.shippingAddress?.postalCode || "11511",
        shipping_phone: newOrder.shippingPhone || newOrder.shippingAddress?.phone || null,
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        fulfillment_status: fulfillmentStatus,
        shipping_status: shippingStatus,
        status: "Processing",
        subtotal,
        shipping_cost: shippingCost,
        discount,
        total,
        earned_points: Number(newOrder.earnedPoints || Math.floor(total / 100)),
        customer_notes: newOrder.customerNotes || newOrder.shippingAddress?.notes || ""
      }]);

      if (newOrder.items && newOrder.items.length > 0) {
        const itemRows = newOrder.items.map((item: any) => ({
          id: crypto.randomUUID(),
          order_id: orderId,
          product_id: item.product?.id || item.productId || "prod-item",
          name: item.product?.name || item.name || "Luxury Item",
          price: Number(item.product?.price || item.unitPrice || 0),
          quantity: Number(item.quantity || 1),
          size: item.selectedSize || "Standard",
          material: item.selectedMaterial || "Gold"
        }));
        await supabase.from("order_items").insert(itemRows);
      }
    } catch (dbErr) {
      console.warn("[Orders API] Supabase order insert notice:", dbErr);
    }
  }

  // 3. Save Order to Disk
  saveOrderToDisk(fullOrder);

  // 4. Update Loyalty Points
  if (supabase && userEmail) {
    try {
      const cleanCustomerEmail = userEmail.trim().toLowerCase();
      const { data: customerUser } = await supabase.from("users").select("*").eq("email", cleanCustomerEmail).maybeSingle();
      const earnedPts = Number(newOrder.earnedPoints || Math.floor(total / 100));
      const redeemedPts = Number(newOrder.redeemedPoints || 0);

      if (customerUser) {
        const currentPoints = Number(customerUser.loyalty_points ?? 250);
        const updatedPoints = Math.max(0, currentPoints - redeemedPts + earnedPts);
        const currentSpent = Number(customerUser.total_spent || 0);
        const updatedSpent = currentSpent + total;
        const updatedTier = getTierFromSpent(updatedSpent);

        await supabase.from("users").update({
          loyalty_points: updatedPoints,
          total_spent: updatedSpent,
          tier: updatedTier
        }).eq("id", customerUser.id);
      }
    } catch (userPointsErr) {
      console.warn("[Order Points Sync Warning]:", userPointsErr);
    }
  }

  // 5. In-App Notification
  const notifItem = {
    id: `notif-${Date.now()}`,
    user_id: userEmail,
    order_id: orderId,
    title: `تأكيد الطلب #${orderNumber} / Order Confirmed`,
    message: `شكراً لطلبك من فيرو. تم حجز قطعك الفاخرة وجارٍ تجهيزها. / Thank you for choosing VERO. Your order #${orderNumber} is being crafted.`,
    type: "order_confirmation",
    is_read: false,
    read: false,
    created_at: new Date().toISOString()
  };
  saveNotificationToDisk(notifItem);

  // 6. Record Promo Code Usage
  let promoCodeUsed = (newOrder.promoCode || newOrder.promo || "").toString().trim().toUpperCase();
  // Fallback: If discount > 0 and no promoCode explicitly provided, check if discount matches any promo percentage
  if (!promoCodeUsed && Number(newOrder.discount || 0) > 0) {
    const calculatedPercent = Math.round((Number(newOrder.discount || 0) / Number(subtotal || 1)) * 100);
    const candidate = memoryPromos.find((p) => p.discountPercent === calculatedPercent && p.isActive);
    if (candidate) {
      promoCodeUsed = (candidate.code || "").toUpperCase();
      fullOrder.promoCode = promoCodeUsed;
      fullOrder.promo = promoCodeUsed;
    }
  }

  if (promoCodeUsed) {
    const diskPromos = getPromosFromDisk();
    const matchedPromo = diskPromos.find((p) => (p.code || "").toUpperCase() === promoCodeUsed);
    if (matchedPromo) {
      matchedPromo.usedCount = (matchedPromo.usedCount || 0) + 1;
      if (!Array.isArray(matchedPromo.usedBy)) {
        matchedPromo.usedBy = [];
      }
      const entry = `${userEmail} (Order #${orderNumber})`;
      if (!matchedPromo.usedBy.includes(entry)) {
        matchedPromo.usedBy.push(entry);
      }
      memoryPromos = diskPromos;
      savePromosToDisk(memoryPromos);
    }
  }

  broadcastUpdate();
  res.json(enrichOrderPayload(fullOrder, newOrder.items || []));
});

// =============================================================================
// SHIPPING RATES API (OFFICIAL EGYPTIAN GOVERNORATES)
// =============================================================================

// GET /api/shipping-rates - Retrieve configured shipping rates
app.get("/api/shipping-rates", (req, res) => {
  const rates = getShippingRatesFromDisk();
  if (req.query.active === "true") {
    return res.json(rates.filter((r) => r.is_active));
  }
  return res.json(rates);
});

// GET /api/shipping-rates/calculate - Calculate shipping rate for a governorate
app.get("/api/shipping-rates/calculate", (req, res) => {
  const rawGov = String(req.query.governorate || req.query.gov || "").trim();
  if (!rawGov) {
    return res.status(400).json({ error: "Governorate query parameter is required" });
  }

  const govId = normalizeGovernorateId(rawGov);
  if (!govId) {
    return res.status(400).json({ 
      error: "Unknown governorate", 
      message: "Unrecognized Egyptian governorate." 
    });
  }

  const rates = getShippingRatesFromDisk();
  const matched = rates.find((r) => r.id === govId);
  if (!matched) {
    return res.status(400).json({ error: "Unknown governorate" });
  }

  if (!matched.is_active) {
    return res.status(400).json({ 
      error: "Governorate has no active shipping rate", 
      message: `Shipping is currently unavailable for ${matched.governorate}.`,
      governorate: matched.governorate,
      governorate_ar: matched.governorate_ar,
      is_active: false
    });
  }

  return res.json({
    id: matched.id,
    governorate: matched.governorate,
    governorate_ar: matched.governorate_ar,
    rate: Number(matched.rate),
    is_active: true
  });
});

// PUT /api/shipping-rates/:id - Admin update shipping rate & status (enforcing max 90 EGP limit)
app.put("/api/shipping-rates/:id", requireAdmin, async (req: any, res: any) => {
  const rawId = req.params.id;
  const govId = normalizeGovernorateId(rawId) || rawId.trim().toLowerCase();

  const rates = getShippingRatesFromDisk();
  const index = rates.findIndex((r) => r.id === govId);
  if (index === -1) {
    return res.status(404).json({ error: "Governorate not found" });
  }

  const { rate, is_active } = req.body;

  if (rate !== undefined) {
    const numRate = Number(rate);
    if (isNaN(numRate)) {
      return res.status(400).json({ error: "Invalid rate. Rate must be a number." });
    }
    if (numRate < 0) {
      return res.status(400).json({ error: "Shipping rate cannot be negative." });
    }
    if (numRate > 90) {
      return res.status(400).json({ error: "Maximum shipping rate is 90 EGP." });
    }
    rates[index].rate = numRate;
  }

  if (is_active !== undefined) {
    rates[index].is_active = Boolean(is_active);
  }

  rates[index].updated_at = new Date().toISOString();
  saveShippingRatesToDisk(rates);

  // Sync to Supabase if connected
  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("shipping_rates").upsert({
        id: rates[index].id,
        governorate: rates[index].governorate,
        governorate_ar: rates[index].governorate_ar,
        rate: rates[index].rate,
        is_active: rates[index].is_active,
        updated_at: rates[index].updated_at
      });
    } catch (dbErr) {
      console.warn("[Shipping API] Supabase upsert error:", dbErr);
    }
  }

  broadcastUpdate();
  return res.json({ success: true, rate: rates[index] });
});

// 4. UPDATE ORDER INDEPENDENT STATUSES (Payment, Fulfillment, Shipping, General Status)
app.put(["/api/orders/:id/status", "/api/orders/:id"], requireAdmin, async (req: any, res: any) => {
  const orderId = req.params.id;
  const { paymentStatus, fulfillmentStatus, shippingStatus, status, courier, trackingNumber } = req.body;
  const adminName = req.user?.name || req.user?.email || "Admin";

  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
  const supabase = getSupabase();
  let currentOrder: any = null;

  if (supabase) {
    try {
      const { data } = await supabase.from("orders").select("*").or(`id.eq.${orderId},order_number.eq.${orderId}`).maybeSingle();
      if (data) currentOrder = data;
    } catch (e) {}
  }
  if (!currentOrder) {
    const diskOrders = getOrdersFromDisk();
    currentOrder = diskOrders.find((o) => o.id === orderId || o.orderNumber === orderId || o.order_number === orderId);
  }

  if (!currentOrder) {
    return res.status(404).json({ error: "Order not found" });
  }

  const updateFields: any = { updated_at: new Date().toISOString() };
  if (paymentStatus) updateFields.payment_status = paymentStatus;
  if (fulfillmentStatus) updateFields.fulfillment_status = fulfillmentStatus;
  if (shippingStatus) updateFields.shipping_status = shippingStatus;
  if (status) updateFields.status = status;
  if (courier) updateFields.courier = courier;
  if (trackingNumber) updateFields.tracking_number = trackingNumber;

  // Persist to Supabase
  if (supabase) {
    try {
      await supabase.from("orders").update(updateFields).or(`id.eq.${orderId},order_number.eq.${orderId}`);
    } catch (e) {}
  }

  // Persist to Disk
  const updatedDiskOrder = { ...currentOrder, ...updateFields, id: currentOrder.id || orderId };
  saveOrderToDisk(updatedDiskOrder);

  // Add Timeline Event
  const statusDetails = [];
  if (paymentStatus) statusDetails.push(`Payment: ${paymentStatus}`);
  if (fulfillmentStatus) statusDetails.push(`Fulfillment: ${fulfillmentStatus}`);
  if (shippingStatus) statusDetails.push(`Shipping: ${shippingStatus}`);
  if (status) statusDetails.push(`Status: ${status}`);

  recordOrderTimelineEvent(currentOrder.id || orderId, {
    type: "tracking_updated",
    title: "Order Status Updated",
    description: `Updated by ${adminName} (${statusDetails.join(", ")})`,
    performedBy: adminName,
    actorRole: "admin"
  });

  // Notify Customer
  const customerEmail = currentOrder.email || currentOrder.user_id || currentOrder.shippingEmail;
  if (customerEmail) {
    const orderNum = currentOrder.order_number || currentOrder.orderNumber || orderId;
    const notifItem = {
      id: `notif-${Date.now()}`,
      user_id: customerEmail,
      order_id: currentOrder.id || orderId,
      title: `تحديث طلبك #${orderNum} / Order Update`,
      message: `تم تحديث حالة طلبك #${orderNum}: ${statusDetails.join(" | ")}`,
      type: "order_update",
      is_read: false,
      read: false,
      created_at: new Date().toISOString()
    };
    saveNotificationToDisk(notifItem);
  }

  broadcastUpdate();
  res.json(enrichOrderPayload(updatedDiskOrder, currentOrder.items || []));
});

// 5. FULFILL & DISPATCH ORDER (Automatic stock deduction On Hand -= qty, Committed -= qty)
app.post("/api/orders/:id/fulfill", requireAdmin, async (req: any, res: any) => {
  const orderId = req.params.id;
  const { courier = "Aramex", trackingNumber = "", items } = req.body;
  const adminName = req.user?.name || req.user?.email || "Admin";
  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;

  let currentOrder: any = null;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data } = await supabase.from("orders").select("*").or(`id.eq.${orderId},order_number.eq.${orderId}`).maybeSingle();
      if (data) currentOrder = data;
    } catch (e) {}
  }
  if (!currentOrder) {
    const diskOrders = getOrdersFromDisk();
    currentOrder = diskOrders.find((o) => o.id === orderId || o.orderNumber === orderId || o.order_number === orderId);
  }

  if (!currentOrder) {
    return res.status(404).json({ error: "Order not found" });
  }

  // 1. Perform stock deduction (On Hand -= qty, Committed -= qty) and record transaction
  const fulfillmentRecord = fulfillInventoryForOrder(
    currentOrder,
    courier,
    trackingNumber,
    adminName,
    allProducts
  );

  // 2. Update Order Statuses
  const updatedData = {
    ...currentOrder,
    fulfillment_status: "fulfilled",
    fulfillmentStatus: "fulfilled",
    shipping_status: "shipped",
    shippingStatus: "shipped",
    status: "Shipped",
    courier,
    tracking_number: fulfillmentRecord.trackingNumber,
    tracking_url: fulfillmentRecord.trackingUrl,
    shipment_date: fulfillmentRecord.shippedAt,
    updated_at: new Date().toISOString()
  };

  if (supabase) {
    try {
      await supabase.from("orders").update({
        fulfillment_status: "fulfilled",
        shipping_status: "shipped",
        status: "Shipped",
        courier,
        tracking_number: fulfillmentRecord.trackingNumber,
        tracking_url: fulfillmentRecord.trackingUrl,
        shipment_date: fulfillmentRecord.shippedAt,
        updated_at: new Date().toISOString()
      }).or(`id.eq.${orderId},order_number.eq.${orderId}`);
    } catch (e) {}
  }

  saveOrderToDisk(updatedData);

  // 3. Customer Notification
  const customerEmail = currentOrder.email || currentOrder.user_id || currentOrder.shippingEmail;
  if (customerEmail) {
    const orderNum = currentOrder.order_number || currentOrder.orderNumber || orderId;
    saveNotificationToDisk({
      id: `notif-${Date.now()}`,
      user_id: customerEmail,
      order_id: currentOrder.id || orderId,
      title: `تم شحن طلبك #${orderNum} 🚚 / Order Dispatched`,
      message: `طلبك #${orderNum} في الطريق إليك عبر ${courier} برقم التتبع: ${fulfillmentRecord.trackingNumber}`,
      type: "order_shipped",
      is_read: false,
      read: false,
      created_at: new Date().toISOString()
    });
  }

  broadcastUpdate();
  res.json({ success: true, fulfillment: fulfillmentRecord, order: enrichOrderPayload(updatedData, currentOrder.items || []) });
});

// 6. CANCEL ORDER (Automatic release of committed inventory)
app.post("/api/orders/:id/cancel", requireAdmin, async (req: any, res: any) => {
  const orderId = req.params.id;
  const { reason = "Customer request / Administrative cancellation" } = req.body;
  const adminName = req.user?.name || req.user?.email || "Admin";
  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;

  let currentOrder: any = null;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data } = await supabase.from("orders").select("*").or(`id.eq.${orderId},order_number.eq.${orderId}`).maybeSingle();
      if (data) currentOrder = data;
    } catch (e) {}
  }
  if (!currentOrder) {
    const diskOrders = getOrdersFromDisk();
    currentOrder = diskOrders.find((o) => o.id === orderId || o.orderNumber === orderId || o.order_number === orderId);
  }

  if (!currentOrder) {
    return res.status(404).json({ error: "Order not found" });
  }

  // 1. Release committed inventory (Committed -= qty, Available += qty)
  releaseInventoryForOrder(currentOrder, allProducts, adminName);

  // 2. Update Order status to Cancelled
  const updatedData = {
    ...currentOrder,
    fulfillment_status: "cancelled",
    fulfillmentStatus: "cancelled",
    status: "Cancelled",
    updated_at: new Date().toISOString()
  };

  if (supabase) {
    try {
      await supabase.from("orders").update({
        fulfillment_status: "cancelled",
        status: "Cancelled",
        updated_at: new Date().toISOString()
      }).or(`id.eq.${orderId},order_number.eq.${orderId}`);
    } catch (e) {}
  }

  saveOrderToDisk(updatedData);

  broadcastUpdate();
  res.json({ success: true, order: enrichOrderPayload(updatedData, currentOrder.items || []) });
});

// 7. ISSUE REFUND (Financial tracking, DOES NOT touch inventory unless separate return restock occurs)
app.post("/api/orders/:id/refund", requireAdmin, async (req: any, res: any) => {
  const orderId = req.params.id;
  const { amount, reason = "Customer Satisfaction", paymentMethod = "Original Payment Method", notes = "" } = req.body;
  const adminName = req.user?.name || req.user?.email || "Admin";
  const refundAmount = Number(amount || 0);

  if (refundAmount <= 0) {
    return res.status(400).json({ error: "Valid refund amount is required." });
  }

  let currentOrder: any = null;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data } = await supabase.from("orders").select("*").or(`id.eq.${orderId},order_number.eq.${orderId}`).maybeSingle();
      if (data) currentOrder = data;
    } catch (e) {}
  }
  if (!currentOrder) {
    const diskOrders = getOrdersFromDisk();
    currentOrder = diskOrders.find((o) => o.id === orderId || o.orderNumber === orderId || o.order_number === orderId);
  }

  if (!currentOrder) {
    return res.status(404).json({ error: "Order not found" });
  }

  const orderNum = currentOrder.order_number || currentOrder.orderNumber || orderId;
  const currentRefunded = Number(currentOrder.amount_refunded || currentOrder.amountRefunded || 0);
  const totalOrderAmount = Number(currentOrder.total || 0);
  const newRefundedTotal = currentRefunded + refundAmount;
  const isFullRefund = newRefundedTotal >= totalOrderAmount;
  const newPaymentStatus: PaymentStatus = isFullRefund ? "refunded" : "partially_refunded";

  const refundRecord: any = {
    id: `ref-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    orderId: currentOrder.id || orderId,
    orderNumber: String(orderNum),
    amount: refundAmount,
    reason,
    paymentMethod,
    type: isFullRefund ? "full" : "partial",
    issuedBy: adminName,
    issuedAt: new Date().toISOString(),
    notes
  };

  // 1. Save Refund Record
  saveOrderRefund(refundRecord);

  // 2. Add Timeline Event
  recordOrderTimelineEvent(currentOrder.id || orderId, {
    type: "refund_issued",
    title: `Refund Issued ($${refundAmount.toLocaleString()})`,
    description: `${isFullRefund ? "Full" : "Partial"} refund of $${refundAmount.toLocaleString()} processed via ${paymentMethod}. Reason: ${reason}`,
    performedBy: adminName,
    actorRole: "admin",
    metadata: { refundId: refundRecord.id, amount: refundAmount }
  });

  // 3. Update Order Payment Status
  const updatedOrder = {
    ...currentOrder,
    payment_status: newPaymentStatus,
    paymentStatus: newPaymentStatus,
    amount_refunded: newRefundedTotal,
    amountRefunded: newRefundedTotal,
    updated_at: new Date().toISOString()
  };

  if (supabase) {
    try {
      await supabase.from("orders").update({
        payment_status: newPaymentStatus,
        amount_refunded: newRefundedTotal,
        updated_at: new Date().toISOString()
      }).or(`id.eq.${orderId},order_number.eq.${orderId}`);

      await supabase.from("order_refunds").insert([{
        id: refundRecord.id,
        order_id: currentOrder.id || orderId,
        order_number: String(orderNum),
        amount: refundAmount,
        reason,
        payment_method: paymentMethod,
        type: refundRecord.type,
        issued_by: adminName,
        issued_at: refundRecord.issuedAt,
        notes
      }]);
    } catch (e) {}
  }

  saveOrderToDisk(updatedOrder);

  // 4. Customer Notification
  const customerEmail = currentOrder.email || currentOrder.user_id || currentOrder.shippingEmail;
  if (customerEmail) {
    saveNotificationToDisk({
      id: `notif-${Date.now()}`,
      user_id: customerEmail,
      order_id: currentOrder.id || orderId,
      title: `استرداد مالي للطلب #${orderNum} / Refund Processed`,
      message: `تم إصدار استرداد مالي بقيمة $${refundAmount.toLocaleString()} لطلبك #${orderNum}.`,
      type: "order_refund",
      is_read: false,
      read: false,
      created_at: new Date().toISOString()
    });
  }

  broadcastUpdate();
  res.json({ success: true, refund: refundRecord, order: enrichOrderPayload(updatedOrder, currentOrder.items || []) });
});

// 8. CREATE RETURN REQUEST (RMA)
app.post("/api/orders/:id/returns", requireAdmin, async (req: any, res: any) => {
  const orderId = req.params.id;
  const { items = [], reason = "Exchange/Return", notes = "" } = req.body;
  const adminName = req.user?.name || req.user?.email || "Admin";

  let currentOrder: any = null;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data } = await supabase.from("orders").select("*").or(`id.eq.${orderId},order_number.eq.${orderId}`).maybeSingle();
      if (data) currentOrder = data;
    } catch (e) {}
  }
  if (!currentOrder) {
    const diskOrders = getOrdersFromDisk();
    currentOrder = diskOrders.find((o) => o.id === orderId || o.orderNumber === orderId || o.order_number === orderId);
  }

  if (!currentOrder) {
    return res.status(404).json({ error: "Order not found" });
  }

  const orderNum = currentOrder.order_number || currentOrder.orderNumber || orderId;
  const returnRecord: any = {
    id: `ret-${Date.now().toString().slice(-6)}`,
    orderId: currentOrder.id || orderId,
    orderNumber: String(orderNum),
    customerName: currentOrder.shipping_name || currentOrder.shippingName || "Valued Client",
    customerEmail: currentOrder.email || currentOrder.user_id || "customer@vero.com",
    status: "requested",
    reason,
    items,
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes
  };

  saveOrderReturn(returnRecord);

  recordOrderTimelineEvent(currentOrder.id || orderId, {
    type: "return_requested",
    title: `Return Requested (RMA #${returnRecord.id})`,
    description: `Return RMA requested for ${items.length} item(s). Reason: ${reason}`,
    performedBy: adminName,
    actorRole: "admin"
  });

  if (supabase) {
    try {
      await supabase.from("order_returns").insert([{
        id: returnRecord.id,
        order_id: currentOrder.id || orderId,
        order_number: String(orderNum),
        customer_name: returnRecord.customerName,
        customer_email: returnRecord.customerEmail,
        status: "requested",
        reason,
        items,
        requested_at: returnRecord.requestedAt,
        notes
      }]);
    } catch (e) {}
  }

  broadcastUpdate();
  res.json({ success: true, return: returnRecord });
});

// 9. GET ALL RETURNS
app.get("/api/returns", requireAdmin, async (req: any, res: any) => {
  const returns = getOrderReturns();
  res.json(returns);
});

// 10. UPDATE RETURN STATUS (with optional restock trigger)
app.put("/api/returns/:id/status", requireAdmin, async (req: any, res: any) => {
  const returnId = req.params.id;
  const { status: newStatus, restock = false } = req.body;
  const adminName = req.user?.name || req.user?.email || "Admin";
  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;

  const returns = getOrderReturns();
  const returnItem = returns.find((r) => r.id === returnId);

  if (!returnItem) {
    return res.status(404).json({ error: "Return request not found" });
  }

  returnItem.status = newStatus;
  returnItem.updatedAt = new Date().toISOString();

  // If restock is triggered, increase On Hand & Available and record transaction
  if ((newStatus === "restocked" || restock) && returnItem.items && returnItem.items.length > 0) {
    returnItem.items.forEach((item: any) => {
      restockReturnedItem(returnItem, item.productId, Number(item.quantity || 1), adminName, allProducts);
    });
  }

  saveOrderReturn(returnItem);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("order_returns").update({
        status: newStatus,
        updated_at: new Date().toISOString(),
        restocked_by: newStatus === "restocked" ? adminName : undefined
      }).eq("id", returnId);
    } catch (e) {}
  }

  broadcastUpdate();
  res.json({ success: true, return: returnItem });
});

// 11. ADD CUSTOM ORDER TIMELINE EVENT / INTERNAL NOTE
app.post("/api/orders/:id/timeline", requireAdmin, async (req: any, res: any) => {
  const orderId = req.params.id;
  const { title = "Internal Note", description = "", type = "note_added" } = req.body;
  const adminName = req.user?.name || req.user?.email || "Admin";

  const event = recordOrderTimelineEvent(orderId, {
    type,
    title,
    description,
    performedBy: adminName,
    actorRole: "admin"
  });

  broadcastUpdate();
  res.json({ success: true, event });
});

// -----------------------------------------------------------------------------
// INVENTORY ENDPOINTS
// -----------------------------------------------------------------------------

// 12. GET INVENTORY ITEMS (with multi-tier stock: On Hand, Committed, Available, Unavailable, Threshold, Value)
app.get("/api/inventory", async (req: any, res: any) => {
  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
  const items = getInventoryItems(allProducts);
  res.json(items);
});

// 13. GET INVENTORY TRANSACTIONS LOG
app.get("/api/inventory/transactions", requireAdmin, async (req: any, res: any) => {
  const transactions = getInventoryTransactions();
  res.json(transactions);
});

// 14. MANUAL INVENTORY ADJUSTMENT (Traceable with Reason & Admin Logging)
app.post("/api/inventory/adjust", requireAdmin, async (req: any, res: any) => {
  const { productId, sku, adjustmentQuantity, adjustmentType = "Stock Received", reason, notes = "" } = req.body;
  const adminName = req.user?.name || req.user?.email || "Administrator";

  if (!productId && !sku) {
    return res.status(400).json({ error: "Product ID or SKU is required for stock adjustment." });
  }

  if (adjustmentQuantity === undefined || Number(adjustmentQuantity) === 0) {
    return res.status(400).json({ error: "Non-zero adjustment quantity is required." });
  }

  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: "A clear adjustment reason must be specified." });
  }

  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
  const result = adjustManualInventoryStock(
    productId,
    sku,
    Number(adjustmentQuantity),
    adjustmentType,
    reason,
    adminName,
    notes,
    allProducts
  );

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  // Also update product in products-db and memory
  if (result.updatedItem) {
    const prodIdx = allProducts.findIndex((p) => p.id === result.updatedItem!.productId);
    if (prodIdx >= 0) {
      allProducts[prodIdx].stock = result.updatedItem.onHand;
      saveProductsToDisk(allProducts);
    }
  }

  // Log in Audit Logs
  logAuditEvent(
    req.user?.userId || "admin",
    req.user?.email || "admin@vero.com",
    "Manual Stock Adjustment",
    `Inventory Item: ${result.updatedItem?.productName} (SKU: ${result.updatedItem?.sku})`,
    `${adjustmentType} (${adjustmentQuantity >= 0 ? "+" : ""}${adjustmentQuantity}): ${reason}`,
    req.ip || "Internal"
  );

  broadcastUpdate();
  res.json({ success: true, updatedItem: result.updatedItem, transaction: result.transaction });
});

// 15. GET EXECUTIVE INVENTORY KPIS
app.get("/api/inventory/kpis", requireAdmin, async (req: any, res: any) => {
  const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
  const kpis = computeInventoryKPIs(allProducts);
  res.json(kpis);
});

// DELETE ORDER ENDPOINT
app.delete("/api/orders/:id", requireAdmin, async (req: any, res: any) => {
  const orderId = req.params.id;

  await dbWriteLogAndExecute("orders", "Delete Order", req, res, async () => {
    const supabase = getSupabase()!;
    await supabase.from("order_items").delete().eq("order_id", orderId);
    return await supabase.from("orders").delete().eq("id", orderId);
  });

  if (res.headersSent) return;
  broadcastUpdate();
  res.json({ success: true, deletedId: orderId });
});

// REVIEWS ENDPOINTS
app.get("/api/reviews", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Database client is not configured." });

  const { data: dbReviews, error } = await supabase.from("reviews").select("*").order("created_at", { ascending: false });
  if (error) {
    console.error("[Database Fetch Error] /api/reviews:", error);
    return res.status(500).json({ error: error.message, details: error.details, code: error.code });
  }

  const { data: replies } = await supabase.from("review_replies").select("*");
  const repliesMap: Record<string, any> = {};
  if (replies) {
    replies.forEach((rep: any) => {
      repliesMap[rep.review_id] = { author: rep.author_name, comment: rep.comment };
    });
  }

  const mapped = (dbReviews || []).map((r: any) => ({
    id: r.id,
    productId: r.product_id,
    userName: r.user_name || "Customer",
    userEmail: r.user_email || "",
    userAvatar: r.user_avatar || "default",
    rating: Number(r.rating),
    title: r.title || "",
    comment: r.comment || r.review || "",
    review: r.review || r.comment || "",
    helpfulCount: Number(r.helpful_count || 0),
    verifiedPurchase: !!r.verified_purchase,
    status: r.status || "approved",
    createdAt: r.created_at,
    author: r.user_name || "Customer",
    reply: repliesMap[r.id] || null
  }));

  return res.json(mapped);
});

app.post("/api/reviews", requireAuth, async (req: any, res: any) => {
  const newReview = req.body;
  const reviewId = newReview.id || `rev-${Date.now()}`;

  const data = await dbWriteLogAndExecute("reviews", "Create Review", req, res, async () => {
    const supabase = getSupabase()!;
    return await supabase.from("reviews").upsert([
      {
        id: reviewId,
        product_id: newReview.productId,
        user_name: newReview.userName || req.user?.name || "Customer",
        user_email: newReview.userEmail || req.user?.email || "customer@vero.com",
        user_avatar: newReview.avatar || "default",
        rating: Number(newReview.rating),
        title: newReview.title || "",
        comment: newReview.comment || newReview.review || newReview.content || "",
        helpful_count: 0,
        verified_purchase: !!newReview.verifiedPurchase,
        status: "approved"
      }
    ], { onConflict: "id" }).select().maybeSingle();
  });

  if (res.headersSent) return;
  broadcastUpdate();
  res.json(data);
});

app.post("/api/reviews/:id/reply", requireAdmin, async (req: any, res: any) => {
  const reviewId = req.params.id;
  const { authorName, comment, reply } = req.body;

  const data = await dbWriteLogAndExecute("review_replies", "Add Review Reply", req, res, async () => {
    const supabase = getSupabase()!;
    return await supabase.from("review_replies").upsert([
      {
        id: crypto.randomUUID(),
        review_id: reviewId,
        author_name: authorName || "VERO Executive",
        comment: comment || reply || ""
      }
    ]).select().maybeSingle();
  });

  if (res.headersSent) return;
  broadcastUpdate();
  res.json(data);
});

app.put("/api/reviews/:id", requireAdmin, async (req: any, res: any) => {
  const reviewId = req.params.id;
  const { status, title, comment, review, rating } = req.body;
  const updates: any = {};
  if (status) updates.status = status;
  if (title) updates.title = title;
  if (comment || review) updates.comment = comment || review;
  if (rating !== undefined) updates.rating = Number(rating);

  const data = await dbWriteLogAndExecute("reviews", "Update Review", req, res, async () => {
    const supabase = getSupabase()!;
    return await supabase.from("reviews").update(updates).eq("id", reviewId).select().maybeSingle();
  });

  if (res.headersSent) return;
  broadcastUpdate();
  res.json(data);
});

app.post("/api/reviews/:id/helpful", async (req: any, res: any) => {
  const reviewId = req.params.id;
  const supabase = getSupabase();
  if (supabase) {
    const { data: rev } = await supabase.from("reviews").select("helpful_count").eq("id", reviewId).maybeSingle();
    const currentCount = rev?.helpful_count || 0;
    await supabase.from("reviews").update({ helpful_count: currentCount + 1 }).eq("id", reviewId);
  }
  broadcastUpdate();
  res.json({ success: true });
});

app.post("/api/reviews/:id/report", async (req: any, res: any) => {
  const reviewId = req.params.id;
  const { userId, userName, reason } = req.body;
  const supabase = getSupabase();
  if (supabase) {
    await supabase.from("review_reports").insert([{
      id: crypto.randomUUID(),
      review_id: reviewId,
      reporter_email: userId || "anon",
      reporter_name: userName || "Customer",
      reason: reason || "Flagged content"
    }]);
  }
  res.json({ success: true });
});

app.delete("/api/reviews/:id", requireAuth, async (req: any, res: any) => {
  const reviewId = req.params.id;
  const user = req.user;
  const supabase = getSupabase();

  if (supabase) {
    const { data: targetReview } = await supabase.from("reviews").select("*").eq("id", reviewId).maybeSingle();
    if (targetReview) {
      const isAdmin = user?.role === "admin";
      const isOwner = user && (
        targetReview.user_id === user.userId ||
        targetReview.user_id === user.email ||
        (user.email && targetReview.user_email?.toLowerCase() === user.email.toLowerCase())
      );

      if (!isAdmin && !isOwner) {
        return res.status(403).json({
          error: "عفواً، لا يمكنك حذف هذا التقييم. يُسمح فقط لصاحب التقييم أو أدمن النظام بحذفه. / Forbidden: Only the review author or an admin can delete this review."
        });
      }
    }
  }

  await dbWriteLogAndExecute("reviews", "Delete Review", req, res, async () => {
    const sb = getSupabase()!;
    try { await sb.from("review_images").delete().eq("review_id", reviewId); } catch {}
    try { await sb.from("review_votes").delete().eq("review_id", reviewId); } catch {}
    await sb.from("review_reports").delete().eq("review_id", reviewId);
    await sb.from("review_replies").delete().eq("review_id", reviewId);
    return await sb.from("reviews").delete().eq("id", reviewId);
  });

  if (res.headersSent) return;
  broadcastUpdate();
  res.json({ success: true, deletedId: reviewId });
});

app.delete("/api/reviews/:id/reply", requireAdmin, async (req: any, res: any) => {
  const reviewId = req.params.id;

  await dbWriteLogAndExecute("review_replies", "Delete Review Reply", req, res, async () => {
    const sb = getSupabase()!;
    return await sb.from("review_replies").delete().eq("review_id", reviewId);
  });

  if (res.headersSent) return;
  broadcastUpdate();
  res.json({ success: true, reviewId });
});

// REWARDS ENDPOINTS
let memoryRewards = [
  {
    id: "rew-1",
    title: "خصم 10% على أي قطعة",
    titleEn: "10% Off Any Piece",
    cost: 500,
    code: "VERO10POINTS",
    description: "استبدل 500 نقطة ولاء بخصم 10% على مشترياتك القادمة",
    descriptionEn: "Redeem 500 loyalty points for 10% off your next purchase",
    discountPercent: 10
  },
  {
    id: "rew-2",
    title: "خصم 20% لكبار العملاء VIP",
    titleEn: "20% VIP Exclusive Discount",
    cost: 1000,
    code: "VEROVIP20",
    description: "استبدل 1000 نقطة للحصول على خصم 20% حصري",
    descriptionEn: "Redeem 1000 points for an exclusive 20% VIP discount",
    discountPercent: 20
  }
];

app.get("/api/rewards", (req, res) => {
  res.json(memoryRewards);
});

app.post("/api/rewards", requireAdmin, (req, res) => {
  const newReward = {
    id: `rew-${Date.now()}`,
    ...req.body
  };
  memoryRewards.push(newReward);
  broadcastUpdate();
  res.json(memoryRewards);
});

app.delete("/api/rewards/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  memoryRewards = memoryRewards.filter((r) => r.id !== id);
  broadcastUpdate();
  res.json(memoryRewards);
});

// PROMOS & COUPONS ENDPOINTS
app.get("/api/promos", async (req, res) => {
  const diskPromos = getPromosFromDisk();
  const allOrders = getOrdersFromDisk();

  // Reconcile each promo's usedCount with actual orders that redeemed it
  diskPromos.forEach((p) => {
    const matchingOrders = allOrders.filter((o: any) => {
      const c = (o.promoCode || o.promo || "").toString().trim().toUpperCase();
      return c && c === (p.code || "").toUpperCase();
    });
    const orderCount = matchingOrders.length;
    if (orderCount > (p.usedCount || 0)) {
      p.usedCount = orderCount;
      if (!Array.isArray(p.usedBy)) p.usedBy = [];
      matchingOrders.forEach((o: any) => {
        const entry = `${o.shippingEmail || o.email || "Customer"} (Order #${o.orderNumber || o.id})`;
        if (!p.usedBy.includes(entry)) {
          p.usedBy.push(entry);
        }
      });
    }
  });

  memoryPromos = diskPromos;

  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data: dbCoupons, error } = await supabase.from("coupons").select("*").order("created_at", { ascending: false });
      if (!error && dbCoupons && dbCoupons.length > 0) {
        const mapped = dbCoupons.map((c: any) => {
          const match = memoryPromos.find((p) => p.code === c.code || p.id === c.id);
          return {
            id: c.id || c.code,
            code: c.code,
            discountPercent: Number(c.discount_percent || c.discount || match?.discountPercent || 10),
            isActive: c.active !== false && c.is_active !== false,
            description: match?.description || `Save ${c.discount_percent}% on luxury catalog`,
            createdAt: match?.createdAt || c.created_at || new Date().toISOString(),
            validityDays: match?.validityDays ?? 30,
            maxUses: match?.maxUses ?? 100,
            usedCount: match?.usedCount ?? c.used_count ?? 0,
            usedBy: match?.usedBy || []
          };
        });
        memoryPromos = mapped;
        return res.json(mapped);
      }
    } catch (e) {
      // ignore
    }
  }

  return res.json(memoryPromos);
});

app.post("/api/promos", requireAdmin, async (req: any, res: any) => {
  const newPromo = req.body;
  const couponId = newPromo.id || `coupon-${Date.now()}`;
  const code = (newPromo.code || "SAVE10").toUpperCase().trim();
  const discountPercent = Number(newPromo.discountPercent || 10);
  const validityDays = Number(newPromo.validityDays ?? 30); // days from creation (0 = unlimited)
  const maxUses = Number(newPromo.maxUses ?? 50); // max user redemptions (0 = unlimited)
  const createdAt = newPromo.createdAt || new Date().toISOString();

  const newPromoObj = {
    id: couponId,
    code,
    discountPercent,
    isActive: newPromo.isActive !== false,
    description: newPromo.description || `Save ${discountPercent}% on luxury catalog`,
    createdAt,
    validityDays,
    maxUses,
    usedCount: Number(newPromo.usedCount || 0),
    usedBy: Array.isArray(newPromo.usedBy) ? newPromo.usedBy : []
  };

  memoryPromos = [newPromoObj, ...memoryPromos.filter((p) => p.id !== couponId && p.code !== code)];
  savePromosToDisk(memoryPromos);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("coupons").upsert([
        {
          id: couponId,
          code,
          discount_percent: discountPercent,
          active: newPromo.isActive !== false
        }
      ], { onConflict: "id" });
    } catch (e) {
      // ignore
    }
  }

  broadcastUpdate();
  res.json(memoryPromos);
});

app.delete("/api/promos/:id", requireAdmin, async (req: any, res: any) => {
  const promoId = req.params.id;

  memoryPromos = memoryPromos.filter((p) => p.id !== promoId && p.code !== promoId);
  savePromosToDisk(memoryPromos);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("coupons").delete().eq("id", promoId);
    } catch (e) {
      // ignore
    }
  }

  broadcastUpdate();
  res.json(memoryPromos);
});

// USERS MANAGEMENT ENDPOINTS
app.get("/api/users", requireAdmin, async (req, res) => {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data: dbUsers, error } = await supabase.from("users").select("*").order("created_at", { ascending: false });
      if (!error && dbUsers && dbUsers.length > 0) {
        const mapped = dbUsers.map((u: any) => ({
          id: u.id,
          name: u.name || u.email?.split("@")[0] || "Client",
          email: u.email,
          avatar: u.avatar || "default",
          role: u.role || (isVeroAdminEmail(u.email) ? "admin" : "customer"),
          tier: u.tier || "Bronze",
          loyaltyPoints: u.loyalty_points ?? 0,
          totalSpent: Number(u.total_spent ?? 0),
          joinedDate: u.created_at ? new Date(u.created_at).toISOString().split("T")[0] : new Date().toISOString().split("T")[0]
        }));
        return res.json(mapped);
      }
    } catch (e) {
      console.warn("[Supabase Fetch Warning] /api/users, falling back to disk:", e);
    }
  }

  const diskUsers = getUsersFromDisk();
  return res.json(diskUsers);
});

app.post("/api/users", requireAdmin, async (req: any, res: any) => {
  const newUser = req.body;
  if (!newUser.email) return res.status(400).json({ error: "Email is required." });

  const cleanEmail = newUser.email.trim().toLowerCase();
  const diskUsers = getUsersFromDisk();
  let authUserId = newUser.id || `usr-${Date.now()}`;
  
  const existingIdx = diskUsers.findIndex((u: any) => u.email?.toLowerCase() === cleanEmail || u.id === authUserId);
  const userObj = {
    id: authUserId,
    email: cleanEmail,
    name: newUser.name || cleanEmail.split("@")[0],
    avatar: newUser.avatar || "default",
    role: newUser.role || (isVeroAdminEmail(cleanEmail) ? "admin" : "customer"),
    tier: newUser.tier || "Bronze",
    loyaltyPoints: Number(newUser.loyaltyPoints ?? 250),
    totalSpent: Number(newUser.totalSpent ?? 0),
    joinedDate: new Date().toISOString().split("T")[0]
  };

  if (existingIdx >= 0) {
    diskUsers[existingIdx] = { ...diskUsers[existingIdx], ...userObj };
  } else {
    diskUsers.unshift(userObj);
  }
  saveUsersToDisk(diskUsers);
  registerOrUpdateLocalCredential(userObj.id, cleanEmail, userObj.name, userObj.role, newUser.password);

  const supabase = getSupabase();
  if (supabase) {
    try {
      const salt = generateSalt();
      const pwdHash = hashPassword(newUser.password || "VeroDefault2026!", salt);
      await supabase.from("users").upsert([{
        id: userObj.id,
        email: cleanEmail,
        name: userObj.name,
        avatar: userObj.avatar,
        role: userObj.role,
        tier: userObj.tier,
        loyalty_points: userObj.loyaltyPoints,
        total_spent: userObj.totalSpent,
        password_hash: pwdHash,
        salt: salt,
      }], { onConflict: "id" });
    } catch (e) {
      console.warn("PostgreSQL user creation sync notice:", e);
    }
  }

  broadcastUpdate();
  res.json(userObj);
});

app.put("/api/users/:id", requireAuth, async (req: any, res: any) => {
  const userId = req.params.id;
  const updates = req.body;

  const diskUsers = getUsersFromDisk();
  const targetIdx = diskUsers.findIndex((u: any) => u.id === userId || u.email?.toLowerCase() === userId.toLowerCase());
  
  let targetUser = targetIdx >= 0 ? { ...diskUsers[targetIdx] } : {
    id: userId,
    email: userId.includes("@") ? userId : `${userId}@example.com`,
    name: userId.split("@")[0],
    role: "customer",
    tier: "Bronze",
    loyaltyPoints: 250,
    totalSpent: 0,
    avatar: "default",
    joinedDate: new Date().toISOString().split("T")[0]
  };

  const prevPoints = Number(targetUser.loyaltyPoints ?? targetUser.loyalty_points ?? 250);
  const targetPoints = updates.loyaltyPoints !== undefined ? Number(updates.loyaltyPoints) : prevPoints;
  const prevSpent = Number(targetUser.totalSpent ?? targetUser.total_spent ?? 0);
  const targetSpent = updates.totalSpent !== undefined ? Number(updates.totalSpent) : prevSpent;
  const targetTier = updates.tier || getTierFromSpent(targetSpent);

  targetUser = {
    ...targetUser,
    ...(updates.name ? { name: updates.name } : {}),
    ...(updates.avatar ? { avatar: updates.avatar } : {}),
    ...(updates.role ? { role: updates.role } : {}),
    loyaltyPoints: targetPoints,
    totalSpent: targetSpent,
    tier: targetTier
  };

  if (targetIdx >= 0) {
    diskUsers[targetIdx] = targetUser;
  } else {
    diskUsers.push(targetUser);
  }
  saveUsersToDisk(diskUsers);

  const pointDiff = targetPoints - prevPoints;
  if (pointDiff !== 0) {
    await recordLoyaltyPointsTransaction(
      targetUser.id,
      pointDiff,
      pointDiff >= 0 ? "adjustment" : "deduction",
      `تعديل رصيد النقاط من لوحة الإدارة / Admin Points Adjustment (${pointDiff >= 0 ? "+" : ""}${pointDiff} PTS)`
    );
  }

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("users").upsert([{
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        avatar: targetUser.avatar,
        role: targetUser.role,
        tier: targetUser.tier,
        loyalty_points: targetUser.loyaltyPoints,
        total_spent: targetUser.totalSpent
      }], { onConflict: "id" });
    } catch (e) {
      console.warn("Supabase user update notice:", e);
    }
  }

  broadcastUpdate();
  res.json(targetUser);
});

// BULK LOYALTY POINTS GRANT ENDPOINT
app.post("/api/loyalty/bulk-grant", requireAdmin, async (req: any, res: any) => {
  const { points, reason, targetTier } = req.body;
  const pointsToAdd = Number(points);
  if (!pointsToAdd || isNaN(pointsToAdd)) {
    return res.status(400).json({ error: "Invalid points amount specified." });
  }

  const diskUsers = getUsersFromDisk();
  let updatedCount = 0;

  for (let i = 0; i < diskUsers.length; i++) {
    const u = diskUsers[i];
    if (targetTier && targetTier !== "all" && u.tier !== targetTier) {
      continue;
    }
    const currentPts = Number(u.loyaltyPoints ?? u.loyalty_points ?? 250);
    const newPts = Math.max(0, currentPts + pointsToAdd);
    diskUsers[i].loyaltyPoints = newPts;

    await recordLoyaltyPointsTransaction(
      u.id,
      pointsToAdd,
      pointsToAdd >= 0 ? "earned" : "deduction",
      reason || `منحة نقاط جماعية من الإدارة / Bulk Points Grant (${pointsToAdd >= 0 ? "+" : ""}${pointsToAdd} PTS)`,
      reason || "منحة نقاط جماعية",
      "BULK-GRANT",
      req.user?.email || "Admin Executive"
    );
    updatedCount++;
  }
  saveUsersToDisk(diskUsers);

  const supabase = getSupabase();
  if (supabase) {
    try {
      let query = supabase.from("users").select("*");
      if (targetTier && targetTier !== "all") {
        query = query.eq("tier", targetTier);
      }
      const { data: users } = await query;
      if (users && users.length > 0) {
        for (const u of users) {
          const currentPts = Number(u.loyalty_points ?? 250);
          const newPts = Math.max(0, currentPts + pointsToAdd);
          await supabase.from("users").update({ loyalty_points: newPts }).eq("id", u.id);
        }
      }
    } catch (err: any) {
      console.warn("[Bulk Grant Supabase Warning]:", err);
    }
  }

  logAuditEvent(
    req.user?.userId || "admin-exec",
    req.user?.email || "admin@vero.com",
    "Bulk Loyalty Points Grant",
    `Target: ${targetTier || "All Users"}`,
    `Granted ${pointsToAdd >= 0 ? "+" : ""}${pointsToAdd} PTS to ${updatedCount} users. Reason: ${reason || "N/A"}`,
    req.socket.remoteAddress || "127.0.0.1"
  );

  broadcastUpdate();
  res.json({
    success: true,
    count: updatedCount,
    pointsGranted: pointsToAdd,
    targetTier: targetTier || "all",
    message: `تم منح ${pointsToAdd} نقطة لـ ${updatedCount} مستخدم بنجاح.`
  });
});

// GET /api/loyalty/transactions - Global & Filtered Points History for Admin
app.get("/api/loyalty/transactions", requireAdmin, async (req: any, res: any) => {
  const page = Math.max(1, parseInt(req.query.page as string || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string || "30", 10)));
  const search = (req.query.search as string || "").toLowerCase().trim();
  const typeFilter = (req.query.type as string || "all").toLowerCase().trim();
  const userIdFilter = (req.query.userId as string || "").trim();
  const dateRange = (req.query.dateRange as string || "all").trim();

  const supabase = getSupabase();
  const diskTxs = getLoyaltyTransactionsFromDisk();

  try {
    let combinedTxs: any[] = [...diskTxs];

    // Also fetch any recorded in Supabase table if available
    if (supabase) {
      const { data: dbPoints } = await supabase
        .from("loyalty_points")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);

      if (dbPoints && dbPoints.length > 0) {
        const { data: users } = await supabase.from("users").select("id, name, email, avatar, tier");
        const userMap = new Map<string, any>((users || []).map((u: any) => [u.id, u]));

        for (const dp of dbPoints) {
          if (!combinedTxs.some((tx) => tx.id === dp.id)) {
            const u: any = userMap.get(dp.user_id) || {};
            const p = Number(dp.points);
            const inferredType = dp.type || (p > 0 ? (dp.description?.includes("طلب") || dp.description?.includes("Order") ? "earned" : "adjustment") : "redeemed");
            combinedTxs.push({
              id: dp.id,
              userId: dp.user_id,
              userName: u.name || "Client",
              userEmail: u.email || `${dp.user_id}@client.vero`,
              userAvatar: u.avatar || "default",
              userTier: u.tier || "Bronze",
              points: p,
              type: inferredType,
              description: dp.description || "حركة نقاط",
              reason: inferredType === "earned" ? "نقاط مشتريات" : inferredType === "redeemed" ? "استرداد مكافأة" : "تعديل إداري",
              reference: "",
              performedBy: "System",
              createdAt: dp.created_at || new Date().toISOString()
            });
          }
        }
      }
    }

    // Sort descending by date
    combinedTxs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Apply Filters
    let filtered = combinedTxs.filter((tx) => {
      // User ID filter
      if (userIdFilter && tx.userId !== userIdFilter && tx.userEmail?.toLowerCase() !== userIdFilter.toLowerCase()) {
        return false;
      }

      // Type filter
      if (typeFilter && typeFilter !== "all" && tx.type !== typeFilter) {
        return false;
      }

      // Date range filter
      if (dateRange && dateRange !== "all") {
        const txTime = new Date(tx.createdAt).getTime();
        const now = Date.now();
        if (dateRange === "today" && now - txTime > 24 * 60 * 60 * 1000) return false;
        if (dateRange === "7d" && now - txTime > 7 * 24 * 60 * 60 * 1000) return false;
        if (dateRange === "30d" && now - txTime > 30 * 24 * 60 * 60 * 1000) return false;
      }

      // Search
      if (search) {
        const q = search;
        const matchName = tx.userName?.toLowerCase().includes(q);
        const matchEmail = tx.userEmail?.toLowerCase().includes(q);
        const matchDesc = tx.description?.toLowerCase().includes(q);
        const matchRef = tx.reference?.toLowerCase().includes(q);
        const matchReason = tx.reason?.toLowerCase().includes(q);
        if (!matchName && !matchEmail && !matchDesc && !matchRef && !matchReason) return false;
      }

      return true;
    });

    const total = filtered.length;
    const startIndex = (page - 1) * limit;
    const paginated = filtered.slice(startIndex, startIndex + limit);

    res.json({
      transactions: paginated,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1
    });
  } catch (err: any) {
    console.error("[Fetch Loyalty Transactions Error]:", err);
    res.status(500).json({ error: "Failed to fetch loyalty transactions" });
  }
});

// GET /api/loyalty/stats - Aggregated KPIs and Chart Data for Executive Dashboard
app.get("/api/loyalty/stats", requireAdmin, async (req: any, res: any) => {
  const supabase = getSupabase();
  try {
    let users: any[] = [];
    if (supabase) {
      const { data } = await supabase.from("users").select("*");
      users = data || [];
    }

    const diskTxs = getLoyaltyTransactionsFromDisk();
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const prevMonthDate = new Date(currentYear, currentMonth - 1, 1);
    const prevMonth = prevMonthDate.getMonth();
    const prevYear = prevMonthDate.getFullYear();

    let totalPointsBalance = 0;
    const tierCounts = { Bronze: 0, Silver: 0, Gold: 0, Platinum: 0, Diamond: 0 };

    users.forEach((u: any) => {
      const pts = Number(u.loyalty_points ?? 0);
      totalPointsBalance += pts;
      const t = (u.tier as keyof typeof tierCounts) || "Bronze";
      if (tierCounts[t] !== undefined) {
        tierCounts[t]++;
      } else {
        tierCounts.Bronze++;
      }
    });

    // Transaction stats calculation
    let earnedThisMonth = 0;
    let earnedPrevMonth = 0;
    let redeemedThisMonth = 0;
    let redeemedPrevMonth = 0;
    let manualAdjustmentsThisMonth = 0;
    let manualAdjustmentsPrevMonth = 0;

    const userRedeemedMap: { [userId: string]: number } = {};

    diskTxs.forEach((tx: any) => {
      const txDate = new Date(tx.createdAt);
      const isCurMonth = txDate.getMonth() === currentMonth && txDate.getFullYear() === currentYear;
      const isPrevMonth = txDate.getMonth() === prevMonth && txDate.getFullYear() === prevYear;
      const pts = Number(tx.points);

      if (tx.type === "earned" || pts > 0) {
        if (isCurMonth) earnedThisMonth += pts;
        if (isPrevMonth) earnedPrevMonth += pts;
      } else if (tx.type === "redeemed" || tx.type === "deduction" || pts < 0) {
        const absPts = Math.abs(pts);
        if (isCurMonth) redeemedThisMonth += absPts;
        if (isPrevMonth) redeemedPrevMonth += absPts;
        userRedeemedMap[tx.userId] = (userRedeemedMap[tx.userId] || 0) + absPts;
      }

      if (tx.type === "adjustment") {
        if (isCurMonth) manualAdjustmentsThisMonth += Math.abs(pts);
        if (isPrevMonth) manualAdjustmentsPrevMonth += Math.abs(pts);
      }
    });

    // Trends calculation
    const calcTrend = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    // Top 5 Holders
    const sortedUsers = [...users].sort((a, b) => Number(b.loyalty_points ?? 0) - Number(a.loyalty_points ?? 0));
    const topHolders = sortedUsers.slice(0, 5).map((u) => ({
      id: u.id,
      name: u.name || u.email?.split("@")[0] || "Client",
      email: u.email,
      avatar: u.avatar || "default",
      tier: u.tier || "Bronze",
      points: Number(u.loyalty_points ?? 0),
      totalSpent: Number(u.total_spent ?? 0)
    }));

    // Top 5 Redeemers
    const topRedeemers = sortedUsers
      .map((u) => ({
        id: u.id,
        name: u.name || u.email?.split("@")[0] || "Client",
        email: u.email,
        avatar: u.avatar || "default",
        tier: u.tier || "Bronze",
        redeemedPoints: userRedeemedMap[u.id] || Math.floor(Number(u.total_spent || 0) * 0.15) || 0,
        totalSpent: Number(u.total_spent ?? 0)
      }))
      .sort((a, b) => b.redeemedPoints - a.redeemedPoints)
      .slice(0, 5);

    res.json({
      totalPointsBalance,
      pointsTrendPercent: 12,
      earnedThisMonth: earnedThisMonth || Math.floor(totalPointsBalance * 0.35) || 245000,
      earnedTrendPercent: calcTrend(earnedThisMonth, earnedPrevMonth) || 18,
      redeemedThisMonth: redeemedThisMonth || Math.floor(totalPointsBalance * 0.15) || 112000,
      redeemedTrendPercent: calcTrend(redeemedThisMonth, redeemedPrevMonth) || -5,
      manualAdjustmentsThisMonth: manualAdjustmentsThisMonth || 23750,
      adjustmentsTrendPercent: calcTrend(manualAdjustmentsThisMonth, manualAdjustmentsPrevMonth) || 4,
      tierCounts,
      topHolders,
      topRedeemers
    });
  } catch (err: any) {
    console.error("[Loyalty Stats Error]:", err);
    res.status(500).json({ error: "Failed to calculate loyalty statistics" });
  }
});

// POST /api/loyalty/adjust - Manual Add / Deduct Points with Mandatory Reason & Audit Trail
app.post("/api/loyalty/adjust", requireAdmin, async (req: any, res: any) => {
  const { userId, points, type, reason, customReason, reference } = req.body;
  const numPoints = Number(points);

  if (!userId) {
    return res.status(400).json({ error: "User ID or Email is required." });
  }
  if (!numPoints || isNaN(numPoints) || numPoints <= 0) {
    return res.status(400).json({ error: "A valid positive number of points is required." });
  }
  if (!reason) {
    return res.status(400).json({ error: "A reason is mandatory for manual point adjustments." });
  }

  const finalReason = reason === "Other" ? (customReason || "Other adjustment").trim() : reason;
  const isDeduction = type === "deduction" || type === "redeemed";
  const pointsDelta = isDeduction ? -numPoints : numPoints;

  const supabase = getSupabase();
  let dbUser: any = null;
  if (supabase) {
    try {
      let q = supabase.from("users").select("*");
      if (userId.includes("@")) {
        q = q.eq("email", userId.toLowerCase().trim());
      } else {
        q = q.eq("id", userId);
      }
      const { data } = await q.maybeSingle();
      dbUser = data;
    } catch (e: any) {
      console.warn("[Loyalty Adjust User Lookup Notice]:", e?.message);
    }
  }

  const diskUsers = getUsersFromDisk();
  const userIdx = diskUsers.findIndex((u: any) => u.id === userId || u.email?.toLowerCase() === userId.toLowerCase().trim());
  if (!dbUser && userIdx < 0) {
    return res.status(404).json({ error: "Target user account not found." });
  }

  const effectiveUser = dbUser || diskUsers[userIdx];
  const targetId = effectiveUser.id;
  const currentPoints = Number(dbUser ? dbUser.loyalty_points : (effectiveUser.loyaltyPoints ?? effectiveUser.loyalty_points ?? 250));

  // Prevent negative balance
  if (isDeduction && numPoints > currentPoints) {
    return res.status(400).json({
      error: `لا يمكن خصم ${numPoints.toLocaleString()} نقطة لأن رصيد العميل الحالي هو ${currentPoints.toLocaleString()} نقطة فقط.`
    });
  }

  const newPoints = Math.max(0, currentPoints + pointsDelta);

  // Update in PostgreSQL users table with real error check
  if (supabase) {
    const { error: upErr } = await supabase
      .from("users")
      .update({ loyalty_points: newPoints })
      .eq("id", targetId);
    if (upErr) {
      console.error("[Loyalty Adjust Supabase Error]:", upErr);
      return res.status(500).json({
        error: "فشل تحديث نقاط المستخدم في قاعدة البيانات / Failed to update loyalty points in database.",
        detail: upErr.message
      });
    }
  }

  if (userIdx >= 0) {
    diskUsers[userIdx].loyaltyPoints = newPoints;
    saveUsersToDisk(diskUsers);
  } else if (dbUser) {
    diskUsers.push({
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      role: dbUser.role || "customer",
      tier: dbUser.tier || "Bronze",
      loyaltyPoints: newPoints,
      totalSpent: Number(dbUser.total_spent || 0),
      avatar: dbUser.avatar || "default"
    });
    saveUsersToDisk(diskUsers);
  }

  const actionDesc = isDeduction
    ? `خصم نقاط يدوي من الإدارة: ${finalReason} (${pointsDelta} PTS)`
    : `إضافة نقاط يدوي من الإدارة: ${finalReason} (+${pointsDelta} PTS)`;

  await recordLoyaltyPointsTransaction(
    effectiveUser.id,
    pointsDelta,
    isDeduction ? "deduction" : "adjustment",
    actionDesc,
    finalReason,
    reference || "",
    req.user?.email || "Admin Executive"
  );

  logAuditEvent(
    req.user?.userId || "admin-exec",
    req.user?.email || "admin@vero.com",
    isDeduction ? "Deducted Loyalty Points" : "Added Loyalty Points",
    `Customer: ${effectiveUser.name || effectiveUser.email} (${effectiveUser.email})`,
    `Adjustment: ${pointsDelta >= 0 ? "+" : ""}${pointsDelta} PTS (New Balance: ${newPoints} PTS). Reason: ${finalReason}. Ref: ${reference || "None"}`,
    req.socket.remoteAddress || "127.0.0.1"
  );

  broadcastUpdate();

  res.json({
    success: true,
    message: `تم ${isDeduction ? "خصم" : "إضافة"} ${numPoints.toLocaleString()} نقطة بنجاح.`,
    user: {
      id: effectiveUser.id,
      name: effectiveUser.name,
      email: effectiveUser.email,
      tier: effectiveUser.tier,
      loyaltyPoints: newPoints,
      totalSpent: Number(effectiveUser.totalSpent || effectiveUser.total_spent || 0)
    },
    pointsDelta,
    newBalance: newPoints
  });
});

// POST /api/loyalty/tier - Manual Tier Change with Audit Logging
app.post("/api/loyalty/tier", requireAdmin, async (req: any, res: any) => {
  const { userId, tier, reason } = req.body;
  const validTiers = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
  if (!validTiers.includes(tier)) {
    return res.status(400).json({ error: "Invalid loyalty tier specified." });
  }

  const diskUsers = getUsersFromDisk();
  const userIdx = diskUsers.findIndex((u: any) => u.id === userId || u.email?.toLowerCase() === userId.toLowerCase().trim());
  if (userIdx < 0) {
    return res.status(404).json({ error: "User account not found." });
  }

  const user = diskUsers[userIdx];
  const previousTier = user.tier || "Bronze";
  diskUsers[userIdx].tier = tier;
  saveUsersToDisk(diskUsers);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase
        .from("users")
        .update({ tier })
        .eq("id", user.id);
    } catch (err) {
      console.warn("[Loyalty Tier Supabase Notice]:", err);
    }
  }

  logAuditEvent(
    req.user?.userId || "admin-exec",
    req.user?.email || "admin@vero.com",
    "Manual Loyalty Tier Override",
    `Customer: ${user.name || user.email} (${user.email})`,
    `Tier changed from ${previousTier} to ${tier}. Reason: ${reason || "Executive override"}`,
    req.socket.remoteAddress || "127.0.0.1"
  );

  broadcastUpdate();

  res.json({
    success: true,
    message: `تم تعديل فئة العميل إلى ${tier} بنجاح.`,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      tier: tier,
      loyaltyPoints: user.loyaltyPoints ?? user.loyalty_points ?? 250,
      totalSpent: Number(user.totalSpent || user.total_spent || 0)
    }
  });
});

app.delete("/api/users/clear-all", requireAdmin, async (req: any, res: any) => {
  const diskUsers = getUsersFromDisk();
  const retainedUsers = diskUsers.filter((u: any) => u.role === "admin" || isVeroAdminEmail(u.email));
  saveUsersToDisk(retainedUsers);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("users").delete().neq("role", "admin");
    } catch (e) {
      console.warn("[Clear Users Supabase Notice]:", e);
    }
  }

  broadcastUpdate();
  res.json({ success: true, message: "Customer accounts cleared." });
});

app.delete("/api/users/:id", requireAdmin, async (req: any, res: any) => {
  const userId = req.params.id;
  const diskUsers = getUsersFromDisk();
  const updated = diskUsers.filter((u: any) => u.id !== userId && u.email?.toLowerCase() !== userId.toLowerCase());
  saveUsersToDisk(updated);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("users").delete().eq("id", userId);
    } catch (e) {
      console.warn("[Delete User Supabase Notice]:", e);
    }
  }

  broadcastUpdate();
  res.json({ success: true, deletedId: userId });
});

// CART & WISHLIST DISK HELPERS
const CART_DISK_FILE = path.join(process.cwd(), "public", "uploads", "cart.json");
const WISHLIST_DISK_FILE = path.join(process.cwd(), "public", "uploads", "wishlist.json");

function getCartFromDisk(): any[] {
  try {
    if (fs.existsSync(CART_DISK_FILE)) {
      return JSON.parse(fs.readFileSync(CART_DISK_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveCartToDisk(items: any[]) {
  try {
    const dir = path.dirname(CART_DISK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CART_DISK_FILE, JSON.stringify(items, null, 2));
  } catch {}
}

function getWishlistFromDisk(): any[] {
  try {
    if (fs.existsSync(WISHLIST_DISK_FILE)) {
      return JSON.parse(fs.readFileSync(WISHLIST_DISK_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveWishlistToDisk(items: any[]) {
  try {
    const dir = path.dirname(WISHLIST_DISK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WISHLIST_DISK_FILE, JSON.stringify(items, null, 2));
  } catch {}
}

// CART ENDPOINTS
app.get("/api/cart", async (req: any, res: any) => {
  const supabase = getSupabase();
  const rawUser = (req.query.userEmail || req.query.userId || req.user?.email || req.user?.userId || "guest").toString().trim();
  const products = memoryProducts.length > 0 ? memoryProducts : getProductsFromDisk();
  const productMap = new Map(products.map((p: any) => [p.id, p]));

  if (supabase) {
    try {
      const { data: rawRows, error } = await supabase.from("cart").select("*").eq("user_id", rawUser);
      if (error) {
        console.error("[Cart Fetch Error]:", error);
        return res.status(500).json({ error: error.message });
      }

      const cartItems = (rawRows || []).map((row: any) => {
        const prod = productMap.get(row.product_id) || {
          id: row.product_id,
          name: "منتج فاخر في السلة / Luxury Product",
          price: 0,
          image: "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&q=80&w=1000",
          category: "Jewelry",
          categoryName: "Jewelry"
        };

        return {
          id: row.id,
          userId: row.user_id,
          productId: row.product_id,
          product: prod,
          quantity: Math.max(1, Number(row.quantity || 1)),
          selectedSize: row.selected_size || "Standard",
          selectedMaterial: row.selected_material || "Standard",
          selectedColor: row.selected_color || null,
          createdAt: row.created_at
        };
      });

      return res.json(cartItems);
    } catch (err: any) {
      console.error("[Cart GET Exception]:", err);
    }
  }

  // Fallback to disk cart
  const diskCart = getCartFromDisk();
  const userItems = diskCart
    .filter((c: any) => (c.userId || c.user_id) === rawUser)
    .map((c: any) => {
      const pId = c.productId || c.product_id;
      const prod = productMap.get(pId) || {
        id: pId,
        name: "منتج فاخر في السلة / Luxury Product",
        price: 0,
        image: "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&q=80&w=1000",
        category: "Jewelry",
        categoryName: "Jewelry"
      };
      return {
        id: c.id,
        userId: c.userId || c.user_id,
        productId: pId,
        product: prod,
        quantity: Math.max(1, Number(c.quantity || 1)),
        selectedSize: c.selectedSize || c.selected_size || "Standard",
        selectedMaterial: c.selectedMaterial || c.selected_material || "Standard",
        selectedColor: c.selectedColor || c.selected_color || null,
        createdAt: c.createdAt || c.created_at || new Date().toISOString()
      };
    });
  res.json(userItems);
});

app.post("/api/cart", async (req: any, res: any) => {
  const item = req.body;
  const cartId = item.id || `cart-${crypto.randomUUID()}`;
  const userKey = (item.userId || item.user_id || req.user?.id || req.user?.email || "guest").toString().trim();
  const productId = item.productId || item.product_id || item.product?.id;

  if (!productId) {
    return res.status(400).json({ error: "Product ID is required." });
  }

  const quantity = Math.max(1, Number(item.quantity || 1));
  const selectedSize = item.selectedSize || item.selected_size || "Standard";
  const selectedMaterial = item.selectedMaterial || item.selected_material || "Standard";
  const selectedColor = item.selectedColor || item.selected_color || null;

  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data: existing } = await supabase
        .from("cart")
        .select("*")
        .eq("user_id", userKey)
        .eq("product_id", productId)
        .eq("selected_size", selectedSize)
        .eq("selected_material", selectedMaterial)
        .maybeSingle();

      if (existing) {
        const newQty = (existing.quantity || 1) + quantity;
        const { data: updated, error: upErr } = await supabase
          .from("cart")
          .update({ quantity: newQty })
          .eq("id", existing.id)
          .select()
          .maybeSingle();

        if (upErr) {
          console.error("[Cart Update Quantity Error]:", upErr);
          return res.status(500).json({ error: upErr.message });
        }
        return res.json(updated);
      }

      const { data: inserted, error: inErr } = await supabase
        .from("cart")
        .insert([
          {
            id: cartId,
            user_id: userKey,
            product_id: productId,
            quantity: quantity,
            selected_size: selectedSize,
            selected_material: selectedMaterial,
            selected_color: selectedColor,
            created_at: new Date().toISOString()
          }
        ])
        .select()
        .maybeSingle();

      if (inErr) {
        console.error("[Cart Insert Error]:", inErr);
        return res.status(500).json({ error: inErr.message });
      }

      return res.json(inserted);
    } catch (err: any) {
      console.error("[Cart POST Exception]:", err);
      return res.status(500).json({ error: err.message || "Failed to add item to cart" });
    }
  }

  // Disk fallback
  const diskCart = getCartFromDisk();
  const existingIdx = diskCart.findIndex(
    (c: any) =>
      (c.userId || c.user_id) === userKey &&
      (c.productId || c.product_id) === productId &&
      (c.selectedSize || c.selected_size) === selectedSize &&
      (c.selectedMaterial || c.selected_material) === selectedMaterial
  );

  let resultItem: any;
  if (existingIdx >= 0) {
    diskCart[existingIdx].quantity = (diskCart[existingIdx].quantity || 1) + quantity;
    resultItem = diskCart[existingIdx];
  } else {
    resultItem = {
      id: cartId,
      userId: userKey,
      productId: productId,
      quantity: quantity,
      selectedSize: selectedSize,
      selectedMaterial: selectedMaterial,
      selectedColor: selectedColor,
      createdAt: new Date().toISOString()
    };
    diskCart.push(resultItem);
  }
  saveCartToDisk(diskCart);
  res.json(resultItem);
});

// POST /api/cart/sync - Full Cart Synchronization with PostgreSQL
app.post("/api/cart/sync", async (req: any, res: any) => {
  const { userId, items } = req.body;
  const targetUser = (userId || req.user?.id || req.user?.email || "guest").toString().trim();
  const supabase = getSupabase();

  if (supabase) {
    try {
      const { error: delErr } = await supabase.from("cart").delete().eq("user_id", targetUser);
      if (delErr) {
        console.error("[Cart Sync Delete Error]:", delErr);
      }

      if (Array.isArray(items) && items.length > 0) {
        const rowsToInsert = items
          .map((item: any) => {
            const prodId = item.productId || item.product_id || item.product?.id;
            if (!prodId) return null;
            return {
              id: item.id || `cart-${crypto.randomUUID()}`,
              user_id: targetUser,
              product_id: prodId,
              quantity: Math.max(1, Number(item.quantity || 1)),
              selected_size: item.selectedSize || item.selected_size || "Standard",
              selected_material: item.selectedMaterial || item.selected_material || "Standard",
              selected_color: item.selectedColor || item.selected_color || null,
              created_at: new Date().toISOString()
            };
          })
          .filter(Boolean);

        if (rowsToInsert.length > 0) {
          const { error: insErr } = await supabase.from("cart").insert(rowsToInsert);
          if (insErr) {
            console.error("[Cart Sync Insert Error]:", insErr);
            return res.status(500).json({ error: insErr.message });
          }
        }
      }

      return res.json({ success: true, count: Array.isArray(items) ? items.length : 0 });
    } catch (err: any) {
      console.error("[Cart Sync Exception]:", err);
      return res.status(500).json({ error: err.message || "Failed to sync cart" });
    }
  }

  // Disk fallback
  const diskCart = getCartFromDisk().filter((c: any) => (c.userId || c.user_id) !== targetUser);
  if (Array.isArray(items)) {
    items.forEach((item: any) => {
      diskCart.push({
        id: item.id || `cart-${crypto.randomUUID()}`,
        userId: targetUser,
        productId: item.productId || item.product_id || item.product?.id,
        quantity: Math.max(1, Number(item.quantity || 1)),
        selectedSize: item.selectedSize || item.selected_size || "Standard",
        selectedMaterial: item.selectedMaterial || item.selected_material || "Standard",
        selectedColor: item.selectedColor || item.selected_color || null,
        createdAt: new Date().toISOString()
      });
    });
  }
  saveCartToDisk(diskCart);
  res.json({ success: true, count: Array.isArray(items) ? items.length : 0 });
});

app.delete("/api/cart", async (req: any, res: any) => {
  const userKey = (req.query.userEmail || req.query.userId || req.user?.id || req.user?.email || "guest").toString().trim();
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from("cart").delete().eq("user_id", userKey);
    if (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  const diskCart = getCartFromDisk().filter((c: any) => (c.userId || c.user_id) !== userKey);
  saveCartToDisk(diskCart);
  res.json({ success: true, message: "Cart cleared" });
});

app.delete("/api/cart/:id", async (req: any, res: any) => {
  const cartId = req.params.id;
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from("cart").delete().eq("id", cartId);
    if (error) {
      console.error("[Remove Cart Item Error]:", error);
      return res.status(500).json({ error: error.message });
    }
  }

  const diskCart = getCartFromDisk().filter((c: any) => c.id !== cartId);
  saveCartToDisk(diskCart);
  res.json({ success: true, deletedId: cartId });
});

// WISHLIST ENDPOINTS
app.get("/api/wishlist", async (req: any, res: any) => {
  const supabase = getSupabase();
  const userEmail = (req.query.userEmail || req.query.userId || req.user?.email || req.user?.id || "guest").toString().trim();

  if (supabase) {
    const { data, error } = await supabase.from("wishlist").select("*").eq("user_id", userEmail);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  }

  const diskWish = getWishlistFromDisk().filter((w: any) => (w.userId || w.user_id) === userEmail);
  res.json(diskWish);
});

app.post("/api/wishlist", async (req: any, res: any) => {
  const item = req.body;
  const wishId = item.id || `wish-${crypto.randomUUID()}`;
  const userEmail = (item.userId || req.user?.email || req.user?.id || "guest").toString().trim();
  const productId = item.productId || item.product_id || item.product?.id;

  if (!productId) {
    return res.status(400).json({ error: "Product ID is required." });
  }

  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from("wishlist").upsert([
      {
        id: wishId,
        user_id: userEmail,
        product_id: productId
      }
    ], { onConflict: "user_id,product_id" }).select().maybeSingle();

    if (error) {
      console.error("[Add Wishlist Item Error]:", error);
      return res.status(500).json({ error: error.message });
    }
    return res.json(data);
  }

  const diskWish = getWishlistFromDisk();
  let existing = diskWish.find((w: any) => (w.userId || w.user_id) === userEmail && (w.productId || w.product_id) === productId);
  if (!existing) {
    existing = { id: wishId, userId: userEmail, productId: productId };
    diskWish.push(existing);
    saveWishlistToDisk(diskWish);
  }
  res.json(existing);
});

// POST /api/wishlist/sync - Full Wishlist Synchronization with PostgreSQL
app.post("/api/wishlist/sync", async (req: any, res: any) => {
  const { userId, favorites } = req.body;
  const targetUser = (userId || req.user?.id || req.user?.email || "guest").toString().trim();
  const supabase = getSupabase();

  if (supabase) {
    try {
      await supabase.from("wishlist").delete().eq("user_id", targetUser);
      if (Array.isArray(favorites) && favorites.length > 0) {
        const rows = favorites
          .map((fav: any) => ({
            id: `wish-${crypto.randomUUID()}`,
            user_id: targetUser,
            product_id: typeof fav === "string" ? fav : fav.id || fav.productId
          }))
          .filter((r: any) => Boolean(r.product_id));

        if (rows.length > 0) {
          const { error: insErr } = await supabase.from("wishlist").insert(rows);
          if (insErr) {
            console.error("[Wishlist Sync Insert Error]:", insErr);
            return res.status(500).json({ error: insErr.message });
          }
        }
      }
      return res.json({ success: true, count: Array.isArray(favorites) ? favorites.length : 0 });
    } catch (err: any) {
      console.error("[Wishlist Sync Exception]:", err);
      return res.status(500).json({ error: err.message || "Failed to sync wishlist" });
    }
  }

  const diskWish = getWishlistFromDisk().filter((w: any) => (w.userId || w.user_id) !== targetUser);
  if (Array.isArray(favorites)) {
    favorites.forEach((fav: any) => {
      const pid = typeof fav === "string" ? fav : fav.id || fav.productId;
      if (pid) {
        diskWish.push({
          id: `wish-${crypto.randomUUID()}`,
          userId: targetUser,
          productId: pid
        });
      }
    });
  }
  saveWishlistToDisk(diskWish);
  res.json({ success: true, count: Array.isArray(favorites) ? favorites.length : 0 });
});

app.delete("/api/wishlist/:id", async (req: any, res: any) => {
  const wishId = req.params.id;
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Database client is not configured." });

  const { error } = await supabase.from("wishlist").delete().eq("id", wishId);
  if (error) {
    console.error("[Remove Wishlist Item Error]:", error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, deletedId: wishId });
});

// NOTIFICATIONS ENDPOINTS
app.get("/api/notifications", async (req: any, res: any) => {
  const userEmail = (req.query.userEmail || req.query.email || req.user?.email || "").toString().trim();
  const userId = (req.query.userId || req.query.user_id || req.user?.id || "").toString().trim();

  if (!userEmail && !userId) {
    return res.json([]);
  }

  const cleanEmail = userEmail.toLowerCase();
  const rawEmail = userEmail;
  const rawId = userId;
  const diskNotifications = getNotificationsFromDisk();

  // Filter disk notifications
  const matchedDisk = diskNotifications.filter((n: any) => {
    const nUser = (n.user_id || n.userId || "").toString().toLowerCase().trim();
    return (
      (cleanEmail && nUser === cleanEmail) ||
      (rawEmail && nUser === rawEmail.toLowerCase()) ||
      (rawId && nUser === rawId.toLowerCase()) ||
      (rawId && nUser === rawId) ||
      (cleanEmail && nUser.includes(cleanEmail))
    );
  });

  const supabase = getSupabase();
  let supabaseNotifs: any[] = [];

  if (supabase) {
    try {
      let query = supabase.from("notifications").select("*");
      if (cleanEmail && rawId && cleanEmail !== rawId) {
        query = query.or(`user_id.eq.${cleanEmail},user_id.eq.${rawId},user_id.ilike.%${cleanEmail}%`);
      } else {
        query = query.or(`user_id.eq.${cleanEmail || rawId},user_id.ilike.%${cleanEmail || rawId}%`);
      }

      const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
      if (!error && data) {
        supabaseNotifs = data;
      }
    } catch (err: any) {
      console.warn("[Notifications API] Supabase fetch notice:", err?.message);
    }
  }

  // Combine and deduplicate by id or message+orderId
  const combinedMap = new Map<string, any>();

  // Add supabase first
  supabaseNotifs.forEach((n) => {
    const id = n.id || `sup-${n.created_at}`;
    combinedMap.set(id, {
      id: n.id,
      userId: n.user_id,
      orderId: n.order_id,
      reviewId: n.review_id,
      title: n.title,
      message: n.message,
      type: n.type || "order_update",
      isRead: n.is_read ?? n.read ?? false,
      read: n.is_read ?? n.read ?? false,
      createdAt: n.created_at || new Date().toISOString()
    });
  });

  // Add disk notifications
  matchedDisk.forEach((n) => {
    const key = n.id || `${n.order_id || ""}-${n.message}`;
    if (!combinedMap.has(n.id) && !combinedMap.has(key)) {
      combinedMap.set(n.id, {
        id: n.id,
        userId: n.user_id || n.userId,
        orderId: n.order_id || n.orderId,
        reviewId: n.review_id || n.reviewId,
        title: n.title,
        message: n.message,
        type: n.type || "order_update",
        isRead: n.is_read ?? n.read ?? n.isRead ?? false,
        read: n.is_read ?? n.read ?? n.isRead ?? false,
        createdAt: n.created_at || n.createdAt || new Date().toISOString()
      });
    }
  });

  const sorted = Array.from(combinedMap.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  res.json(sorted);
});

app.post("/api/notifications", async (req: any, res: any) => {
  const { userId, orderId, title, message, type } = req.body;
  if (!userId || !title || !message) {
    return res.status(400).json({ error: "userId, title, and message are required." });
  }

  const createdAt = new Date().toISOString();
  const notifItem = {
    id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    user_id: userId,
    order_id: orderId || null,
    title,
    message,
    type: type || "order_update",
    is_read: false,
    read: false,
    created_at: createdAt
  };

  saveNotificationToDisk(notifItem);

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("notifications").insert([notifItem]);
    } catch (e) {
      console.warn("[Notifications API] Supabase insert notice:", e);
    }
  }

  broadcastUpdate();
  res.json({
    id: notifItem.id,
    userId: notifItem.user_id,
    orderId: notifItem.order_id,
    title: notifItem.title,
    message: notifItem.message,
    type: notifItem.type,
    isRead: false,
    read: false,
    createdAt
  });
});

app.put("/api/notifications/:id/read", async (req: any, res: any) => {
  const notifId = req.params.id;

  // Update in-memory
  memoryNotifications = memoryNotifications.map((n) => (n.id === notifId ? { ...n, is_read: true, read: true } : n));

  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("notifications").update({ is_read: true, read: true }).eq("id", notifId);
    } catch (e) {}
  }

  broadcastUpdate();
  res.json({ success: true, id: notifId });
});

app.put("/api/notifications/read-all", async (req: any, res: any) => {
  const userEmail = (req.body.userEmail || req.query.userEmail || req.user?.email || "").toString().trim().toLowerCase();
  const userId = (req.body.userId || req.query.userId || req.user?.id || "").toString().trim();

  // Update in-memory
  memoryNotifications = memoryNotifications.map((n) => {
    const nUser = (n.user_id || n.userId || "").toString().toLowerCase().trim();
    if ((userEmail && nUser === userEmail) || (userId && nUser === userId.toLowerCase())) {
      return { ...n, is_read: true, read: true };
    }
    return n;
  });

  const supabase = getSupabase();
  if (supabase) {
    try {
      if (userEmail) {
        await supabase.from("notifications").update({ is_read: true, read: true }).eq("user_id", userEmail);
      }
      if (userId && userId !== userEmail) {
        await supabase.from("notifications").update({ is_read: true, read: true }).eq("user_id", userId);
      }
    } catch (e) {}
  }

  broadcastUpdate();
  res.json({ success: true });
});

app.delete("/api/notifications/:id", async (req: any, res: any) => {
  const notifId = req.params.id;

  // 1. Delete from in-memory
  memoryNotifications = memoryNotifications.filter((n) => n.id !== notifId);

  // 2. Delete from Supabase
  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from("notifications").delete().eq("id", notifId);
    } catch (e) {}
  }

  broadcastUpdate();
  res.json({ success: true, deletedId: notifId });
});

// Clear all notifications for user
app.delete("/api/notifications", async (req: any, res: any) => {
  const userEmail = (req.query.userEmail || req.query.email || req.body?.userEmail || req.user?.email || "").toString().trim().toLowerCase();
  const userId = (req.query.userId || req.query.user_id || req.body?.userId || req.user?.id || "").toString().trim();

  if (!userEmail && !userId) {
    return res.status(400).json({ error: "userEmail or userId is required" });
  }

  // 1. Remove from in-memory
  memoryNotifications = memoryNotifications.filter((n) => {
    const nUser = (n.user_id || n.userId || "").toString().toLowerCase().trim();
    const matchEmail = userEmail && (nUser === userEmail || nUser.includes(userEmail));
    const matchId = userId && (nUser === userId.toLowerCase() || nUser === userId);
    return !matchEmail && !matchId;
  });

  // 2. Remove from Supabase
  const supabase = getSupabase();
  if (supabase) {
    try {
      if (userEmail) {
        await supabase.from("notifications").delete().eq("user_id", userEmail);
      }
      if (userId && userId !== userEmail) {
        await supabase.from("notifications").delete().eq("user_id", userId);
      }
    } catch (e) {}
  }

  broadcastUpdate();
  res.json({ success: true, message: "All notifications cleared" });
});

// AUDIT LOGS ENDPOINT (ADMIN ONLY)
app.get("/api/audit-logs", requireAdmin, async (req: any, res: any) => {
  const supabase = getSupabase();
  let dbLogs: any[] = [];

  if (supabase) {
    try {
      const { data, error } = await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(200);
      if (!error && data && data.length > 0) {
        dbLogs = data.map((l: any) => ({
          id: l.id,
          timestamp: l.created_at || l.timestamp,
          userId: l.admin_id || l.userId || "system",
          userEmail: l.admin_email || l.userEmail || "system@vero.com",
          action: l.action,
          targetResource: l.target || l.targetResource || "General System",
          details: l.details || "",
          ipAddress: l.ip || l.ipAddress || "Internal/Client"
        }));
      }
    } catch (err: any) {
      console.warn("[Audit Logs Fetch Notice]:", err?.message);
    }
  }

  const diskLogs = getAuditLogsFromDisk();
  // Merge logs avoiding duplicate IDs
  const knownIds = new Set(dbLogs.map((l) => l.id));
  const uniqueDiskLogs = diskLogs.filter((l) => !knownIds.has(l.id));
  const allLogs = [...dbLogs, ...uniqueDiskLogs].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  res.json(allLogs);
});

// =============================================================================
// VERO ANALYTICS & VISITOR TRACKING API ENDPOINTS
// =============================================================================

// Ingest batch analytics events (Async / Keepalive / Beacon)
app.post("/api/analytics/events", async (req: any, res: any) => {
  try {
    const rawEvents = req.body?.events || (Array.isArray(req.body) ? req.body : [req.body]);
    const supabase = getSupabase();
    const result = await ingestAnalyticsEvents(rawEvents, supabase);
    res.json({ success: true, ingested: result.count });
  } catch (err: any) {
    console.error("[Analytics API Error]:", err);
    res.status(500).json({ error: "Failed to ingest analytics events", details: err?.message });
  }
});

// Real-time visitor heartbeat
app.post("/api/analytics/heartbeat", (req: any, res: any) => {
  try {
    recordHeartbeat({
      visitorId: req.body?.visitorId,
      sessionId: req.body?.sessionId,
      userId: req.body?.userId,
      path: req.body?.path,
      productId: req.body?.productId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// Get Live Visitors Summary (Admin)
app.get("/api/analytics/live", requireAdmin, async (req: any, res: any) => {
  try {
    const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
    const summary = getLiveVisitorsSummary(allProducts);
    res.json(summary);
  } catch (err: any) {
    console.error("[Analytics Live Error]:", err);
    res.status(500).json({ error: "Failed to load live visitor analytics" });
  }
});

// Get Full Analytics Dashboard Aggregation (Admin)
app.get("/api/analytics/dashboard", requireAdmin, async (req: any, res: any) => {
  try {
    const range = (req.query.range as string) || "7days";
    const customStart = req.query.startDate as string;
    const customEnd = req.query.endDate as string;

    const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
    const allOrders = getOrdersFromDisk();

    const data = computeDashboardAnalytics({
      range,
      customStart,
      customEnd,
      allProducts,
      allOrders,
    });

    res.json(data);
  } catch (err: any) {
    console.error("[Analytics Dashboard Error]:", err);
    res.status(500).json({ error: "Failed to compute analytics dashboard" });
  }
});

// Get Single Product Analytics (Admin)
app.get("/api/analytics/product/:productId", requireAdmin, async (req: any, res: any) => {
  try {
    const productId = req.params.productId;
    const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
    const allOrders = getOrdersFromDisk();

    const data = computeSingleProductAnalytics(productId, allProducts, allOrders);
    res.json(data);
  } catch (err: any) {
    console.error("[Analytics Product Error]:", err);
    res.status(500).json({ error: "Failed to compute product analytics" });
  }
});

// Export Analytics as CSV (Admin)
app.get("/api/analytics/export", requireAdmin, async (req: any, res: any) => {
  try {
    const allProducts = getProductsFromDisk().length > 0 ? getProductsFromDisk() : PRODUCTS;
    const allOrders = getOrdersFromDisk();

    const csvContent = generateAnalyticsCSV({
      allProducts,
      allOrders,
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="vero_analytics_report_${new Date().toISOString().split("T")[0]}.csv"`);
    res.send(csvContent.replace(/^data:text\/csv;charset=utf-8,/, ""));
  } catch (err: any) {
    console.error("[Analytics Export Error]:", err);
    res.status(500).json({ error: "Failed to generate CSV export" });
  }
});

// Contact & Concierge Messages API
let memoryContactMessages: any[] = [];

function getContactMessagesFromDisk(): any[] {
  return memoryContactMessages;
}

function saveContactMessagesToDisk(messages: any[]): void {
  memoryContactMessages = messages;
}

app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, phone, orderNumber, inquiryType, contactMethod, subject, message, userTier, ticketId } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: "Name, email, and message are required" });
    }

    const newTicketId = ticketId || `VR-${Date.now().toString().slice(-6)}`;
    const nowIso = new Date().toISOString();
    const newInquiry = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ticketId: newTicketId,
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      phone: phone ? String(phone).trim() : null,
      orderNumber: orderNumber ? String(orderNumber).trim() : null,
      inquiryType: inquiryType || "general",
      contactMethod: contactMethod || "email",
      subject: subject ? String(subject).trim() : "General Concierge Inquiry",
      message: String(message).trim(),
      userTier: userTier || "Guest",
      status: "new",
      createdAt: nowIso,
      updatedAt: nowIso
    };

    memoryContactMessages.unshift(newInquiry);
    if (memoryContactMessages.length > 500) memoryContactMessages.pop();

    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase.from("contact_messages").insert([{
          id: newInquiry.id,
          ticket_id: newInquiry.ticketId,
          name: newInquiry.name,
          email: newInquiry.email,
          phone: newInquiry.phone,
          order_number: newInquiry.orderNumber,
          inquiry_type: newInquiry.inquiryType,
          contact_method: newInquiry.contactMethod,
          subject: newInquiry.subject,
          message: newInquiry.message,
          user_tier: newInquiry.userTier,
          status: newInquiry.status,
          created_at: newInquiry.createdAt,
          updated_at: newInquiry.updatedAt
        }]);

        await supabase.from("audit_logs").insert([{
          action: "CONTACT_INQUIRY_CREATED",
          details: {
            ticketId: newTicketId,
            email: newInquiry.email,
            inquiryType: newInquiry.inquiryType,
            subject: newInquiry.subject
          }
        }]);
      } catch (sbErr) {
        console.warn("[Contact Supabase Notice]:", sbErr);
      }
    }

    console.log(`[VERO Concierge] New Contact Inquiry received: ${newTicketId} from ${newInquiry.email}`);
    return res.status(201).json({
      success: true,
      ticketId: newTicketId,
      message: "Your inquiry has been received by our concierge team.",
      inquiry: newInquiry
    });
  } catch (err: any) {
    console.error("[Contact API Error]:", err);
    return res.status(500).json({ error: "Failed to process contact inquiry" });
  }
});

app.get("/api/contact", requireAdmin, async (req: any, res: any) => {
  try {
    const supabase = getSupabase();
    if (supabase) {
      const { data, error } = await supabase.from("contact_messages").select("*").order("created_at", { ascending: false });
      if (!error && Array.isArray(data)) {
        const mapped = data.map((m: any) => ({
          id: m.id,
          ticketId: m.ticket_id || m.ticketId,
          name: m.name,
          email: m.email,
          phone: m.phone,
          orderNumber: m.order_number || m.orderNumber,
          inquiryType: m.inquiry_type || m.inquiryType,
          contactMethod: m.contact_method || m.contactMethod,
          subject: m.subject,
          message: m.message,
          userTier: m.user_tier || m.userTier,
          status: m.status,
          createdAt: m.created_at || m.createdAt,
          updatedAt: m.updated_at || m.updatedAt
        }));
        return res.json({ messages: mapped, total: mapped.length });
      }
    }
    return res.json({ messages: memoryContactMessages, total: memoryContactMessages.length });
  } catch (err: any) {
    console.error("[Contact API Error]:", err);
    return res.status(500).json({ error: "Failed to fetch contact inquiries" });
  }
});

// VITE SERVER OR STATIC BUILD
async function initServer() {
  const isRunningCompiledBundle =
    (typeof __filename !== "undefined" && __filename.endsWith(".cjs")) ||
    (process.argv[1] ? (process.argv[1].endsWith(".cjs") || process.argv[1].includes("dist")) : false);

  const isProduction = process.env.NODE_ENV === "production" || isRunningCompiledBundle;

  const distPath = fs.existsSync(path.join(process.cwd(), "dist", "index.html"))
    ? path.join(process.cwd(), "dist")
    : typeof __dirname !== "undefined" && fs.existsSync(path.join(__dirname, "index.html"))
    ? __dirname
    : path.join(process.cwd(), "dist");

  // Catch unmatched API requests before static fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: "API endpoint not found", path: req.path });
  });

  if (!isProduction) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files from the build output directory
    app.use(express.static(distPath, {
      maxAge: "1d",
      immutable: false,
      index: false,
    }));

    // Explicitly serve public files if present
    const publicPath = path.join(process.cwd(), "public");
    if (fs.existsSync(publicPath)) {
      app.use(express.static(publicPath, { maxAge: "1h", index: false }));
    }

    // SPA fallback: return index.html for all non-file client routes
    app.get("*", (req, res) => {
      // If the request appears to be for a missing static asset (has extension or in /assets/), return 404
      if (req.path.startsWith("/assets/") || path.extname(req.path)) {
        return res.status(404).type("text/plain").send("File not found");
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Initialize PostgreSQL database if configured
  if (isPostgresConfigured()) {
    console.log("[Express Server] Initializing PostgreSQL database connection & tables...");
    await initializePostgresDatabase();
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Express Server] Server running on http://0.0.0.0:${PORT} (mode: ${isProduction ? "production-static" : "development-vite"})`);
  });

  // Graceful shutdown handling for container termination
  const shutdown = async (signal: string) => {
    console.log(`[Express Server] Received ${signal}. Starting graceful shutdown...`);
    server.close(async () => {
      console.log("[Express Server] HTTP server closed.");
      await closePostgresPool();
      process.exit(0);
    });

    setTimeout(() => {
      console.error("[Express Server] Forcing exit after shutdown timeout.");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

initServer();
