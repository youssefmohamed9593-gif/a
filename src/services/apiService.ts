import { Product, ProductGender, Category, CartItem, Order, UserProfile, Review, getTierFromSpent, InAppNotification } from "../types";

// ==========================================
// COLUMN MAPPINGS (SNAKE_CASE <-> CAMELCASE)
// ==========================================

export function mapDbProductToLocal(dbProduct: any): Product {
  const images = Array.isArray(dbProduct.images) ? dbProduct.images : (dbProduct.images ? [dbProduct.images] : []);
  const mainImage = dbProduct.image || images[0] || "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=800&q=80";
  const secImages = dbProduct.secondaryImages || dbProduct.secondary_images || images.slice(1);

  // Extract explicit gender from product or specifications fallback
  let resolvedGender: ProductGender | undefined = undefined;
  if (dbProduct.gender === "Men" || dbProduct.gender === "Women" || dbProduct.gender === "Unisex") {
    resolvedGender = dbProduct.gender;
  } else if (Array.isArray(dbProduct.specifications)) {
    const specGender = dbProduct.specifications.find((s: any) => typeof s === "string" && s.startsWith("gender:"));
    if (specGender) {
      const g = specGender.split(":")[1];
      if (g === "Men" || g === "Women" || g === "Unisex") {
        resolvedGender = g as ProductGender;
      }
    }
  }

  return {
    id: dbProduct.id,
    name: dbProduct.name,
    categoryId: dbProduct.category_id || dbProduct.categoryId || "rings",
    categoryName: dbProduct.category_name || dbProduct.categoryName || "Rings",
    price: Number(dbProduct.price),
    image: mainImage,
    secondaryImages: secImages,
    description: dbProduct.description || "",
    tagline: dbProduct.tagline || "",
    isNew: dbProduct.is_new !== false && dbProduct.isNew !== false,
    isPreOrder: !!(dbProduct.pre_order ?? dbProduct.is_pre_order ?? dbProduct.isPreOrder),
    materialOptions: dbProduct.materials || dbProduct.material_options || dbProduct.materialOptions || ["#E5D5BC", "#E5E4E2"],
    sizeOptions: dbProduct.sizes || dbProduct.size_options || dbProduct.sizeOptions || ["Standard", "Premium"],
    details: dbProduct.details || [],
    craftsmanship: dbProduct.craftsmanship || "",
    stock: dbProduct.stock === null || dbProduct.stock === undefined ? undefined : Number(dbProduct.stock),
    sku: dbProduct.sku || undefined,
    brand: dbProduct.brand || "VERO",
    category: dbProduct.category || dbProduct.category_name || "Rings",
    gender: resolvedGender,
    costPrice: dbProduct.costPrice !== undefined ? Number(dbProduct.costPrice) : (dbProduct.unit_cost !== undefined ? Number(dbProduct.unit_cost) : undefined),
    lowStockThreshold: dbProduct.lowStockThreshold !== undefined ? Number(dbProduct.lowStockThreshold) : (dbProduct.low_stock_threshold !== undefined ? Number(dbProduct.low_stock_threshold) : 5),
    status: dbProduct.status || "active",
    variants: Array.isArray(dbProduct.variants) ? dbProduct.variants : [],
    seoTitle: dbProduct.seoTitle || dbProduct.seo_title || undefined,
    metaDescription: dbProduct.metaDescription || dbProduct.meta_description || undefined,
    slug: dbProduct.slug || undefined,
    shipping: dbProduct.shipping || (dbProduct.weight || dbProduct.length || dbProduct.width || dbProduct.height ? { weight: dbProduct.weight, length: dbProduct.length, width: dbProduct.width, height: dbProduct.height } : undefined),
    imageAlt: dbProduct.imageAlt || dbProduct.image_alt || undefined,
    preOrderNote: dbProduct.preOrderNote || dbProduct.pre_order_note || undefined,
    estimatedShipDate: dbProduct.estimatedShipDate || dbProduct.estimated_ship_date || undefined
  };
}

