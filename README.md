# Spatial Vision Tech

## PhonePe / UPI payment setup

The site uses a PhonePe-compatible UPI QR for the ₹100 pre-registration fee, ₹4,900 final registration fee, and each course installment. Students submit the UPI transaction ID after payment, receive a downloadable receipt marked as pending verification, and admin verifies the transaction before approval.

Registration is staged: students first submit ₹100 for pre-registration. After admin approval, they can submit the remaining ₹4,900 final registration fee. Admin can set each student's finalized fee, verify submitted payments individually, and certificates unlock only when verified payments reach that finalized fee.

Update the UPI ID and QR URLs in `register.html` and `student.html` if your payment account changes. Deploy the static site with:

```bash
firebase deploy --only hosting
```

## Google Sheets data export

The Firebase backend exports registrations, verified payment submissions, performance results, and contact enquiries to separate tabs in one Google Sheet.

1. Create a Google Sheet in the `spatialvisiontech` Google account and copy its ID from the URL.
2. Enable the Google Sheets API in the Google Cloud project `spatial-vision-tech`.
3. Create `functions/.env` from `functions/.env.example` and set `GOOGLE_SHEET_ID` to the copied Sheet ID.
4. Share the Sheet with the Firebase App Engine service account, usually `spatial-vision-tech@appspot.gserviceaccount.com`, as Editor. The exact account is shown in Firebase Console under Project settings > Service accounts.
5. Make sure the Firestore rules allow signed-in registration/student writes and public creation of valid `enquiries` records. The enquiry form now saves to Firestore before opening the visitor's email app.
6. Install and deploy the backend and hosting:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions,hosting
```

The backend creates `Registrations`, `Payments`, `Performance`, and `Enquiries` tabs automatically the first time data is received. Google Sheets can download the workbook as `.xlsx` at any time.