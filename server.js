/*************************************************
 * PWAN BUY2SELL – FULL GRIDFS BACKEND WITH ADMIN
 *************************************************/

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const multer = require('multer');
const { GridFsStorage } = require('multer-gridfs-storage');
const crypto = require('crypto');
const path = require('path');

const app = express();

/* ---------- MIDDLEWARE ---------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'pwan-admin-session',
  secret: process.env.ADMIN_SECRET || 'devsecret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true }
}));

app.use(express.staticpath.join(__dirname, 'public'));


/* ---------- DATABASE ---------- */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

const conn = mongoose.connection;

/* ---------- GRIDFS SETUP ---------- */
let gfs;
conn.once('open', () => {
  gfs = new mongoose.mongo.GridFSBucket(conn.db, {
    bucketName: 'uploads'
  });
  console.log('📁 GridFS ready');
});

/* ---------- SCHEMA ---------- */
const SubmissionSchema = new mongoose.Schema({
  fullName: String,
  email: String,
  paymentDate: String,
  accountDetails: String,
  files: [
    {
      fileId: mongoose.Schema.Types.ObjectId,
      filename: String,
      contentType: String,
      originalName: String
    }
  ],
  createdAt: { type: Date, default: Date.now }
});

const Submission = mongoose.model('Submission', SubmissionSchema);

/* ---------- FILE STORAGE ---------- */
const storage = new GridFsStorage({
  url: process.env.MONGO_URI,
  file: (req, file) => {
    return new Promise((resolve, reject) => {
      crypto.randomBytes(16, (err, buf) => {
        if (err) return reject(err);
        resolve({
          filename: buf.toString('hex') + path.extname(file.originalname),
          bucketName: 'uploads',
          contentType: file.mimetype,
          metadata: { originalName: file.originalname }
        });
      });
    });
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

/* ---------- ADMIN MIDDLEWARE ---------- */
function adminOnly(req, res, next) {
  if (req.session.admin) return next();
  return res.status(403).json({ error: 'Admin access only' });
}

/* ---------- ROUTES ---------- */

/* Submission route */
app.post('/submit-poa', upload.array('documents'), async (req, res) => {
  try {
    const { fullName, email, paymentDate, accountDetails } = req.body;

    if (!fullName || !email || !paymentDate || !accountDetails || !req.files.length) {
      return res.status(400).json({ error: 'All fields and files are required' });
    }

    const submission = await Submission.create({
      fullName,
      email,
      paymentDate,
      accountDetails,
      files: req.files.map(f => ({
        fileId: f.id,
        filename: f.filename,
        contentType: f.contentType,
        originalName: f.metadata.originalName
      }))
    });

    res.json({ success: true, id: submission._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Submission failed' });
  }
});

/* Admin login – allow ANY email/password */
app.post('/admin/login', (req, res) => {
  req.session.admin = true;
  res.json({ success: true, message: 'Logged in as admin' });
});

/* Admin logout */
app.post('/admin/logout', adminOnly, (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

/* Get all submissions (admin) */
app.get('/admin/submissions', adminOnly, async (req, res) => {
  const submissions = await Submission.find().sort({ createdAt: -1 });
  res.json(submissions);
});

/* Download a file by ID (admin) */
app.get('/admin/file/:id', adminOnly, async (req, res) => {
  try {
    const fileId = new mongoose.Types.ObjectId(req.params.id);

    const file = await conn.db.collection('uploads.files').findOne({ _id: fileId });
    if (!file) return res.status(404).json({ error: 'File not found' });

    res.set('Content-Type', file.contentType);
    res.set('Content-Disposition', `attachment; filename="${file.metadata.originalName}"`);

    gfs.openDownloadStream(fileId).pipe(res);
  } catch {
    res.status(400).json({ error: 'Invalid file ID' });
  }
});

/* ---------- SERVER ---------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