export function mapLocalProductToDb(product: Product): any {
  const allImages = [product.image, ...(product.secondaryImages || [])].filter(Boolean);
  const existingSpecs = Array.isArray((product as any).specifications)
    ? (product as any).specifications.filter((s: any) => typeof s === "string" && s.trim() && !s.startsWith("gender:"))
    : [];
  if (product.gender) {
    existingSpecs.push(`gender:${product.gender}`);
  }

  return {
    id: product.id,
    name: product.name,
    category_id: product.categoryId || "rings",
    category_name: product.categoryName || "Rings",
    price: Number(product.price) || 0,
    image: product.image,
    images: allImages,
    secondary_images: product.secondaryImages || [],
    description: product.description || "",
    tagline: product.tagline || "",
    is_new: product.isNew ?? true,
    is_pre_order: product.isPreOrder ?? false,
    materials: Array.isArray(product.materialOptions) ? product.materialOptions : ["#E5D5BC", "#E5E4E2"],
    sizes: Array.isArray(product.sizeOptions) ? product.sizeOptions : ["Standard", "Premium"],
    details: Array.isArray(product.details) ? product.details : [],
    craftsmanship: product.craftsmanship || "",
    stock: typeof product.stock === "number" && !isNaN(product.stock) ? product.stock : 10,
    sku: product.sku || null,
    brand: product.brand || "VERO",
    gender: product.gender || "Unisex",
    cost_price: product.costPrice ?? null,
    low_stock_threshold: product.lowStockThreshold ?? 5,
    status: product.status || "active",
    variants: Array.isArray(product.variants) ? product.variants : [],
    seo_title: product.seoTitle || null,
    meta_description: product.metaDescription || null,
    slug: product.slug || null,
    shipping: product.shipping || null,
    image_alt: product.imageAlt || null,
    pre_order_note: product.preOrderNote || null,
    estimated_ship_date: product.estimatedShipDate || null,
    specifications: existingSpecs
  };
}

// ==========================================
// AUTHENTICATION HEADERS HELPER
// ==========================================

export function getAuthHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("vero_session_token");
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      headers["X-Session-Token"] = token;
    }
    const userStr = localStorage.getItem("vero_user");
    if (userStr) {
      try {
        const u = JSON.parse(userStr);
        if (u.email) headers["X-User-Email"] = u.email;
        if (u.role === "admin") headers["X-Admin-Authorized"] = "true";
      } catch {}
    }
  }
  return headers;
}

// ==========================================
// 1. AUTH & PROFILE SERVICES
// ==========================================

export const authService = {
  async getProfile(userIdOrEmail: string): Promise<UserProfile | null> {
    try {
      const res = await fetch(`/api/auth/profile?email=${encodeURIComponent(userIdOrEmail)}`, {
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn("[authService] getProfile notice:", e);
    }
    return null;
  },

  async updateProfile(userId: string, updates: Partial<UserProfile>): Promise<UserProfile | null> {
    try {
      const res = await fetch(`/api/auth/profile`, {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify({ userId, ...updates }),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn("[authService] updateProfile notice:", e);
    }
    return null;
  }
};

// ==========================================
// 2. CATEGORIES SERVICES
// ==========================================

export const categoryService = {
  async getCategories(): Promise<Category[]> {
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) return data;
      }
    } catch (e) {
      console.warn("[categoryService] getCategories notice:", e);
    }
    return [];
  }
};

// ==========================================
// 3. PRODUCTS SERVICES
// ==========================================

export const productService = {
  async getProducts(): Promise<Product[]> {
    try {
      const res = await fetch("/api/products", {
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          return data.map(mapDbProductToLocal);
        }
      }
    } catch (e) {
      console.warn("[productService] getProducts notice:", e);
    }
    return [];
  },

  async createProduct(product: Product): Promise<Product | null> {
    const dbPayload = mapLocalProductToDb(product);
    const res = await fetch("/api/products", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(dbPayload),
    });
    if (res.ok) {
      const data = await res.json();
      return mapDbProductToLocal(data);
    }
    throw new Error("Failed to create product");
  },

  async updateProduct(id: string, updates: Partial<Product>): Promise<Product | null> {
    const res = await fetch(`/api/products/${id}`, {
      method: "PUT",
      headers: getAuthHeaders(),
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      const data = await res.json();
      return mapDbProductToLocal(data);
    }
    throw new Error("Failed to update product");
  },

  async deleteProduct(id: string): Promise<boolean> {
    const res = await fetch(`/api/products/${id}`, {
      method: "DELETE",
      headers: getAuthHeaders(),
    });
    return res.ok;
  }
};

// ==========================================
// 4. CART & WISHLIST SERVICES
// ==========================================

export const cartService = {
  async getCart(userId: string): Promise<CartItem[]> {
    try {
      const res = await fetch(`/api/cart?userEmail=${encodeURIComponent(userId)}`, {
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn("[cartService] getCart notice:", e);
    }
    return [];
  },

  async syncCart(userId: string, items: CartItem[]): Promise<void> {
    try {
      await fetch(`/api/cart/sync`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ userId, items }),
      });
    } catch (e) {
      console.warn("[cartService] syncCart notice:", e);
    }
  }
};

