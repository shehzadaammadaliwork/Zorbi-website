/* =========================================================================
   Zorbi Kids Club — Book Now page logic
   =========================================================================
   TODO: CRM INTEGRATION

     1. fetchZones() / fetchAdmissionPlans(zoneId)
        Call the real CRM directly from the browser using the publishable
        `X-Tenant-Key` (pk_live_...). That key is safe to ship in client-side
        JS — it only grants read access to zones/plans, nothing sensitive.

     2. lookupCustomerByPhone(phone)
        Calls OUR OWN proxy server (PROXY_BASE_URL), never the CRM directly.
        The proxy is the only place that holds the secret `X-Api-Key`
        (sk_live_...) required by GET /api/customers — that key must never
        reach the browser. See /server for the proxy implementation.

     3. submitBooking(payload)
        TODO: replace with a real CRM booking-creation endpoint once one is
        documented. There is currently no POST /api/bookings in the CRM API,
        so this still uses local/mock booking creation (status UNPAID).
        The payload includes zone, plan, ageGroup, discount, totalAmount,
        children, status and createdAt — no paymentMethod field, since the
        customer never chooses one on this website.

   Pricing is FLAT per admission plan (`base_price`) — this CRM has no
   per-age-group pricing, by design. `ageGroup` is stored per child for
   record-keeping only and never affects the total.

   Payment method (Cash / Card / Mobile) is chosen by staff at the counter,
   not by the customer here. After check-in, this page renders a QR code
   that encodes only the booking's reference string
   (`ZORBI-BOOKING-{bookingId}`) — not a URL. Staff scan that QR code at the
   counter, which should open the CRM's check-in screen pre-filled with
   this booking's zone, plan, age group, phone, and child names. Staff then
   select the payment method, change status from UNPAID to PAID, and print
   the receipt — all inside the CRM / POS software, not on this website.

   There is still no receipt.html page on this website, and the QR code
   never encodes a URL — it only carries the bookingId reference above.
   ========================================================================= */

// TODO: set the real CRM API host before going live.
const CRM_BASE_URL = "https://creamy-utopia-api.easyspawn.com";
// TODO: set the real publishable tenant key before going live. Safe in browser JS.
const CRM_TENANT_KEY = "pk_live_ttARxufRQinoyYpQLZSSWJPYawxSjr4f";
// Base URL of our own proxy server (see /server) once it is deployed.
const PROXY_BASE_URL = "http://localhost:4000";

function mockDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Zones as last returned by fetchZones(), kept so "All Zones" can fan out an
// admission-plans request per zone (the CRM requires a zoneId on every call).
let allLoadedZones = [];

