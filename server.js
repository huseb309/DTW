const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const phonenumbers = require('google-libphonenumber');
const crypto = require('crypto-js');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const session = require('express-session');

dotenv.config();

const app = express();
const upload = multer({ dest: 'uploads/' });
const textUpload = multer().none();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public')); // Hanya untuk file statis seperti doodle.png
app.use(session({
  secret: process.env.SESSION_SECRET || 'default_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Ubah ke true jika menggunakan HTTPS
}));

let dataTarget = null;
let scheduleDetails = {};
let failedNumbers = [];
let ongoingNumbers = [];
let isCanceled = false;
let currentProgress = 0;

// DB terpisah
const schedulesDb = new sqlite3.Database('schedules.db', (err) => {
  if (err) console.error('Error connecting to schedules.db:', err);
});
const logsDb = new sqlite3.Database('logs.db', (err) => {
  if (err) console.error('Error connecting to logs.db:', err);
});

// Buat tabel jika belum ada
schedulesDb.serialize(() => {
  schedulesDb.run(`CREATE TABLE IF NOT EXISTS schedules 
    (schedule_id TEXT PRIMARY KEY, pesan_full TEXT, days TEXT, jam TEXT, penerima INTEGER)`, (err) => {
    if (err) console.error('Error creating schedules table:', err);
  });
});

logsDb.serialize(() => {
  logsDb.run(`CREATE TABLE IF NOT EXISTS logs 
    (timestamp TEXT, teks TEXT, nomor TEXT, status TEXT, schedule_id TEXT)`, (err) => {
    if (err) console.error('Error creating logs table:', err);
  });
});

// Environment variables
const DIGITALIN_API_KEY = process.env.DIGITALIN_API_KEY;
const DIGITALIN_SENDER_NUMBER = process.env.DIGITALIN_SENDER_NUMBER;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const USERS = JSON.parse(process.env.USERS || '[]');

if (!DIGITALIN_API_KEY || !DIGITALIN_SENDER_NUMBER || !ADMIN_NUMBER || !USERS.length) {
  throw new Error('Environment variables DIGITALIN_API_KEY, DIGITALIN_SENDER_NUMBER, ADMIN_NUMBER, and USERS must be set in .env');
}

const DIGITALIN_API_URL = 'https://wa.digitalin.id/send-message';

