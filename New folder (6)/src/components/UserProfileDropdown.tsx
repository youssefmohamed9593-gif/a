import React from "react";
import { UserProfile, Reward } from "../types";
import { motion, AnimatePresence } from "motion/react";
import {
  LogOut,
  Award,
  Shield,
  Gift,
  Clipboard,
  CreditCard,
  ChevronRight,
  X,
  Sparkles,
  Check,
  Copy,
  User,
  Mail,
  Calendar,
  Edit2,
  Package,
  TrendingUp,
  ExternalLink,
  ShoppingBag,
  ShieldCheck,
  CheckCircle2,
  Lock,
  ArrowRight
} from "lucide-react";
import UserAvatar from "./UserAvatar";
import { safeFetch } from "../utils/apiUtils";

interface UserProfileDropdownProps {
  user: UserProfile;
  isOpen: boolean;
  onClose: () => void;
  onLogout: () => void;
  onOpenOrders?: () => void;
  onUpdateUser: (profile: UserProfile) => void;
}

export default function UserProfileDropdown({
  user,
  isOpen,
  onClose,
  onLogout,
  onUpdateUser,
}: UserProfileDropdownProps) {
  const [activeSubTab, setActiveSubTab] = React.useState<"overview" | "rewards">("overview");
  const [userOrders, setUserOrders] = React.useState<any[]>([]);
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const [rewards, setRewards] = React.useState<Reward[]>([]);
  const [showAccountDetails, setShowAccountDetails] = React.useState(false);

  // Inline name editing
  const [isEditingName, setIsEditingName] = React.useState(false);
  const [editedName, setEditedName] = React.useState(user.name);

  React.useEffect(() => {
    setEditedName(user.name);
  }, [user.name]);

  const handleSaveName = async () => {
    const trimmed = editedName.trim();
    if (!trimmed || trimmed === user.name) {
      setIsEditingName(false);
      return;
    }
    const updatedUser = { ...user, name: trimmed };
    onUpdateUser(updatedUser);
    setIsEditingName(false);
    setSuccessMessage("تم تحديث اسم الحساب بنجاح / Name updated successfully");
    setTimeout(() => setSuccessMessage(null), 3500);

    try {
      await fetch("/api/users/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, name: trimmed }),
      });
    } catch (e) {
      // non-blocking
    }
  };

  React.useEffect(() => {
    if (isOpen) {
      safeFetch("/api/rewards")
        .then((res) => {
          if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
            return res.json();
          }
          return [];
        })
        .then((data) => setRewards(Array.isArray(data) ? data : []))
        .catch((err) => console.warn("Notice loading rewards:", err?.message || err));
    }
  }, [isOpen]);

  React.useEffect(() => {
    if (isOpen && user.email) {
      safeFetch(`/api/loyalty/history?email=${encodeURIComponent(user.email)}`)
        .then((res) => {
          if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
            return res.json();
          }
          return null;
        })
        .then((data) => {
          if (data && typeof data.points === "number") {
            const pts = data.points;
            const tr = data.tier || user.tier;
            const spnt = data.totalSpent !== undefined ? data.totalSpent : user.totalSpent;
            if (pts !== user.loyaltyPoints || tr !== user.tier || spnt !== user.totalSpent) {
              onUpdateUser({
                ...user,
                loyaltyPoints: pts,
                tier: tr,
                totalSpent: spnt,
              });
            }
          }
        })
        .catch((err) => console.warn("Notice syncing user loyalty details:", err?.message || err));
    }
  }, [isOpen, user.email, onUpdateUser]);

  // Daily Check-In state
  const todayStr = new Date().toDateString();
  const checkInKey = `vero_checkin_${user.email}`;
  const [hasCheckedInToday, setHasCheckedInToday] = React.useState(() => {
    return localStorage.getItem(checkInKey) === todayStr;
  });

  // Fetch real orders for user
  React.useEffect(() => {
    if (isOpen) {
      const loadOrders = async () => {
        try {
          const res = await safeFetch("/api/orders");
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
              const matched = data.filter((o: any) => {
                const oEmail = (o.shippingEmail || o.email || o.userEmail || "").toLowerCase().trim();
                const uEmail = (user.email || "").toLowerCase().trim();
                return oEmail && uEmail && oEmail === uEmail;
              });
              if (matched.length > 0) {
                setUserOrders(matched);
                return;
              }
            }
          }
        } catch (e) {
          // ignore
        }

        const savedOrders = localStorage.getItem("vero_orders");
        if (savedOrders) {
          try {
            const allOrders = JSON.parse(savedOrders);
            const filtered = allOrders.filter(
              (o: any) => (o.email || o.shippingEmail || "").toLowerCase().trim() === (user.email || "").toLowerCase().trim()
            );
            if (filtered.length > 0) {
              setUserOrders(filtered);
              return;
            }
          } catch (e) {}
        }

        // Default to empty array if no orders
        setUserOrders([]);
      };

      loadOrders();
    }
  }, [isOpen, user.email]);

  const handleDailyCheckIn = () => {
    if (hasCheckedInToday) return;

    const updatedUser: UserProfile = {
      ...user,
      loyaltyPoints: (user.loyaltyPoints || 0) + 10,
    };

    localStorage.setItem(checkInKey, todayStr);
    setHasCheckedInToday(true);
    onUpdateUser(updatedUser);

    setSuccessMessage("تم تسجيل الحضور اليومي بنجاح! حصلت على +10 نقطة 🎁");
    setTimeout(() => setSuccessMessage(null), 4000);
  };

  const handleRedeemReward = (reward: Reward) => {
    if ((user.loyaltyPoints || 0) < reward.cost) return;

    const currentRedeemed = user.redeemedRewards || [];
    const updatedUser: UserProfile = {
      ...user,
      loyaltyPoints: (user.loyaltyPoints || 0) - reward.cost,
      redeemedRewards: [...currentRedeemed, `${reward.titleEn} (Code: ${reward.code})`],
    };

    onUpdateUser(updatedUser);
    setSuccessMessage(`تم استبدال الجائزة بنجاح! كود الخصم: ${reward.code}`);
    setTimeout(() => setSuccessMessage(null), 5000);
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  // Tier progression data
  const spent = user.totalSpent || 0;
  const currentTier = user.tier || "Bronze";

  const tierLevels = [
    { name: "Bronze", nameAr: "البرونزي", min: 0, max: 5000, next: "Silver", nextAr: "الفضي" },
    { name: "Silver", nameAr: "الفضي", min: 5000, max: 15000, next: "Gold", nextAr: "الذهبي" },
    { name: "Gold", nameAr: "الذهبي", min: 15000, max: 35000, next: "Platinum", nextAr: "البلاتيني" },
    { name: "Platinum", nameAr: "البلاتيني", min: 35000, max: 75000, next: "Diamond", nextAr: "الماسي" },
    { name: "Diamond", nameAr: "الماسي", min: 75000, max: Infinity, next: null, nextAr: null },
  ];

  const currentTierData = tierLevels.find((t) => t.name.toLowerCase() === currentTier.toLowerCase()) || tierLevels[0];
  const nextTierName = currentTierData.next;
  const nextTierNameAr = currentTierData.nextAr;
  const nextTierTarget = currentTierData.max;
  const remainingForNextTier = nextTierName ? Math.max(0, nextTierTarget - spent) : 0;
  const tierProgressPct = nextTierName
    ? Math.min(100, Math.max(8, Math.round(((spent - currentTierData.min) / (nextTierTarget - currentTierData.min)) * 100)))
    : 100;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Click-outside backdrop to close */}
          <motion.div
            id="user-dropdown-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1.5px]"
          />

          {/* Dropdown Container: Fixed under mobile header, absolute top-full under desktop button */}
          <motion.div
            id="user-dropdown-container"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed inset-x-3 top-16 sm:top-auto sm:inset-auto sm:absolute sm:right-0 sm:top-full sm:mt-2 w-auto sm:w-[350px] max-h-[calc(100dvh-85px)] sm:max-h-[calc(100dvh-105px)] flex flex-col rounded-2xl bg-[#fffcf9] border border-stone-200/90 shadow-[0_15px_45px_rgba(0,0,0,0.16)] p-3 sm:p-3.5 text-stone-900 z-50 text-left overflow-hidden"
          >
            {/* Header bar */}
            <div className="flex justify-between items-center pb-2 border-b border-stone-200/60 shrink-0">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-[#ba9b72]" />
                <span className="text-[9px] uppercase tracking-[0.2em] font-bold text-[#ba9b72]">
                  VERO ELITE VAULT
                </span>
              </div>
              <button
                onClick={onClose}
                className="p-1 rounded-full text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer"
                aria-label="Close"
              >
                <X className="w-3.5 h-3.5 stroke-[1.5]" />
              </button>
            </div>

            {/* Member Profile Avatar & Name */}
            <div className="mt-2.5 flex items-center gap-2.5 shrink-0">
              <UserAvatar
                name={user.name}
                avatar={user.avatar}
                tier={user.tier || "Bronze"}
                className="w-10 h-10 shrink-0"
              />
              <div className="min-w-0 flex-1">
                {isEditingName ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={editedName}
                      onChange={(e) => setEditedName(e.target.value)}
                      className="text-xs px-2 py-0.5 border border-stone-300 rounded bg-white font-medium text-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-400 w-28"
                      placeholder="Name"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleSaveName}
                      className="p-1 bg-[#ba9b72] text-white rounded hover:bg-[#a3855a] transition-colors"
                      title="حفظ"
                    >
                      <Check className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditedName(user.name);
                        setIsEditingName(false);
                      }}
                      className="p-1 text-stone-400 hover:text-stone-600 rounded"
                      title="إلغاء"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 group/name">
                    <h3 className="font-serif text-base font-bold uppercase text-stone-900 tracking-wide leading-tight truncate">
                      {user.name || "VERO"}
                    </h3>
                    <button
                      type="button"
                      onClick={() => setIsEditingName(true)}
                      className="opacity-0 group-hover/name:opacity-100 p-0.5 text-stone-400 hover:text-stone-700 transition-opacity"
                      title="Edit name"
                    >
                      <Edit2 className="w-2.5 h-2.5" />
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-1 text-[9px] font-bold text-[#9e7d51] tracking-wider uppercase mt-0.5">
                  <Award className="w-3 h-3 text-[#9e7d51] stroke-[2]" />
                  <span>{user.tier ? user.tier.toUpperCase() : "BRONZE"} MEMBER</span>
                </div>
                <span className="text-[11px] text-stone-400 font-normal truncate block mt-0.5">
                  {user.email}
                </span>
              </div>
            </div>

            {/* Inner Tabs Navigation */}
            <div className="flex items-center gap-4 sm:gap-5 border-b border-stone-200/60 mt-2.5 text-[11px] shrink-0">
              <button
                type="button"
                onClick={() => setActiveSubTab("overview")}
                className={`pb-1.5 transition-all cursor-pointer whitespace-nowrap ${
                  activeSubTab === "overview"
                    ? "text-stone-900 font-bold border-b-2 border-stone-900 -mb-[1px]"
                    : "text-stone-400 hover:text-stone-700 font-medium border-b-2 border-transparent"
                }`}
              >
                الملف التعريفي / Profile
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab("rewards")}
                className={`pb-1.5 transition-all cursor-pointer whitespace-nowrap ${
                  activeSubTab === "rewards"
                    ? "text-stone-900 font-bold border-b-2 border-stone-900 -mb-[1px]"
                    : "text-stone-400 hover:text-stone-700 font-medium border-b-2 border-transparent"
                }`}
              >
                متجر الجوائز
              </button>
            </div>

            {/* Global Feedback notification */}
            <AnimatePresence>
              {successMessage && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="mt-2 bg-[#ba9b72]/15 text-[#8a6a3b] border border-[#ba9b72]/30 rounded-xl px-2.5 py-1 text-[9px] text-center font-bold shrink-0"
                >
                  {successMessage}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Scrollable Subtab Content Container */}
            <div className="flex-1 overflow-y-auto pr-0.5 mt-2.5 space-y-2.5 scrollbar-thin">
              {/* TAB 1: OVERVIEW & FULL PROFILE */}
              {activeSubTab === "overview" && (
                <div className="space-y-2.5">
                  {/* Compact Gold VIP Membership Card */}
                  <div
                    className="relative overflow-hidden rounded-xl p-3 sm:p-3.5 shadow-[0_8px_20px_rgba(150,105,35,0.18)] text-white select-none"
                    style={{
                      background: "linear-gradient(115deg, #a7772e 0%, #c49646 28%, #ebd6a8 52%, #dbbc7c 70%, #8d6219 100%)",
                    }}
                  >
                    {/* Soft satin diagonal sheen highlight */}
                    <div
                      className="absolute inset-0 pointer-events-none opacity-30 mix-blend-overlay"
                      style={{
                        background: "radial-gradient(ellipse at 70% 30%, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 65%)",
                      }}
                    />

                    <div className="relative z-10">
                      <div className="flex justify-between items-start">
                        <span className="text-[8px] font-extrabold tracking-[0.2em] uppercase text-white/90 block">
                          VERO ELITE CLUB
                        </span>
                        <span className="text-[8px] bg-white/20 backdrop-blur-xs px-1.5 py-0.5 rounded-full uppercase tracking-wider font-bold">
                          {user.tier || "Bronze"}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 mt-1.5">
                        {/* Medal badge */}
                        <svg className="w-4 h-4 shrink-0 drop-shadow-xs" viewBox="0 0 32 32" fill="none">
                          <polygon points="11,2 6,15 11,15 13,8" fill="#22c55e" />
                          <polygon points="8,2 6,15 9,15 11,2" fill="#15803d" />
                          <polygon points="21,2 26,15 21,15 19,8" fill="#22c55e" />
                          <polygon points="24,2 26,15 23,15 21,2" fill="#15803d" />
                          <polygon points="13,8 11,15 21,15 19,8" fill="#166534" />
                          <polygon points="15,2 14,14 18,14 17,2" fill="#dc2626" />
                          <circle cx="16" cy="21" r="9" fill="#9a5a22" stroke="#ea580c" strokeWidth="1.5" />
                          <circle cx="16" cy="21" r="7" fill="#c27838" />
                          <circle cx="16" cy="21" r="5.5" stroke="#7c3a12" strokeWidth="1" strokeDasharray="1.5 1.5" fill="none" />
                          <text x="16" y="24" textAnchor="middle" fill="#542407" fontSize="8" fontWeight="bold" fontFamily="serif">3</text>
                        </svg>
                        <h3 className="font-serif font-black text-xs sm:text-sm tracking-wide uppercase text-white drop-shadow-xs">
                          {user.tier ? `${user.tier.toUpperCase()} COLLECTOR` : "BRONZE COLLECTOR"}
                        </h3>
                      </div>

                      <div className="pt-3.5 flex justify-between items-end">
                        <div>
                          <span className="text-[7px] uppercase tracking-[0.15em] font-bold text-white/75 block">
                            COLLECTOR SIGNATURE
                          </span>
                          <span className="font-serif italic font-bold text-white text-xs sm:text-sm tracking-wide capitalize mt-0.5 block">
                            {(user.name || "vero").toLowerCase()}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => setActiveSubTab("rewards")}
                          className="text-right group/pts cursor-pointer"
                          title="افتح متجر الجوائز / Open Rewards Vault"
                        >
                          <span className="text-[7px] uppercase tracking-[0.15em] font-bold text-white/75 flex items-center justify-end gap-1">
                            POINT BALANCE <span className="text-[10px]">🎁</span>
                          </span>
                          <span className="font-mono font-bold text-white text-xs sm:text-sm tracking-wider underline underline-offset-4 decoration-white/90 mt-0.5 block group-hover/pts:text-amber-100 transition-colors">
                            {user.loyaltyPoints || 0} PTS
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Daily Check-In Bonus Banner (10 Points) */}
                  <div className="p-2 sm:p-2.5 bg-[#fff8f0] border border-[#e8d7c0] rounded-xl flex items-center justify-between gap-2 shadow-2xs">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-md bg-[#ba9b72]/15 flex items-center justify-center text-[#ba9b72] shrink-0">
                        <Gift className="w-3.5 h-3.5" />
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-stone-900 leading-tight">تسجيل الحضور اليومي</p>
                        <p className="text-[8px] text-stone-500 mt-0.5">احصل على +10 نقاط ولاء يومياً</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleDailyCheckIn}
                      disabled={hasCheckedInToday}
                      className={`px-2.5 py-1 rounded-lg text-[9px] font-bold tracking-wider transition-all flex items-center gap-1 shrink-0 ${
                        hasCheckedInToday
                          ? "bg-emerald-100/90 text-emerald-800 cursor-default"
                          : "bg-[#ba9b72] hover:bg-[#a5865d] text-white cursor-pointer active:scale-95 shadow-2xs"
                      }`}
                    >
                      {hasCheckedInToday ? (
                        <>
                          <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
                          <span>تم الاستلام اليوم</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-2.5 h-2.5" />
                          <span>استلم +10 PTS</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Tier Level Progression */}
                  {nextTierName && (
                    <div className="p-2 bg-white border border-stone-200/80 rounded-xl space-y-1 shadow-2xs">
                      <div className="flex justify-between items-center text-[9px]">
                        <span className="font-bold text-stone-800">
                          المستوى التالي: <span className="text-[#ba9b72]">{nextTierNameAr} ({nextTierName})</span>
                        </span>
                        <span className="text-stone-500 font-mono">
                          متبقي EGP {remainingForNextTier.toLocaleString()}
                        </span>
                      </div>
                      <div className="w-full bg-stone-100 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-gradient-to-r from-[#ba9b72] to-[#dfc499] h-full rounded-full transition-all duration-500"
                          style={{ width: `${tierProgressPct}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Quick Summary Grid */}
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <div className="p-2 bg-white border border-stone-200/70 rounded-xl">
                      <span className="text-[8px] text-stone-400 block font-medium uppercase tracking-wider">إجمالي المشتريات</span>
                      <span className="font-mono font-bold text-stone-900 text-xs mt-0.5 block">
                        EGP {(user.totalSpent || 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="p-2 bg-white border border-stone-200/70 rounded-xl">
                      <span className="text-[8px] text-stone-400 block font-medium uppercase tracking-wider">الطلبات المكتملة</span>
                      <span className="font-mono font-bold text-stone-900 text-xs mt-0.5 block">
                        {userOrders.length} طلب
                      </span>
                    </div>
                  </div>
                </div>
              )}

          {/* TAB 2: REWARDS VAULT */}
          {activeSubTab === "rewards" && (
            <div className="space-y-3">
              {/* Header info */}
              <div className="bg-[#c5a880]/10 border border-[#c5a880]/20 rounded-xl p-3 flex justify-between items-center">
                <div>
                  <p className="text-[9px] text-brand-outline font-semibold uppercase">نقاطك المتاحة / Available Points</p>
                  <p className="text-sm font-bold text-brand-gold font-mono">{user.loyaltyPoints || 0} PTS</p>
                </div>
                <p className="text-[8px] text-brand-outline/70 text-right max-w-[150px]">
                  استبدل نقاطك بكوبونات خصم أو ميزات شحن فورية.
                </p>
              </div>

              {/* Rewards Catalogue */}
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1 scrollbar-thin">
                {rewards.length === 0 ? (
                  <div className="text-center py-8 text-brand-outline font-light text-xs bg-brand-gold/5 border border-dashed border-[#c5a880]/20 rounded-xl p-4">
                    لا توجد جوائز متاحة حالياً في الخزنة.
                    <span className="block mt-1 text-[10px] font-mono text-brand-gold">
                      No rewards currently available. Check back soon!
                    </span>
                  </div>
                ) : (
                  rewards.map((reward) => {
                    const canAfford = (user.loyaltyPoints || 0) >= reward.cost;
                    return (
                      <div
                        key={reward.id}
                        className="p-3 bg-white border border-[#c5a880]/15 rounded-xl space-y-1.5 text-left relative shadow-2xs"
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <h6 className="font-serif text-[10.5px] font-bold text-brand-dark">
                              {reward.title}
                            </h6>
                            <span className="text-[8px] font-sans text-brand-outline/70 block">
                              {reward.titleEn}
                            </span>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <span className="text-[9px] font-bold text-brand-gold bg-[#c5a880]/10 px-1.5 py-0.5 rounded-md text-center font-mono">
                              {reward.cost} PTS
                            </span>
                            {reward.discountPercent && (
                              <span className="text-[8px] font-bold text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded-md text-center">
                                {reward.discountPercent}% OFF
                              </span>
                            )}
                          </div>
                        </div>

                        <p className="text-[8.5px] text-brand-outline leading-relaxed">
                          {reward.description}
                        </p>

                        <div className="flex justify-between items-center pt-1 border-t border-[#c5a880]/5">
                          <span className="text-[8px] text-brand-outline/65 font-mono">
                            Code: {reward.code}
                          </span>
                          <button
                            onClick={() => handleRedeemReward(reward)}
                            disabled={!canAfford}
                            className={`px-3 py-1 rounded-lg text-[8px] uppercase font-bold tracking-wider transition-all cursor-pointer ${
                              canAfford
                                ? "bg-brand-gold hover:bg-[#b0936e] text-white active:scale-95"
                                : "bg-gray-100 text-gray-400 cursor-not-allowed"
                            }`}
                          >
                            {canAfford ? "استرداد الجائزة" : "نقاط غير كافية"}
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* My Redeemed Rewards Vouchers */}
              {user.redeemedRewards && user.redeemedRewards.length > 0 && (
                <div className="pt-2 border-t border-[#c5a880]/15 space-y-2">
                  <h5 className="text-[9px] uppercase tracking-[0.2em] text-brand-outline/65 font-bold">
                    جوائزي المستردة / My Redeemed Awards
                  </h5>
                  <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
                    {user.redeemedRewards.map((item, idx) => {
                      const codeMatch = item.match(/Code:\s*([A-Z0-9]+)/);
                      const code = codeMatch ? codeMatch[1] : "";
                      return (
                        <div
                          key={idx}
                          className="flex justify-between items-center bg-[#fdfaf7] border border-[#c5a880]/10 rounded-lg p-2 text-[9px]"
                        >
                          <span className="truncate max-w-[200px] text-brand-dark font-medium">
                            {item.split(" (Code:")[0]}
                          </span>
                          {code && (
                            <button
                              onClick={() => handleCopyCode(code)}
                              className="flex items-center gap-1 text-[8.5px] font-mono text-brand-gold hover:text-[#b0936e] bg-white border border-[#c5a880]/20 px-1.5 py-0.5 rounded-md active:scale-95 transition-all cursor-pointer"
                            >
                              {copiedCode === code ? (
                                <>
                                  <Check className="w-2.5 h-2.5 text-emerald-600" />
                                  <span>Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-2.5 h-2.5" />
                                  <span>{code}</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Action Buttons */}
        <div className="mt-2.5 pt-2 border-t border-stone-200/60 shrink-0">
          <button
            id="btn-logout"
            onClick={() => {
              onLogout();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-1.5 py-2 px-3 border border-red-200 hover:border-red-300 hover:bg-red-50/50 text-red-600 hover:text-red-700 text-[10.5px] font-bold uppercase tracking-wider rounded-xl transition-all active:scale-[0.98] cursor-pointer bg-white"
          >
            <LogOut className="w-3.5 h-3.5 stroke-[2]" />
            <span>EXIT PRIVATE VAULT</span>
          </button>
        </div>
      </motion.div>
    </>
  )}
</AnimatePresence>
  );
}
