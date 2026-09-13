/* =========================================================================
   Zorbi Kids Club — customer-lookup proxy
   =========================================================================
   This server exists for exactly one reason: GET /api/customers on the CRM
   requires a SECRET X-Api-Key, which must never reach the browser. This
   proxy holds that key server-side and re-exposes a single safe endpoint,
   GET /api/customer-lookup, that book-now.html's booking.js calls instead.

   Zones and admission plans are NOT proxied here — those CRM endpoints only
   need the publishable X-Tenant-Key, so booking.js calls them directly.
   ========================================================================= */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { CRM_BASE_URL, CRM_SECRET_KEY, ALLOWED_ORIGIN, PORT } = process.env;

if (!CRM_BASE_URL || !CRM_SECRET_KEY || !ALLOWED_ORIGIN) {
  console.error(
    "Missing required env vars. Check CRM_BASE_URL, CRM_SECRET_KEY and ALLOWED_ORIGIN in .env",
  );
  process.exit(1);
}

const app = express();

app.use(cors({ origin: ALLOWED_ORIGIN }));

const customerLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests — please slow down." },
});

app.get(
  "/api/customer-lookup",
  customerLookupLimiter,
  async (req, res) => {
    const rawPhone = req.query.phone;
    if (!rawPhone || typeof rawPhone !== "string" || !rawPhone.trim()) {
      return res.status(400).json({ success: false, message: "phone is required" });
    }

    const phone = rawPhone.replace(/[\s-]/g, "");

    let crmRes;
    try {
      crmRes = await fetch(
        `${CRM_BASE_URL}/api/customers?phone=${encodeURIComponent(phone)}`,
        {
          headers: {
            "X-Api-Key": CRM_SECRET_KEY,
            Accept: "application/json",
          },
        },
      );
    } catch (networkErr) {
      return res
        .status(502)
        .json({ success: false, message: "Upstream CRM unavailable" });
    }

    let body;
    try {
      body = await crmRes.json();
    } catch (parseErr) {
      return res
        .status(502)
        .json({ success: false, message: "Upstream CRM unavailable" });
    }

    return res.status(crmRes.status).json(body);
  },
);

app.listen(PORT, () => {
  console.log(`Zorbi customer-lookup proxy listening on port ${PORT}`);
});
