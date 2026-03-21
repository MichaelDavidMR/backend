const express = require('express');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./authMiddleware');

const router = express.Router();

// Carga los admins desde el .env
// Formato en .env:
//   ADMIN_USERS=correo1@x.com:Password1,correo2@x.com:Password2
function getAdmins() {
  const raw = process.env.ADMIN_USERS || '';
  return raw.split(',').map(entry => {
    const [email, ...rest] = entry.trim().split(':');
    return { email: email?.trim(), password: rest.join(':').trim() };
  }).filter(u => u.email && u.password);
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
  }

  const admins = getAdmins();

  if (admins.length === 0) {
    return res.status(500).json({ error: 'No hay admins configurados en ADMIN_USERS del .env' });
  }

  const match = admins.find(
    u => u.email === email && u.password === password
  );

  if (!match) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }

  const token = jwt.sign(
    { email: match.email, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  res.json({ token, email: match.email });
});

// GET /api/auth/verify
router.get('/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, user: req.user });
});

module.exports = router;