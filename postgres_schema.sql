-- =============================================================================
-- VERO LUXURY POSTGRESQL DATABASE SCHEMA
-- Application: VERO Luxury E-Commerce Platform
-- Database: PostgreSQL 14+ (Native Self-Hosted / Local / Cloud)
-- Idempotent & Non-Destructive: 100% Safe for Re-execution on Existing Databases
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 1. USERS & PROFILES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT DEFAULT 'default',
  phone TEXT,
  role TEXT DEFAULT 'customer',
  tier TEXT DEFAULT 'Bronze',
  loyalty_points INTEGER DEFAULT 250,
  total_spent NUMERIC(12, 2) DEFAULT 0.00,
  addresses JSONB DEFAULT '[]'::jsonb,
  redeemed_rewards TEXT[] DEFAULT ARRAY[]::TEXT[],
  password_hash TEXT,
  salt TEXT,
  session_token TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent column migrations for users
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='loyalty_points') THEN
    ALTER TABLE public.users ADD COLUMN loyalty_points INTEGER DEFAULT 250;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='total_spent') THEN
    ALTER TABLE public.users ADD COLUMN total_spent NUMERIC(12, 2) DEFAULT 0.00;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='tier') THEN
    ALTER TABLE public.users ADD COLUMN tier TEXT DEFAULT 'Bronze';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='role') THEN
    ALTER TABLE public.users ADD COLUMN role TEXT DEFAULT 'customer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='avatar') THEN
    ALTER TABLE public.users ADD COLUMN avatar TEXT DEFAULT 'default';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='phone') THEN
    ALTER TABLE public.users ADD COLUMN phone TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='addresses') THEN
    ALTER TABLE public.users ADD COLUMN addresses JSONB DEFAULT '[]'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='redeemed_rewards') THEN
    ALTER TABLE public.users ADD COLUMN redeemed_rewards TEXT[] DEFAULT ARRAY[]::TEXT[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='password_hash') THEN
    ALTER TABLE public.users ADD COLUMN password_hash TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='salt') THEN
    ALTER TABLE public.users ADD COLUMN salt TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='session_token') THEN
    ALTER TABLE public.users ADD COLUMN session_token TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='last_login_at') THEN
    ALTER TABLE public.users ADD COLUMN last_login_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='updated_at') THEN
    ALTER TABLE public.users ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

CREATE OR REPLACE VIEW public.profiles AS SELECT * FROM public.users;

-- =============================================================================
-- 2. SESSIONS & AUTHENTICATION TOKENS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  name TEXT,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON public.sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON public.sessions(expires_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions' AND column_name='user_agent') THEN
    ALTER TABLE public.sessions ADD COLUMN user_agent TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions' AND column_name='ip_address') THEN
    ALTER TABLE public.sessions ADD COLUMN ip_address TEXT;
  END IF;
END $$;

-- =============================================================================
-- 3. CATEGORIES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_ar TEXT,
  name_en TEXT,
  slug TEXT UNIQUE NOT NULL,
  image TEXT,
  description TEXT,
  parent_id TEXT REFERENCES public.categories(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'active',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_slug ON public.categories(slug);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='categories' AND column_name='name_ar') THEN
    ALTER TABLE public.categories ADD COLUMN name_ar TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='categories' AND column_name='name_en') THEN
    ALTER TABLE public.categories ADD COLUMN name_en TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='categories' AND column_name='status') THEN
    ALTER TABLE public.categories ADD COLUMN status TEXT DEFAULT 'active';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='categories' AND column_name='sort_order') THEN
    ALTER TABLE public.categories ADD COLUMN sort_order INTEGER DEFAULT 0;
  END IF;
END $$;