async function crmGet(path) {
  let res;
  try {
    res = await fetch(`${CRM_BASE_URL}${path}`, {
      headers: { "X-Tenant-Key": CRM_TENANT_KEY, Accept: "application/json" },
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
  let res;
  try {
    res = await fetch(
      `${PROXY_BASE_URL}/api/customer-lookup?phone=${encodeURIComponent(phone)}`,
      { headers: { Accept: "application/json" } },
    );
  } catch (networkErr) {
    const error = new Error("Network error contacting lookup service");
    error.status = 0;
    throw error;
  }

  if (res.status === 404) {
    return { found: false, data: null };
  }

  let json = null;
  try {
    json = await res.json();
  } catch (parseErr) {
    // leave json as null; handled by the !json check below
  }

  if (!res.ok || !json || !json.success) {
    const error = new Error((json && json.message) || "Customer lookup failed");
    error.status = res.status;
    error.errorCode = json && json.error_code;
    throw error;
  }

  return { found: true, data: json.data };
}

async function submitBooking(payload) {
  // TODO: replace with real CRM booking-creation endpoint once available.
  // const res = await fetch(`${CRM_BASE_URL}/api/bookings`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify(payload),
  // });
  // if (!res.ok) throw new Error("Booking submission failed");
  // return res.json();

  await mockDelay(650);
  const bookingId = "BKG-" + Date.now().toString(36).toUpperCase();
  return { success: true, data: { bookingId, ...payload } };
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

  phone: "",
  customerLookupLoading: false,
  customerLookupError: false,
  customerLookupErrorMessage: null,
  customerFound: null,
  registeredChildren: [],

  children: [{ name: "", ticketNo: "" }],
  discount: 0,

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

  phoneInput: document.getElementById("customerPhoneInput"),
  searchBtn: document.getElementById("customerSearchBtn"),
  searchBtnIcon: document.getElementById("customerSearchBtnIcon"),
  customerLookupMsg: document.getElementById("customerLookupMsg"),
  registeredChildrenBox: document.getElementById("registeredChildrenBox"),
  registeredChildrenList: document.getElementById("registeredChildrenList"),

  childrenList: document.getElementById("childrenList"),
  addChildBtn: document.getElementById("addChildBtn"),

  discountInput: document.getElementById("discountInput"),

  summaryZone: document.getElementById("summaryZone"),
  summaryPlan: document.getElementById("summaryPlan"),
  summaryAge: document.getElementById("summaryAge"),
  summaryChildren: document.getElementById("summaryChildren"),
  summaryDiscount: document.getElementById("summaryDiscount"),
  summaryTotal: document.getElementById("summaryTotal"),

  checkinBtn: document.getElementById("checkinBtn"),
  checkinBtnLabel: document.getElementById("checkinBtnLabel"),

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

function calculateTotal() {
  const plan = getSelectedPlan();
  if (!plan) return 0;
  const childCount = Math.max(state.children.length, 1);
  const raw =
    Number(plan.base_price) * childCount - Number(state.discount || 0);
  return Math.max(raw, 0);
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
      return `
        <button type="button" class="plan-card${active}" data-plan-id="${plan.id}">
          <h4 class="plan-card__name">${escapeHtml(plan.name)}</h4>
          <div class="plan-card__meta">
            <span class="plan-card__duration"><i class="fa-regular fa-clock"></i> ${plan.duration_minutes}m</span>
            <span class="plan-card__price">${formatMoney(plan.base_price)}</span>
          </div>
        </button>`;
    })
    .join("");
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
  state.selectedPlanId = state.selectedPlanId === planId ? null : planId;
  renderPlans();
  renderOrderSummary();
  updateCheckinButtonState();
}

/* ------------------------------- Step 3: Age group ----------------------- */

function renderAgeButtons() {
  el.ageButtonsRow.innerHTML = AGE_GROUPS.map(
    (age) =>
      `<button type="button" class="age-btn${state.ageGroup === age ? " active" : ""}" data-age="${age}">${age}</button>`,
  ).join("");
}

function handleAgeButtonClick(age) {
  state.ageGroup = age;
  renderAgeButtons();
  renderOrderSummary();
  updateCheckinButtonState();
}

/* ------------------------------- Step 4: Customer lookup ------------------ */

function renderCustomerLookupState() {
  if (state.customerLookupError) {
    el.customerLookupMsg.hidden = false;
    el.customerLookupMsg.className = "inline-message inline-message--error";
    el.customerLookupMsg.textContent =
      state.customerLookupErrorMessage ||
      "Couldn't search for this customer — please try again.";
    el.registeredChildrenBox.hidden = true;
    return;
  }

  if (state.customerFound === true) {
    el.customerLookupMsg.hidden = true;
    el.registeredChildrenBox.hidden = false;
    el.registeredChildrenList.innerHTML = state.registeredChildren
      .map(
        (child, index) => `
        <label class="registered-child-row">
          <input type="checkbox" class="registered-child-checkbox" data-child-index="${index}">
          <span>${escapeHtml(child.name)} <em>(${escapeHtml(child.ageGroup)})</em></span>
        </label>`,
      )
      .join("");
    return;
  }

  if (state.customerFound === false) {
    el.registeredChildrenBox.hidden = true;
    el.customerLookupMsg.hidden = false;
    el.customerLookupMsg.className = "inline-message inline-message--info";
    el.customerLookupMsg.textContent =
      "New customer — please add child details below.";
    return;
  }

  el.customerLookupMsg.hidden = true;
  el.registeredChildrenBox.hidden = true;
}

function setSearchLoading(isLoading) {
  el.searchBtn.disabled = isLoading;
  el.searchBtnIcon.className = isLoading
    ? "fa-solid fa-spinner fa-spin"
    : "fa-regular fa-magnifying-glass";
}

async function handleCustomerSearch() {
  const phone = el.phoneInput.value.trim();
  if (!phone) {
    el.customerLookupMsg.hidden = false;
    el.customerLookupMsg.className = "inline-message inline-message--error";
    el.customerLookupMsg.textContent = "Please enter a phone number to search.";
    return;
  }

  state.phone = phone;
  state.customerLookupLoading = true;
  state.customerLookupError = false;
  state.customerLookupErrorMessage = null;
  state.customerFound = null;
  setSearchLoading(true);
  renderCustomerLookupState();

  try {
    const result = await lookupCustomerByPhone(phone);
    state.customerLookupLoading = false;
    state.customerFound = result.found;
    // CRM returns each child's age field as `age_group`; keep our internal
    // shape (`ageGroup`) the same as manually-entered children below.
    state.registeredChildren = result.found
      ? result.data.children.map((child) => ({
          name: child.name,
          ageGroup: child.age_group,
        }))
      : [];
    renderCustomerLookupState();
  } catch (err) {
    state.customerLookupLoading = false;
    state.customerFound = null;
    state.customerLookupError = true;
    state.customerLookupErrorMessage = describeApiError(err, "phone");
    renderCustomerLookupState();
  } finally {
    setSearchLoading(false);
  }
}

function handleRegisteredChildToggle(index, checked) {
  const registeredChild = state.registeredChildren[index];
  if (!registeredChild) return;

  if (checked) {
    const alreadyBlank = state.children.findIndex(
      (child) => !child.name && !child.ticketNo,
    );
    const newChild = { name: registeredChild.name, ticketNo: "" };
    if (alreadyBlank !== -1) {
      state.children[alreadyBlank] = newChild;
    } else {
      state.children.push(newChild);
    }
  } else {
    const idx = state.children.findIndex(
      (child) => child.name === registeredChild.name,
    );
    if (idx !== -1 && state.children.length > 1) {
      state.children.splice(idx, 1);
    }
  }
  renderChildren();
  renderOrderSummary();
}

/* ------------------------------- Step 5: Children ------------------------ */

function renderChildren() {
  el.childrenList.innerHTML = state.children
    .map((child, index) => {
      const removeDisabled = state.children.length <= 1;
      return `
        <div class="child-row" data-child-index="${index}">
          <div class="child-row__field child-row__name">
            <label>Child Name *</label>
            <input type="text" class="child-name-input" data-child-index="${index}" placeholder="Child's full name" value="${escapeHtml(child.name)}">
          </div>
          <div class="child-row__field child-row__ticket">
            <label>Ticket / Band #</label>
            <input type="text" class="child-ticket-input" data-child-index="${index}" placeholder="Optional">
          </div>
          <button type="button" class="child-row__remove" data-child-index="${index}" ${removeDisabled ? "disabled" : ""} aria-label="Remove child">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>`;
    })
    .join("");

  state.children.forEach((child, index) => {
    const ticketInput = el.childrenList.querySelector(
      `.child-ticket-input[data-child-index="${index}"]`,
    );
    if (ticketInput) ticketInput.value = child.ticketNo || "";
  });
}

function handleAddChild() {
  state.children.push({ name: "", ticketNo: "" });
  renderChildren();
  renderOrderSummary();
  updateCheckinButtonState();
}

function handleRemoveChild(index) {
  if (state.children.length <= 1) return;
  state.children.splice(index, 1);
  renderChildren();
  renderOrderSummary();
  updateCheckinButtonState();
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

  el.summaryZone.textContent = zoneLabel;
  el.summaryPlan.textContent = plan ? plan.name : "Select a plan";
  el.summaryAge.textContent = state.ageGroup || "—";
  el.summaryChildren.textContent = String(state.children.length);
  el.summaryDiscount.textContent =
    state.discount > 0 ? `− ${formatMoney(state.discount)}` : "—";

  const total = calculateTotal();
  el.summaryTotal.textContent = formatMoney(total);
  el.checkinBtnLabel.textContent = `Check In · ${formatMoney(total)}`;
}

/* ------------------------------- Validation + submit ------------------- */

function updateCheckinButtonState() {
  const stillLoading = state.zonesLoading || state.plansLoading;
  const hasError = state.zonesError || state.plansError;
  el.checkinBtn.disabled = stillLoading || hasError || state.submitting;
}

function validateForm() {
  if (state.selectedZoneId === null) return "Please select a play zone.";
  if (!state.selectedPlanId) return "Please select an admission plan.";
  if (!state.ageGroup) return "Please select an age group.";
  if (!state.phone.trim())
    return "Please search for a customer by phone number first.";

  const namedChildren = state.children.filter(
    (child) => child.name.trim().length > 0,
  );
  if (namedChildren.length === 0)
    return "Please add at least one child with a name.";

  return null;
}

function showFormError(message) {
  if (!message) {
    el.formError.hidden = true;
    el.formError.textContent = "";
    return;
  }
  el.formError.hidden = false;
  el.formError.textContent = message;
}

async function handleCheckin() {
  const validationError = validateForm();
  if (validationError) {
    showFormError(validationError);
    return;
  }
  showFormError(null);

  const plan = getSelectedPlan();
  const namedChildren = state.children.filter(
    (child) => child.name.trim().length > 0,
  );

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
    zoneId,
    planId: plan.id,
    ageGroup: state.ageGroup,
    discount: Number(state.discount || 0),
    totalAmount: calculateTotal(),
    status: "UNPAID",
    children: namedChildren.map((child) => ({
      name: child.name.trim(),
      ageGroup: state.ageGroup,
      ticketNo: child.ticketNo || "",
    })),
    createdAt: new Date().toISOString(),
  };

  state.submitting = true;
  el.checkinBtn.disabled = true;
  el.checkinBtnLabel.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Checking In...`;

  try {
    const res = await submitBooking(payload);
    if (!res || !res.success)
      throw new Error("Booking submission was not successful");
    showConfirmation(res.data.bookingId);
  } catch (err) {
    state.submitting = false;
    updateCheckinButtonState();
    renderOrderSummary();
    showFormError("Something went wrong while checking in — please try again.");
  }
}

function renderQrCode(bookingId) {
  const qrText = `ZORBI-BOOKING-${bookingId}`;
  const qrOptions = {
    text: qrText,
    width: 200,
    height: 200,
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
  state.customerLookupLoading = false;
  state.customerLookupError = false;
  state.customerLookupErrorMessage = null;
  state.customerFound = null;
  state.registeredChildren = [];
  state.children = [{ name: "", ticketNo: "" }];
  state.discount = 0;
  state.submitting = false;

  el.phoneInput.value = "";
  el.discountInput.value = "0";
  showFormError(null);
  renderCustomerLookupState();
  renderAgeButtons();
  renderChildren();
  el.checkinBtnLabel.textContent = "Check In · Rs 0";

  el.qrCodeWrap.innerHTML = "";
  el.qrCodePrint.innerHTML = "";
  el.bookingReferenceText.textContent = "Booking Reference: —";
  el.printBookingReference.textContent = "";

  el.bookingConfirmation.hidden = true;
  el.bookingFormWrapper.hidden = false;

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

el.searchBtn.addEventListener("click", handleCustomerSearch);
el.phoneInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    handleCustomerSearch();
  }
});

el.registeredChildrenList.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".registered-child-checkbox");
  if (!checkbox) return;
  handleRegisteredChildToggle(
    Number(checkbox.dataset.childIndex),
    checkbox.checked,
  );
});

el.addChildBtn.addEventListener("click", handleAddChild);

el.childrenList.addEventListener("click", (event) => {
  const removeBtn = event.target.closest(".child-row__remove");
  if (removeBtn && !removeBtn.disabled) {
    handleRemoveChild(Number(removeBtn.dataset.childIndex));
  }
});

el.childrenList.addEventListener("input", (event) => {
  const index = Number(event.target.dataset.childIndex);
  if (Number.isNaN(index)) return;

  if (event.target.classList.contains("child-name-input")) {
    state.children[index].name = event.target.value;
    renderOrderSummary();
  } else if (event.target.classList.contains("child-ticket-input")) {
    state.children[index].ticketNo = event.target.value;
  }
});

el.discountInput.addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.discount = Number.isNaN(value) || value < 0 ? 0 : value;
  renderOrderSummary();
});

el.checkinBtn.addEventListener("click", handleCheckin);
el.bookAnotherBtn.addEventListener("click", resetBookingForm);
el.printQrBtn.addEventListener("click", () => window.print());

/* ------------------------------- Init ------------------------------------ */
/* This script is loaded at the end of <body>, so the DOM is already parsed
   by the time it runs — no need to wait for DOMContentLoaded. */

renderAgeButtons();
renderChildren();
renderCustomerLookupState();
renderOrderSummary();
// Plans depend on allLoadedZones (used to fan out "All Zones" requests),
// so zones must finish loading first.
loadZones().then(() => loadPlans());
