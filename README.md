# Spatial Vision Tech

## PhonePe / UPI payment setup

The site uses a PhonePe-compatible UPI QR for the ₹100 pre-registration fee, ₹4,900 final registration fee, and each course installment. Students submit the UPI transaction ID after payment, receive a downloadable receipt marked as pending verification, and admin verifies the transaction before approval.

Registration is staged: students first submit ₹100 for pre-registration. After admin approval, they can submit the remaining ₹4,900 final registration fee. Admin can set each student's finalized fee, verify submitted payments individually, and certificates unlock only when verified payments reach that finalized fee.

Update the UPI ID and QR URLs in `register.html` and `student.html` if your payment account changes. Deploy the static site with:

```bash
firebase deploy --only hosting
```