-- =============================================================================
-- 4. PRODUCTS & LUXURY CREATIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_ar TEXT,
  name_en TEXT,
  description TEXT,
  description_ar TEXT,
  description_en TEXT,
  price NUMERIC(12, 2) NOT NULL,
  original_price NUMERIC(12, 2),
  sale_price NUMERIC(12, 2),
  sku TEXT UNIQUE,
  stock INTEGER DEFAULT 10,
  on_hand INTEGER DEFAULT 10,
  committed INTEGER DEFAULT 0,
  reserved INTEGER DEFAULT 0,
  unavailable INTEGER DEFAULT 0,
  low_stock_threshold INTEGER DEFAULT 3,
  unit_cost NUMERIC(12, 2) DEFAULT 0.00,
  category_id TEXT REFERENCES public.categories(id) ON DELETE SET NULL,
  category_name TEXT,
  rating NUMERIC(2, 1) DEFAULT 5.0,
  reviews_count INTEGER DEFAULT 0,
  is_new BOOLEAN DEFAULT TRUE,
  is_bestseller BOOLEAN DEFAULT FALSE,
  is_featured BOOLEAN DEFAULT FALSE,
  coming_soon BOOLEAN DEFAULT FALSE,
  pre_order BOOLEAN DEFAULT FALSE,
  points_earned INTEGER DEFAULT 0,
  image TEXT NOT NULL,
  secondary_images TEXT[] DEFAULT ARRAY[]::TEXT[],
  images TEXT[] DEFAULT ARRAY[]::TEXT[],
  sizes TEXT[] DEFAULT ARRAY[]::TEXT[],
  size_options TEXT[] DEFAULT ARRAY[]::TEXT[],
  materials TEXT[] DEFAULT ARRAY[]::TEXT[],
  material_options TEXT[] DEFAULT ARRAY[]::TEXT[],
  colors TEXT[] DEFAULT ARRAY[]::TEXT[],
  details TEXT[] DEFAULT ARRAY[]::TEXT[],
  craftsmanship TEXT DEFAULT '',
  variants JSONB DEFAULT '[]'::jsonb,
  specifications JSONB DEFAULT '[]'::jsonb,
  gender TEXT DEFAULT 'All',
  seo_title TEXT,
  seo_description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON public.products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_sku ON public.products(sku);
CREATE INDEX IF NOT EXISTS idx_products_price ON public.products(price);
CREATE INDEX IF NOT EXISTS idx_products_created ON public.products(created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='name_ar') THEN
    ALTER TABLE public.products ADD COLUMN name_ar TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='name_en') THEN
    ALTER TABLE public.products ADD COLUMN name_en TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='description_ar') THEN
    ALTER TABLE public.products ADD COLUMN description_ar TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='description_en') THEN
    ALTER TABLE public.products ADD COLUMN description_en TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='original_price') THEN
    ALTER TABLE public.products ADD COLUMN original_price NUMERIC(12, 2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='sale_price') THEN
    ALTER TABLE public.products ADD COLUMN sale_price NUMERIC(12, 2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='points_earned') THEN
    ALTER TABLE public.products ADD COLUMN points_earned INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='is_new') THEN
    ALTER TABLE public.products ADD COLUMN is_new BOOLEAN DEFAULT TRUE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='pre_order') THEN
    ALTER TABLE public.products ADD COLUMN pre_order BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='images') THEN
    ALTER TABLE public.products ADD COLUMN images TEXT[] DEFAULT ARRAY[]::TEXT[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='sizes') THEN
    ALTER TABLE public.products ADD COLUMN sizes TEXT[] DEFAULT ARRAY[]::TEXT[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='materials') THEN
    ALTER TABLE public.products ADD COLUMN materials TEXT[] DEFAULT ARRAY[]::TEXT[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='variants') THEN
    ALTER TABLE public.products ADD COLUMN variants JSONB DEFAULT '[]'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='specifications') THEN
    ALTER TABLE public.products ADD COLUMN specifications JSONB DEFAULT '[]'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='gender') THEN
    ALTER TABLE public.products ADD COLUMN gender TEXT DEFAULT 'All';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='seo_title') THEN
    ALTER TABLE public.products ADD COLUMN seo_title TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='seo_description') THEN
    ALTER TABLE public.products ADD COLUMN seo_description TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='details') THEN
    ALTER TABLE public.products ADD COLUMN details TEXT[] DEFAULT ARRAY[]::TEXT[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='craftsmanship') THEN
    ALTER TABLE public.products ADD COLUMN craftsmanship TEXT DEFAULT '';
  END IF;