// Middleware autentikasi
const authMiddleware = (req, res, next) => {
  console.log('Auth check:', req.session.user ? 'Authenticated' : 'Not authenticated');
  if (req.session && req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Helper functions
function tulisLog(teks, nomor = null, status = null, scheduleId = null) {
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const hashedNomor = nomor ? crypto.SHA256(nomor.toString()).toString() : null;
  logsDb.run('INSERT INTO logs (timestamp, teks, nomor, status, schedule_id) VALUES (?, ?, ?, ?, ?)',
    [timestamp, teks, hashedNomor, status, scheduleId || 'Manual'],
    (err) => { if (err) console.error('Error writing log:', err); }
  );
}

function formatNomor(nomorRaw) {
  try {
    if (!nomorRaw) {
      throw new Error('Nomor kosong atau tidak valid');
    }
    let nomor = nomorRaw.toString().trim().replace(/[\s\r\n]+/g, '');
    if (typeof nomorRaw === 'number' || nomor.endsWith('.0')) {
      nomor = Math.floor(Number(nomor)).toString();
    }
    if (nomor === '' || !/^\+?62[0-9]{8,12}$/.test(nomor)) {
      throw new Error(`Format nomor tidak valid: harus dimulai dengan 62 atau +62 diikuti 8-12 digit, ditemukan ${nomor.length} digit`);
    }
    const PNF = phonenumbers.PhoneNumberFormat;
    const PhoneNumberUtil = phonenumbers.PhoneNumberUtil.getInstance();
    let parsed;
    if (nomor.startsWith('62')) {
      parsed = PhoneNumberUtil.parse('+' + nomor);
    } else if (nomor.startsWith('+62')) {
      parsed = PhoneNumberUtil.parse(nomor);
    } else {
      parsed = PhoneNumberUtil.parse(nomor, 'ID');
    }
    if (PhoneNumberUtil.isValidNumber(parsed)) {
      const formatted = PhoneNumberUtil.format(parsed, PNF.E164).replace('+', '');
      tulisLog(`[INFO] Nomor ${nomorRaw} divalidasi sebagai ${formatted}`);
      return formatted;
    }
    throw new Error('Nomor telepon tidak valid menurut standar internasional');
  } catch (e) {
    tulisLog(`[ERROR] Format nomor ${nomorRaw} tidak valid: ${e.message}`, nomorRaw, 'Gagal');
    return null;
  }
}

async function sendWhatsappMessage(toNumber, message) {
  const url = `${DIGITALIN_API_URL}?api_key=${DIGITALIN_API_KEY}&sender=${DIGITALIN_SENDER_NUMBER}&number=${toNumber}&message=${encodeURIComponent(message)}`;
  try {
    const response = await axios.get(url, { timeout: 30000 });
    if (response.status === 200) {
      return true;
    } else {
      tulisLog(`[ERROR] Gagal mengirim pesan ke ${toNumber}: Status ${response.status}`, toNumber, 'Gagal');
      return false;
    }
  } catch (e) {
    tulisLog(`[ERROR] Gagal mengirim pesan ke ${toNumber}: ${e.message}`, toNumber, 'Gagal');
    return false;
  }
}

async function sendAdminNotification(message) {
  if (await sendWhatsappMessage(ADMIN_NUMBER.replace('+', ''), message)) {
    tulisLog(`[SUKSES] Pemberitahuan ke admin ${ADMIN_NUMBER} terkirim.`, ADMIN_NUMBER, 'Sukses');
  } else {
    tulisLog(`[GAGAL] Pemberitahuan ke admin ${ADMIN_NUMBER} tidak terkirim.`, ADMIN_NUMBER, 'Gagal');
  }
}

async function kirimSemua(scheduleId = null) {
  if (!dataTarget || dataTarget.length === 0) {
    tulisLog('[ERROR] Tidak ada data nomor untuk dikirim.', null, null, scheduleId);
    return { status: 'error', message: 'Mohon unggah file Excel terlebih dahulu.' };
  }

  const pesan = scheduleId && scheduleDetails[scheduleId] ? scheduleDetails[scheduleId].pesanFull.trim() : '';
  if (!pesan) {
    tulisLog('[ERROR] Pesan kosong, pengiriman dibatalkan.', null, null, scheduleId);
    return { status: 'error', message: 'Pesan tidak boleh kosong.' };
  }

  const totalNumbers = dataTarget.length;
  const notification = `*Pengiriman Pesan Terjadwal Akan Dimulai*\nPengiriman pesan "${pesan.slice(0, 50)}..." ke ${totalNumbers} nomor dimulai`;
  await sendAdminNotification(notification);

  tulisLog(`=== Mulai proses pengiriman (ID: ${scheduleId || 'Manual'}) ===`, null, null, scheduleId);
  ongoingNumbers = [];
  let successfulSends = 0;
  for (let i = 0; i < dataTarget.length; i++) {
    if (isCanceled) {
      tulisLog('[INFO] Pengiriman dibatalkan oleh pengguna.', null, null, scheduleId);
      ongoingNumbers = [];
      currentProgress = 0;
      break;
    }
    const row = dataTarget[i];
    const nomor = formatNomor(row['Nomor WhatsApp']);
    if (nomor) {
      ongoingNumbers.push(nomor);
      tulisLog(`[SEDANG DIKIRIM] Memproses pesan ke ${nomor}.`, nomor, 'Sedang dikirim', scheduleId);
      if (await sendWhatsappMessage(nomor, pesan)) {
        tulisLog(`[SUKSES] Pesan ke ${nomor} terkirim.`, nomor, 'Sukses', scheduleId);
        successfulSends++;
      } else {
        tulisLog(`[GAGAL] Pesan ke ${nomor} tidak terkirim, akan dicoba lagi.`, nomor, 'Gagal', scheduleId);
        failedNumbers.push(nomor);
        await sendAdminNotification(`*Pengiriman ke nomor ${nomor} telah GAGAL*`);
      }
      ongoingNumbers = ongoingNumbers.filter(n => n !== nomor);
      currentProgress = ((i + 1) / totalNumbers) * 100;
      await new Promise(resolve => setTimeout(resolve, Math.random() * 30000 + 30000)); // 30-60s delay
    }
  }

  if (failedNumbers.length > 0 && !isCanceled) {
    tulisLog(`=== Mengirim ulang pesan yang gagal (ID: ${scheduleId || 'Manual'}) ===`, null, null, scheduleId);
    for (let j = 0; j < failedNumbers.length; j++) {
      const nomor = failedNumbers[j];
      ongoingNumbers.push(nomor);
      tulisLog(`[SEDANG DIKIRIM] Memproses ulang pesan ke ${nomor}.`, nomor, 'Sedang dikirim', scheduleId);
      if (await sendWhatsappMessage(nomor, pesan)) {
        tulisLog(`[SUKSES] Pesan ke ${nomor} terkirim pada percobaan ulang.`, nomor, 'Sukses', scheduleId);
        failedNumbers = failedNumbers.filter(n => n !== nomor);
        successfulSends++;
        j--; // Adjust index after removal
      } else {
        tulisLog(`[GAGAL] Pesan ke ${nomor} gagal lagi.`, nomor, 'Gagal', scheduleId);
        await sendAdminNotification(`*Pengiriman ke nomor ${nomor} telah GAGAL*`);
      }
      ongoingNumbers = ongoingNumbers.filter(n => n !== nomor);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 30000 + 30000));
    }
    if (failedNumbers.length > 0) {
      tulisLog(`[INFO] Nomor yang masih gagal: ${failedNumbers.length} nomor.`, null, null, scheduleId);
    } else {
      tulisLog('[INFO] Semua pesan gagal telah berhasil dikirim ulang.', null, null, scheduleId);
    }
  }

  if (!isCanceled) {
    const notification = `*Pengiriman Pesan Terjadwal Telah Selesai*\nPesan "${pesan.slice(0, 50)}..." telah dikirimkan ke ${successfulSends} nomor, jumlah pesan gagal = ${failedNumbers.length}`;
    await sendAdminNotification(notification);
    tulisLog('=== Selesai semua pengiriman ===', null, null, scheduleId);
  }

  currentProgress = 0;
  return { status: 'success', message: 'Semua pesan telah diproses.' };
}

