import crypto from "crypto";
import {
  InventoryItem,
  InventoryTransaction,
  InventoryTransactionType,
  OrderTimelineEvent,
  OrderReturn,
  OrderRefund,
  OrderFulfillment,
  PaymentStatus,
  FulfillmentStatus,
  ShippingStatus,
  StockStatus,
  InventoryKPIs
} from "./types";

// In-Memory Storage Buffers
let memoryInventoryItems: InventoryItem[] = [];
let memoryInventoryTransactions: InventoryTransaction[] = [];
let memoryOrderTimeline: OrderTimelineEvent[] = [];
let memoryOrderReturns: OrderReturn[] = [];
let memoryOrderRefunds: OrderRefund[] = [];
let memoryOrderFulfillments: OrderFulfillment[] = [];

// Helper to generate SKU from Product
export function generateSkuForProduct(prod: any, index: number = 1): string {
  if (prod.sku && prod.sku.trim()) return prod.sku.trim().toUpperCase();
  const categoryPrefix = (prod.categoryId || prod.categoryName || "GEN")
    .toString()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
  const cleanId = (prod.id || "001").toString().replace(/[^0-9]/g, "").slice(0, 3).padStart(3, "0");
  return `VR-${categoryPrefix}-${cleanId || index.toString().padStart(3, "0")}`;
}

// -----------------------------------------------------------------------------
// INVENTORY ITEMS
// -----------------------------------------------------------------------------
export function getInventoryItems(allProducts: any[] = []): InventoryItem[] {
  // Ensure every product in the catalog has an inventory record
  const existingProductIds = new Set(memoryInventoryItems.map((item) => item.productId));

  allProducts.forEach((prod, idx) => {
    if (!existingProductIds.has(prod.id)) {
      const sku = generateSkuForProduct(prod, idx + 1);
      const onHand = Number(prod.stock !== undefined ? prod.stock : 15);
      const retailPrice = Number(prod.price || 500);
      const unitCost = Number(prod.cost || Math.round(retailPrice * 0.42));
      const threshold = Number(prod.lowStockThreshold || 3);
      const committed = 0;
      const unavailable = 0;
      const available = Math.max(0, onHand - committed - unavailable);
      
      let stockStatus: StockStatus = "in_stock";
      if (available === 0) stockStatus = "out_of_stock";
      else if (available <= threshold) stockStatus = "low_stock";

      const newItem: InventoryItem = {
        id: `inv-${prod.id}`,
        productId: prod.id,
        productName: prod.name || "Luxury Item",
        productImage: prod.image || "",
        categoryName: prod.categoryName || "Fine Jewelry",
        categoryId: prod.categoryId || "fine-jewelry",
        sku,
        onHand,
        committed,
        available,
        reserved: 0,
        unavailable,
        lowStockThreshold: threshold,
        unitCost,
        retailPrice,
        stockStatus,
        location: "Main Cairo Vault (Section A-4)",
        updatedAt: new Date().toISOString()
      };

      memoryInventoryItems.push(newItem);
    }
  });

  // Always compute accurate dynamic stock status
  return memoryInventoryItems.map((item) => {
    const available = Math.max(0, item.onHand - item.committed - item.unavailable);
    let stockStatus: StockStatus = "in_stock";
    if (available === 0) stockStatus = "out_of_stock";
    else if (available <= item.lowStockThreshold) stockStatus = "low_stock";

    return {
      ...item,
      available,
      stockStatus
    };
  });
}

export function saveInventoryItemsToDisk(items: InventoryItem[]) {
  memoryInventoryItems = items;
}

// -----------------------------------------------------------------------------
// INVENTORY TRANSACTIONS LOG
// -----------------------------------------------------------------------------
export function getInventoryTransactions(): InventoryTransaction[] {
  return memoryInventoryTransactions;
}