export const wishlistService = {
  async getWishlist(userId: string): Promise<string[]> {
    try {
      const res = await fetch(`/api/wishlist?userEmail=${encodeURIComponent(userId)}`, {
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data) ? data.map((item: any) => item.product_id || item.productId || item) : [];
      }
    } catch (e) {
      console.warn("[wishlistService] getWishlist notice:", e);
    }
    return [];
  },

  async addToWishlist(userId: string, productId: string): Promise<void> {
    try {
      await fetch(`/api/wishlist`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ userId, productId }),
      });
    } catch (e) {
      console.warn("[wishlistService] addToWishlist notice:", e);
    }
  },

  async removeFromWishlist(userId: string, productId: string): Promise<void> {
    try {
      await fetch(`/api/wishlist/${productId}?userId=${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
    } catch (e) {
      console.warn("[wishlistService] removeFromWishlist notice:", e);
    }
  }
};

// ==========================================
// 5. NOTIFICATIONS SERVICES
// ==========================================

export const notificationService = {
  async getNotifications(userIdOrEmail: string): Promise<InAppNotification[]> {
    if (!userIdOrEmail) return [];
    try {
      const res = await fetch(`/api/notifications?userEmail=${encodeURIComponent(userIdOrEmail)}&userId=${encodeURIComponent(userIdOrEmail)}`, {
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          return data.map((n: any) => ({
            id: n.id,
            userId: n.userId || n.user_id,
            orderId: n.orderId || n.order_id,
            reviewId: n.reviewId || n.review_id,
            title: n.title,
            message: n.message,
            type: n.type || "order_update",
            isRead: n.isRead ?? n.is_read ?? n.read ?? false,
            read: n.isRead ?? n.is_read ?? n.read ?? false,
            createdAt: n.createdAt || n.created_at || new Date().toISOString(),
          }));
        }
      }
    } catch (e) {
      console.warn("[notificationService] getNotifications notice:", e);
    }
    return [];
  },

  async markAsRead(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: "PUT",
        headers: getAuthHeaders(),
      });
      return res.ok;
    } catch (e) {
      console.error("[notificationService] markAsRead error:", e);
      return false;
    }
  },

  async markAllAsRead(userIdOrEmail: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/notifications/read-all`, {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify({ userEmail: userIdOrEmail, userId: userIdOrEmail }),
      });
      return res.ok;
    } catch (e) {
      console.error("[notificationService] markAllAsRead error:", e);
      return false;
    }
  },

  async deleteNotification(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/notifications/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      return res.ok;
    } catch (e) {
      console.error("[notificationService] deleteNotification error:", e);
      return false;
    }
  },

  async clearAllNotifications(userIdOrEmail: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/notifications?userEmail=${encodeURIComponent(userIdOrEmail)}&userId=${encodeURIComponent(userIdOrEmail)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      return res.ok;
    } catch (e) {
      console.error("[notificationService] clearAllNotifications error:", e);
      return false;
    }
  },

  async createNotification(payload: {
    userId: string;
    orderId?: string;
    title: string;
    message: string;
    type?: string;
  }): Promise<InAppNotification | null> {
    try {
      const res = await fetch(`/api/notifications`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.error("[notificationService] createNotification error:", e);
    }
    return null;
  },

  subscribeToUserNotifications(
    userIdOrEmail: string,
    onNewNotification: (notif: InAppNotification) => void
  ) {
    if (!userIdOrEmail) return () => {};

    let lastKnownIds = new Set<string>();
    let isMounted = true;

    const poll = async () => {
      if (!isMounted) return;
      try {
        const notifs = await notificationService.getNotifications(userIdOrEmail);
        notifs.forEach((n) => {
          if (lastKnownIds.size > 0 && !lastKnownIds.has(n.id)) {
            onNewNotification(n);
          }
          lastKnownIds.add(n.id);
        });
      } catch {}
    };

    // Initial check
    poll();
    const interval = setInterval(poll, 15000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }
};