function loadSchedules() {
  scheduleDetails = {};
  schedulesDb.all('SELECT * FROM schedules', (err, rows) => {
    if (err) {
      console.error('Error loading schedules:', err);
      return;
    }
    rows.forEach(row => {
      const { schedule_id, pesan_full, days, jam, penerima } = row;
      const daysArray = days.split(',').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d));
      const pesan = pesan_full.length > 50 ? pesan_full.slice(0, 50) + '...' : pesan_full;
      try {
        if (!jam || !jam.match(/^\d{2}:\d{2}$/)) throw new Error(`Invalid time format: ${jam}`);
        const [hour, minute] = jam.split(':').map(Number);
        if (isNaN(hour) || isNaN(minute)) throw new Error(`Invalid time parsing: ${jam}`);
        const cronJob = cron.schedule(`${minute} ${hour} * * *`, () => checkAndSend(schedule_id), { timezone: 'Asia/Jakarta' });
        scheduleDetails[schedule_id] = {
          pesan,
          pesanFull: pesan_full,
          days: daysArray,
          jam,
          penerima,
          job: cronJob
        };
      } catch (e) {
        console.error(`Error scheduling cron for ${schedule_id}:`, e);
        tulisLog(`[ERROR] Gagal menjadwalkan cron untuk ${schedule_id}: ${e.message}`);
      }
    });
  });
}