END $$;

-- =============================================================================
-- 5. CART TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.cart (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id TEXT NOT NULL,
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  quantity INTEGER DEFAULT 1,
  selected_size TEXT,
  selected_material TEXT,
  selected_color TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cart_user ON public.cart(user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cart' AND column_name='selected_size') THEN
    ALTER TABLE public.cart ADD COLUMN selected_size TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cart' AND column_name='selected_material') THEN
    ALTER TABLE public.cart ADD COLUMN selected_material TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cart' AND column_name='selected_color') THEN
    ALTER TABLE public.cart ADD COLUMN selected_color TEXT;
  END IF;
END $$;

-- =============================================================================
-- 6. WISHLIST TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.wishlist (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id TEXT NOT NULL,
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wishlist_user ON public.wishlist(user_id);

-- =============================================================================
-- 7. ORDERS & FINANCIALS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.orders (
  id TEXT PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  user_id TEXT,
  email TEXT NOT NULL,
  shipping_name TEXT NOT NULL,
  shipping_address TEXT NOT NULL,
  shipping_city TEXT NOT NULL,
  governorate TEXT,
  shipping_zip TEXT,
  shipping_phone TEXT,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled',
  shipping_status TEXT DEFAULT 'processing',
  status TEXT NOT NULL DEFAULT 'pending',
  subtotal NUMERIC(12, 2) NOT NULL,
  shipping_cost NUMERIC(12, 2) DEFAULT 0.00,
  discount NUMERIC(12, 2) DEFAULT 0.00,
  amount_paid NUMERIC(12, 2) DEFAULT 0.00,
  amount_refunded NUMERIC(12, 2) DEFAULT 0.00,
  total NUMERIC(12, 2) NOT NULL,
  earned_points INTEGER DEFAULT 0,
  used_points INTEGER DEFAULT 0,
  courier TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  shipment_date TIMESTAMPTZ,
  estimated_delivery TEXT,
  estimated_delivery_date TIMESTAMPTZ,
  admin_notes TEXT,
  customer_notes TEXT,
  returns JSONB DEFAULT '[]'::jsonb,
  timeline JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_email ON public.orders(email);
CREATE INDEX IF NOT EXISTS idx_orders_number ON public.orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment ON public.orders(fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON public.orders(payment_status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='shipping_status') THEN
    ALTER TABLE public.orders ADD COLUMN shipping_status TEXT DEFAULT 'processing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='governorate') THEN
    ALTER TABLE public.orders ADD COLUMN governorate TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='shipping_cost') THEN
    ALTER TABLE public.orders ADD COLUMN shipping_cost NUMERIC(12, 2) DEFAULT 0.00;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='amount_refunded') THEN
    ALTER TABLE public.orders ADD COLUMN amount_refunded NUMERIC(12, 2) DEFAULT 0.00;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='courier') THEN
    ALTER TABLE public.orders ADD COLUMN courier TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='tracking_number') THEN
    ALTER TABLE public.orders ADD COLUMN tracking_number TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='tracking_url') THEN
    ALTER TABLE public.orders ADD COLUMN tracking_url TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='shipment_date') THEN
    ALTER TABLE public.orders ADD COLUMN shipment_date TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='returns') THEN
    ALTER TABLE public.orders ADD COLUMN returns JSONB DEFAULT '[]'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='timeline') THEN
    ALTER TABLE public.orders ADD COLUMN timeline JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- =============================================================================
-- 8. ORDER ITEMS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES public.products(id) ON DELETE SET NULL,
  sku TEXT,
  name TEXT NOT NULL,
  price NUMERIC(12, 2) NOT NULL,
  unit_price NUMERIC(12, 2),
  quantity INTEGER NOT NULL DEFAULT 1,
  size TEXT,
  material TEXT,
  color TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items(order_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='size') THEN
    ALTER TABLE public.order_items ADD COLUMN size TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='material') THEN
    ALTER TABLE public.order_items ADD COLUMN material TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='color') THEN
    ALTER TABLE public.order_items ADD COLUMN color TEXT;
  END IF;