export function recordInventoryTransaction(tx: Omit<InventoryTransaction, "id" | "timestamp">): InventoryTransaction {
  const newTx: InventoryTransaction = {
    id: `tx-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    ...tx,
    timestamp: new Date().toISOString()
  };

  memoryInventoryTransactions.unshift(newTx);
  if (memoryInventoryTransactions.length > 5000) memoryInventoryTransactions.pop();

  return newTx;
}

// -----------------------------------------------------------------------------
// ORDER TIMELINE EVENTS
// -----------------------------------------------------------------------------
export function getOrderTimelineEvents(orderId?: string): OrderTimelineEvent[] {
  if (orderId) {
    return memoryOrderTimeline
      .filter((e) => e.orderId === orderId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
  return memoryOrderTimeline;
}

export function recordOrderTimelineEvent(
  orderId: string,
  event: {
    type: OrderTimelineEvent["type"];
    title: string;
    description: string;
    performedBy?: string;
    actorRole?: "admin" | "system" | "customer";
    metadata?: Record<string, any>;
  }
): OrderTimelineEvent {
  const newEvent: OrderTimelineEvent = {
    id: `tl-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    orderId,
    type: event.type,
    title: event.title,
    description: event.description,
    performedBy: event.performedBy || "System Automations",
    actorRole: event.actorRole || "system",
    timestamp: new Date().toISOString(),
    metadata: event.metadata || {}
  };

  memoryOrderTimeline.push(newEvent);
  if (memoryOrderTimeline.length > 10000) memoryOrderTimeline.shift();

  return newEvent;
}

// -----------------------------------------------------------------------------
// ORDER RETURNS (RMA)
// -----------------------------------------------------------------------------
export function getOrderReturns(orderId?: string): OrderReturn[] {
  if (orderId) {
    return memoryOrderReturns.filter((r) => r.orderId === orderId);
  }
  return memoryOrderReturns;
}

export function saveOrderReturn(returnItem: OrderReturn) {
  const existingIndex = memoryOrderReturns.findIndex((r) => r.id === returnItem.id);
  if (existingIndex >= 0) {
    memoryOrderReturns[existingIndex] = { ...memoryOrderReturns[existingIndex], ...returnItem, updatedAt: new Date().toISOString() };
  } else {
    memoryOrderReturns.unshift(returnItem);
  }
}

// -----------------------------------------------------------------------------
// ORDER REFUNDS
// -----------------------------------------------------------------------------
export function getOrderRefunds(orderId?: string): OrderRefund[] {
  if (orderId) {
    return memoryOrderRefunds.filter((r) => r.orderId === orderId);
  }
  return memoryOrderRefunds;
}

export function saveOrderRefund(refund: OrderRefund) {
  memoryOrderRefunds.unshift(refund);
}

// -----------------------------------------------------------------------------
// ORDER FULFILLMENTS
// -----------------------------------------------------------------------------
export function getOrderFulfillments(orderId?: string): OrderFulfillment[] {
  if (orderId) {
    return memoryOrderFulfillments.filter((f) => f.orderId === orderId);
  }
  return memoryOrderFulfillments;
}

export function saveOrderFulfillment(fulfillment: OrderFulfillment) {
  memoryOrderFulfillments.unshift(fulfillment);
}

// =============================================================================
// CORE INVENTORY FLOW CONTROLLERS
// =============================================================================

/**
 * 1. Automatic Inventory Reservation when Order is Placed:
 *    Committed += quantity, Available = On Hand - Committed - Unavailable
 *    Logs transaction: "X units committed to Order #XXXX"
 */