async function startSchedule(req, res) {
  try {
    console.log('Raw request headers:', req.headers);
    console.log('Raw request body:', req.body);

    if (!req.body) {
      tulisLog('[ERROR] Request body is undefined');
      return res.status(400).json({ status: 'error', message: 'Request body is missing or could not be parsed.' });
    }

    const { jam, pesan } = req.body;
    let days = req.body.days;
    console.log('Received in startSchedule:', { jam, days, pesan });

    if (!jam || !jam.match(/^\d{2}:\d{2}$/)) {
      tulisLog(`[ERROR] Format jam tidak valid: ${jam}`, null, null, null);
      return res.status(400).json({ status: 'error', message: 'Format jam tidak valid (harus HH:mm, misal 14:00).' });
    }
    const [hour, minute] = jam.split(':').map(Number);
    if (isNaN(hour) || isNaN(minute) || hour > 23 || minute > 59) {
      tulisLog(`[ERROR] Nilai jam tidak valid: ${jam}`, null, null, null);
      return res.status(400).json({ status: 'error', message: 'Nilai jam atau menit tidak valid.' });
    }
    const selectedDays = Array.isArray(days)
      ? days.map(d => parseInt(d, 10)).filter(d => !isNaN(d))
      : (typeof days === 'string' ? [parseInt(days, 10)].filter(d => !isNaN(d)) : []);
    if (selectedDays.length === 0) {
      tulisLog('[ERROR] Tidak ada tanggal yang dipilih.', null, null, null);
      return res.status(400).json({ status: 'error', message: 'Pilih setidaknya satu tanggal untuk jadwal.' });
    }
    if (!dataTarget || dataTarget.length === 0) {
      tulisLog('[ERROR] Tidak ada data nomor untuk dikirim.', null, null, null);
      return res.status(400).json({ status: 'error', message: 'Mohon unggah file Excel terlebih dahulu.' });
    }
    if (!pesan || !pesan.trim()) {
      tulisLog('[ERROR] Pesan kosong.', null, null, null);
      return res.status(400).json({ status: 'error', message: 'Pesan tidak boleh kosong.' });
    }

    logsDb.run('DELETE FROM logs', (err) => {
      if (err) console.error('Error clearing logs:', err);
    });

    const lastDay = Math.max(...selectedDays);
    const jamFormatted = jam.replace(':', '');
    let scheduleId = `JD${lastDay.toString().padStart(2, '0')}J${jamFormatted}`;
    let suffix = 1;
    let originalId = scheduleId;
    while (scheduleDetails[scheduleId]) {
      scheduleId = `${originalId}_${suffix}`;
      suffix++;
    }

    // PERBAIKAN: Ubah ID menjadi YYYY-MM-DD_HH:MM untuk sesi unik
    const today = new Date();
    const year = today.getFullYear();
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const dayStr = lastDay.toString().padStart(2, '0');
    scheduleId = `${year}-${month}-${dayStr}_${jam}`;

    const totalNumbers = dataTarget.length;
    const selectedDaysStr = selectedDays.join(', ');
    const notification = `*Jadwal Aktif (ID: ${scheduleId})*\nPesan "${pesan.slice(0, 50)}..." akan dikirimkan ke ${totalNumbers} nomor pada tanggal ${selectedDaysStr} pukul ${jam}`;
    await sendAdminNotification(notification);

    const daysStr = selectedDays.join(',');
    schedulesDb.run(
      'INSERT INTO schedules (schedule_id, pesan_full, days, jam, penerima) VALUES (?, ?, ?, ?, ?)',
      [scheduleId, pesan, daysStr, jam, totalNumbers],
      (err) => {
        if (err) {
          console.error('Error inserting schedule:', err);
          tulisLog(`[ERROR] Gagal menyimpan jadwal ${scheduleId}: ${err.message}`);
          return res.status(500).json({ status: 'error', message: 'Gagal menyimpan jadwal ke database.' });
        }
      }
    );

    const cronJob = cron.schedule(`${minute} ${hour} * * *`, () => checkAndSend(scheduleId), { timezone: 'Asia/Jakarta' });
    scheduleDetails[scheduleId] = {
      pesan: pesan.length > 50 ? pesan.slice(0, 50) + '...' : pesan,
      pesanFull: pesan,
      days: selectedDays,
      jam,
      penerima: totalNumbers,
      job: cronJob
    };
    tulisLog(`[INFO] Jadwal aktif setiap hari jam ${jam} (ID: ${scheduleId})`);
    return res.json({ status: 'success', message: `Pesan akan dikirim setiap hari jam ${jam} pada tanggal yang dipilih (ID: ${scheduleId}).` });
  } catch (e) {
    console.error('Error in startSchedule:', e);
    tulisLog(`[ERROR] Kesalahan server saat membuat jadwal: ${e.message}`);
    return res.status(500).json({ status: 'error', message: 'Terjadi kesalahan server saat membuat jadwal.' });
  }
}

