# SM TPU Inventory — SM Branch 1 & SM Branch 2

Mobile-first inventory, daily sales, stock-in, and branch transfer app with Gmail / Google Sheets sync and daily automated Drive backups.

## Project Files
- `web/` — Installable Mobile PWA (`index.html`, `styles.css`, `app.js`, `initial-data.js`, `manifest.json`, `sw.js`, `icon.svg`)
- `google-apps-script/Code.gs` — Google Sheets + Daily Backup backend script
- `data/raw_inventory.csv` — Your original pasted TPU list
- `data/cleaned_inventory.csv` — Cleaned 2-branch CSV ready for Google Sheets (`284` models, `911` pcs in `SM Branch 1`, `0` in `SM Branch 2`)
- `scripts/clean_inventory.mjs` — Script used to normalize the raw CSV

## 1. Google Sheets + Gmail Setup (5 Minutes)
1. Open [Google Sheets](https://sheets.google.com) in your Gmail account and create a blank spreadsheet named **SM TPU Inventory**.
2. Click **Extensions → Apps Script**.
3. Delete any default code in `Code.gs`, paste the full contents of `google-apps-script/Code.gs`, and click **Save**.
4. Reload your Google Sheet. A new menu **SM TPU App** will appear at the top:
   - Click **SM TPU App → 1. Setup / Repair Sheets** (creates `Current_Stock`, `Daily_Sales`, `Stock_In`, `Transfers`, and `Print_View`).
   - Click **SM TPU App → 2. Enable Daily Auto-Backup (11:55 PM)** (saves a daily backup copy in Google Drive folder `SM_TPU_Daily_Backups`).
5. Back in Apps Script, click **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`).

## 2. Mobile App Setup (For Both Phones)
Host the `web/` folder for free (for example, drag-and-drop the `web/` folder onto [Netlify Drop](https://app.netlify.com/drop) or GitHub Pages), or test locally with any static server (`npx serve web`).
1. Open the app URL on your phone (Chrome/Safari) → **Add to Home Screen** to install like a mobile app.
2. On **Phone 1**, select **SM Branch 1**. On **Phone 2 (Bhai)**, select **SM Branch 2**.
3. Go to **Settings**, paste your Apps Script **Web app URL**, tap **Save & Test URL**, then tap **Push Stock to Sheet** (one time only).
4. On Phone 2, tap **Sync from Sheet** in Settings to pull the live stock.
