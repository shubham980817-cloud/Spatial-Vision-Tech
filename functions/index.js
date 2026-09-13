const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const cashfreeClientId = defineSecret('CASHFREE_CLIENT_ID');
const cashfreeClientSecret = defineSecret('CASHFREE_CLIENT_SECRET');
const cashfreeEnvironment = defineString('CASHFREE_ENVIRONMENT', { default: 'sandbox' });
const appBaseUrl = defineString('APP_BASE_URL', { default: 'http://localhost:5000' });

const REGISTRATION_AMOUNT = 5000;
const INSTALLMENT_AMOUNT = 10000;
const API_VERSION = '2023-08-01';

function allowCors(response) {
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function cashfreeBaseUrl() {
  return cashfreeEnvironment.value() === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

async function verifyUser(request) {
  const authorization = request.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    throw new Error('Authentication required.');
  }
  return admin.auth().verifyIdToken(authorization.slice(7));
}

function cashfreeHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-version': API_VERSION,
    'x-client-id': cashfreeClientId.value(),
    'x-client-secret': cashfreeClientSecret.value(),
  };
}

exports.createCashfreeOrder = onRequest(
  { secrets: [cashfreeClientId, cashfreeClientSecret] },
  async (request, response) => {
    allowCors(response);
    if (request.method === 'OPTIONS') return response.status(204).send('');
    if (request.method !== 'POST') return response.status(405).json({ error: 'POST required.' });

    try {
      const user = await verifyUser(request);
      const { name, email, phone, course, paymentType, installmentType } = request.body || {};
      const isRegistration = paymentType === 'registration';
      const amount = isRegistration ? REGISTRATION_AMOUNT : INSTALLMENT_AMOUNT;
      const validInstallments = [
        '1st Installment (₹10,000)',
        '2nd Installment (₹10,000)',
        '3rd Installment (₹10,000)',
      ];

      if (!name || !email || !course || !paymentType || !['registration', 'installment'].includes(paymentType)) {
        return response.status(400).json({ error: 'Missing or invalid payment details.' });
      }
      if (!isRegistration && !validInstallments.includes(installmentType)) {
        return response.status(400).json({ error: 'Invalid installment.' });
      }
      if (email.toLowerCase() !== (user.email || '').toLowerCase()) {
        return response.status(403).json({ error: 'Email does not match the signed-in account.' });
      }

      const studentRef = db.collection('students').doc(user.uid);
      const studentSnapshot = await studentRef.get();
      if (!isRegistration && (!studentSnapshot.exists || studentSnapshot.data().approvalStatus !== 'Approved')) {
        return response.status(403).json({ error: 'Your student account must be approved before paying course installments.' });
      }
      if (studentSnapshot.exists && paymentType === 'registration' && studentSnapshot.data().regFeePaid) {
        return response.status(409).json({ error: 'Registration payment is already complete.' });
      }

      const orderId = `SVT_${paymentType}_${user.uid}_${Date.now()}`;
      const orderResponse = await fetch(`${cashfreeBaseUrl()}/orders`, {
        method: 'POST',
        headers: cashfreeHeaders(),
        body: JSON.stringify({
          order_id: orderId,
          order_amount: amount,
          order_currency: 'INR',
          customer_details: {
            customer_id: user.uid,
            customer_name: name,
            customer_email: email,
            customer_phone: phone || '9999999999',
          },
          order_meta: {
            return_url: `${appBaseUrl.value()}/${isRegistration ? 'register.html' : 'student.html'}?payment_status=success&order_id={order_id}`,
            notify_url: 'https://us-central1-spatial-vision-tech.cloudfunctions.net/cashfreeWebhook',
          },
          order_note: `${paymentType} - ${installmentType || 'Registration Fee'} - ${course}`,
        }),
      });

      const order = await orderResponse.json();
      if (!orderResponse.ok) {
        logger.error('Cashfree order creation failed', order);
        return response.status(502).json({ error: 'Unable to create Cashfree payment order.' });
      }

      await studentRef.set({
        uid: user.uid,
        name,
        email,
        course,
        phone: phone || '',
        studentId: `SVT/${new Date().getFullYear()}/${user.uid.slice(0, 6).toUpperCase()}`,
        regYear: new Date().getFullYear(),
        regDate: studentSnapshot.data()?.regDate || new Date().toISOString(),
        approvalStatus: studentSnapshot.data()?.approvalStatus || 'Pending',
        grantedAccess: false,
        feeHistory: studentSnapshot.data()?.feeHistory || [],
        registrationFee: REGISTRATION_AMOUNT,
        regPaymentStatus: paymentType === 'registration' ? 'Pending' : (studentSnapshot.data()?.regPaymentStatus || 'Paid'),
        cashfreeOrderId: orderId,
        lastPaymentType: paymentType,
        lastPaymentAmount: amount,
        pendingInstallmentType: installmentType || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return response.json({ orderId, paymentSessionId: order.payment_session_id });
    } catch (error) {
      logger.error('Cashfree order request failed', error);
      return response.status(error.message.includes('Authentication') ? 401 : 500)
        .json({ error: error.message });
    }
  },
);

exports.cashfreeWebhook = onRequest(
  { secrets: [cashfreeClientSecret] },
  async (request, response) => {
    if (request.method !== 'POST') return response.status(405).send('POST required.');

    try {
      const timestamp = request.get('x-webhook-timestamp');
      const signature = request.get('x-webhook-signature');
      const rawBody = request.rawBody?.toString() || JSON.stringify(request.body || {});
      const expectedSignature = crypto
        .createHmac('sha256', cashfreeClientSecret.value())
        .update(`${timestamp}${rawBody}`)
        .digest('base64');

      const signatureBuffer = Buffer.from(signature || '');
      const expectedBuffer = Buffer.from(expectedSignature);
      if (!timestamp || !signature || signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return response.status(401).send('Invalid signature.');
      }

      const orderId = request.body?.data?.order?.order_id;
      const orderStatus = request.body?.data?.order?.order_status;
      const paymentStatus = request.body?.data?.payment?.payment_status;
      if (!orderId) return response.status(400).send('Missing order ID.');

      const orderParts = orderId.split('_');
      const uid = orderParts.slice(2, -1).join('_');
      if (!uid) return response.status(400).send('Invalid order ID.');

      const paid = orderStatus === 'PAID' && paymentStatus === 'SUCCESS';
      const studentRef = db.collection('students').doc(uid);
      const studentSnapshot = await studentRef.get();
      const update = {
        regFeePaid: orderParts[1] === 'registration' && paid,
        regPaymentStatus: paid ? 'Paid' : (orderStatus || 'Failed'),
        cashfreePaymentStatus: paymentStatus || orderStatus || 'Unknown',
        cashfreeOrderId: orderId,
        paymentVerifiedAt: paid ? admin.firestore.FieldValue.serverTimestamp() : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (paid && orderParts[1] === 'installment') {
        update.feeHistory = admin.firestore.FieldValue.arrayUnion({
          type: studentSnapshot.data()?.pendingInstallmentType || 'Course Installment',
          amount: String(INSTALLMENT_AMOUNT),
          status: 'Paid',
          cashfreeOrderId: orderId,
          date: new Date().toISOString(),
        });
      }

      await studentRef.set(update, { merge: true });
      return response.status(200).send('Webhook processed.');
    } catch (error) {
      logger.error('Cashfree webhook failed', error);
      return response.status(500).send('Webhook processing failed.');
    }
  },
);