async function checkAndSend(scheduleId) {
  if (!dataTarget || dataTarget.length === 0) {
    tulisLog('[ERROR] Tidak ada data nomor untuk dikirim.', null, null, scheduleId);
    return;
  }
  const details = scheduleDetails[scheduleId];
  if (!details || !details.pesanFull.trim()) {
    tulisLog('[ERROR] Pesan kosong, pengiriman dibatalkan.', null, null, scheduleId);
    return;
  }
  const today = new Date();
  const todayDay = today.getDate();
  const selectedDays = details.days;
  const [hour, minute] = details.jam.split(':').map(Number);
  console.log(`Checking schedule ${scheduleId}: today=${todayDay}, selectedDays=${selectedDays}, time=${details.jam}`);

  const now = new Date();
  const scheduledTimeToday = new Date(now.getFullYear(), now.getMonth(), todayDay, hour, minute);
  const timeDiff = (now - scheduledTimeToday) / 1000 / 60;
  if (selectedDays.includes(todayDay) && timeDiff <= 5) {
    tulisLog(`[INFO] Hari ini tanggal ${todayDay}, termasuk daftar pengiriman (ID: ${scheduleId}).`, null, null, scheduleId);
    await kirimSemua(scheduleId);
    // PERBAIKAN: Penghapusan otomatis jika hanya hari ini dan sudah selesai
    if (selectedDays.length === 1 && selectedDays[0] === todayDay && timeDiff > 0) {
      const job = details.job;
      if (job) job.stop();
      schedulesDb.run('DELETE FROM schedules WHERE schedule_id = ?', [scheduleId], (err) => {
        if (err) console.error('Error deleting schedule:', err);
        tulisLog(`[INFO] Jadwal ${scheduleId} dihapus otomatis setelah pengiriman selesai (hanya hari ini).`, null, null, scheduleId);
      });
      delete scheduleDetails[scheduleId];
    }
  } else if (selectedDays.includes(todayDay)) {
    tulisLog(`[INFO] Hari ini tanggal ${todayDay}, tetapi waktu ${details.jam} sudah lewat (selisih: ${timeDiff.toFixed(2)} menit).`, null, null, scheduleId);
  }

  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();
  let futureDays = [];
  selectedDays.forEach(day => {
    try {
      let scheduledDate = new Date(currentYear, currentMonth, day, hour, minute);
      if (scheduledDate > now && scheduledDate.getDate() === day) {
        futureDays.push(day);
      }
      const nextMonth = currentMonth < 11 ? currentMonth + 1 : 0;
      const nextYear = currentMonth < 11 ? currentYear : currentYear + 1;
      scheduledDate = new Date(nextYear, nextMonth, day, hour, minute);
      if (scheduledDate > now && scheduledDate.getDate() === day) {
        futureDays.push(day);
      }
    } catch (e) {
      console.error(`Error checking future date for day ${day}:`, e);
    }
  });
  console.log(`Future days for ${scheduleId}: ${futureDays}`);

  if (futureDays.length === 0 && scheduleDetails[scheduleId]) {
    const job = scheduleDetails[scheduleId].job;
    if (job) job.stop();
    schedulesDb.run('DELETE FROM schedules WHERE schedule_id = ?', [scheduleId], (err) => {
      if (err) console.error('Error deleting schedule:', err);
      tulisLog(`[INFO] Jadwal ${scheduleId} dihapus dari schedules.db.`, null, null, scheduleId);
    });
    delete scheduleDetails[scheduleId];
    tulisLog(`[INFO] Jadwal ${scheduleId} dihapus otomatis karena semua tanggal dan waktu pengiriman telah terlewati.`, null, null, scheduleId);
  } else {
    tulisLog(`[INFO] Jadwal ${scheduleId} tetap aktif karena masih ada tanggal atau waktu pengiriman di masa depan: ${futureDays}.`, null, null, scheduleId);
  }
}

function cancelKirim() {
  isCanceled = true;
  ongoingNumbers = [];
  currentProgress = 0;
  tulisLog('[INFO] Pengiriman dibatalkan oleh pengguna.');
  return { status: 'success', message: 'Pengiriman dibatalkan.' };
}