export function reserveInventoryForOrder(order: any, allProducts: any[] = []): { success: boolean; errors: string[] } {
  const items = getInventoryItems(allProducts);
  const errors: string[] = [];
  const orderNum = order.orderNumber || order.id;

  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return { success: true, errors: [] };
  }

  // Pre-check available quantities
  order.items.forEach((oi: any) => {
    const prodId = oi.product?.id || oi.productId;
    const qty = Number(oi.quantity || 1);
    const item = items.find((i) => i.productId === prodId);
    if (item && item.available < qty) {
      errors.push(`Insufficient stock for "${item.productName}" (SKU: ${item.sku}). Available: ${item.available}, Requested: ${qty}`);
    }
  });

  if (errors.length > 0) {
    console.warn(`[Inventory Reservation Warning] Order ${orderNum}:`, errors);
    // Even if low, we proceed but log warnings
  }

  // Perform atomic reservations and log transactions
  order.items.forEach((oi: any) => {
    const prodId = oi.product?.id || oi.productId;
    const qty = Number(oi.quantity || 1);
    const itemIndex = items.findIndex((i) => i.productId === prodId);

    if (itemIndex >= 0) {
      const current = items[itemIndex];
      const prevOnHand = current.onHand;
      const prevAvailable = current.available;
      
      current.committed += qty;
      current.available = Math.max(0, current.onHand - current.committed - current.unavailable);
      current.updatedAt = new Date().toISOString();

      recordInventoryTransaction({
        productId: current.productId,
        productName: current.productName,
        sku: current.sku,
        type: "order_reserved",
        quantity: qty,
        previousOnHand: prevOnHand,
        newOnHand: current.onHand,
        previousAvailable: prevAvailable,
        newAvailable: current.available,
        referenceType: "order",
        referenceId: String(orderNum),
        reason: `Reserved for active order #${orderNum}`,
        performedBy: "Checkout Automations"
      });
    }
  });

  saveInventoryItemsToDisk(items);

  // Add Initial Order Timeline Events
  recordOrderTimelineEvent(order.id, {
    type: "order_created",
    title: "Order Created",
    description: `Order #${orderNum} placed by customer ${order.shippingName || order.userEmail || "Customer"}`,
    performedBy: order.shippingName || "Customer",
    actorRole: "customer"
  });

  recordOrderTimelineEvent(order.id, {
    type: "inventory_reserved",
    title: "Inventory Allocated & Reserved",
    description: `Physical stock committed for ${order.items.length} line item(s) in Cairo Vault`,
    performedBy: "VERO Inventory Automations",
    actorRole: "system"
  });

  return { success: true, errors };
}

/**
 * 2. Automatic Inventory Release when Order is Cancelled:
 *    Committed -= quantity, Available = On Hand - Committed - Unavailable
 *    Logs transaction: "X units released from cancelled Order #XXXX"
 */
export function releaseInventoryForOrder(order: any, allProducts: any[] = [], cancelledBy: string = "Admin"): boolean {
  if (!order.items || !Array.isArray(order.items)) return false;
  const items = getInventoryItems(allProducts);
  const orderNum = order.orderNumber || order.id;

  order.items.forEach((oi: any) => {
    const prodId = oi.product?.id || oi.productId;
    const qty = Number(oi.quantity || 1);
    const itemIndex = items.findIndex((i) => i.productId === prodId);

    if (itemIndex >= 0) {
      const current = items[itemIndex];
      const prevOnHand = current.onHand;
      const prevAvailable = current.available;

      current.committed = Math.max(0, current.committed - qty);
      current.available = Math.max(0, current.onHand - current.committed - current.unavailable);
      current.updatedAt = new Date().toISOString();

      recordInventoryTransaction({
        productId: current.productId,
        productName: current.productName,
        sku: current.sku,
        type: "order_cancelled",
        quantity: qty,
        previousOnHand: prevOnHand,
        newOnHand: current.onHand,
        previousAvailable: prevAvailable,
        newAvailable: current.available,
        referenceType: "order",
        referenceId: String(orderNum),
        reason: `Committed inventory released due to order cancellation`,
        performedBy: cancelledBy
      });
    }
  });

  saveInventoryItemsToDisk(items);

  recordOrderTimelineEvent(order.id, {
    type: "cancelled",
    title: "Order Cancelled & Stock Released",
    description: `Order cancelled by ${cancelledBy}. Reserved inventory returned to general availability.`,
    performedBy: cancelledBy,
    actorRole: "admin"
  });

  return true;
}

/**
 * 3. Automatic Stock Deduction when Order is Fulfilled & Dispatched:
 *    On Hand -= quantity, Committed -= quantity, Available remains accurate
 *    Logs transaction: "X units fulfilled for Order #XXXX"
 */
