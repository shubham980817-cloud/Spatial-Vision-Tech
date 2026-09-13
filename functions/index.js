const admin = require('firebase-admin');
const { google } = require('googleapis');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');

admin.initializeApp();

const spreadsheetId = () => process.env.GOOGLE_SHEET_ID;
let sheetsClientPromise;

async function getSheetsClient() {
  if (!spreadsheetId()) {
    throw new Error('Missing sheets.id Firebase runtime configuration.');
  }

  if (!sheetsClientPromise) {
    sheetsClientPromise = google.auth.getClient({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    }).then(auth => google.sheets({ version: 'v4', auth }));
  }

  return sheetsClientPromise;
}

async function ensureSheet(sheets, title, headers) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId(),
    fields: 'sheets.properties.title'
  });
  const titles = (spreadsheet.data.sheets || []).map(sheet => sheet.properties.title);

  if (!titles.includes(title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${title}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
}

async function appendRow(title, headers, row) {
  const sheets = await getSheetsClient();
  await ensureSheet(sheets, title, headers);
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${title}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

function json(value) {
  return JSON.stringify(value || {});
}

exports.exportRegistration = onDocumentCreated('students/{studentId}', async event => {
    const snapshot = event.data;
    const student = snapshot.data();
    await appendRow('Registrations', [
      'Recorded At', 'Student ID', 'Firebase UID', 'Name', 'Email', 'Phone',
      'Course', 'Registration Date', 'Approval Status', 'Registration Payment Status',
      'Registration UTR'
    ], [
      new Date().toISOString(), student.studentId || '', student.uid || event.params.studentId,
      student.name || '', student.email || '', student.phone || '', student.course || '',
      student.regDate || '', student.approvalStatus || '', student.regPaymentStatus || '',
      student.regUtr || ''
    ]);
  });

exports.exportStudentUpdates = onDocumentUpdated('students/{studentId}', async event => {
    const change = event.data;
    const before = change.before.data();
    const after = change.after.data();
    const tasks = [];
    const oldFees = before.feeHistory || [];
    const newFees = after.feeHistory || [];
    const oldAttempts = before.testAttempts || [];
    const newAttempts = after.testAttempts || [];

    newFees.slice(oldFees.length).forEach(fee => {
      tasks.push(appendRow('Payments', [
        'Recorded At', 'Student ID', 'Name', 'Email', 'Course', 'Receipt Number',
        'Fee Type', 'Amount', 'UTR', 'Status', 'Payment Date', 'Verified At'
      ], [
        new Date().toISOString(), after.studentId || event.params.studentId, after.name || '',
        after.email || '', after.course || '', fee.receiptNo || '', fee.type || '', fee.amount || '',
        fee.utr || '', fee.status || 'Recorded', fee.date || '', fee.verifiedAt || ''
      ]));
    });

    newAttempts.slice(oldAttempts.length).forEach(attempt => {
      tasks.push(appendRow('Performance', [
        'Recorded At', 'Student ID', 'Name', 'Email', 'Course', 'Score', 'Completed At', 'Answers'
      ], [
        new Date().toISOString(), after.studentId || event.params.studentId, after.name || '',
        after.email || '', after.course || '', attempt.score ?? '', attempt.completedAt || '', json(attempt.answers)
      ]));
    });

    await Promise.all(tasks);
  });

exports.exportEnquiry = onDocumentCreated('enquiries/{enquiryId}', async event => {
    const snapshot = event.data;
    const enquiry = snapshot.data();
    await appendRow('Enquiries', [
      'Recorded At', 'Enquiry ID', 'Name', 'Email', 'Phone', 'Message'
    ], [
      enquiry.createdAt || new Date().toISOString(), event.params.enquiryId,
      enquiry.name || '', enquiry.email || '', enquiry.phone || '', enquiry.message || ''
    ]);
  });