async function editSchedule(req, res) {
  try {
    console.log('Raw request headers:', req.headers);
    console.log('Raw request body:', req.body);

    if (!req.body) {
      tulisLog('[ERROR] Request body is undefined in editSchedule');
      return res.status(400).json({ status: 'error', message: 'Request body is missing or could not be parsed.' });
    }

    const { id, jam, pesan } = req.body;
    let days = req.body.days;
    console.log('Received in editSchedule:', { id, jam, days, pesan });

    if (!id || !scheduleDetails[id]) {
      tulisLog(`[ERROR] Jadwal tidak ditemukan: ${id}`, null, null, id);
      return res.status(400).json({ status: 'error', message: 'Jadwal tidak ditemukan.' });
    }
    if (!jam || !jam.match(/^\d{2}:\d{2}$/)) {
      tulisLog(`[ERROR] Format jam tidak valid di edit: ${jam}`, null, null, id);
      return res.status(400).json({ status: 'error', message: 'Format jam tidak valid (harus HH:mm, misal 14:00).' });
    }
    const [hour, minute] = jam.split(':').map(Number);
    if (isNaN(hour) || isNaN(minute) || hour > 23 || minute > 59) {
      tulisLog(`[ERROR] Nilai jam tidak valid di edit: ${jam}`, null, null, id);
      return res.status(400).json({ status: 'error', message: 'Nilai jam atau menit tidak valid.' });
    }
    const selectedDays = Array.isArray(days)
      ? days.map(d => parseInt(d, 10)).filter(d => !isNaN(d))
      : (typeof days === 'string' ? [parseInt(days, 10)].filter(d => !isNaN(d)) : []);
    if (selectedDays.length === 0) {
      tulisLog('[ERROR] Tidak ada tanggal yang dipilih di edit.', null, null, id);
      return res.status(400).json({ status: 'error', message: 'Pilih setidaknya satu tanggal untuk jadwal.' });
    }
    if (!pesan || !pesan.trim()) {
      tulisLog('[ERROR] Pesan kosong di edit.', null, null, id);
      return res.status(400).json({ status: 'error', message: 'Pesan tidak boleh kosong.' });
    }

    const oldJob = scheduleDetails[id].job;
    if (oldJob) oldJob.stop();

    const daysStr = selectedDays.join(',');
    const penerima = dataTarget ? dataTarget.length : 0;
    schedulesDb.run(
      'UPDATE schedules SET pesan_full = ?, days = ?, jam = ?, penerima = ? WHERE schedule_id = ?',
      [pesan, daysStr, jam, penerima, id],
      (err) => {
        if (err) {
          console.error('Error updating schedule:', err);
          tulisLog(`[ERROR] Gagal memperbarui jadwal ${id}: ${err.message}`);
          return res.status(500).json({ status: 'error', message: 'Gagal memperbarui jadwal di database.' });
        }
      }
    );

    const newJob = cron.schedule(`${minute} ${hour} * * *`, () => checkAndSend(id), { timezone: 'Asia/Jakarta' });
    scheduleDetails[id] = {
      pesan: pesan.length > 50 ? pesan.slice(0, 50) + '...' : pesan,
      pesanFull: pesan,
      days: selectedDays,
      jam,
      penerima,
      job: newJob
    };
    tulisLog(`[INFO] Jadwal ${id} diperbarui.`);
    return res.json({ status: 'success', message: `Jadwal ${id} berhasil diperbarui.` });
  } catch (e) {
    console.error('Error in editSchedule:', e);
    tulisLog(`[ERROR] Kesalahan server saat memperbarui jadwal: ${e.message}`);
    return res.status(500).json({ status: 'error', message: 'Terjadi kesalahan server saat memperbarui jadwal.' });
  }
}

function deleteSchedule(req, res) {
  try {
    const { id } = req.body;
    if (!id || !scheduleDetails[id]) {
      tulisLog(`[ERROR] Jadwal tidak ditemukan: ${id}`);
      return res.status(400).json({ status: 'error', message: 'Jadwal tidak ditemukan.' });
    }
    const job = scheduleDetails[id].job;
    if (job) job.stop();
    schedulesDb.run('DELETE FROM schedules WHERE schedule_id = ?', [id], (err) => {
      if (err) {
        console.error('Error deleting schedule:', err);
        tulisLog(`[ERROR] Gagal menghapus jadwal ${id}: ${err.message}`);
        return res.status(500).json({ status: 'error', message: 'Gagal menghapus jadwal dari database.' });
      }
      // PERBAIKAN: Tidak hapus log, hanya jadwal
    });
    delete scheduleDetails[id];
    tulisLog(`[INFO] Jadwal ${id} dihapus (log tetap disimpan).`);
    return res.json({ status: 'success', message: `Jadwal ${id} berhasil dihapus.` });
  } catch (e) {
    console.error('Error in deleteSchedule:', e);
    tulisLog(`[ERROR] Kesalahan server saat menghapus jadwal: ${e.message}`);
    return res.status(500).json({ status: 'error', message: 'Terjadi kesalahan server saat menghapus jadwal.' });
  }
}

