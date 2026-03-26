require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('./authMiddleware');
const authRoutes = require('./authRoutes');

const app = express();
const PORT = process.env.PORT || 4000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: Faltan las credenciales de Supabase en el archivo .env');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('ERROR: Falta JWT_SECRET en el archivo .env');
  process.exit(1);
}
if (!process.env.ADMIN_USERS) {
  console.error('ERROR: Falta ADMIN_USERS en el archivo .env  (formato: correo1:pass1,correo2:pass2)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ============ AUTH ROUTES (públicas, sin middleware) ============
app.use('/api/auth', authRoutes);

// ============ PUBLIC STATS (sin auth — para la pantalla de login) ============
app.get('/api/public-stats', async (req, res) => {
  try {
    const [
      { count: totalClients },
      { count: totalServices },
      { count: totalReceipts }
    ] = await Promise.all([
      supabase.from('clients').select('id', { count: 'exact', head: true }),
      supabase.from('services').select('id', { count: 'exact', head: true }),
      supabase.from('receipts').select('id', { count: 'exact', head: true }).eq('anulled', false)
    ]);
    res.json({
      totalClients: totalClients || 0,
      totalServices: totalServices || 0,
      totalReceipts: totalReceipts || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MIDDLEWARE DE AUTENTICACIÓN (protege todo lo de abajo) ============
app.use('/api', authMiddleware);

// ============ HELPER FUNCTIONS ============

async function generateNextId(tableName, prefix) {
  const { data, error } = await supabase
    .from(tableName)
    .select('id')
    .order('id', { ascending: false })
    .limit(1);

  let nextNumber = 1;
  if (data && data.length > 0 && data[0].id) {
    const parts = data[0].id.split('-');
    if (parts.length === 2) {
      nextNumber = parseInt(parts[1], 10) + 1;
    }
  }

  const padded = String(nextNumber).padStart(4, '0');
  return `${prefix}-${padded}`;
}

function validateReceiptTotals(receipt) {
  const itemsTotal = receipt.items.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
  const calculatedSubtotal = itemsTotal - receipt.discount;
  const calculatedTotal = calculatedSubtotal + receipt.tax;

  if (Math.abs(calculatedSubtotal - receipt.subtotal) > 0.01)
    return { valid: false, error: 'Subtotal does not match items' };
  if (Math.abs(calculatedTotal - receipt.total) > 0.01)
    return { valid: false, error: 'Total does not match subtotal + tax' };
  return { valid: true };
}

// ============ CLIENTS ENDPOINTS ============

app.get('/api/clients', async (req, res) => {
  const { data, error } = await supabase.from('clients').select('*').order('createdAt', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/clients', async (req, res) => {
  const { name, phone, address = '', notes = '' } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });

  const id = await generateNextId('clients', 'C');
  const newClient = { id, name, phone, address, notes, createdAt: new Date().toISOString() };

  const { data, error } = await supabase.from('clients').insert([newClient]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ============ SERVICES ENDPOINTS ============

app.get('/api/services', async (req, res) => {
  const { data, error } = await supabase.from('services').select('*').order('createdAt', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/services', async (req, res) => {
  const { name, price, description = '' } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'Name and price are required' });

  const id = await generateNextId('services', 'S');
  const newService = { id, name, price: parseFloat(price), description, createdAt: new Date().toISOString() };

  const { data, error } = await supabase.from('services').insert([newService]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ============ RECEIPTS ENDPOINTS ============

app.get('/api/receipts', async (req, res) => {
  const { from, to, clientId, anulled } = req.query;
  let query = supabase.from('receipts').select('*');

  if (from) query = query.gte('createdAt', new Date(from).toISOString());
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    query = query.lte('createdAt', toDate.toISOString());
  }
  if (clientId) query = query.eq('clientId', clientId);

  if (anulled !== undefined) {
    query = query.eq('anulled', anulled === 'true');
  } else {
    query = query.eq('anulled', false);
  }

  query = query.order('createdAt', { ascending: false });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/receipts/:id', async (req, res) => {
  const { data: receipt, error: receiptError } = await supabase
    .from('receipts').select('*').eq('id', req.params.id).single();

  if (receiptError || !receipt) return res.status(404).json({ error: 'Receipt not found' });

  const { data: client } = await supabase
    .from('clients').select('*').eq('id', receipt.clientId).single();

  res.json({ ...receipt, client });
});

app.post('/api/receipts', async (req, res) => {
  const { clientId, items = [], paymentMethod, notes = '', tax = 0, discount = 0, photos = [] } = req.body;

  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  if (!items.length) return res.status(400).json({ error: 'At least one item is required' });
  if (!paymentMethod) return res.status(400).json({ error: 'paymentMethod is required' });

  const { data: client, error: clientError } = await supabase.from('clients').select('id').eq('id', clientId).single();
  if (clientError || !client) return res.status(400).json({ error: 'Client not found' });

  const processedItems = items.map(item => ({
    serviceId: item.serviceId || null,
    description: item.description,
    qty: parseInt(item.qty) || 1,
    unitPrice: parseFloat(item.unitPrice) || 0,
    subtotal: (parseInt(item.qty) || 1) * (parseFloat(item.unitPrice) || 0)
  }));

  const itemsTotal = processedItems.reduce((sum, item) => sum + item.subtotal, 0);
  const subtotal = itemsTotal - parseFloat(discount);
  const total = subtotal + parseFloat(tax);
  const id = await generateNextId('receipts', 'R');

  const newReceipt = {
    id, clientId, items: processedItems, subtotal,
    tax: parseFloat(tax), discount: parseFloat(discount), total,
    paymentMethod, notes, photos,
    createdAt: new Date().toISOString(),
    lastEditedBy: null, editedAt: null,
    anulled: false, anulledReason: null
  };

  const validation = validateReceiptTotals(newReceipt);
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  const { data, error } = await supabase.from('receipts').insert([newReceipt]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.put('/api/receipts/:id', async (req, res) => {
  const { items, paymentMethod, notes, tax, discount, editedBy } = req.body;

  const { data: receipt, error: fetchError } = await supabase.from('receipts').select('*').eq('id', req.params.id).single();
  if (fetchError || !receipt) return res.status(404).json({ error: 'Receipt not found' });
  if (receipt.anulled) return res.status(400).json({ error: 'Cannot edit anulled receipt' });

  const updates = {
    lastEditedBy: editedBy || req.user?.email || 'system',
    editedAt: new Date().toISOString()
  };

  if (paymentMethod) updates.paymentMethod = paymentMethod;
  if (notes !== undefined) updates.notes = notes;

  let currentItems = items ? items.map(item => ({
    serviceId: item.serviceId || null,
    description: item.description,
    qty: parseInt(item.qty) || 1,
    unitPrice: parseFloat(item.unitPrice) || 0,
    subtotal: (parseInt(item.qty) || 1) * (parseFloat(item.unitPrice) || 0)
  })) : receipt.items;

  let currentTax = tax !== undefined ? parseFloat(tax) : receipt.tax;
  let currentDiscount = discount !== undefined ? parseFloat(discount) : receipt.discount;
  const itemsTotal = currentItems.reduce((sum, item) => sum + item.subtotal, 0);

  updates.items = currentItems;
  updates.tax = currentTax;
  updates.discount = currentDiscount;
  updates.subtotal = itemsTotal - currentDiscount;
  updates.total = updates.subtotal + currentTax;

  const { data, error } = await supabase.from('receipts').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/receipts/:id/anull', async (req, res) => {
  const { reason, anulledBy } = req.body;
  if (!reason) return res.status(400).json({ error: 'Anullment reason is required' });

  const updates = {
    anulled: true,
    anulledReason: reason,
    anulledBy: anulledBy || req.user?.email || 'system',
    anulledAt: new Date().toISOString()
  };

  const { data, error } = await supabase.from('receipts').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Receipt not found' });
  res.json(data);
});

// ============ EXPORT & BACKUP ENDPOINTS ============

app.get('/api/export', async (req, res) => {
  const { from, to } = req.query;
  let query = supabase.from('receipts').select('*, clients(*)').eq('anulled', false);

  if (from) query = query.gte('createdAt', new Date(from).toISOString());
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    query = query.lte('createdAt', toDate.toISOString());
  }

  const { data: receipts, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const headers = ['ID', 'Fecha', 'Cliente', 'Telefono', 'Items', 'Subtotal', 'Descuento', 'Impuesto', 'Total', 'Metodo Pago', 'Notas'];
  const rows = receipts.map(r => {
    const client = r.clients;
    const itemsDesc = (r.items || []).map(i => `${i.description}(${i.qty})`).join('; ');
    return [
      r.id, r.createdAt, client ? client.name : 'N/A', client ? client.phone : 'N/A',
      itemsDesc, r.subtotal, r.discount, r.tax, r.total, r.paymentMethod, r.notes
    ];
  });

  const csv = [headers.join(','), ...rows.map(row => row.map(cell => `"${cell || ''}"`).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=receipts.csv');
  res.send(csv);
});

app.get('/api/backup', async (req, res) => {
  const [clients, services, receipts] = await Promise.all([
    supabase.from('clients').select('*'),
    supabase.from('services').select('*'),
    supabase.from('receipts').select('*')
  ]);

  const backupData = {
    clients: clients.data || [],
    services: services.data || [],
    receipts: receipts.data || [],
    backupDate: new Date().toISOString()
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=backup-${new Date().toISOString().split('T')[0]}.json`);
  res.json(backupData);
});

app.post('/api/restore', async (req, res) => {
  const backupData = req.body;
  if (!backupData.clients || !backupData.services || !backupData.receipts)
    return res.status(400).json({ error: 'Invalid backup file format' });

  await Promise.all([
    supabase.from('clients').upsert(backupData.clients),
    supabase.from('services').upsert(backupData.services),
    supabase.from('receipts').upsert(backupData.receipts)
  ]);

  res.json({ message: 'Database restored successfully via Supabase' });
});

// ============ DASHBOARD STATS ============

// Helper: average gap in minutes between consecutive receipts
function avgGapMins(list) {
  if (!list || list.length < 2) return null;
  let total = 0;
  for (let i = 1; i < list.length; i++) {
    total += new Date(list[i].createdAt) - new Date(list[i - 1].createdAt);
  }
  return +(total / (list.length - 1) / 60000).toFixed(1);
}

app.get('/api/stats', async (req, res) => {
  const now = new Date();
  const startOfMonth  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const startOfToday  = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const oneWeekAgo    = new Date(now); oneWeekAgo.setDate(now.getDate() - 7);
  const twoWeeksAgo   = new Date(now); twoWeeksAgo.setDate(now.getDate() - 14);
  const sixMonthsAgo  = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString();

  // ── Run all queries in parallel ──────────────────────────────
  const [
    { data: monthReceipts },
    { data: lastReceipts },
    { count: totalClients },
    { count: totalServices },
    { data: historicReceipts },
    { data: recentForTime },      // last 14 days for avg-time calc
    { data: todayRecs }           // today for workshop status
  ] = await Promise.all([
    supabase.from('receipts').select('total, createdAt').eq('anulled', false).gte('createdAt', startOfMonth),
    supabase.from('receipts').select('*').eq('anulled', false).order('createdAt', { ascending: false }).limit(5),
    supabase.from('clients').select('id', { count: 'exact', head: true }),
    supabase.from('services').select('id', { count: 'exact', head: true }),
    supabase.from('receipts').select('total, createdAt').eq('anulled', false).gte('createdAt', sixMonthsAgo),
    supabase.from('receipts').select('createdAt').eq('anulled', false).gte('createdAt', twoWeeksAgo.toISOString()).order('createdAt', { ascending: true }),
    supabase.from('receipts').select('id').eq('anulled', false).gte('createdAt', startOfToday)
  ]);

  // ── Month totals ─────────────────────────────────────────────
  const totalMonth = (monthReceipts || []).reduce((sum, r) => sum + r.total, 0);
  const totalJobs  = (monthReceipts || []).length;

  // ── Monthly chart data ───────────────────────────────────────
  const monthlyData = [];
  for (let i = 5; i >= 0; i--) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd  = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    const mReceipts = (historicReceipts || []).filter(r => {
      const d = new Date(r.createdAt);
      return d >= monthDate && d <= monthEnd;
    });
    monthlyData.push({
      month: monthDate.toLocaleString('es', { month: 'short' }),
      total: mReceipts.reduce((sum, r) => sum + r.total, 0),
      count: mReceipts.length
    });
  }

  // ── Avg time per receipt (gap between consecutive receipts) ──
  const thisWeekRecs = (recentForTime || []).filter(r => new Date(r.createdAt) >= oneWeekAgo);
  const lastWeekRecs = (recentForTime || []).filter(r => {
    const d = new Date(r.createdAt);
    return d >= twoWeeksAgo && d < oneWeekAgo;
  });

  const avgThisWeek = avgGapMins(thisWeekRecs);
  const avgLastWeek = avgGapMins(lastWeekRecs);

  // avgTimeTrend > 0 means faster this week (took less time), > 0 is good
  let avgTimeTrend = null;
  if (avgThisWeek !== null && avgLastWeek !== null && avgLastWeek > 0) {
    avgTimeTrend = +((avgLastWeek - avgThisWeek) / avgLastWeek * 100).toFixed(1);
  }

  // ── Workshop status ──────────────────────────────────────────
  // DAILY_TARGET can be set in .env (default 10 receipts/day)
  const DAILY_TARGET = parseInt(process.env.DAILY_TARGET || '10');
  const todayCount   = (todayRecs || []).length;
  const onTrackPct   = Math.min(Math.round((todayCount / DAILY_TARGET) * 100), 100);

  res.json({
    totalMonth,
    totalJobs,
    totalClients:  totalClients  || 0,
    totalServices: totalServices || 0,
    lastReceipts:  lastReceipts  || [],
    monthlyData,
    // ── new fields ──
    avgTimePerReceipt: avgThisWeek,           // minutes (null if not enough data)
    avgTimeTrend,                             // % change vs last week (positive = faster)
    workshopStatus: {
      onTrack: onTrackPct,                    // % of daily target completed
      free:    100 - onTrackPct,              // remaining capacity
      todayCount,
      dailyTarget: DAILY_TARGET
    }
  });
});

app.get('/', (req, res) => res.send('API is running'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Receipts Mini-ERP API running on port ${PORT}`);
  console.log(`Database connected to: Supabase`);
  console.log(`Auth: enabled ✔`);
  console.log(`Daily target: ${process.env.DAILY_TARGET || 10} receipts/day`);
});

module.exports = { app, supabase };