export function fulfillInventoryForOrder(
  order: any,
  courier: string = "Aramex",
  trackingNumber: string = "",
  fulfilledBy: string = "Admin",
  allProducts: any[] = []
): OrderFulfillment {
  const items = getInventoryItems(allProducts);
  const orderNum = order.orderNumber || order.id;

  if (order.items && Array.isArray(order.items)) {
    order.items.forEach((oi: any) => {
      const prodId = oi.product?.id || oi.productId;
      const qty = Number(oi.quantity || 1);
      const itemIndex = items.findIndex((i) => i.productId === prodId);

      if (itemIndex >= 0) {
        const current = items[itemIndex];
        const prevOnHand = current.onHand;
        const prevAvailable = current.available;

        current.onHand = Math.max(0, current.onHand - qty);
        current.committed = Math.max(0, current.committed - qty);
        current.available = Math.max(0, current.onHand - current.committed - current.unavailable);
        current.updatedAt = new Date().toISOString();

        recordInventoryTransaction({
          productId: current.productId,
          productName: current.productName,
          sku: current.sku,
          type: "order_fulfilled",
          quantity: -qty,
          previousOnHand: prevOnHand,
          newOnHand: current.onHand,
          previousAvailable: prevAvailable,
          newAvailable: current.available,
          referenceType: "order",
          referenceId: String(orderNum),
          reason: `Fulfilled & dispatched via ${courier} (Tracking: ${trackingNumber || "N/A"})`,
          performedBy: fulfilledBy
        });
      }
    });

    saveInventoryItemsToDisk(items);
  }

  const cleanTracking = trackingNumber || `VR-TRK-${Math.floor(100000 + Math.random() * 900000)}`;
  const fulfillmentRecord: OrderFulfillment = {
    id: `ful-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    orderId: order.id,
    orderNumber: String(orderNum),
    courier,
    trackingNumber: cleanTracking,
    trackingUrl: `https://track.vero.luxury/${cleanTracking}`,
    status: "shipped",
    items: (order.items || []).map((i: any) => ({
      productId: i.product?.id || i.productId,
      quantity: Number(i.quantity || 1)
    })),
    shippedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  saveOrderFulfillment(fulfillmentRecord);

  recordOrderTimelineEvent(order.id, {
    type: "shipped",
    title: `Dispatched with ${courier}`,
    description: `Tracking Number: ${cleanTracking}. Packed and handed over to courier for priority delivery.`,
    performedBy: fulfilledBy,
    actorRole: "admin",
    metadata: { courier, trackingNumber: cleanTracking }
  });

  return fulfillmentRecord;
}

/**
 * 4. Manual Inventory Stock Adjustment with Strict Traceability & Reason:
 */
export function adjustManualInventoryStock(
  productId: string,
  sku: string,
  adjustmentQuantity: number,
  adjustmentType: string,
  reason: string,
  adminName: string,
  notes: string = "",
  allProducts: any[] = []
): { updatedItem: InventoryItem | null; transaction: InventoryTransaction | null; error?: string } {
  const items = getInventoryItems(allProducts);
  const itemIndex = items.findIndex((i) => (sku && i.sku === sku) || i.productId === productId);

  if (itemIndex < 0) {
    return { updatedItem: null, transaction: null, error: `Inventory item with SKU "${sku}" or ID "${productId}" not found.` };
  }

  const item = items[itemIndex];
  const prevOnHand = item.onHand;
  const prevAvailable = item.available;

  const targetOnHand = item.onHand + Number(adjustmentQuantity);
  if (targetOnHand < 0) {
    return { updatedItem: null, transaction: null, error: `Adjustment would result in negative stock (${targetOnHand}). Current on-hand is ${item.onHand}.` };
  }

  item.onHand = targetOnHand;
  item.available = Math.max(0, item.onHand - item.committed - item.unavailable);
  item.updatedAt = new Date().toISOString();

  // Map adjustment type to transaction type
  let txType: InventoryTransactionType = "manual_adjustment";
  if (adjustmentType === "Stock Received") txType = "stock_received";
  else if (adjustmentType === "Damage") txType = "damaged_stock";
  else if (adjustmentType === "Loss") txType = "loss";
  else if (adjustmentType === "Correction") txType = "correction";
  else if (adjustmentType === "Return") txType = "customer_return";

  const tx = recordInventoryTransaction({
    productId: item.productId,
    productName: item.productName,
    sku: item.sku,
    type: txType,
    quantity: Number(adjustmentQuantity),
    previousOnHand: prevOnHand,
    newOnHand: item.onHand,
    previousAvailable: prevAvailable,
    newAvailable: item.available,
    referenceType: "manual",
    referenceId: `ADJ-${Date.now().toString().slice(-6)}`,
    reason: `${adjustmentType}: ${reason}${notes ? ` (${notes})` : ""}`,
    performedBy: adminName || "Administrator"
  });

  saveInventoryItemsToDisk(items);

  return { updatedItem: item, transaction: tx };
}

/**
 * 5. Returns & Restocking Workflow:
 *    When restocked: On Hand += qty, Available += qty, Creates Inventory Transaction
 */
export function restockReturnedItem(
  orderReturn: OrderReturn,
  productId: string,
  quantity: number,
  restockedBy: string = "Admin",
  allProducts: any[] = []
): { success: boolean; item?: InventoryItem; transaction?: InventoryTransaction; error?: string } {
  const items = getInventoryItems(allProducts);
  const itemIndex = items.findIndex((i) => i.productId === productId);

  if (itemIndex < 0) {
    return { success: false, error: `Product ID "${productId}" not found in inventory.` };
  }

  const current = items[itemIndex];
  const prevOnHand = current.onHand;
  const prevAvailable = current.available;

  current.onHand += Number(quantity);
  current.available = Math.max(0, current.onHand - current.committed - current.unavailable);
  current.updatedAt = new Date().toISOString();

  const tx = recordInventoryTransaction({
    productId: current.productId,
    productName: current.productName,
    sku: current.sku,
    type: "customer_return",
    quantity: Number(quantity),
    previousOnHand: prevOnHand,
    newOnHand: current.onHand,
    previousAvailable: prevAvailable,
    newAvailable: current.available,
    referenceType: "return",
    referenceId: orderReturn.id,
    reason: `Restocked ${quantity} unit(s) from Return #${orderReturn.id} (Order #${orderReturn.orderNumber})`,
    performedBy: restockedBy
  });

  saveInventoryItemsToDisk(items);

  recordOrderTimelineEvent(orderReturn.orderId, {
    type: "item_restocked",
    title: "Returned Items Restocked",
    description: `${quantity} unit(s) of "${current.productName}" inspected and restocked into Cairo Vault`,
    performedBy: restockedBy,
    actorRole: "admin",
    metadata: { returnId: orderReturn.id, productId, quantity }
  });

  return { success: true, item: current, transaction: tx };
}

/**
 * 6. Executive Inventory KPIs Aggregator
 */
export function computeInventoryKPIs(allProducts: any[] = []): InventoryKPIs {
  const items = getInventoryItems(allProducts);

  let totalInventoryValue = 0;
  let totalUnitsOnHand = 0;
  let totalAvailableUnits = 0;
  let totalCommittedUnits = 0;
  let totalUnavailableUnits = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  items.forEach((item) => {
    const onHand = Number(item.onHand || 0);
    const available = Math.max(0, onHand - (item.committed || 0) - (item.unavailable || 0));
    const committed = Number(item.committed || 0);
    const unavailable = Number(item.unavailable || 0);
    const unitCost = Number(item.unitCost || item.retailPrice * 0.42 || 0);

    totalUnitsOnHand += onHand;
    totalAvailableUnits += available;
    totalCommittedUnits += committed;
    totalUnavailableUnits += unavailable;
    totalInventoryValue += onHand * unitCost;

    if (available === 0) {
      outOfStockCount++;
    } else if (available <= (item.lowStockThreshold || 3)) {
      lowStockCount++;
    }
  });

  // Calculate annual/quarterly turnover rate proxy
  const turnoverRate = totalUnitsOnHand > 0 ? Number(((totalCommittedUnits * 4.2) / totalUnitsOnHand).toFixed(1)) : 2.4;

  return {
    totalInventoryValue: Math.round(totalInventoryValue),
    totalUnitsOnHand,
    totalAvailableUnits,
    totalCommittedUnits,
    totalUnavailableUnits,
    lowStockCount,
    outOfStockCount,
    totalProductsTracked: items.length,
    inventoryTurnoverRate: Math.max(1.2, turnoverRate)
  };
}