// Routes
app.get('/login', (req, res) => {
  console.log('Serving login page');
  res.sendFile(path.join(__dirname, 'templates', 'login.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).json({ status: 'error', message: 'Gagal logout.' });
    }
    console.log('User logged out, redirecting to /login');
    res.redirect('/login');
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  console.log('Login attempt:', { username, password });
  const user = USERS.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.user = { username: user.username };
    tulisLog(`[SUKSES] Pengguna ${username} berhasil login.`);
    console.log('Login successful, setting session for:', username);
    res.json({ status: 'success', message: 'Login berhasil!' });
  } else {
    tulisLog(`[GAGAL] Login gagal untuk pengguna ${username}.`);
    console.log('Login failed for:', username);
    res.status(401).json({ status: 'error', message: 'Username atau password salah.' });
  }
});

app.get('/', authMiddleware, (req, res) => {
  console.log('Serving index page for user:', req.session.user?.username);
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'Tidak ada file yang diunggah.' });
    if (!req.file.originalname.endsWith('.xlsx')) return res.status(400).json({ status: 'error', message: 'File harus berformat .xlsx.' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.getWorksheet(1);
    const rows = [];
    let invalidNumbers = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const nomorRaw = row.getCell(1).value;
        console.log(`Raw nomor dari Excel baris ${rowNumber}:`, nomorRaw, typeof nomorRaw);
        const nomor = formatNomor(nomorRaw);
        if (nomor) {
          rows.push({ 'Nomor WhatsApp': nomor });
        } else {
          invalidNumbers.push({ row: rowNumber, nomor: nomorRaw });
        }
      }
    });
    if (rows.length === 0) {
      tulisLog(`[ERROR] Tidak ada nomor WhatsApp yang valid dalam file Excel.`);
      return res.status(400).json({
        status: 'error',
        message: 'Tidak ada nomor WhatsApp yang valid dalam file Excel.',
        invalidNumbers: invalidNumbers.map(n => `Baris ${n.row}: ${n.nomor}`)
      });
    }
    if (invalidNumbers.length > 0) {
      tulisLog(`[WARNING] Ditemukan ${invalidNumbers.length} nomor tidak valid: ${invalidNumbers.map(n => `Baris ${n.row}: ${n.nomor}`).join(', ')}`);
    }
    dataTarget = rows;
    fs.unlinkSync(req.file.path);
    const newPenerima = dataTarget.length;
    schedulesDb.run('UPDATE schedules SET penerima = ?', [newPenerima], (err) => {
      if (err) console.error('Error updating penerima:', err);
    });
    Object.values(scheduleDetails).forEach(details => details.penerima = newPenerima);
    tulisLog(`[SUKSES] File Excel berhasil dimuat dengan ${newPenerima} nomor valid.`);
    res.json({
      status: 'success',
      message: `Nomor berhasil dimuat. ${newPenerima} nomor valid.`,
      total_contacts: newPenerima,
      invalidNumbers: invalidNumbers.length > 0 ? invalidNumbers.map(n => `Baris ${n.row}: ${n.nomor}`) : []
    });
  } catch (e) {
    console.error('Error in upload:', e);
    tulisLog(`[ERROR] Gagal membaca file Excel: ${e.message}`);
    res.status(500).json({ status: 'error', message: `Gagal membaca file: ${e.message}` });
  }
});

app.post('/send', authMiddleware, async (req, res) => {
  try {
    const pesan = req.body.pesan ? req.body.pesan.trim() : '';
    if (!pesan) return res.status(400).json({ status: 'error', message: 'Pesan tidak boleh kosong.' });
    scheduleDetails['manual'] = { pesanFull: pesan };
    const result = await kirimSemua('manual');
    delete scheduleDetails['manual'];
    res.json(result);
  } catch (e) {
    console.error('Error in send:', e);
    tulisLog(`[ERROR] Kesalahan server saat mengirim pesan: ${e.message}`);
    res.status(500).json({ status: 'error', message: 'Terjadi kesalahan server saat mengirim pesan.' });
  }
});

app.post('/schedule', authMiddleware, textUpload, async (req, res) => {
  await startSchedule(req, res);
});

app.post('/cancel', authMiddleware, (req, res) => {
  try {
    const result = cancelKirim();
    res.json(result);
  } catch (e) {
    console.error('Error in cancel:', e);
    tulisLog(`[ERROR] Kesalahan server saat membatalkan pengiriman: ${e.message}`);
    return res.status(500).json({ status: 'error', message: 'Terjadi kesalahan server saat membatalkan pengiriman.' });
  }
});

