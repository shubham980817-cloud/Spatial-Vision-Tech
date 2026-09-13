# Spatial Vision Tech

## PhonePe / UPI payment setup

The site uses a PhonePe-compatible UPI QR for the ₹5,000 registration fee and each ₹10,000 installment. Students submit the UPI transaction ID after payment, receive a downloadable receipt marked as pending verification, and admin verifies the transaction before approval.

Update the UPI ID and QR URLs in `register.html` and `student.html` if your payment account changes. Deploy the static site with:

```bash
firebase deploy --only hosting
```