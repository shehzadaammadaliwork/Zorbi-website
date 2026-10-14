/* =========================================================================
   Zorbi Kids Club — Book Now page logic
   =========================================================================
   CRM INTEGRATION — everything is handled by the Creamy Utopia CRM API.
   This website has no backend of its own: every call below goes straight
   from the browser to the CRM with the publishable `X-Tenant-Key`
   (pk_live_...), which is safe to ship in client-side JS.

     GET  /api/zones                       play zones
     GET  /api/admission-plans?zoneId=     plans for a zone (with age prices)
     GET  /api/customer-lookup?phone=      a returning customer's children
                                           (names + age group only); runs
                                           by itself once the number is full
     POST /api/bookings                    creates the booking (UNPAID)

   The CRM re-prices every booking itself (plan price per age group, plus
   any peak/holiday rule), so the total shown here is an estimate. Any discount
   is given by staff at the counter, never on this page.

   Payment method (Cash / Card / Mobile) is chosen by staff at the counter,
   not by the customer here. After check-in, this page renders a QR code
   that encodes only the booking's reference string
   (`ZORBI-BOOKING-{bookingId}`, e.g. ZORBI-BOOKING-WB-7K3F9Q) — not a URL.
   Staff scan that QR code on the CRM's Front Desk page, which opens Check In
   pre-filled with this booking's zone, plan, age group, phone and children.
   Staff then take payment and print the slip — all inside the CRM.
   ========================================================================= */

// Opened on localhost → the local CRM (php artisan serve on :8000) with the
// local database's own publishable key; anywhere else → production.
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const CRM_BASE_URL = IS_LOCAL
  ? "http://127.0.0.1:8000"
  : "https://creamy-utopia-api.easyspawn.com";
// Publishable tenant key (CRM → `php artisan tenant:api-key zorbi-kids-club public`).
const CRM_TENANT_KEY = IS_LOCAL
  ? "pk_live_MhOHLSJ1QJfErL4SfgXQ0eTLNjqq8vNw"
  : "pk_live_ttARxufRQinoyYpQLZSSWJPYawxSjr4f";

// Zones as last returned by fetchZones(), kept so "All Zones" can fan out an
// admission-plans request per zone (the CRM requires a zoneId on every call).
let allLoadedZones = [];