END $$;

-- =============================================================================
-- 9. ORDER RETURNS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.order_returns (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_number TEXT,
  return_number TEXT,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  refund_method TEXT NOT NULL DEFAULT 'original_payment',
  refund_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  restock_items BOOLEAN NOT NULL DEFAULT TRUE,
  restocked BOOLEAN NOT NULL DEFAULT FALSE,
  restocked_by TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL,
  notes TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_returns_order ON public.order_returns(order_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_returns' AND column_name='order_number') THEN
    ALTER TABLE public.order_returns ADD COLUMN order_number TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_returns' AND column_name='requested_at') THEN
    ALTER TABLE public.order_returns ADD COLUMN requested_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_returns' AND column_name='restocked_by') THEN
    ALTER TABLE public.order_returns ADD COLUMN restocked_by TEXT;
  END IF;
  -- Make return_number optional if it existed with strict NOT NULL
  BEGIN
    ALTER TABLE public.order_returns ALTER COLUMN return_number DROP NOT NULL;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- =============================================================================
-- 10. ORDER REFUNDS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.order_refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_number TEXT,
  amount NUMERIC(12, 2) NOT NULL,
  reason TEXT NOT NULL,
  refund_method TEXT NOT NULL DEFAULT 'original_payment',
  payment_method TEXT DEFAULT 'original_payment',
  type TEXT DEFAULT 'full',
  processed_by TEXT NOT NULL DEFAULT 'Admin',
  issued_by TEXT DEFAULT 'Admin',
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_order ON public.order_refunds(order_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_refunds' AND column_name='order_number') THEN
    ALTER TABLE public.order_refunds ADD COLUMN order_number TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_refunds' AND column_name='payment_method') THEN
    ALTER TABLE public.order_refunds ADD COLUMN payment_method TEXT DEFAULT 'original_payment';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_refunds' AND column_name='type') THEN
    ALTER TABLE public.order_refunds ADD COLUMN type TEXT DEFAULT 'full';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_refunds' AND column_name='issued_by') THEN
    ALTER TABLE public.order_refunds ADD COLUMN issued_by TEXT DEFAULT 'Admin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_refunds' AND column_name='issued_at') THEN
    ALTER TABLE public.order_refunds ADD COLUMN issued_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_refunds' AND column_name='notes') THEN
    ALTER TABLE public.order_refunds ADD COLUMN notes TEXT;
  END IF;
END $$;

-- =============================================================================
-- 11. REVIEWS & RATINGS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.reviews (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  user_avatar TEXT DEFAULT 'default',
  user_email TEXT NOT NULL,
  rating NUMERIC(2, 1) NOT NULL,
  title TEXT,
  comment TEXT NOT NULL,
  helpful_count INTEGER DEFAULT 0,
  verified_purchase BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'approved',
  reply TEXT,
  reply_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_product ON public.reviews(product_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reviews' AND column_name='helpful_count') THEN
    ALTER TABLE public.reviews ADD COLUMN helpful_count INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reviews' AND column_name='verified_purchase') THEN
    ALTER TABLE public.reviews ADD COLUMN verified_purchase BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reviews' AND column_name='status') THEN
    ALTER TABLE public.reviews ADD COLUMN status TEXT DEFAULT 'approved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reviews' AND column_name='reply') THEN
    ALTER TABLE public.reviews ADD COLUMN reply TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reviews' AND column_name='reply_date') THEN
    ALTER TABLE public.reviews ADD COLUMN reply_date TIMESTAMPTZ;
  END IF;
END $$;

-- =============================================================================
-- 12. REVIEW REPLIES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.review_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id TEXT REFERENCES public.reviews(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  comment TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_replies_review ON public.review_replies(review_id);

-- =============================================================================
-- 13. REVIEW REPORTS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.review_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id TEXT REFERENCES public.reviews(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  reporter_email TEXT,
  reporter_name TEXT DEFAULT 'Customer',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_reports_review ON public.review_reports(review_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='review_reports' AND column_name='reporter_name') THEN
    ALTER TABLE public.review_reports ADD COLUMN reporter_name TEXT DEFAULT 'Customer';
  END IF;
END $$;

-- =============================================================================
-- 14. COUPONS & PROMOTIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.coupons (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  discount_value NUMERIC(12, 2) DEFAULT 0.00,
  discount_type TEXT DEFAULT 'percentage',
  max_discount NUMERIC(12, 2),
  min_order_amount NUMERIC(12, 2) DEFAULT 0.00,
  active BOOLEAN DEFAULT TRUE,
  expiry_date TIMESTAMPTZ,
  usage_count INTEGER DEFAULT 0,
  usage_limit INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupons_code ON public.coupons(code);

-- =============================================================================
-- 15. LOYALTY & REWARDS TRANSACTIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.loyalty_points (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT,
  reference_id TEXT,
  performed_by TEXT DEFAULT 'System',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_points_user ON public.loyalty_points(user_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_points_created ON public.loyalty_points(created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loyalty_points' AND column_name='reason') THEN
    ALTER TABLE public.loyalty_points ADD COLUMN reason TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loyalty_points' AND column_name='reference_id') THEN
    ALTER TABLE public.loyalty_points ADD COLUMN reference_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loyalty_points' AND column_name='performed_by') THEN
    ALTER TABLE public.loyalty_points ADD COLUMN performed_by TEXT DEFAULT 'System';
  END IF;
END $$;

-- =============================================================================
-- 16. NOTIFICATIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  order_id TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'order_update',
  is_read BOOLEAN DEFAULT FALSE,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name='read') THEN
    ALTER TABLE public.notifications ADD COLUMN read BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- =============================================================================
-- 17. AUDIT LOGS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT,
  admin_email TEXT,
  user_id TEXT,
  user_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  resource TEXT,
  details TEXT,
  ip TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs(created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' AND column_name='admin_id') THEN
    ALTER TABLE public.audit_logs ADD COLUMN admin_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' AND column_name='admin_email') THEN
    ALTER TABLE public.audit_logs ADD COLUMN admin_email TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' AND column_name='target') THEN
    ALTER TABLE public.audit_logs ADD COLUMN target TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' AND column_name='resource') THEN
    ALTER TABLE public.audit_logs ADD COLUMN resource TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' AND column_name='ip') THEN
    ALTER TABLE public.audit_logs ADD COLUMN ip TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' AND column_name='ip_address') THEN
    ALTER TABLE public.audit_logs ADD COLUMN ip_address TEXT;
  END IF;
END $$;

-- =============================================================================
-- 18. ANALYTICS & VISITOR TELEMETRY TABLES
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.analytics_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  user_id TEXT,
  device_type TEXT DEFAULT 'desktop',
  browser TEXT,
  os TEXT,
  referrer TEXT,
  landing_page TEXT,
  country TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_sessions_vid ON public.analytics_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_sid ON public.analytics_sessions(session_id);

CREATE TABLE IF NOT EXISTS public.analytics_page_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES public.analytics_sessions(session_id) ON DELETE CASCADE,
  user_id TEXT,
  path TEXT NOT NULL,
  title TEXT,
  referrer TEXT,
  duration_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_pageviews_sid ON public.analytics_page_views(session_id);

CREATE TABLE IF NOT EXISTS public.analytics_product_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES public.analytics_sessions(session_id) ON DELETE CASCADE,
  user_id TEXT,
  product_id TEXT NOT NULL,
  product_name TEXT,
  duration_seconds INTEGER DEFAULT 0,
  referrer TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_prodviews_pid ON public.analytics_product_views(product_id);

CREATE TABLE IF NOT EXISTS public.analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT,
  event_name TEXT NOT NULL,
  event_category TEXT DEFAULT 'interaction',
  event_label TEXT,
  event_value NUMERIC(12, 2),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON public.analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_vid ON public.analytics_events(visitor_id);

-- =============================================================================
-- 19. SHIPPING RATES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.shipping_rates (
  id TEXT PRIMARY KEY,
  governorate TEXT UNIQUE NOT NULL,
  governorate_ar TEXT NOT NULL,
  rate NUMERIC(10, 2) NOT NULL DEFAULT 50.00,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_shipping_rate_bounds CHECK (rate >= 0 AND rate <= 90)
);

CREATE INDEX IF NOT EXISTS idx_shipping_rates_governorate ON public.shipping_rates(governorate);
CREATE INDEX IF NOT EXISTS idx_shipping_rates_is_active ON public.shipping_rates(is_active);

-- Seed initial 27 Egyptian Governorates
INSERT INTO public.shipping_rates (id, governorate, governorate_ar, rate, is_active)
VALUES
  ('cairo', 'Cairo', 'القاهرة', 50.00, true),
  ('giza', 'Giza', 'الجيزة', 50.00, true),
  ('qalyubia', 'Qalyubia', 'القليوبية', 60.00, true),
  ('alexandria', 'Alexandria', 'الإسكندرية', 70.00, true),
  ('dakahlia', 'Dakahlia', 'الدقهلية', 70.00, true),
  ('sharqia', 'Sharqia', 'الشرقية', 70.00, true),
  ('gharbia', 'Gharbia', 'الغربية', 70.00, true),
  ('monufia', 'Monufia', 'المنوفية', 70.00, true),
  ('beheira', 'Beheira', 'البحيرة', 75.00, true),
  ('kafr_el_sheikh', 'Kafr El Sheikh', 'كفر الشيخ', 75.00, true),
  ('damietta', 'Damietta', 'دمياط', 75.00, true),
  ('port_said', 'Port Said', 'بورسعيد', 75.00, true),
  ('ismailia', 'Ismailia', 'الإسماعيلية', 75.00, true),
  ('suez', 'Suez', 'السويس', 75.00, true),
  ('fayoum', 'Fayoum', 'الفيوم', 80.00, true),
  ('beni_suef', 'Beni Suef', 'بني سويف', 80.00, true),
  ('minya', 'Minya', 'المنيا', 90.00, true),
  ('assiut', 'Assiut', 'أسيوط', 90.00, true),
  ('sohag', 'Sohag', 'سوهاج', 90.00, true),
  ('qena', 'Qena', 'قنا', 90.00, true),
  ('luxor', 'Luxor', 'الأقصر', 90.00, true),
  ('aswan', 'Aswan', 'أسوان', 90.00, true),
  ('red_sea', 'Red Sea', 'البحر الأحمر', 90.00, true),
  ('new_valley', 'New Valley', 'الوادي الجديد', 90.00, true),
  ('north_sinai', 'North Sinai', 'شمال سيناء', 90.00, true),
  ('south_sinai', 'South Sinai', 'جنوب سيناء', 90.00, true),
  ('matrouh', 'Matrouh', 'مطروح', 90.00, true)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 20. CONTACT & CONCIERGE MESSAGES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  order_number TEXT,
  inquiry_type TEXT DEFAULT 'general',
  contact_method TEXT DEFAULT 'email',
  subject TEXT,
  message TEXT NOT NULL,
  user_tier TEXT DEFAULT 'Guest',
  status TEXT DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_email ON public.contact_messages(email);
CREATE INDEX IF NOT EXISTS idx_contact_messages_ticket ON public.contact_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_contact_messages_status ON public.contact_messages(status);

-- =============================================================================
-- 21. AUTOMATIC TIMESTAMPS & TRIGGERS
-- =============================================================================
CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_modtime') THEN
    CREATE TRIGGER update_users_modtime BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_products_modtime') THEN
    CREATE TRIGGER update_products_modtime BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_categories_modtime') THEN
    CREATE TRIGGER update_categories_modtime BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_orders_modtime') THEN
    CREATE TRIGGER update_orders_modtime BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_shipping_rates_modtime') THEN
    CREATE TRIGGER update_shipping_rates_modtime BEFORE UPDATE ON public.shipping_rates FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_contact_messages_modtime') THEN
    CREATE TRIGGER update_contact_messages_modtime BEFORE UPDATE ON public.contact_messages FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
  END IF;
END $$;

-- =============================================================================
-- 22. ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_page_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_product_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

-- Clean and idempotent RLS Policies
DO $$ BEGIN
  -- Public Read Policies
  DROP POLICY IF EXISTS "Public Read Categories" ON public.categories;
  CREATE POLICY "Public Read Categories" ON public.categories FOR SELECT USING (true);

  DROP POLICY IF EXISTS "Public Read Products" ON public.products;
  CREATE POLICY "Public Read Products" ON public.products FOR SELECT USING (true);

  DROP POLICY IF EXISTS "Public Read Reviews" ON public.reviews;
  CREATE POLICY "Public Read Reviews" ON public.reviews FOR SELECT USING (true);

  DROP POLICY IF EXISTS "Public Read Coupons" ON public.coupons;
  CREATE POLICY "Public Read Coupons" ON public.coupons FOR SELECT USING (true);

  DROP POLICY IF EXISTS "Public Read Shipping Rates" ON public.shipping_rates;
  CREATE POLICY "Public Read Shipping Rates" ON public.shipping_rates FOR SELECT USING (true);

  -- Full Access Policies for App Engine & Service API
  DROP POLICY IF EXISTS "Allow All Full Access Users" ON public.users;
  CREATE POLICY "Allow All Full Access Users" ON public.users FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Sessions" ON public.sessions;
  CREATE POLICY "Allow All Full Access Sessions" ON public.sessions FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Categories" ON public.categories;
  CREATE POLICY "Allow All Full Access Categories" ON public.categories FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Products" ON public.products;
  CREATE POLICY "Allow All Full Access Products" ON public.products FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Orders" ON public.orders;
  CREATE POLICY "Allow All Full Access Orders" ON public.orders FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Order Items" ON public.order_items;
  CREATE POLICY "Allow All Full Access Order Items" ON public.order_items FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Order Returns" ON public.order_returns;
  CREATE POLICY "Allow All Full Access Order Returns" ON public.order_returns FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Order Refunds" ON public.order_refunds;
  CREATE POLICY "Allow All Full Access Order Refunds" ON public.order_refunds FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Cart" ON public.cart;
  CREATE POLICY "Allow All Full Access Cart" ON public.cart FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Wishlist" ON public.wishlist;
  CREATE POLICY "Allow All Full Access Wishlist" ON public.wishlist FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Reviews" ON public.reviews;
  CREATE POLICY "Allow All Full Access Reviews" ON public.reviews FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Review Replies" ON public.review_replies;
  CREATE POLICY "Allow All Full Access Review Replies" ON public.review_replies FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Review Reports" ON public.review_reports;
  CREATE POLICY "Allow All Full Access Review Reports" ON public.review_reports FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Coupons" ON public.coupons;
  CREATE POLICY "Allow All Full Access Coupons" ON public.coupons FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Loyalty" ON public.loyalty_points;
  CREATE POLICY "Allow All Full Access Loyalty" ON public.loyalty_points FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Notifications" ON public.notifications;
  CREATE POLICY "Allow All Full Access Notifications" ON public.notifications FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Audit Logs" ON public.audit_logs;
  CREATE POLICY "Allow All Full Access Audit Logs" ON public.audit_logs FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Shipping Rates" ON public.shipping_rates;
  CREATE POLICY "Allow All Full Access Shipping Rates" ON public.shipping_rates FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Full Access Contact Messages" ON public.contact_messages;
  CREATE POLICY "Allow All Full Access Contact Messages" ON public.contact_messages FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Analytics Sessions" ON public.analytics_sessions;
  CREATE POLICY "Allow All Analytics Sessions" ON public.analytics_sessions FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Analytics Pageviews" ON public.analytics_page_views;
  CREATE POLICY "Allow All Analytics Pageviews" ON public.analytics_page_views FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Analytics Prodviews" ON public.analytics_product_views;
  CREATE POLICY "Allow All Analytics Prodviews" ON public.analytics_product_views FOR ALL USING (true);

  DROP POLICY IF EXISTS "Allow All Analytics Events" ON public.analytics_events;
  CREATE POLICY "Allow All Analytics Events" ON public.analytics_events FOR ALL USING (true);
END $$;

-- =============================================================================
-- END OF VERO LUXURY POSTGRESQL SCHEMA
-- =============================================================================
