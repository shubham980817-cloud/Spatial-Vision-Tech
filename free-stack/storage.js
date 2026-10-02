const STORAGE_KEY = 'svt_free_portal_students';
const ADMIN_EMAIL = 'admin@spatialvisiontech.in';
const ADMIN_PASSWORD = 'Admin@123456';

function readStudents() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Unable to read student database:', error);
    return [];
  }
}

function writeStudents(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function generateStudentId() {
  return `SVT/${new Date().getFullYear()}/${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function getStudentByEmail(email) {
  return readStudents().find(student => student.email && student.email.toLowerCase() === String(email).trim().toLowerCase());
}

function getStudentById(id) {
  return readStudents().find(student => student.uid === id || student.studentId === id);
}

function ensureSeedData() {
  const students = readStudents();
  if (!students.length) {
    const adminSeed = {
      uid: 'admin-seed',
      studentId: 'ADMIN-001',
      name: 'Administrator',
      email: ADMIN_EMAIL,
      phone: '0000000000',
      course: 'Administration',
      password: ADMIN_PASSWORD,
      role: 'admin',
      approvalStatus: 'Approved',
      grantedAccess: true,
      preRegistrationPaid: true,
      regPaymentStatus: 'Pre-registration Paid',
      finalizedFee: 4900,
      feeHistory: []
    };
    writeStudents([adminSeed]);
  }
}

function saveStudent(student) {
  const students = readStudents();
  const existingIndex = students.findIndex(item => item.uid === student.uid || item.email === student.email);
  if (existingIndex >= 0) {
    students[existingIndex] = { ...students[existingIndex], ...student };
  } else {
    students.push(student);
  }
  writeStudents(students);
  return student;
}

function validateAdminLogin(email, password) {
  return String(email).trim().toLowerCase() === ADMIN_EMAIL && String(password) === ADMIN_PASSWORD;
}

function setStudentPassword(uid, newPassword) {
  const students = readStudents();
  const index = students.findIndex(student => student.uid === uid || student.studentId === uid);
  if (index < 0) return false;
  students[index].password = newPassword;
  writeStudents(students);
  return true;
}

function createStudentRecord(payload) {
  const students = readStudents();
  const uid = payload.uid || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const student = {
    uid,
    studentId: payload.studentId || generateStudentId(),
    name: payload.name,
    email: payload.email,
    phone: payload.phone,
    course: payload.course,
    password: payload.password,
    role: 'student',
    regDate: payload.regDate || new Date().toISOString(),
    regUtr: payload.regUtr || '',
    regPaymentStatus: payload.regPaymentStatus || 'Submitted',
    approvalStatus: payload.approvalStatus || 'Pending',
    grantedAccess: Boolean(payload.grantedAccess),
    preRegistrationAmount: 100,
    preRegistrationPaid: Boolean(payload.preRegistrationPaid),
    finalizedFee: payload.finalizedFee || 4900,
    feeHistory: Array.isArray(payload.feeHistory) ? payload.feeHistory : []
  };

  const existingIndex = students.findIndex(item => item.email && item.email.toLowerCase() === student.email.toLowerCase());
  if (existingIndex >= 0) {
    students[existingIndex] = student;
  } else {
    students.push(student);
  }

  writeStudents(students);
  return student;
}

function updateStudent(uid, updates) {
  const students = readStudents();
  const index = students.findIndex(student => student.uid === uid || student.studentId === uid);
  if (index < 0) return null;
  students[index] = { ...students[index], ...updates };
  writeStudents(students);
  return students[index];
}

ensureSeedData();