async function crmRequest(path, options = {}) {
  let res;
  try {
    res = await fetch(`${CRM_BASE_URL}${path}`, {
      ...options,
      headers: {
        "X-Tenant-Key": CRM_TENANT_KEY,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (networkErr) {
    const error = new Error("Network error contacting CRM");
    error.status = 0;
    throw error;
  }

  let json = null;
  try {
    json = await res.json();
  } catch (parseErr) {
    // leave json as null; handled by the !json check below
  }

  if (!res.ok || !json || !json.success) {
    const error = new Error(
      (json && json.message) || `Request failed (${res.status})`,
    );
    error.status = res.status;
    error.errorCode = json && json.error_code;
    throw error;
  }

  return json.data;
}

function crmGet(path) {
  return crmRequest(path);
}

async function fetchZones() {
  return crmGet("/api/zones");
}

async function fetchAdmissionPlans(zoneId) {
  // zoneId is undefined/null/"all" when the "All Zones" chip is selected.
  const zoneIdsToFetch =
    zoneId && zoneId !== ALL_ZONES_ID
      ? [zoneId]
      : allLoadedZones.map((zone) => zone.id);

  if (zoneIdsToFetch.length === 0) return [];

  const resultsPerZone = await Promise.all(
    zoneIdsToFetch.map((id) =>
      crmGet(`/api/admission-plans?zoneId=${encodeURIComponent(id)}`),
    ),
  );

  // A plan can belong to more than one zone, so "All Zones" can return the
  // same plan from multiple per-zone requests — dedupe by plan id.
  const merged = new Map();
  resultsPerZone.flat().forEach((plan) => {
    if (plan.is_active) merged.set(plan.id, plan);
  });
  return Array.from(merged.values());
}

async function lookupCustomerByPhone(phone) {
  try {
    const data = await crmGet(
      `/api/customer-lookup?phone=${encodeURIComponent(phone)}`,
    );
    return { found: true, data };
  } catch (err) {
    if (err.status === 404) return { found: false, data: null };
    throw err;
  }
}

async function submitBooking(payload) {
  // Returns { bookingId: "WB-XXXXXX", status: "UNPAID", estimatedAmount, ... }
  const data = await crmRequest("/api/bookings", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { success: true, data };
}

/* ---------------------------------------------------------------------- */

function describeApiError(err, context) {
  const status = err && err.status;

  if (status === 401 || status === 403) {
    return "Service temporarily unavailable — please contact staff.";
  }
  if (status === 422) {
    if (context === "zone") return "Please select a valid zone.";
    if (context === "plan") return "Please select a valid zone to view plans.";
    if (context === "phone") return "Please enter a valid phone number.";
    return (err && err.message) || "Please check your input and try again.";
  }
  if (status === 0) {
    return "Network error — please check your connection and try again.";
  }
  return (err && err.message) || "Something went wrong — please try again.";
}

/* ---------------------------------------------------------------------- */

const AGE_GROUPS = ["Infant", "Toddler", "Child", "Adult"];
const ALL_ZONES_ID = "all";
// Pakistani mobile numbers are 11 digits (03xx…), 12 with the 92 prefix.
const PHONE_MIN_DIGITS = 11;
const IS_MOBILE = () => window.matchMedia("(max-width: 991px)").matches;

const state = {
  zones: [],
  zonesLoading: false,
  zonesError: false,
  zonesErrorMessage: null,
  selectedZoneId: ALL_ZONES_ID,

  plans: [],
  plansLoading: false,
  plansError: false,
  plansErrorMessage: null,
  selectedPlanId: null,

  ageGroup: null,

  // Customer — same flow as the CRM front-desk Check In: type the phone, the
  // CRM is searched automatically, known children appear as tick chips.
  phone: "",
  lookupStatus: "idle", // idle | loading | found | new | error
  lookupErrorMessage: null,
  lookupSeq: 0,
  knownChildren: [], // [{ name, ageGroup }] from the CRM
  pickedNames: [], // known children ticked
  addedNames: [], // new children typed in
  guardianName: "",

  submitting: false,
};

const el = {
  zoneChipRow: document.getElementById("zoneChipRow"),
  zoneErrorBox: document.getElementById("zoneErrorBox"),
  zoneRetryBtn: document.getElementById("zoneRetryBtn"),

  planGrid: document.getElementById("planGrid"),
  planErrorBox: document.getElementById("planErrorBox"),
  planRetryBtn: document.getElementById("planRetryBtn"),
  planEmptyMsg: document.getElementById("planEmptyMsg"),

  ageButtonsRow: document.getElementById("ageButtonsRow"),

  phoneSearchRow: document.getElementById("phoneSearchRow"),
  phoneInput: document.getElementById("customerPhoneInput"),
  phoneHint: document.getElementById("phoneHint"),
  searchBtn: document.getElementById("customerSearchBtn"),
  searchBtnIcon: document.getElementById("customerSearchBtnIcon"),
  customerLookupMsg: document.getElementById("customerLookupMsg"),
  customerBox: document.getElementById("customerBox"),
  customerBoxTitle: document.getElementById("customerBoxTitle"),
  customerChangeBtn: document.getElementById("customerChangeBtn"),
  guardianNameField: document.getElementById("guardianNameField"),
  guardianNameInput: document.getElementById("guardianNameInput"),
  kidsHead: document.getElementById("kidsHead"),
  kidsHeadLabel: document.getElementById("kidsHeadLabel"),
  kidsSelectAllBtn: document.getElementById("kidsSelectAllBtn"),
  kidChips: document.getElementById("kidChips"),
  newChildLabel: document.getElementById("newChildLabel"),
  newChildInput: document.getElementById("newChildInput"),
  addChildBtn: document.getElementById("addChildBtn"),

  summaryZone: document.getElementById("summaryZone"),
  summaryPlan: document.getElementById("summaryPlan"),
  summaryAge: document.getElementById("summaryAge"),
  summaryChildren: document.getElementById("summaryChildren"),
  summaryTotal: document.getElementById("summaryTotal"),

  checkinBtn: document.getElementById("checkinBtn"),
  checkinBtnLabel: document.getElementById("checkinBtnLabel"),

  mobileBar: document.getElementById("mobileCheckoutBar"),
  mobileBarCount: document.getElementById("mobileBarCount"),
  mobileBarTotal: document.getElementById("mobileBarTotal"),
  mobileCheckinBtn: document.getElementById("mobileCheckinBtn"),
  mobileFormError: document.getElementById("mobileFormError"),

  bookingFormWrapper: document.getElementById("bookingFormWrapper"),
  bookingConfirmation: document.getElementById("bookingConfirmation"),
  qrCodeWrap: document.getElementById("qrCodeWrap"),
  bookingReferenceText: document.getElementById("bookingReferenceText"),
  printQrBtn: document.getElementById("printQrBtn"),
  qrCodePrint: document.getElementById("qrCodePrint"),
  printBookingReference: document.getElementById("printBookingReference"),
  bookAnotherBtn: document.getElementById("bookAnotherBtn"),

  formError: document.getElementById("formError"),
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setErrorBoxMessage(box, message, fallback) {
  const p = box.querySelector("p");
  if (p) p.textContent = message || fallback;
}

function getSelectedPlan() {
  return (
    state.plans.find((plan) => String(plan.id) === state.selectedPlanId) || null
  );
}

function formatMoney(amount, currency) {
  const symbol = currency === "PKR" || !currency ? "Rs" : currency;
  return `${symbol} ${Number(amount).toLocaleString()}`;
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

// On phones, glide to the next step after a choice so the customer never has
// to hunt for it — one thumb, top to bottom.
function scrollToStep(id) {
  if (!IS_MOBILE()) return;
  const target = document.getElementById(id);
  if (!target) return;
  window.scrollTo({
    top: target.getBoundingClientRect().top + window.scrollY - 90,
    behavior: "smooth",
  });
}

// Plan price for the chosen age group (CRM `prices`), else the plan's base_price.
function planPrice(plan, ageGroup) {
  const override =
    ageGroup &&
    (plan.prices || []).find((p) => p.age_group === ageGroup.toLowerCase());
  return Number(override ? override.price : plan.base_price);
}

// Everyone coming in: ticked known children, added ones, plus a name still
// sitting in the box (people forget to tap Add in a rush).
function getChildNames() {
  const names = [...state.pickedNames, ...state.addedNames];
  const typed = el.newChildInput.value.trim();
  if (
    typed &&
    !names.some((name) => name.toLowerCase() === typed.toLowerCase())
  ) {
    names.push(typed);
  }
  return names;
}

function calculateTotal() {
  const plan = getSelectedPlan();
  if (!plan) return 0;
  const childCount = Math.max(getChildNames().length, 1);
  return planPrice(plan, state.ageGroup) * childCount;
}

/* ------------------------------- Step 1: Zones ------------------------- */

function renderZoneSkeleton() {
  el.zoneErrorBox.hidden = true;
  const placeholders = [1, 2, 3, 4]
    .map(() => `<span class="chip chip-skeleton"></span>`)
    .join("");
  el.zoneChipRow.innerHTML = placeholders;
}

function renderZones() {
  if (state.zonesError) {
    el.zoneChipRow.innerHTML = "";
    setErrorBoxMessage(
      el.zoneErrorBox,
      state.zonesErrorMessage,
      "Couldn't load play zones — please refresh",
    );
    el.zoneErrorBox.hidden = false;
    return;
  }
  el.zoneErrorBox.hidden = true;

  const allChip = `<button type="button" class="chip${state.selectedZoneId === ALL_ZONES_ID ? " active" : ""}" data-zone-id="${ALL_ZONES_ID}">All Zones</button>`;
  const zoneChips = state.zones
    .map(
      (zone) =>
        `<button type="button" class="chip${state.selectedZoneId === String(zone.id) ? " active" : ""}" data-zone-id="${zone.id}">${escapeHtml(zone.name)}</button>`,
    )
    .join("");

  el.zoneChipRow.innerHTML = allChip + zoneChips;
}

async function loadZones() {
  state.zonesLoading = true;
  state.zonesError = false;
  state.zonesErrorMessage = null;
  renderZoneSkeleton();
  updateCheckinButtonState();

  try {
    const zones = await fetchZones();
    allLoadedZones = zones.filter((zone) => zone.is_active);
    state.zones = allLoadedZones;
    state.zonesLoading = false;
    renderZones();
  } catch (err) {
    state.zonesLoading = false;
    state.zonesError = true;
    state.zonesErrorMessage = describeApiError(err, "zone");
    renderZones();
  }
  updateCheckinButtonState();
}

function handleZoneChipClick(zoneId) {
  if (state.selectedZoneId === zoneId) return;
  state.selectedZoneId = zoneId;
  state.selectedPlanId = null;
  renderZones();
  loadPlans();
  renderOrderSummary();
  scrollToStep("step-plan");
}

/* ------------------------------- Step 2: Plans -------------------------- */

function renderPlanSkeleton() {
  el.planErrorBox.hidden = true;
  el.planEmptyMsg.hidden = true;
  const placeholders = [1, 2, 3]
    .map(
      () =>
        `<div class="plan-card plan-card-skeleton"><div class="sk-line sk-line-lg"></div><div class="sk-line sk-line-sm"></div><div class="sk-line sk-line-sm"></div></div>`,
    )
    .join("");
  el.planGrid.innerHTML = placeholders;
}

function renderPlans() {
  if (state.plansError) {
    el.planGrid.innerHTML = "";
    el.planEmptyMsg.hidden = true;
    setErrorBoxMessage(
      el.planErrorBox,
      state.plansErrorMessage,
      "Couldn't load admission plans — please refresh",
    );
    el.planErrorBox.hidden = false;
    return;
  }
  el.planErrorBox.hidden = true;

  if (state.plans.length === 0) {
    el.planGrid.innerHTML = "";
    el.planEmptyMsg.hidden = false;
    return;
  }
  el.planEmptyMsg.hidden = true;

  el.planGrid.innerHTML = state.plans
    .map((plan) => {
      const active = String(plan.id) === state.selectedPlanId ? " active" : "";
      const duration = plan.duration_minutes
        ? `<span class="plan-card__duration"><i class="fa-regular fa-clock"></i> ${formatDuration(plan.duration_minutes)}</span>`
        : `<span class="plan-card__duration">${plan.type === "daypass" ? "Full day" : "Entry"}</span>`;
      return `
        <button type="button" class="plan-card${active}" data-plan-id="${plan.id}">
          <h4 class="plan-card__name">${escapeHtml(plan.name)}</h4>
          <div class="plan-card__meta">
            ${duration}
            <span class="plan-card__price">${formatMoney(planPrice(plan, state.ageGroup))}</span>
          </div>
        </button>`;
    })
    .join("");
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours} hour${hours > 1 ? "s" : ""}`;
}

async function loadPlans() {
  state.plansLoading = true;
  state.plansError = false;
  state.plansErrorMessage = null;
  renderPlanSkeleton();
  updateCheckinButtonState();

  try {
    const zoneParam =
      state.selectedZoneId === ALL_ZONES_ID ? undefined : state.selectedZoneId;
    state.plans = await fetchAdmissionPlans(zoneParam);
    state.plansLoading = false;
    renderPlans();
  } catch (err) {
    state.plansLoading = false;
    state.plansError = true;
    state.plansErrorMessage = describeApiError(err, "plan");
    renderPlans();
  }
  updateCheckinButtonState();
  renderOrderSummary();
}

function handlePlanCardClick(planId) {
  const wasSelected = state.selectedPlanId === planId;
  state.selectedPlanId = wasSelected ? null : planId;
  renderPlans();
  renderOrderSummary();
  updateCheckinButtonState();
  if (!wasSelected) scrollToStep(state.ageGroup ? "step-customer" : "step-age");
}

/* ------------------------------- Step 3: Age group ----------------------- */

function renderAgeButtons() {
  el.ageButtonsRow.innerHTML = AGE_GROUPS.map(
    (age) =>
      `<button type="button" class="age-btn${state.ageGroup === age ? " active" : ""}" data-age="${age}">${age}</button>`,
  ).join("");
}

function handleAgeButtonClick(age) {
  const firstPick = !state.ageGroup;
  state.ageGroup = age;
  renderAgeButtons();
  if (!state.plansLoading) renderPlans(); // prices differ per age group
  renderOrderSummary();
  updateCheckinButtonState();
  if (firstPick) scrollToStep("step-customer");
}

/* ------------------------------- Step 4: Customer & children ------------- */

function setSearchLoading(isLoading) {
  el.searchBtn.disabled = isLoading;
  el.searchBtnIcon.className = isLoading
    ? "fa-solid fa-spinner fa-spin"
    : "fa-regular fa-magnifying-glass";
}

function showLookupMessage(type, text) {
  if (!text) {
    el.customerLookupMsg.hidden = true;
    return;
  }
  el.customerLookupMsg.hidden = false;
  el.customerLookupMsg.className = `inline-message inline-message--${type}`;
  el.customerLookupMsg.textContent = text;
}

function kidChip(name, { picked, subtitle, added }) {
  const icon = picked ? "fa-solid fa-circle-check" : "fa-regular fa-circle";
  return `
    <button type="button" class="kid-chip${picked ? " picked" : ""}" data-name="${escapeHtml(name)}" data-added="${added ? "1" : ""}" aria-pressed="${picked}">
      <i class="${added ? "fa-solid fa-xmark" : icon}"></i>
      ${escapeHtml(name)}
      ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}
    </button>`;
}

function renderCustomer() {
  const status = state.lookupStatus;
  const locked = status === "found" || status === "new";

  // Phone row: hidden once a customer is locked in (X to change), like the CRM.
  el.phoneSearchRow.hidden = locked;
  el.phoneHint.hidden = locked || status === "error";
  setSearchLoading(status === "loading");

  if (status === "error") {
    showLookupMessage(
      "error",
      state.lookupErrorMessage ||
        "Couldn't search for this customer — please try again.",
    );
  } else {
    showLookupMessage(null);
  }

  el.customerBox.hidden = !locked;
  if (!locked) return;

  el.customerBox.classList.toggle("cust-box--new", status === "new");
  el.customerBoxTitle.innerHTML =
    status === "found"
      ? `<i class="fa-solid fa-user-check"></i> Welcome back · ${escapeHtml(state.phone)}`
      : `<i class="fa-solid fa-user-plus"></i> New customer · ${escapeHtml(state.phone)}`;

  el.guardianNameField.hidden = status !== "new";

  const known = state.knownChildren;
  const pickedCount = state.pickedNames.length + state.addedNames.length;
  el.kidsHead.hidden = known.length === 0 && state.addedNames.length === 0;
  el.kidsHeadLabel.textContent =
    known.length > 0
      ? `Who's coming?${pickedCount ? ` · ${pickedCount} selected` : ""}`
      : `Children${pickedCount ? ` · ${pickedCount}` : ""}`;

  const allPicked =
    known.length > 0 &&
    known.every((child) => state.pickedNames.includes(child.name));
  el.kidsSelectAllBtn.hidden = known.length < 2;
  el.kidsSelectAllBtn.textContent = allPicked
    ? "Clear"
    : `Select all (${known.length})`;

  el.kidChips.innerHTML =
    known
      .map((child) =>
        kidChip(child.name, {
          picked: state.pickedNames.includes(child.name),
          subtitle: child.ageGroup,
        }),
      )
      .join("") +
    state.addedNames
      .map((name) => kidChip(name, { picked: true, added: true }))
      .join("");

  el.newChildLabel.textContent =
    known.length > 0 ? "New child (not in the list above)" : "Child's name";
}

function resetCustomer() {
  state.lookupSeq += 1; // drop any in-flight lookup
  state.lookupStatus = "idle";
  state.lookupErrorMessage = null;
  state.knownChildren = [];
  state.pickedNames = [];
  state.addedNames = [];
  state.guardianName = "";
  el.guardianNameInput.value = "";
  el.newChildInput.value = "";
}

let lookupTimer = null;

function handlePhoneInput() {
  state.phone = el.phoneInput.value.trim();
  clearTimeout(lookupTimer);
  if (state.lookupStatus === "error") state.lookupStatus = "idle";

  // Search as soon as the number is complete — no button tap needed.
  if (phoneDigits(state.phone).length >= PHONE_MIN_DIGITS) {
    lookupTimer = setTimeout(handleCustomerSearch, 350);
  }
  renderCustomer();
}

async function handleCustomerSearch() {
  clearTimeout(lookupTimer);
  const phone = el.phoneInput.value.trim();
  if (phoneDigits(phone).length < 10) {
    state.lookupStatus = "error";
    state.lookupErrorMessage = "Please enter your full phone number.";
    renderCustomer();
    return;
  }

  state.phone = phone;
  state.lookupStatus = "loading";
  const seq = ++state.lookupSeq;
  renderCustomer();

  try {
    const result = await lookupCustomerByPhone(phone);
    if (seq !== state.lookupSeq) return; // a newer search started
    state.knownChildren = result.found
      ? result.data.children.map((child) => ({
          name: child.name,
          ageGroup: child.age_group,
        }))
      : [];
    state.pickedNames = [];
    state.lookupStatus = result.found ? "found" : "new";
  } catch (err) {
    if (seq !== state.lookupSeq) return;
    state.lookupStatus = "error";
    state.lookupErrorMessage = describeApiError(err, "phone");
  }
  renderCustomer();
  renderOrderSummary();

  // Found with children → nothing to type; new → straight to the name field.
  if (state.lookupStatus === "new") {
    el.guardianNameInput.focus();
  } else if (
    state.lookupStatus === "found" &&
    state.knownChildren.length === 0
  ) {
    el.newChildInput.focus();
  }
  el.phoneInput.blur();
}

function handleChangeCustomer() {
  resetCustomer();
  el.phoneInput.value = "";
  state.phone = "";
  renderCustomer();
  renderOrderSummary();
  el.phoneInput.focus();
}

function handleKidChipClick(chip) {
  const name = chip.dataset.name;
  if (chip.dataset.added) {
    state.addedNames = state.addedNames.filter((n) => n !== name);
  } else if (state.pickedNames.includes(name)) {
    state.pickedNames = state.pickedNames.filter((n) => n !== name);
  } else {
    state.pickedNames = [...state.pickedNames, name];
  }
  showFormError(null);
  renderCustomer();
  renderOrderSummary();
}

function handleSelectAllKids() {
  const all = state.knownChildren.map((child) => child.name);
  const allPicked = all.every((name) => state.pickedNames.includes(name));
  state.pickedNames = allPicked ? [] : all;
  renderCustomer();
  renderOrderSummary();
}

function handleAddChild() {
  const name = el.newChildInput.value.trim();
  if (!name) {
    el.newChildInput.focus();
    return;
  }
  const known = state.knownChildren.find(
    (child) => child.name.toLowerCase() === name.toLowerCase(),
  );
  if (known) {
    // Typed a child we already know — just tick them.
    if (!state.pickedNames.includes(known.name)) {
      state.pickedNames = [...state.pickedNames, known.name];
    }
  } else if (
    !state.addedNames.some((n) => n.toLowerCase() === name.toLowerCase())
  ) {
    state.addedNames = [...state.addedNames, name];
  }
  el.newChildInput.value = "";
  showFormError(null);
  renderCustomer();
  renderOrderSummary();
  el.newChildInput.focus(); // ready for the next sibling
}

/* ------------------------------- Order summary ------------------------- */

function renderOrderSummary() {
  const zone = state.zones.find((z) => String(z.id) === state.selectedZoneId);
  const zoneLabel =
    state.selectedZoneId === ALL_ZONES_ID
      ? "All Zones"
      : zone
        ? zone.name
        : "—";
  const plan = getSelectedPlan();
  const names = getChildNames();
  const total = calculateTotal();

  el.summaryZone.textContent = zoneLabel;
  el.summaryPlan.textContent = plan ? plan.name : "Select a plan";
  el.summaryAge.textContent = state.ageGroup || "—";
  el.summaryChildren.textContent = names.length ? names.join(", ") : "—";
  el.summaryTotal.textContent = formatMoney(total);
  el.checkinBtnLabel.textContent = `Check In · ${formatMoney(total)}`;

  el.mobileBarTotal.textContent = formatMoney(total);
  el.mobileBarCount.textContent = !plan
    ? "Pick a plan"
    : `${plan.name} · ${names.length || 1} ${names.length > 1 ? "children" : "child"}`;
}

/* ------------------------------- Validation + submit ------------------- */

function updateCheckinButtonState() {
  const stillLoading = state.zonesLoading || state.plansLoading;
  const hasError = state.zonesError || state.plansError;
  const disabled = stillLoading || hasError || state.submitting;
  el.checkinBtn.disabled = disabled;
  el.mobileCheckinBtn.disabled = disabled;
}

// Returns [message, stepId] so phones can jump to the step that needs fixing.
function validateForm() {
  if (!state.selectedPlanId)
    return ["Please select an admission plan.", "step-plan"];
  if (!state.ageGroup) return ["Please select an age group.", "step-age"];
  if (state.lookupStatus !== "found" && state.lookupStatus !== "new")
    return ["Please enter your phone number.", "step-customer"];
  if (getChildNames().length === 0)
    return [
      state.knownChildren.length
        ? "Tick at least one child, or add a new one."
        : "Please add your child's name.",
      "step-customer",
    ];
  return null;
}

function showFormError(message) {
  [el.formError, el.mobileFormError].forEach((box) => {
    box.hidden = !message;
    box.textContent = message || "";
  });
}

function setSubmitting(isSubmitting) {
  state.submitting = isSubmitting;
  updateCheckinButtonState();
  if (isSubmitting) {
    const spinner = `<i class="fa-solid fa-spinner fa-spin"></i> Checking In...`;
    el.checkinBtnLabel.innerHTML = spinner;
    el.mobileCheckinBtn.innerHTML = spinner;
  } else {
    el.mobileCheckinBtn.textContent = "Check In";
    renderOrderSummary();
  }
}

async function handleCheckin() {
  if (state.submitting) return;
  const invalid = validateForm();
  if (invalid) {
    showFormError(invalid[0]);
    scrollToStep(invalid[1]);
    return;
  }
  showFormError(null);

  const plan = getSelectedPlan();

  // A plan can belong to multiple zones (see plan.zones), so there's no
  // single "the" zone for it. If the customer filtered to one specific zone,
  // use that; otherwise ("All Zones") fall back to the plan's first zone.
  const zoneId =
    state.selectedZoneId !== ALL_ZONES_ID
      ? Number(state.selectedZoneId)
      : plan.zones && plan.zones[0]
        ? plan.zones[0].id
        : null;

  const payload = {
    phone: state.phone,
    name: state.lookupStatus === "new" ? el.guardianNameInput.value.trim() : undefined,
    zoneId,
    planId: plan.id,
    ageGroup: state.ageGroup,
    children: getChildNames().map((name) => ({
      name,
      ageGroup: state.ageGroup,
    })),
  };

  setSubmitting(true);

  try {
    const res = await submitBooking(payload);
    if (!res || !res.success)
      throw new Error("Booking submission was not successful");
    showConfirmation(res.data.bookingId);
  } catch (err) {
    setSubmitting(false);
    showFormError(
      err && err.status === 422
        ? err.message
        : err && err.status === 429
          ? "Too many attempts — please wait a minute and try again."
          : describeApiError(err) ||
            "Something went wrong while checking in — please try again.",
    );
  }
}

function renderQrCode(bookingId) {
  const qrText = `ZORBI-BOOKING-${bookingId}`;
  const qrOptions = {
    text: qrText,
    width: 220,
    height: 220,
    correctLevel: QRCode.CorrectLevel.M,
  };

  // Cleared first so re-checking in (Book Another Slot -> Check In again)
  // doesn't stack a second canvas on top of the previous one.
  el.qrCodeWrap.innerHTML = "";
  el.qrCodePrint.innerHTML = "";
  new QRCode(el.qrCodeWrap, qrOptions);
  new QRCode(el.qrCodePrint, qrOptions);

  const referenceLabel = `Booking Reference: ${bookingId}`;
  el.bookingReferenceText.textContent = referenceLabel;
  el.printBookingReference.textContent = referenceLabel;
}

function showConfirmation(bookingId) {
  el.bookingFormWrapper.hidden = true;
  el.mobileBar.hidden = true;
  el.bookingConfirmation.hidden = false;
  renderQrCode(bookingId);
  window.scrollTo({
    top: el.bookingConfirmation.offsetTop - 120,
    behavior: "smooth",
  });
}

function resetBookingForm() {
  state.selectedZoneId = ALL_ZONES_ID;
  state.selectedPlanId = null;
  state.ageGroup = null;
  state.phone = "";
  resetCustomer();
  state.submitting = false;

  el.phoneInput.value = "";
  showFormError(null);
  renderCustomer();
  renderAgeButtons();
  el.mobileCheckinBtn.textContent = "Check In";
  updateCheckinButtonState();

  el.qrCodeWrap.innerHTML = "";
  el.qrCodePrint.innerHTML = "";
  el.bookingReferenceText.textContent = "Booking Reference: —";
  el.printBookingReference.textContent = "";

  el.bookingConfirmation.hidden = true;
  el.bookingFormWrapper.hidden = false;
  el.mobileBar.hidden = false;
  renderOrderSummary();

  // Plans depend on allLoadedZones (used to fan out "All Zones" requests),
  // so zones must finish loading first.
  loadZones().then(() => loadPlans());
}

/* ------------------------------- Event wiring --------------------------- */

el.zoneChipRow.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip || chip.classList.contains("chip-skeleton")) return;
  handleZoneChipClick(chip.dataset.zoneId);
});

el.zoneRetryBtn.addEventListener("click", loadZones);
el.planRetryBtn.addEventListener("click", loadPlans);

el.planGrid.addEventListener("click", (event) => {
  const card = event.target.closest(".plan-card");
  if (!card || card.classList.contains("plan-card-skeleton")) return;
  handlePlanCardClick(card.dataset.planId);
});

el.ageButtonsRow.addEventListener("click", (event) => {
  const btn = event.target.closest(".age-btn");
  if (!btn) return;
  handleAgeButtonClick(btn.dataset.age);
});

el.phoneInput.addEventListener("input", handlePhoneInput);
el.phoneInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    handleCustomerSearch();
  }
});
el.searchBtn.addEventListener("click", handleCustomerSearch);
el.customerChangeBtn.addEventListener("click", handleChangeCustomer);