app.post('/edit_schedule', authMiddleware, textUpload, async (req, res) => {
  await editSchedule(req, res);
});

app.post('/delete_schedule', authMiddleware, (req, res) => {
  deleteSchedule(req, res); // PERBAIKAN: Perbaiki parameter menjadi (req, res)
});

app.get('/logs', authMiddleware, (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString().split('T')[0];
    const scheduleId = req.query.schedule_id || null;
    let query = 'SELECT teks FROM logs WHERE date(timestamp) = ?';
    let params = [dateStr];
    if (scheduleId) {
      query += ' AND schedule_id = ?';
      params.push(scheduleId);
    }
    logsDb.all(query, params, (err, rows) => {
      if (err) {
        console.error('Error fetching logs:', err);
        return res.status(500).json({ logs: [], date: dateStr });
      }
      const logs = rows.map(row => row.teks);
      res.json({ logs, date: dateStr });
    });
  } catch (e) {
    console.error('Error in logs:', e);
    res.status(500).json({ status: 'error', message: 'Terjadi kesalahan server saat mengambil log.' });
  }
});

app.get('/logs_dates', authMiddleware, (req, res) => {
  try {
    logsDb.all('SELECT DISTINCT date(timestamp) FROM logs ORDER BY date(timestamp) DESC', (err, rows) => {
      if (err) {
        console.error('Error fetching log dates:', err);
        return res.status(500).json([]);
      }
      const dates = rows.map(row => row['date(timestamp)']);
      res.json(dates);
    });
  } catch (e) {
    console.error('Error in logs_dates:', e);
    res.status(500).json([]);
  }
});

app.get('/download_logs', authMiddleware, (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString().split('T')[0];
    const scheduleId = req.query.schedule_id || null;
    let query = 'SELECT timestamp, teks FROM logs WHERE date(timestamp) = ?';
    let params = [dateStr];
    if (scheduleId) {
      query += ' AND schedule_id = ?';
      params.push(scheduleId);
    }
    logsDb.all(query, params, (err, rows) => {
      if (err) {
        console.error('Error downloading logs:', err);
        return res.status(500).send('Error');
      }
      let content = 'Timestamp | Log Message\n' + '-'.repeat(50) + '\n';
      rows.forEach(row => {
        content += `${row.timestamp} | ${row.teks}\n`;
      });
      res.header('Content-Type', 'text/plain');
      res.header('Content-Disposition', `attachment; filename=logs_${dateStr}.txt`);
      res.send(content);
    });
  } catch (e) {
    console.error('Error in download_logs:', e);
    res.status(500).send('Error');
  }
});

app.get('/progress', authMiddleware, (req, res) => {
  res.json({ progress: currentProgress });
});

app.get('/schedules', authMiddleware, (req, res) => {
  try {
    const serializable = {};
    Object.entries(scheduleDetails).forEach(([key, value]) => {
      serializable[key] = {
        pesan: value.pesan,
        days: value.days,
        jam: value.jam,
        penerima: value.penerima
      };
    });
    res.json(serializable);
  } catch (e) {
    console.error('Error in schedules:', e);
    res.status(500).json({ status: 'error', message: 'Terjadi kesalahan server saat mengambil jadwal.' });
  }
});

// PERBAIKAN: Endpoint baru untuk daftar sesi (ID pengiriman)
app.get('/sessions', authMiddleware, (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString().split('T')[0];
    logsDb.all('SELECT DISTINCT schedule_id FROM logs WHERE date(timestamp) = ? AND schedule_id IS NOT NULL ORDER BY schedule_id', [dateStr], (err, rows) => {
      if (err) {
        console.error('Error fetching sessions:', err);
        return res.status(500).json([]);
      }
      const sessions = rows.map(row => row.schedule_id);
      res.json(sessions);
    });
  } catch (e) {
    console.error('Error in sessions:', e);
    res.status(500).json([]);
  }
});

// PERBAIKAN: Cron job untuk hapus log > 30 hari
cron.schedule('0 0 * * *', () => {
  logsDb.run("DELETE FROM logs WHERE timestamp < datetime('now', '-30 days')", (err) => {
    if (err) console.error('Error deleting old logs:', err);
    else console.log('Old logs deleted successfully.');
  });
}, { timezone: 'Asia/Jakarta' });

// Init
loadSchedules();
app.listen(6600, () => console.log('Server running on port 6600'));