el.kidChips.addEventListener("click", (event) => {
  const chip = event.target.closest(".kid-chip");
  if (chip) handleKidChipClick(chip);
});
el.kidsSelectAllBtn.addEventListener("click", handleSelectAllKids);

el.addChildBtn.addEventListener("click", handleAddChild);
el.newChildInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    handleAddChild();
  }
});
el.newChildInput.addEventListener("input", renderOrderSummary);
el.guardianNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    el.newChildInput.focus();
  }
});

el.checkinBtn.addEventListener("click", handleCheckin);
el.mobileCheckinBtn.addEventListener("click", handleCheckin);
el.bookAnotherBtn.addEventListener("click", resetBookingForm);
el.printQrBtn.addEventListener("click", () => window.print());

/* ------------------------------- Init ------------------------------------ */
/* This script is loaded at the end of <body>, so the DOM is already parsed
   by the time it runs — no need to wait for DOMContentLoaded. */

// The theme's smooth-scroll wrapper is CSS-transformed, which breaks
// position:fixed for anything inside it — the bar has to live on <body>.
document.body.appendChild(el.mobileBar);

renderAgeButtons();
renderCustomer();
renderOrderSummary();
// Plans depend on allLoadedZones (used to fan out "All Zones" requests),
// so zones must finish loading first.
loadZones().then(() => loadPlans());
